import { describe, expect, it } from 'vitest';
import { computeForecast, resolvePlan, type ForecastOptions } from './engine';
import { formatMoneyRange, horizonLabel } from './format';
import type { ApiAccount, ApiAccountUsage, ApiUsageWindow, Range } from './types';

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

function run(
  accounts: ApiAccount[],
  data: Record<string, ApiAccountUsage | undefined>,
  options: ForecastOptions = {},
) {
  return computeForecast(accounts, data, NOW, { random: () => 0, ...options });
}

function horizon(result: ReturnType<typeof computeForecast>, hours: number) {
  const item = result.horizons.find((entry) => entry.hours === hours);
  if (!item) {
    throw new Error(`missing horizon ${hours}`);
  }
  return item;
}

/** 范围包含期望值，且上下限都在 tolerance 以内（利用率取整带来的偏差） */
function expectAround(range: Range, value: number, tolerance = 0.05) {
  expect(range.min).toBeLessThanOrEqual(value + 1e-6);
  expect(range.max).toBeGreaterThanOrEqual(value - 1e-6);
  expect(range.min).toBeGreaterThanOrEqual(value * (1 - tolerance));
  expect(range.max).toBeLessThanOrEqual(value * (1 + tolerance));
}

const ONE: Range = { min: 1, max: 1 };
const NONE: Range = { min: 0, max: 0 };

describe('horizonLabel', () => {
  it('shows whole multi-day horizons in days', () => {
    expect(horizonLabel(0)).toBe('现在');
    expect(horizonLabel(5)).toBe('5h 后');
    expect(horizonLabel(24)).toBe('24h 后');
    expect(horizonLabel(48)).toBe('2 天后');
    expect(horizonLabel(72)).toBe('3 天后');
  });
});

describe('formatMoneyRange', () => {
  it('collapses narrow ranges into one value', () => {
    expect(formatMoneyRange({ min: 99.6, max: 100.3 })).toBe('$100');
    expect(formatMoneyRange({ min: 900, max: 1050 })).toBe('$900 ~ $1,050');
  });
});

describe('resolvePlan', () => {
  it('matches page badges for team seats', () => {
    expect(resolvePlan({ subscription_type: 'team', seat_tier: 'team_standard' }).label).toBe('Team S');
    expect(resolvePlan({ subscription_type: 'team', seat_tier: 'team_tier_1' }).label).toBe('Team P');
    expect(resolvePlan({ subscription_type: 'max', rate_limit_tier: 'default_claude_max_20x' }).label).toBe('Max 20x');
    expect(resolvePlan(null).key).toBe('unknown');
  });
});

describe('budget estimation', () => {
  it('derives a full window from used cost and widens with lower utilization', () => {
    // 5h 50% 已用 $50 → 满额 ≈ $90；7d 10% 已用 $100 → 满额 ≈ $900，利用率低所以范围更宽
    const result = run([account(1)], { 1: usage(win(50, 50, 3), win(10, 100, 100)) });
    const fiveHourFull = horizon(result, 5).quota;
    expectAround(fiveHourFull, 90, 0.02);
    const rolling = result.rolling7d.remaining;
    expectAround(rolling, 800, 0.06);
    expect(rolling.max - rolling.min).toBeGreaterThan(fiveHourFull.max - fiveHourFull.min);
  });

  it('samples a saturated same-plan account when a window has zero consumption', () => {
    const accounts = [account(1), account(2), account(3)];
    const result = run(accounts, {
      1: usage(win(90, 108, 3), win(40, 400, 100)), // 已用满：5h 满额 ≈ $108
      2: usage(win(30, 20, 3), win(20, 200, 100)), // 未用满：不作为抽样来源
      3: usage(win(0, 0, null), win(10, 100, 100)), // 5h 周期消耗为 0 → 抽到 #1
    });
    expect(result.peerEstimatedAccounts).toBe(1);
    // #1 已到冷却线不计；#2 自身 5h 剩余 ≈ $40；#3 用抽到的满额 ≈ $108
    expect(result.totals.available).toBe(2);
    expectAround(horizon(result, 0).quota, 108 + 40, 0.03);
  });

  it('falls back to any sampled account when no peer is saturated', () => {
    const result = run([account(1), account(2)], {
      1: usage(win(50, 50, 3), win(20, 200, 100)),
      2: usage(win(0, 0, null), win(20, 200, 100)),
    });
    expect(result.peerEstimatedAccounts).toBe(1);
    expectAround(horizon(result, 0).quota, 40 + 90, 0.03);
  });
});

describe('snapshot mode', () => {
  it('uses the account own window cost as budget and recovers at the 5h reset', () => {
    // 5h 90% 已用 $100 → 冷却 1.5h 后重置，新窗口额度 $100；7d 30% 已用 $300 → 到 90% 还剩 $600
    const accounts = [
      account(1, { temp_unschedulable_until: at(1.5), temp_unschedulable_reason: '{"source":"account_scheduling_threshold"}' }),
    ];
    const result = run(accounts, { 1: usage(win(90, 100, 1.5), win(30, 300, 100)) });

    expect(result.totals).toMatchObject({ all: 1, available: 0, cooling: 1, unpredictable: 0 });
    expect(horizon(result, 1).availableAccounts).toEqual(NONE);
    const twoHours = horizon(result, 2);
    expect(twoHours.availableAccounts).toEqual(ONE);
    expectAround(twoHours.quota, 100, 0.01);
    expect(twoHours.newlyRecovered).toHaveLength(1);
    expect(twoHours.newlyRecovered[0]).toMatchObject({ id: 1, blockedBy: ['5h'], recoverAt: NOW + 1.5 * HOUR });
    expect(horizon(result, 3).newlyRecovered).toHaveLength(0);
  });

  it('restores the full 5h quota when an active window resets', () => {
    // 5h 窗口从首次使用开始计时，30 分钟后到期；已用 $30 = 30%，到 90% 冷却线还能用 $60，重置后恢复满额 $90
    const result = run([account(1)], { 1: usage(win(30, 30, 0.5), win(10, 100, 100)) });
    expectAround(horizon(result, 0).quota, 60, 0.03);
    expectAround(horizon(result, 1).quota, 90, 0.02);
    expectAround(horizon(result, 24).quota, 90, 0.02);
  });

  it('caps the 5h quota by the remaining 7d quota', () => {
    // 5h 刚开始，满额 ≈ $81；7d 85% 已用 $850 → 到 90% 只剩约 $50
    const result = run([account(1)], { 1: usage(win(10, 9, 4), win(85, 850, 60)) });
    expectAround(horizon(result, 0).quota, 50, 0.15);
  });

  it('ignores the 7d F window when deciding cooldown', () => {
    const result = run([account(1)], {
      1: { ...usage(win(40, 40, 3), win(20, 200, 80)), seven_day_fable: win(95, 0, 80) },
    });
    expect(result.totals.available).toBe(1);
    expectAround(horizon(result, 0).quota, 50, 0.03); // 40 * (90 - 40) / 40
  });
});

describe('depletion mode', () => {
  it('runs multiple 5h rounds but never beyond the remaining 7d quota', () => {
    // 5h 满额 ≈ $100（当前窗口用了 10%）；7d 50% 已用 $1000 → 满额 $1800，剩 $800，5 天后才重置
    const result = run([account(1)], { 1: usage(win(10, 11.11, 5), win(50, 1000, 120)) }, { mode: 'depletion' });
    // 现在：当前 5h 窗口立即用满
    expectAround(horizon(result, 0).quota, 100 * (80 / 90), 0.1);
    // 24h：第 0/5/10/15/20h 共 5 轮 ≈ 88.9 + 4 × 100；利用率 10% 时 ±0.5% 约等于 ±5%
    const day = horizon(result, 24);
    expectAround(day.quota, 88.9 + 4 * 100, 0.06);
    expect(day.availableAccounts).toEqual(ONE);
    // 2 天：7d 剩余 $800 已用完，进入 7d 冷却
    const twoDays = horizon(result, 48);
    expectAround(twoDays.quota, 800, 0.05);
    expect(twoDays.availableAccounts).toEqual(NONE);
    expect(twoDays.depletedNow).toEqual(ONE);
    expect(twoDays.newlyDepleted).toHaveLength(1);
    expect(twoDays.newlyDepleted[0]).toMatchObject({ id: 1, until: NOW + 120 * HOUR });
    // 3 天：仍在 7d 冷却，累计不再增加
    const threeDays = horizon(result, 72);
    expect(threeDays.quota).toEqual(twoDays.quota);
    expect(threeDays.availableAccounts).toEqual(NONE);
    expect(result.depletedAccounts).toEqual(ONE);
  });

  it('starts a fresh 7d window after the rolling 7d resets', () => {
    // 7d 剩余很少且 30h 后重置：先用完 → 7d 冷却 → 30h 后按满额继续
    const result = run([account(1)], { 1: usage(win(10, 10, 5), win(88, 880, 30)) }, { mode: 'depletion' });
    expect(horizon(result, 24).availableAccounts).toEqual(NONE);
    const twoDays = horizon(result, 48);
    expect(twoDays.availableAccounts).toEqual(ONE);
    expect(twoDays.newlyRestored.map((item) => item.id)).toEqual([1]);
    expect(twoDays.quota.min).toBeGreaterThan(horizon(result, 24).quota.max);
  });

  it('only starts consuming after a cooling account recovers', () => {
    const accounts = [account(1, { temp_unschedulable_until: at(2) })];
    const result = run(accounts, { 1: usage(win(90, 90, 2), win(30, 300, 100)) }, { mode: 'depletion' });
    expect(horizon(result, 1).quota).toEqual(NONE);
    // 2h 恢复后立即用满第一轮；之后 7/12/17/22h 各一轮
    expectAround(horizon(result, 3).quota, 90, 0.02);
    expectAround(horizon(result, 24).quota, 90 * 5, 0.02);
  });

  it('reports 7d max usable as current remaining plus full new windows after resets', () => {
    const accounts = [account(1), account(2), account(3, { temp_unschedulable_until: at(30) })];
    const result = run(
      accounts,
      {
        1: usage(win(10, 11.11, 5), win(50, 1000, 120)), // 7d 剩 $800，3 天内不重置
        2: usage(win(10, 10, 5), win(88, 880, 30)), // 7d 剩 $20，30h 后重置成 $900
        3: usage(win(0, 0, null), win(90, 900, 30)), // 7d 冷却，30h 后重置成 $900
      },
      { mode: 'depletion' },
    );
    const rolling = result.rolling7d;
    expect(rolling.accounts).toBe(3);
    expect(rolling.resetsInHorizon.accounts).toBe(2);
    expectAround(rolling.remaining, 800 + 20, 0.06);
    expectAround(rolling.resetsInHorizon.gain, 900 + 900, 0.03);
    expect(rolling.maxUsable).not.toBeNull();
    expectAround(rolling.maxUsable!, 800 + 20 + 1800, 0.04);
    // 7d 冷却的账号当前剩余为 0，但 3 天内会多出一整份 7d，所以 7d 最多可用大于当前剩余之和
    expect(rolling.maxUsable!.min).toBeGreaterThan(rolling.remaining.max);
  });

  it('never lets cumulative quota exceed the 7d cap at any horizon', () => {
    const accounts = [
      account(1),
      account(2),
      account(3, { temp_unschedulable_until: at(30) }),
      account(4, { temp_unschedulable_until: at(3) }),
    ];
    const result = run(
      accounts,
      {
        1: usage(win(10, 11.11, 5), win(50, 1000, 120)),
        2: usage(win(10, 10, 5), win(88, 880, 30)),
        3: usage(win(0, 0, null), win(90, 900, 30)),
        4: usage(win(92, 100, 3), win(20, 200, 60)),
      },
      { mode: 'depletion' },
    );
    for (const entry of result.horizons) {
      expect(entry.cap7d).not.toBeNull();
      expect(entry.quota.min).toBeLessThanOrEqual(entry.cap7d!.min + 1e-6);
      expect(entry.quota.max).toBeLessThanOrEqual(entry.cap7d!.max + 1e-6);
    }
    const last = result.horizons.at(-1)!;
    expect(last.quota.max).toBeLessThanOrEqual(result.rolling7d.maxUsable!.max + 1e-6);
    expect(last.cap7d).toEqual(result.rolling7d.maxUsable);
  });

  it('keeps the snapshot rolling row on current remaining without a cap', () => {
    const result = run([account(1)], { 1: usage(win(10, 10, 5), win(50, 1000, 120)) });
    expect(result.rolling7d.maxUsable).toBeNull();
    expect(result.horizons.every((entry) => entry.cap7d === null)).toBe(true);
  });

  it('stops consuming when the account reaches 30 days', () => {
    const accounts = [account(1, { created_at: at(12 - 30 * 24) })];
    const result = run(accounts, { 1: usage(win(10, 10, 5), win(10, 100, 120)) }, { mode: 'depletion' });
    // 第 0/5/10h 三轮后到期
    const day = horizon(result, 24);
    expect(day.availableAccounts).toEqual(NONE);
    expect(day.expiredSinceNow).toBe(1);
    expectAround(day.quota, 80 + 90 + 90, 0.06);
  });
});

describe('classification', () => {
  it('keeps 7d cooling accounts blocked even after the 5h window resets', () => {
    const accounts = [account(1, { temp_unschedulable_until: at(1) })];
    // 5h 也满了且 1h 后重置，但 7d 要 30h 后才重置 → 只能在 30h 后恢复
    const result = run(accounts, { 1: usage(win(92, 120, 1), win(90, 1000, 30)) });

    expect(horizon(result, 5).availableAccounts).toEqual(NONE);
    expect(horizon(result, 24).availableAccounts).toEqual(NONE);
    const twoDays = horizon(result, 48);
    expect(twoDays.availableAccounts).toEqual(ONE);
    // 5h 和 7d 都过线，恢复时间取更晚的 7d 重置
    expect(twoDays.newlyRecovered[0]).toMatchObject({ id: 1, blockedBy: ['5h', '7d'], recoverAt: NOW + 30 * HOUR });
    expect(result.coolingBeyond).toEqual({ count: 0, earliestRecoverAt: null });
  });

  it('reports accounts that stay cooling beyond the last horizon', () => {
    // 7d 冷却 100h 后才结束，超出 3 天预测范围
    const accounts = [account(1, { temp_unschedulable_until: at(100) })];
    const result = run(accounts, { 1: usage(win(10, 10, 3), win(90, 900, 100)) });
    expect(result.horizons.map((entry) => entry.hours)).toEqual([0, 1, 2, 3, 5, 24, 48, 72]);
    expect(horizon(result, 72).availableAccounts).toEqual(NONE);
    expect(result.coolingBeyond).toEqual({ count: 1, earliestRecoverAt: NOW + 100 * HOUR });
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
    const result = run(accounts, {});
    expect(result.totals.unpredictable).toBe(6);
    expect(result.totals.unpredictableByLabel).toEqual({
      错误: 1,
      限流中: 1,
      暂停调度: 1,
      停用: 1,
      代理故障: 1,
      过载中: 1,
    });
    expect(result.horizons.every((entry) => entry.availableAccounts.max === 0)).toBe(true);
  });

  it('labels daily cost cap cooldowns and uses the backend cooldown end', () => {
    const accounts = [
      account(1, { temp_unschedulable_until: at(4), temp_unschedulable_reason: '{"source":"daily_standard_cost_cap","cap":200}' }),
    ];
    const result = run(accounts, { 1: usage(win(20, 30, 2), win(40, 400, 90)) });
    expect(horizon(result, 3).availableAccounts).toEqual(NONE);
    expect(horizon(result, 5).newlyRecovered[0]).toMatchObject({ id: 1, blockedBy: ['temp'] });
  });

  it('marks accounts at the threshold as cooling even before the backend refreshes', () => {
    const result = run([account(1)], { 1: usage(win(91, 110, 0.5), win(40, 400, 50)) });
    expect(result.totals.cooling).toBe(1);
    expect(horizon(result, 1).availableAccounts).toEqual(ONE);
  });

  it('splits available accounts and quota by plan', () => {
    const standard = { subscription_type: 'team', seat_tier: 'team_standard' };
    const accounts = [
      account(1, { extra: standard }),
      account(2),
      account(3, { extra: standard, temp_unschedulable_until: at(2) }),
    ];
    const result = run(accounts, {
      1: usage(win(45, 10, 3), win(30, 80, 100)),
      2: usage(win(45, 50, 3), win(10, 100, 100)),
      3: usage(win(90, 20, 2), win(30, 80, 100)),
    });
    const now = horizon(result, 0);
    expect(now.availableAccounts).toEqual({ min: 2, max: 2 });
    expect(now.byPlan.map((plan) => [plan.planLabel, plan.accounts])).toEqual([
      ['Team P', ONE],
      ['Team S', ONE],
    ]);
    expectAround(now.byPlan[0]!.quota, 50, 0.03);
    expectAround(now.byPlan[1]!.quota, 10, 0.03);
    expect(horizon(result, 3).availableAccounts).toEqual({ min: 3, max: 3 });
  });

  it('reports the rolling 7d quota across available and cooling accounts', () => {
    const accounts = [
      account(1),
      account(2, { temp_unschedulable_until: at(2) }),
      account(3, { temp_unschedulable_until: at(10) }),
      account(4, { status: 'error' }),
    ];
    const result = run(accounts, {
      1: usage(win(30, 30, 3), win(30, 300, 100)), // 7d 剩余 600
      2: usage(win(90, 90, 2), win(60, 600, 100)), // 5h 冷却中，7d 剩余 300
      3: usage(win(10, 10, 4), win(90, 900, 10)), // 7d 冷却，10h 后重置回 900
      4: usage(win(10, 10, 4), win(10, 100, 100)), // 不可预估，不计入
    });
    expect(result.rolling7d.accounts).toBe(3);
    expectAround(result.rolling7d.remaining, 900, 0.03);
    expect(result.rolling7d.resetsInHorizon.accounts).toBe(1);
    expectAround(result.rolling7d.resetsInHorizon.gain, 900, 0.01);
  });

  it('excludes accounts that already lived 30 days', () => {
    const accounts = [account(1, { created_at: at(-30 * 24 - 1) }), account(2, { created_at: at(-10 * 24) })];
    const result = run(accounts, {
      1: usage(win(10, 10, 3), win(10, 100, 100)),
      2: usage(win(10, 10, 3), win(10, 100, 100)),
    });
    expect(result.totals.available).toBe(1);
    expect(result.totals.unpredictableByLabel).toEqual({ '已满 30 天': 1 });
  });

  it('removes available accounts once they reach 30 days', () => {
    // 2.5h 后满 30 天：现在和 2h 后可用，3h 后移出
    const accounts = [account(1, { created_at: at(2.5 - 30 * 24) }), account(2)];
    const result = run(accounts, {
      1: usage(win(30, 30, 0.5), win(10, 100, 100)),
      2: usage(win(30, 30, 0.5), win(10, 100, 100)),
    });
    expect(horizon(result, 2).availableAccounts).toEqual({ min: 2, max: 2 });
    const threeHours = horizon(result, 3);
    expect(threeHours).toMatchObject({ availableAccounts: ONE, expiredSinceNow: 1 });
    expectAround(threeHours.quota, 90, 0.02);
    expect(threeHours.newlyExpired).toHaveLength(1);
    expect(threeHours.newlyExpired[0]).toMatchObject({ id: 1, expiresAt: NOW + 2.5 * HOUR });
    expect(horizon(result, 5).newlyExpired).toHaveLength(0);
    expect(result.expiry).toMatchObject({ inHorizon: 1, nextAt: NOW + 2.5 * HOUR, neverRecover: 0 });
  });

  it('never recovers a cooling account that expires before its cooldown ends', () => {
    // 7d 冷却 30h 后才结束，但 10h 后就满 30 天
    const accounts = [account(1, { created_at: at(10 - 30 * 24), temp_unschedulable_until: at(30) })];
    const result = run(accounts, { 1: usage(win(10, 10, 3), win(90, 900, 30)) });
    expect(
      result.horizons.every((entry) => entry.availableAccounts.max === 0 && entry.newlyRecovered.length === 0),
    ).toBe(true);
    expect(result.coolingBeyond.count).toBe(0);
    expect(result.expiry).toMatchObject({ neverRecover: 1, inHorizon: 0, nextAt: null });
    expect(result.rolling7d.accounts).toBe(0);
  });

  it('counts a cooling account that recovers and then expires inside the horizon', () => {
    // 1h 后恢复，4h 后满 30 天
    const accounts = [account(1, { created_at: at(4 - 30 * 24), temp_unschedulable_until: at(1) })];
    const result = run(accounts, { 1: usage(win(90, 90, 1), win(20, 200, 100)) });
    expect(horizon(result, 2)).toMatchObject({ availableAccounts: ONE, recoveredSinceNow: 1, expiredSinceNow: 0 });
    expect(horizon(result, 5)).toMatchObject({ availableAccounts: NONE, recoveredSinceNow: 1, expiredSinceNow: 1 });
    expect(horizon(result, 5).newlyExpired[0]).toMatchObject({ id: 1 });
  });

  it('treats an already-expired temporary cooldown as available', () => {
    const accounts = [account(1, { temp_unschedulable_until: at(-1) })];
    const result = run(accounts, { 1: usage(win(0, 0, null), win(9, 100, 120)) });
    expect(result.totals.available).toBe(1);
  });
});
