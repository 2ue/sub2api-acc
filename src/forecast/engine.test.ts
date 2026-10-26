import { describe, expect, it } from 'vitest';
import { computeForecast, resolvePlan } from './engine';
import type { ApiAccount, ApiAccountUsage, ApiUsageWindow } from './types';

const NOW = Date.parse('2026-10-26T16:00:00+08:00');
const HOUR = 3_600_000;

function at(hours: number): string {
  return new Date(NOW + hours * HOUR).toISOString();
}

function account(id: number, patch: Partial<ApiAccount> = {}): ApiAccount {
  return {
    id,
    name: `account-${id}`,
    platform: 'anthropic',
    status: 'active',
    schedulable: true,
    extra: { subscription_type: 'team', seat_tier: 'team_tier_1' },
    temp_unschedulable_until: null,
    temp_unschedulable_reason: null,
    rate_limit_reset_at: null,
    overload_until: null,
    ...patch,
  };
}

function win(utilization: number, cost: number, resetsInHours: number | null): ApiUsageWindow {
  return {
    utilization,
    resets_at: resetsInHours === null ? null : at(resetsInHours),
    window_stats: { cost },
  };
}

function usage(fiveHour: ApiUsageWindow | null, sevenDay: ApiUsageWindow | null): ApiAccountUsage {
  return { five_hour: fiveHour, seven_day: sevenDay };
}

function horizon(result: ReturnType<typeof computeForecast>, hours: number) {
  const item = result.horizons.find((entry) => entry.hours === hours);
  if (!item) {
    throw new Error(`missing horizon ${hours}`);
  }
  return item;
}

describe('resolvePlan', () => {
  it('matches page badges for team seats', () => {
    expect(resolvePlan({ subscription_type: 'team', seat_tier: 'team_standard' }).label).toBe('Team S');
    expect(resolvePlan({ subscription_type: 'team', seat_tier: 'team_tier_1' }).label).toBe('Team P');
    expect(resolvePlan({ subscription_type: 'max', rate_limit_tier: 'default_claude_max_20x' }).label).toBe('Max 20x');
    expect(resolvePlan(null).key).toBe('unknown');
  });
});

describe('computeForecast', () => {
  it('uses the account own window cost as budget and recovers at the 5h reset', () => {
    // 5h 90% 已用 $100 → 冷却 1.5h 后重置，新窗口额度 $100；7d 30% 已用 $300 → 到 90% 还剩 $600
    const accounts = [
      account(1, { temp_unschedulable_until: at(1.5), temp_unschedulable_reason: '{"source":"account_scheduling_threshold"}' }),
    ];
    const result = computeForecast(accounts, { 1: usage(win(90, 100, 1.5), win(30, 300, 100)) }, NOW);

    expect(result.totals).toMatchObject({ all: 1, available: 0, cooling: 1, unpredictable: 0 });
    expect(horizon(result, 1).availableAccounts).toBe(0);
    const twoHours = horizon(result, 2);
    expect(twoHours.availableAccounts).toBe(1);
    expect(twoHours.quota5h).toBeCloseTo(100);
    expect(twoHours.newlyRecovered).toHaveLength(1);
    expect(twoHours.newlyRecovered[0]).toMatchObject({ id: 1, blockedBy: ['5h'], recoverAt: NOW + 1.5 * HOUR });
    expect(horizon(result, 3).newlyRecovered).toHaveLength(0);
  });

  it('restores the full 5h quota when an active window resets', () => {
    // 5h 窗口从首次使用开始计时，30 分钟后到期；已用 $30 = 30%，到 90% 冷却线还能用 $60，重置后恢复满额 $90
    const result = computeForecast([account(1)], { 1: usage(win(30, 30, 0.5), win(10, 100, 100)) }, NOW);

    expect(horizon(result, 0)).toMatchObject({ availableAccounts: 1, quota5h: 60 });
    expect(horizon(result, 1)).toMatchObject({ availableAccounts: 1, quota5h: 90 });
    expect(horizon(result, 24)).toMatchObject({ availableAccounts: 1, quota5h: 90 });
  });

  it('keeps 7d cooling accounts blocked even after the 5h window resets', () => {
    const accounts = [
      account(1, { temp_unschedulable_until: at(1) }),
    ];
    // 5h 也满了且 1h 后重置，但 7d 要 30h 后才重置 → 只能在 30h 后恢复
    const result = computeForecast(accounts, { 1: usage(win(92, 120, 1), win(90, 1000, 30)) }, NOW);

    expect(horizon(result, 5).availableAccounts).toBe(0);
    expect(horizon(result, 24).availableAccounts).toBe(0);
    expect(result.coolingBeyond).toEqual({ count: 1, earliestRecoverAt: NOW + 30 * HOUR });
  });

  it('ignores the 7d F window when deciding cooldown', () => {
    const result = computeForecast(
      [account(1)],
      { 1: { ...usage(win(40, 40, 3), win(20, 200, 80)), seven_day_fable: win(95, 0, 80) } },
      NOW,
    );
    expect(result.totals.available).toBe(1);
    expect(horizon(result, 0).quota5h).toBeCloseTo(50); // 40 * (90 - 40) / 40
  });

  it('treats only temporary cooldowns as predictable', () => {
    const accounts = [
      account(1, { status: 'error' }),
      account(2, { rate_limit_reset_at: at(2) }),
      account(3, { schedulable: false, temp_unschedulable_until: at(1) }),
      account(4, { status: 'inactive' }),
      account(5, { temp_unschedulable_until: at(2), temp_unschedulable_reason: 'upstream transport error (proxy/network): timed out' }),
      account(6, { overload_until: at(1) }),
    ];
    const result = computeForecast(accounts, {}, NOW);
    expect(result.totals.unpredictable).toBe(6);
    expect(result.totals.unpredictableByLabel).toEqual({
      错误: 1,
      限流中: 1,
      暂停调度: 1,
      停用: 1,
      代理故障: 1,
      过载中: 1,
    });
    expect(result.horizons.every((entry) => entry.availableAccounts === 0)).toBe(true);
  });

  it('labels daily cost cap cooldowns and uses the backend cooldown end', () => {
    const accounts = [
      account(1, { temp_unschedulable_until: at(4), temp_unschedulable_reason: '{"source":"daily_standard_cost_cap","cap":200}' }),
    ];
    const result = computeForecast(accounts, { 1: usage(win(20, 30, 2), win(40, 400, 90)) }, NOW);
    expect(horizon(result, 3).availableAccounts).toBe(0);
    expect(horizon(result, 5).newlyRecovered[0]).toMatchObject({ id: 1, blockedBy: ['temp'] });
  });

  it('falls back to the same-plan median when an account has no usable sample', () => {
    const accounts = [account(1), account(2), account(3), account(4, { temp_unschedulable_until: at(1) })];
    const result = computeForecast(
      accounts,
      {
        1: usage(win(50, 50, 3), win(10, 100, 100)), // 5h 预算 90，7d 预算 900
        2: usage(win(60, 80, 3), win(20, 220, 100)), // 5h 预算 120，7d 预算 990
        3: usage(win(30, 40, 3), win(30, 330, 100)), // 5h 预算 120，7d 预算 990
        4: usage(win(90, 0, 0.5), win(0, 0, null)), // 没有金额样本 → 中位数 120 / 990
      },
      NOW,
    );
    const oneHour = horizon(result, 1);
    expect(oneHour.availableAccounts).toBe(4);
    expect(oneHour.newlyRecovered[0]).toMatchObject({ id: 4, quota5h: 120, quota7d: 990 });
    expect(result.peerEstimatedAccounts).toBe(1);
  });

  it('caps the 5h quota by the remaining 7d quota', () => {
    // 5h 刚重置，预算 $100；7d 85% 已用 $850 → 到 90% 只剩 $50
    const result = computeForecast([account(1)], { 1: usage(win(10, 10, 4), win(85, 850, 60)) }, NOW);
    expect(horizon(result, 0)).toMatchObject({ quota5h: 50 });
  });

  it('marks accounts at the threshold as cooling even before the backend refreshes', () => {
    const result = computeForecast([account(1)], { 1: usage(win(91, 110, 0.5), win(40, 400, 50)) }, NOW);
    expect(result.totals.cooling).toBe(1);
    expect(horizon(result, 1).availableAccounts).toBe(1);
  });

  it('splits available accounts and quota by plan', () => {
    const standard = { subscription_type: 'team', seat_tier: 'team_standard' };
    const accounts = [
      account(1, { extra: standard }),
      account(2),
      account(3, { extra: standard, temp_unschedulable_until: at(2) }),
    ];
    const result = computeForecast(
      accounts,
      {
        1: usage(win(45, 10, 3), win(30, 80, 100)),
        2: usage(win(45, 50, 3), win(10, 100, 100)),
        3: usage(win(90, 20, 2), win(30, 80, 100)),
      },
      NOW,
    );
    expect(horizon(result, 0)).toMatchObject({
      availableAccounts: 2,
      stillCooling: 1,
      byPlan: [
        { planLabel: 'Team P', accounts: 1, quota: 50 },
        { planLabel: 'Team S', accounts: 1, quota: 10 },
      ],
    });
    expect(horizon(result, 3)).toMatchObject({ availableAccounts: 3, stillCooling: 0 });
  });

  it('reports the weekly 7d quota across available and cooling accounts', () => {
    const accounts = [
      account(1),
      account(2, { temp_unschedulable_until: at(2) }),
      account(3, { temp_unschedulable_until: at(10) }),
      account(4, { status: 'error' }),
    ];
    const result = computeForecast(
      accounts,
      {
        1: usage(win(30, 30, 3), win(30, 300, 100)), // 7d 剩余 600
        2: usage(win(90, 90, 2), win(60, 600, 100)), // 5h 冷却中，7d 剩余 300
        3: usage(win(10, 10, 4), win(90, 900, 10)), // 7d 冷却，10h 后重置回 900
        4: usage(win(10, 10, 4), win(10, 100, 100)), // 不可预估，不计入
      },
      NOW,
    );
    expect(result.weekly.accounts).toBe(3);
    expect(result.weekly.remaining).toBeCloseTo(900);
    expect(result.weekly.resetsInHorizon.accounts).toBe(1);
    expect(result.weekly.resetsInHorizon.gain).toBeCloseTo(900);
  });

  it('excludes accounts that already lived 30 days', () => {
    const accounts = [account(1, { created_at: at(-30 * 24 - 1) }), account(2, { created_at: at(-10 * 24) })];
    const result = computeForecast(
      accounts,
      { 1: usage(win(10, 10, 3), win(10, 100, 100)), 2: usage(win(10, 10, 3), win(10, 100, 100)) },
      NOW,
    );
    expect(result.totals.available).toBe(1);
    expect(result.totals.unpredictableByLabel).toEqual({ '已满 30 天': 1 });
  });

  it('removes available accounts once they reach 30 days', () => {
    // 2.5h 后满 30 天：现在和 2h 后可用，3h 后移出
    const accounts = [account(1, { created_at: at(2.5 - 30 * 24) }), account(2)];
    const result = computeForecast(
      accounts,
      { 1: usage(win(30, 30, 0.5), win(10, 100, 100)), 2: usage(win(30, 30, 0.5), win(10, 100, 100)) },
      NOW,
    );
    expect(horizon(result, 2).availableAccounts).toBe(2);
    const threeHours = horizon(result, 3);
    expect(threeHours).toMatchObject({ availableAccounts: 1, expiredSinceNow: 1, quota5h: 90 });
    expect(threeHours.newlyExpired).toHaveLength(1);
    expect(threeHours.newlyExpired[0]).toMatchObject({ id: 1, expiresAt: NOW + 2.5 * HOUR, quota5h: 90 });
    expect(horizon(result, 5).newlyExpired).toHaveLength(0);
    expect(result.expiry).toMatchObject({ inHorizon: 1, nextAt: NOW + 2.5 * HOUR, neverRecover: 0 });
  });

  it('never recovers a cooling account that expires before its cooldown ends', () => {
    // 7d 冷却 30h 后才结束，但 10h 后就满 30 天
    const accounts = [account(1, { created_at: at(10 - 30 * 24), temp_unschedulable_until: at(30) })];
    const result = computeForecast(accounts, { 1: usage(win(10, 10, 3), win(90, 900, 30)) }, NOW);
    expect(result.horizons.every((entry) => entry.availableAccounts === 0 && entry.newlyRecovered.length === 0)).toBe(true);
    expect(result.coolingBeyond.count).toBe(0);
    expect(result.expiry).toMatchObject({ neverRecover: 1, inHorizon: 0, nextAt: null });
    expect(result.weekly.accounts).toBe(0);
  });

  it('counts a cooling account that recovers and then expires inside the horizon', () => {
    // 1h 后恢复，4h 后满 30 天
    const accounts = [account(1, { created_at: at(4 - 30 * 24), temp_unschedulable_until: at(1) })];
    const result = computeForecast(accounts, { 1: usage(win(90, 90, 1), win(20, 200, 100)) }, NOW);
    expect(horizon(result, 2)).toMatchObject({ availableAccounts: 1, recoveredSinceNow: 1, expiredSinceNow: 0 });
    expect(horizon(result, 5)).toMatchObject({ availableAccounts: 0, recoveredSinceNow: 1, expiredSinceNow: 1 });
    expect(horizon(result, 5).newlyExpired[0]).toMatchObject({ id: 1 });
  });

  it('treats an already-expired temporary cooldown as available', () => {
    const accounts = [account(1, { temp_unschedulable_until: at(-1) })];
    const result = computeForecast(accounts, { 1: usage(win(0, 0, null), win(9, 100, 120)) }, NOW);
    expect(result.totals.available).toBe(1);
  });
});
