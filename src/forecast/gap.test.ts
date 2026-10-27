import { describe, expect, it } from 'vitest';
import {
  accountTemplates,
  analyzeGaps,
  historyDemand,
  manualDemand,
  peakDemand,
  recentDemand,
  type GapOptions,
  type HourlyPoint,
} from './gap';
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
    ...patch,
  };
}

function win(utilization: number, cost: number, resetsInHours: number | null): ApiUsageWindow {
  return { utilization, resets_at: resetsInHours === null ? null : at(resetsInHours), window_stats: { cost } };
}

function usage(fiveHour: ApiUsageWindow | null, sevenDay: ApiUsageWindow | null): ApiAccountUsage {
  return { five_hour: fiveHour, seven_day: sevenDay };
}

function run(
  accounts: ApiAccount[],
  data: Record<string, ApiAccountUsage>,
  perHour: number,
  options: GapOptions = {},
) {
  return analyzeGaps(accounts, data, NOW, manualDemand(perHour), { random: () => 0, hours: 24, advise: false, ...options });
}

function bucketAt(result: ReturnType<typeof analyzeGaps>, hoursFromNow: number) {
  const time = NOW + hoursFromNow * HOUR;
  const bucket = result.buckets.find((item) => item.start <= time && time < item.end);
  if (!bucket) {
    throw new Error(`no bucket at ${hoursFromNow}h`);
  }
  return bucket;
}

describe('analyzeGaps', () => {
  it('serves demand fully when quota is plentiful', () => {
    // 5h 满额 ≈ $90，7d 剩余 ≈ $810；需求 $10/h
    const result = run([account(1)], { 1: usage(win(10, 10, 4), win(10, 100, 150)) }, 10);
    expect(result.firstShortfallAt).toBeNull();
    expect(result.firstOutageAt).toBeNull();
    expect(result.totals.served.min).toBeCloseTo(240, 0);
    expect(result.buckets.every((bucket) => bucket.level === 'ok' || bucket.level === 'warn')).toBe(true);
  });

  it('limits 5h usage by the remaining 7d quota', () => {
    // 5h 满额 ≈ $90，但 7d 只剩约 $20（88% ±0.5% → $15 ~ $25）：无论有多少 5h 轮次，24h 内都不会超过它
    const result = run([account(1)], { 1: usage(win(10, 10, 4), win(88, 880, 150)) }, 50);
    expect(result.totals.served.min).toBeGreaterThan(14);
    expect(result.totals.served.max).toBeLessThan(26);
    expect(result.totals.served.max).toBeLessThanOrEqual(result.totals.sevenDayCapacity.max + 1e-6);
    expect(result.firstOutageAt).not.toBeNull();
    // 7d 用完后的不可调度原因记为 7d
    expect(bucketAt(result, 5).blocked['7d']).toBe(1);
  });

  it('detects an outage while the only account waits for its 5h reset', () => {
    // 5h 剩 $40（当前 50%，满额 $90），2h 后重置；需求 $60/h → 40 分钟用完，之后断档到 2h
    const result = run([account(1)], { 1: usage(win(50, 50, 2), win(10, 100, 150)) }, 60);
    expect(result.firstOutageAt).not.toBeNull();
    expect(result.firstOutageAt!).toBeLessThan(NOW + HOUR);
    const second = bucketAt(result, 1.5);
    expect(second.level).toBe('outage');
    expect(second.blocked['5h']).toBe(1);
    // 2h 后 5h 重置，恢复供给
    const third = bucketAt(result, 2.5);
    expect(third.served.min).toBeGreaterThan(0);
    expect(third.recovered).toBeGreaterThanOrEqual(1);
  });

  it('starts a new 5h window on first use after a reset, not at the reset time', () => {
    // 5h 窗口 1h 后重置；需求只在 3h 后才出现 → 新窗口从 3h 开始计时，8h 才再重置
    const demand = { ...manualDemand(0), hourlyAt: (time: number) => (time >= NOW + 3 * HOUR ? 30 : 0), averageHourly: 0 };
    const result = analyzeGaps(
      [account(1)],
      { 1: usage(win(80, 80, 1), win(10, 100, 150)) },
      NOW,
      demand,
      { random: () => 0, hours: 12, advise: false },
    );
    // 3h 起一个窗口 $90，需求 $30/h → 3h 用完；6h~8h 在等 5h 重置
    expect(bucketAt(result, 7).level).toBe('outage');
    expect(bucketAt(result, 8.5).served.min).toBeGreaterThan(0);
  });

  it('waits for temporary cooldowns before using an account', () => {
    const accounts = [account(1, { temp_unschedulable_until: at(2) })];
    const result = run(accounts, { 1: usage(win(90, 90, 2), win(30, 300, 150)) }, 30);
    expect(bucketAt(result, 0.5)).toMatchObject({ minAccounts: 0, level: 'outage' });
    expect(bucketAt(result, 0.5).blocked.temp).toBe(1);
    expect(bucketAt(result, 2.5).served.min).toBeCloseTo(30, 0);
  });

  it('spreads demand across accounts and reports tightest bucket', () => {
    const accounts = [account(1), account(2)];
    const result = run(
      accounts,
      {
        1: usage(win(50, 50, 1), win(10, 100, 150)), // 5h 剩 $40，1h 后重置
        2: usage(win(10, 10, 4), win(10, 100, 150)), // 5h 剩 $80，4h 后重置
      },
      45,
      { hours: 6 },
    );
    expect(result.firstOutageAt).toBeNull();
    expect(result.tightest).not.toBeNull();
    expect(result.totals.shortfall.max).toBeLessThan(1);
  });

  it('never serves more than the 7d capacity over the period', () => {
    const accounts = [account(1), account(2), account(3, { temp_unschedulable_until: at(20) })];
    const result = analyzeGaps(
      accounts,
      {
        1: usage(win(10, 10, 4), win(80, 800, 30)),
        2: usage(win(20, 20, 2), win(60, 600, 100)),
        3: usage(win(0, 0, null), win(90, 900, 20)),
      },
      NOW,
      manualDemand(400),
      { random: () => 0, hours: 72, advise: false },
    );
    expect(result.totals.served.max).toBeLessThanOrEqual(result.totals.sevenDayCapacity.max + 1e-6);
    expect(result.totals.served.min).toBeLessThanOrEqual(result.totals.sevenDayCapacity.min + 1e-6);
  });

  it('builds 1h buckets for 24h, 3h buckets until 3 days and 6h buckets after', () => {
    const result = run([account(1)], { 1: usage(win(10, 10, 4), win(10, 100, 150)) }, 1, { hours: 168 });
    const sizes = result.buckets.map((bucket) => (bucket.end - bucket.start) / HOUR);
    expect(sizes.slice(0, 24).every((size) => size === 1)).toBe(true);
    expect(sizes.slice(24, 40).every((size) => size === 3)).toBe(true);
    expect(sizes.slice(40).every((size) => size === 6)).toBe(true);
    expect(result.buckets).toHaveLength(24 + 16 + 16);
  });

  it('keeps 5h rounds within the 7d remaining over 7 days and refills after the 7d reset', () => {
    // 7d 剩约 $90，3 天后重置成满额约 $810：7 天总消耗 ≈ 90 + 810（80% ±0.5% 时约 $890 ~ $1,090），不会按 5h 轮数无限累加
    const result = run([account(1)], { 1: usage(win(10, 10, 4), win(80, 720, 72)) }, 200, { hours: 168 });
    expect(result.totals.served.max).toBeLessThanOrEqual(result.totals.sevenDayCapacity.max + 1e-6);
    expect(result.totals.sevenDayCapacity.min).toBeGreaterThan(850);
    expect(result.totals.sevenDayCapacity.max).toBeLessThan(1100);
    // 需求 $200/h 远超供给，7 天内能用的就是 7d 上限
    expect(result.totals.served.min).toBeGreaterThan(result.totals.sevenDayCapacity.min * 0.95);
  });
});

describe('capacity advice', () => {
  it('finds the largest demand multiplier without shortfall', () => {
    // 两个账号各 5h 满额 ≈ $90、7d 很充足：每 5h 最多 $180 ≈ $36/h；需求 $18/h → 约可扩大到 ×2
    const accounts = [account(1), account(2)];
    const data = {
      1: usage(win(0, 0, null), win(10, 100, 150)),
      2: usage(win(10, 10, 5), win(10, 100, 150)),
    };
    const result = analyzeGaps(accounts, data, NOW, manualDemand(18), { random: () => 0, hours: 24, safetyAccounts: 0 });
    const { advice } = result;
    expect(advice.maxMultiplier).not.toBeNull();
    expect(advice.maxMultiplier!.min).toBeGreaterThan(1.6);
    expect(advice.maxMultiplier!.max).toBeLessThan(2.5);
    expect(advice.suggestedMultiplier!).toBeLessThanOrEqual(advice.maxMultiplier!.min + 1e-6);
    // 以建议倍数模拟确实不缺口
    const check = analyzeGaps(accounts, data, NOW, manualDemand(18), {
      random: () => 0,
      hours: 24,
      advise: false,
      demandMultiplier: advice.suggestedMultiplier!,
    });
    expect(check.firstShortfallAt).toBeNull();
    expect(check.firstOutageAt).toBeNull();
    // 超过最大倍数后出现缺口，并给出瓶颈时间
    expect(advice.bottleneckAt).not.toBeNull();
  });

  it('reports a deficit when current demand already exceeds supply', () => {
    const result = analyzeGaps([account(1)], { 1: usage(win(10, 10, 5), win(10, 100, 150)) }, NOW, manualDemand(60), {
      random: () => 0,
      hours: 24,
    });
    expect(result.advice.maxMultiplier!.max).toBeLessThan(1);
    expect(result.advice.suggestedMultiplier!).toBeLessThan(1);
  });

  it('flags outages that happen without any demand', () => {
    // 唯一的账号 5h 后满 30 天：没有需求也会断档
    const accounts = [account(1, { created_at: at(5 - 30 * 24) })];
    const result = analyzeGaps(accounts, { 1: usage(win(10, 10, 5), win(10, 100, 150)) }, NOW, manualDemand(5), {
      random: () => 0,
      hours: 24,
      safetyAccounts: 0,
    });
    expect(result.advice.structuralOutageAt).toBe(NOW + 5 * HOUR);
    expect(result.advice.maxMultiplier!.max).toBe(0);
  });

  it('returns no advice when demand is zero', () => {
    const result = analyzeGaps([account(1)], { 1: usage(win(10, 10, 5), win(10, 100, 150)) }, NOW, manualDemand(0), {
      random: () => 0,
      hours: 24,
    });
    expect(result.advice.maxMultiplier).toBeNull();
    expect(result.advice.suggestedMultiplier).toBeNull();
  });
});

describe('replenishment plan', () => {
  // 一个已用满的参照账号（5h 满额 ≈ $90、7d 满额 ≈ $900，冷却中不参与供给）+ 一个可用账号
  const reference = usage(win(90, 90, 100), win(90, 900, 100));

  it('builds templates from saturated same-plan accounts', () => {
    const result = analyzeGaps(
      [account(1, { temp_unschedulable_until: at(100) }), account(2)],
      { 1: reference, 2: usage(win(10, 10, 5), win(10, 100, 150)) },
      NOW,
      manualDemand(10),
      { random: () => 0, hours: 24, advise: false, plan: true },
    );
    const template = result.plan!.template!;
    expect(template.planLabel).toBe('Team P');
    // 已用满的 #1 作为参照，5h ≈ $90、7d ≈ $900
    expect(template.fiveHour.min).toBeGreaterThan(85);
    expect(template.fiveHour.max).toBeLessThan(95);
    expect(template.sevenDay.min).toBeGreaterThan(850);
  });

  it('adds accounts before the first shortfall until demand is covered', () => {
    // 只有 #2 可用（5h 满额 ≈ $90）；需求 $60/h 会很快断档
    const accounts = [account(1, { temp_unschedulable_until: at(100) }), account(2)];
    const data = { 1: reference, 2: usage(win(10, 10, 5), win(10, 100, 150)) };
    const result = analyzeGaps(accounts, data, NOW, manualDemand(60), {
      random: () => 0,
      hours: 24,
      advise: false,
      plan: true,
      safetyAccounts: 0,
    });
    const plan = result.plan!;
    expect(result.firstOutageAt).not.toBeNull();
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.accounts).toBe(plan.steps.reduce((total, step) => total + step.count, 0));
    // 需求 $60/h，每个新账号每 5h 约 $90：同一时段要一次补多个，而不是一个个补
    expect(plan.steps[0]!.count).toBeGreaterThan(1);
    expect(plan.resolved).toBe(true);
    expect(plan.firstShortfallAt).toBeNull();
    expect(plan.firstOutageAt).toBeNull();
    // 每个补号时间都在它要解决的问题之前
    for (const step of plan.steps) {
      expect(step.at).toBeLessThan(step.triggerAt);
      expect(step.at).toBeGreaterThanOrEqual(NOW);
    }
    // 补完后可消耗更多，且总消耗仍受各账号 7d 上限约束
    expect(plan.totals.served.min).toBeGreaterThan(result.totals.served.min);
    expect(plan.buckets).toHaveLength(result.buckets.length);
  });

  it('needs no accounts when supply already covers demand', () => {
    const result = analyzeGaps(
      [account(1, { temp_unschedulable_until: at(100) }), account(2), account(3)],
      { 1: reference, 2: usage(win(10, 10, 5), win(10, 100, 150)), 3: usage(win(10, 10, 5), win(10, 100, 150)) },
      NOW,
      manualDemand(5),
      { random: () => 0, hours: 24, advise: false, plan: true, safetyAccounts: 1 },
    );
    expect(result.plan!.steps).toHaveLength(0);
    expect(result.plan!.accounts).toBe(0);
    expect(result.plan!.resolved).toBe(true);
  });

  it('also replenishes before the safety line is crossed', () => {
    // 需求很小、不会缺口，但 #2 3h 后满 30 天，之后可调度账号低于预警线 1
    const accounts = [account(1, { temp_unschedulable_until: at(100) }), account(2, { created_at: at(3 - 30 * 24) })];
    const result = analyzeGaps(
      accounts,
      { 1: reference, 2: usage(win(10, 10, 5), win(10, 100, 150)) },
      NOW,
      manualDemand(1),
      { random: () => 0, hours: 24, advise: false, plan: true, safetyAccounts: 1 },
    );
    const plan = result.plan!;
    expect(plan.steps[0]).toMatchObject({ trigger: 'outage' });
    expect(plan.steps[0]!.at).toBeLessThan(NOW + 3 * HOUR);
    expect(plan.resolved).toBe(true);
  });

  it('exposes templates for every plan with samples', () => {
    const standard = { subscription_type: 'team', seat_tier: 'team_standard' };
    const result = analyzeGaps(
      [account(1, { temp_unschedulable_until: at(100) }), account(2, { extra: standard, temp_unschedulable_until: at(100) })],
      { 1: reference, 2: usage(win(90, 20, 100), win(90, 200, 100)) },
      NOW,
      manualDemand(1),
      { random: () => 0, hours: 24, advise: false, plan: true },
    );
    expect(result.plan!.templates.map((template) => template.planLabel).sort()).toEqual(['Team P', 'Team S']);
    expect(result.plan!.alternatives).toHaveLength(1);
    expect(accountTemplates([])).toEqual([]);
  });
});

describe('peak risk', () => {
  it('finds the highest consecutive 5h average inside the lookback', () => {
    const history: HourlyPoint[] = Array.from({ length: 24 }, (_, index) => ({
      at: NOW - (24 - index) * HOUR,
      // 第 10~14 个小时是高峰
      cost: index >= 10 && index < 15 ? 200 : 50,
    }));
    const peak = peakDemand(history, NOW, 24);
    expect(peak).toMatchObject({ hourly: 200, start: NOW - 14 * HOUR, end: NOW - 9 * HOUR, lookbackHours: 24, lookbackName: '最近 24h' });
    // 只看最近 6h 时高峰不在区间内
    expect(peakDemand(history, NOW, 6)!.hourly).toBe(50);
  });

  it('marks peak start times that would cause an extra outage', () => {
    // 两个账号：#1 现在可用，#2 冷却到 10h；基础需求 $10/h 没问题，$60/h 的 5h 高峰在前 10h 会断档
    const accounts = [account(1), account(2, { temp_unschedulable_until: at(10) })];
    const data = {
      1: usage(win(10, 10, 5), win(10, 100, 150)),
      2: usage(win(90, 90, 10), win(10, 100, 150)),
    };
    const peak = { hourly: 60, start: NOW - 6 * HOUR, end: NOW - HOUR, lookbackHours: 24, lookbackName: '最近 24h' };
    const result = analyzeGaps(accounts, data, NOW, manualDemand(10), {
      random: () => 0,
      hours: 24,
      advise: false,
      peak,
    });
    expect(result.firstOutageAt).toBeNull();
    const risk = result.peakRisk!;
    expect(risk.slots[0]).toMatchObject({ start: NOW, level: 'outage' });
    expect(risk.firstRiskStart).toBe(NOW);
    expect(risk.outageSlots).toBeGreaterThan(0);
    expect(risk.worst).not.toBeNull();
    // 最后一个高峰开始时间要保证整段 5h 都在分析期内
    expect(risk.slots.at(-1)!.start).toBeLessThanOrEqual(NOW + 19 * HOUR);
  });

  it('scales the peak with the demand multiplier', () => {
    const peak = { hourly: 20, start: NOW - 6 * HOUR, end: NOW - HOUR, lookbackHours: 24, lookbackName: '最近 24h' };
    const result = analyzeGaps([account(1)], { 1: usage(win(10, 10, 5), win(10, 100, 150)) }, NOW, manualDemand(5), {
      random: () => 0,
      hours: 24,
      advise: false,
      demandMultiplier: 1.5,
      peak,
    });
    expect(result.peakRisk!.scaledHourly).toBeCloseTo(30);
  });
});

describe('demand profiles', () => {
  const history: HourlyPoint[] = Array.from({ length: 72 }, (_, index) => {
    const time = NOW - (72 - index) * HOUR;
    // 白天 10~20 点 $100/h，其余 $20/h
    const hour = new Date(time).getHours();
    return { at: time, cost: hour >= 10 && hour < 20 ? 100 : 20 };
  });

  it('averages the most recent complete hours', () => {
    const profile = recentDemand(history, NOW, 4);
    // 16:00 前的 12~15 点都是白天
    expect(profile.averageHourly).toBeCloseTo(100);
    expect(profile.hourlyAt(NOW + 10 * HOUR)).toBeCloseTo(100);
    expect(profile.label).toBe('最近 4h 平均');
    expect(recentDemand(history, NOW, 72).label).toBe('最近 3 天平均');
  });

  it('uses the full calendar day for yesterday instead of the rolling 24h', () => {
    // NOW 是 16:00：昨天 0~24 点完整一天，白天 10 个小时 × $100 + 夜里 14 个小时 × $20
    const profile = recentDemand(history, NOW, 'yesterday');
    expect(profile.label).toBe('昨天平均');
    expect(profile.averageHourly).toBeCloseTo((10 * 100 + 14 * 20) / 24);
    // 滚动 24h 同样各钟点一次，但跨两个自然日
    expect(recentDemand(history, NOW, 24).averageHourly).toBeCloseTo((10 * 100 + 14 * 20) / 24);
    const sameHour = historyDemand(history, NOW, 'yesterday');
    expect(sameHour.label).toBe('昨天同时段');
    const noon = new Date(NOW);
    noon.setHours(12, 0, 0, 0);
    expect(sameHour.hourlyAt(noon.getTime())).toBeCloseTo(100);
  });

  it('only looks at yesterday when finding the yesterday peak', () => {
    const points: HourlyPoint[] = [
      ...history,
      // 今天上午的一次大高峰不属于昨天
      ...[9, 10, 11, 12, 13].map((hour) => {
        const time = new Date(NOW);
        time.setHours(hour, 0, 0, 0);
        return { at: time.getTime(), cost: 999 };
      }),
    ];
    const peak = peakDemand(points, NOW, 'yesterday')!;
    expect(peak.lookbackName).toBe('昨天');
    expect(peak.hourly).toBeCloseTo(100);
    const todayStart = new Date(NOW);
    todayStart.setHours(0, 0, 0, 0);
    expect(peak.end).toBeLessThanOrEqual(todayStart.getTime());
  });

  it('keeps the daily peak pattern from history', () => {
    const profile = historyDemand(history, NOW, 72);
    const morning = new Date(NOW);
    morning.setHours(3, 0, 0, 0);
    const noon = new Date(NOW);
    noon.setHours(12, 0, 0, 0);
    expect(profile.hourlyAt(morning.getTime())).toBeCloseTo(20);
    expect(profile.hourlyAt(noon.getTime())).toBeCloseTo(100);
  });
});
