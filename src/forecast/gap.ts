import { ACCOUNT_LIFETIME_DAYS, estimateAccounts } from './engine';
import { joinSuffix } from './format';
import type { AccountForecast, ApiAccount, ApiAccountUsage, Range, UsageWindowKey } from './types';

/**
 * 断档分析：按需求逐段模拟未来每个时间段能消耗多少、是否出现无账号可用。
 *
 * 规则（与额度预估一致）：
 * - 每个账号的 5h / 7d 完整额度、当前剩余、冷却恢复、30 天到期都复用 estimateAccounts 的估算；
 * - 每笔消耗同时扣 5h 和 7d，5h 能用的永远不超过 7d 剩余；
 * - 5h 或 7d 用到冷却线即冷却，到该窗口重置才恢复；窗口从本轮首次使用起计时（滚动窗口），
 *   重置后的第一笔消耗才开启新窗口；
 * - 需求按“填满一个再用下一个”分配给可调度账号（先用 5h 快要重置的），分配不出去的计为缺口。
 *
 * 富余与扩容：在同一条需求曲线上按倍数放大反复模拟，找出不出现缺口的最大倍数。
 * 高峰风险：把统计区间里消耗最高的连续 5h 平均值，当作一次 5h 高峰放到分析期内各个时间点，
 * 看高峰落在哪些时间会额外造成断档或缺口。
 *
 * 补充账号：按当前需求倍数，逐个在“首次断档 / 缺口 / 低于预警线”之前补一个新账号，直到分析期内不再出问题；
 * 新账号按同套餐已用满账号的中位数估算满额，5h / 7d 都从首次使用起计时，同样受 7d 上限约束。
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const WINDOW_MS: Record<UsageWindowKey, number> = { '5h': 5 * HOUR_MS, '7d': 7 * 24 * HOUR_MS };
/** 模拟步长：足够细，能看到 5h 冷却与恢复的错位 */
export const GAP_STEP_MINUTES = 10;
/** 扩容倍数的搜索上限；达到即表示“至少”这么多 */
export const MAX_SEARCH_MULTIPLIER = 20;
const SEARCH_PRECISION = 0.02;
/** 建议倍数向下取整到该步长，偏保守 */
export const SUGGEST_STEP = 0.05;
/** 高峰持续时长（与 5h 窗口一致） */
export const PEAK_HOURS = 5;
const EPSILON = 1e-6;
/** 时间段划分：[到第几小时为止, 每段几小时] */
const BUCKET_TIERS: ReadonlyArray<readonly [number, number]> = [
  [24, 1],
  [72, 3],
  [Number.POSITIVE_INFINITY, 6],
];

export type DemandSource = 'recent' | 'history' | 'manual';
export type Bound = keyof Range;

export interface DemandProfile {
  source: DemandSource;
  /** 每小时需求（美元），按时间段起点取值 */
  hourlyAt: (time: number) => number;
  /** 说明用：平均每小时需求 */
  averageHourly: number;
  label: string;
}

export interface GapOptions {
  /** 分析时长（小时） */
  hours?: number;
  /** 可调度账号低于该值视为预警 */
  safetyAccounts?: number;
  /** 需求倍数，用于情景对比 */
  demandMultiplier?: number;
  /** 是否计算富余与扩容建议（需要多次模拟） */
  advise?: boolean;
  /** 复用之前算好的扩容建议：它只取决于需求曲线、时长和预警线，与当前倍数无关 */
  advice?: CapacityAdvice;
  /** 统计区间内的 5h 高峰；提供时扫描高峰落在各时间点的断档风险 */
  peak?: PeakDemand | null;
  /** 是否计算补充账号方案（需要多次模拟） */
  plan?: boolean;
  /** 补充账号最多提前多久到位（小时），默认 1h：太早补会白白消耗新账号的 30 天存活 */
  planLeadHours?: number;
  random?: () => number;
}

/** 统计区间内消耗最高的连续 5h */
export interface PeakDemand {
  /** 这 5h 的平均每小时消耗 */
  hourly: number;
  /** 高峰在历史上出现的时间 */
  start: number;
  end: number;
  lookbackHours: number;
  /** 统计区间名称，如“最近 24h”“昨天” */
  lookbackName: string;
}

export type PeakLevel = 'ok' | 'short' | 'outage';

export interface PeakSlot {
  /** 假设高峰从这里开始，持续 5h */
  start: number;
  level: PeakLevel;
  /** 与不加高峰相比额外的断档时长（分钟）与缺口金额 */
  extraOutageMinutes: number;
  extraShortfall: number;
}

export interface PeakRisk {
  peak: PeakDemand;
  /** 乘以需求倍数后的高峰每小时消耗 */
  scaledHourly: number;
  slots: PeakSlot[];
  outageSlots: number;
  shortfallSlots: number;
  /** 最早会额外断档 / 缺口的高峰开始时间 */
  firstRiskStart: number | null;
  /** 额外断档最长（其次缺口最大）的情形 */
  worst: PeakSlot | null;
}

/** 新补充账号的模板：按同套餐已用满账号的中位数估算 5h / 7d 满额 */
export interface AccountTemplate {
  planLabel: string;
  /** 该套餐现有可预估账号数，用于挑选默认补充的套餐 */
  accounts: number;
  fiveHour: Range;
  sevenDay: Range;
  /** 参与估算的已用满样本数 */
  samples: { fiveHour: number; sevenDay: number };
}

export interface ReplenishStep {
  /** 新账号最晚要在这个时间前可调度 */
  at: number;
  /** 这一批补充的账号数 */
  count: number;
  /** 不补时首次出问题的时间（缺口 / 断档 / 低于预警线） */
  triggerAt: number;
  trigger: 'outage' | 'shortfall' | 'safety';
  planLabel: string;
}

/** 只用某一种套餐补充时需要的账号数 */
export interface ReplenishAlternative {
  planLabel: string;
  accounts: number;
  resolved: boolean;
}

export interface ReplenishPlan {
  template: AccountTemplate | null;
  /** 可选的其它套餐模板 */
  templates: AccountTemplate[];
  /** 按批次排列，同一批在同一时间前到位 */
  steps: ReplenishStep[];
  /** 补充账号总数 */
  accounts: number;
  /** 其它套餐各自需要的数量，便于选择怎么补 */
  alternatives: ReplenishAlternative[];
  /** 补完之后分析期内不再缺口、断档或低于预警线；达到补充上限仍未解决时为 false */
  resolved: boolean;
  maxSteps: number;
  leadHours: number;
  /** 补充后的时间段汇总与总计，用于对比趋势 */
  buckets: GapBucket[];
  totals: { served: Range; shortfall: Range; outageMinutes: Range };
  firstShortfallAt: number | null;
  firstOutageAt: number | null;
}

export type BucketLevel = 'ok' | 'warn' | 'short' | 'outage';

export type BlockReason = '5h' | '7d' | 'temp' | 'expired';

export interface GapBucket {
  start: number;
  end: number;
  demand: number;
  /** 实际能消耗的金额（两种额度估算） */
  served: Range;
  /** 需求缺口 = 需求 − 实际消耗 */
  shortfall: Range;
  /** 段内最紧张时刻，可调度账号还能立即多用的金额 */
  headroom: Range;
  /** 段内最少 / 平均可调度账号（取偏小估算，最保守） */
  minAccounts: number;
  avgAccounts: number;
  /** 段内无账号可用的累计时长（分钟） */
  outageMinutes: Range;
  level: BucketLevel;
  /** 段内不可调度账号的原因分布（取段内最紧张时刻，偏小估算） */
  blocked: Record<BlockReason, number>;
  /** 段内恢复可调度的账号数（5h / 7d / 临时冷却结束） */
  recovered: number;
  /** 段末 7d 剩余之和（未到期账号） */
  sevenDayLeft: Range;
}

export interface CapacityAdvice {
  /** 不出现缺口的最大需求倍数（偏小 / 偏大估算）；需求为 0 或没有账号时为 null */
  maxMultiplier: Range | null;
  /** 建议倍数：不缺口，且需求不会把可调度账号压到预警线以下（冷却本身造成的除外）；偏小估算，向下取整 */
  suggestedMultiplier: number | null;
  /** 超过最大倍数后最先出现缺口的时间（偏小估算） */
  bottleneckAt: number | null;
  /** 与需求无关、因冷却 / 到期首次没有任何账号可调度的时间 */
  structuralOutageAt: number | null;
  /** 实际采用的预警线：冷却本身已低于设定值时取冷却下的最少可调度数 */
  safetyFloor: number;
  searchCap: number;
}

export interface GapResult {
  generatedAt: number;
  hours: number;
  demand: {
    label: string;
    source: DemandSource;
    multiplier: number;
    /** 乘以倍数后的需求 */
    averageHourly: number;
    total: number;
    /** ×1 的需求，扩容倍数以它为基准 */
    baseAverageHourly: number;
    baseTotal: number;
  };
  buckets: GapBucket[];
  /** 首次出现缺口 / 无账号可用的时间（偏小估算，最早） */
  firstShortfallAt: number | null;
  firstOutageAt: number | null;
  /** 偏大估算下的首次缺口（晚于或等于上面），用于给出范围 */
  firstShortfallAtOptimistic: number | null;
  totals: {
    served: Range;
    shortfall: Range;
    outageMinutes: Range;
    /** 分析期内 7d 最多可用（可调度起的 7d 剩余 + 期间重置后的新额度），总消耗不会超过它 */
    sevenDayCapacity: Range;
  };
  advice: CapacityAdvice;
  /** 统计区间高峰落在各时间点的断档风险；没有历史数据时为 null */
  peakRisk: PeakRisk | null;
  /** 补充账号方案；未要求计算时为 null */
  plan: ReplenishPlan | null;
  /** 最紧张的时间段（缺口最大，没有缺口时取可调度账号最少） */
  tightest: GapBucket | null;
  /** predictable：参与模拟；unpredictable：错误 / 限流等不计入；noSample：5h 无法估算未计入 */
  accounts: { predictable: number; unpredictable: number; noSample: number };
  safetyAccounts: number;
  stepMinutes: number;
}

interface WindowState {
  /** 当前窗口到冷却线前还能用的金额 */
  left: number;
  /** 当前窗口结束（重置）时间；null 表示窗口未开启，下一笔消耗才开始计时 */
  end: number | null;
  /** 完整窗口额度 */
  budget: number;
  /** 没有任何样本的 7d 不做约束 */
  unlimited: boolean;
}

interface SimAccount {
  fiveHour: WindowState;
  sevenDay: WindowState;
  /** 临时不可调度结束时间（含后端冷却与已触线窗口的重置） */
  readyAt: number;
  expiresAt: number;
  /** 分析期内 7d 最多可用：可调度起的 7d 剩余 + 之后每次 7d 重置的新额度 */
  capacity: number;
  /** 是否已经计入起始 7d 剩余（账号首次可调度时计入） */
  granted: boolean;
}

interface Tick {
  at: number;
  served: number;
  demand: number;
  schedulable: number;
  blocked: Record<BlockReason, number>;
  recovered: number;
  sevenDayLeft: number;
  headroom: number;
}

interface SimStats {
  demand: number;
  served: number;
  outageSteps: number;
  minSchedulable: number;
  firstShortfallAt: number | null;
  firstOutageAt: number | null;
  /** 不论有无需求，首次没有任何账号可调度的时间 */
  firstEmptyAt: number | null;
  capacity: number;
}

export function analyzeGaps(
  accounts: ApiAccount[],
  usage: Record<string, ApiAccountUsage | undefined>,
  now: number,
  demand: DemandProfile,
  options: GapOptions = {},
): GapResult {
  const hours = options.hours ?? 72;
  const multiplier = options.demandMultiplier ?? 1;
  const safetyAccounts = options.safetyAccounts ?? 3;
  const forecasts = estimateAccounts(accounts, usage, now, options.random ?? Math.random);
  const predictable = forecasts.filter((forecast) => forecast.state !== 'unpredictable');
  // 5h 没有样本、也没有可抽样的同套餐账号时无法估算，不参与模拟
  const usable = predictable.filter(
    (forecast) => forecast.windows['5h'].budgetSource !== 'none' && forecast.windows['5h'].budget.max > 0,
  );
  const until = now + hours * HOUR_MS;
  const base = (time: number) => Math.max(0, demand.hourlyAt(time));
  const scaled = (time: number) => base(time) * multiplier;

  const low = simulate(usable, now, until, scaled, 'min', true);
  const high = simulate(usable, now, until, scaled, 'max', true);
  const buckets = buildBucketEdges(now, until).map(([start, end]) =>
    summarizeBucket(low.ticks, high.ticks, start, end, safetyAccounts),
  );
  const baseTotal = sumDemand(base, now, until);
  const advice =
    options.advice ??
    (options.advise === false
      ? emptyAdvice(safetyAccounts)
      : adviseCapacity(usable, now, until, base, baseTotal, safetyAccounts));
  const total = low.stats.demand;
  const step = GAP_STEP_MINUTES;
  const peakRisk = options.peak ? scanPeakRisk(usable, now, until, scaled, multiplier, options.peak, low.stats) : null;
  const plan = options.plan
    ? planReplenishment(usable, now, until, scaled, safetyAccounts, options.planLeadHours ?? 1)
    : null;

  return {
    generatedAt: now,
    hours,
    demand: {
      label: demand.label,
      source: demand.source,
      multiplier,
      averageHourly: demand.averageHourly * multiplier,
      total,
      baseAverageHourly: demand.averageHourly,
      baseTotal,
    },
    buckets,
    firstShortfallAt: low.stats.firstShortfallAt,
    firstOutageAt: low.stats.firstOutageAt,
    firstShortfallAtOptimistic: high.stats.firstShortfallAt,
    totals: {
      served: orderedRange(low.stats.served, high.stats.served),
      shortfall: orderedRange(Math.max(0, total - high.stats.served), Math.max(0, total - low.stats.served)),
      outageMinutes: orderedRange(high.stats.outageSteps * step, low.stats.outageSteps * step),
      sevenDayCapacity: orderedRange(low.stats.capacity, high.stats.capacity),
    },
    advice,
    peakRisk,
    plan,
    tightest: pickTightest(buckets),
    accounts: {
      predictable: usable.length,
      unpredictable: forecasts.length - predictable.length,
      noSample: predictable.length - usable.length,
    },
    safetyAccounts,
    stepMinutes: step,
  };
}

/**
 * 扩容倍数：先倍增找到上界再二分，假设需求越大越容易出现缺口。
 * - 最大承载：不出现缺口的最大倍数，偏小 / 偏大两种额度估算各算一次；
 * - 建议：还要求可调度账号不低于预警线，冷却本身已低于预警线时以冷却下的最少值为准。
 */
function adviseCapacity(
  usable: AccountForecast[],
  now: number,
  until: number,
  base: (time: number) => number,
  baseTotal: number,
  safetyAccounts: number,
): CapacityAdvice {
  if (baseTotal <= EPSILON || usable.length === 0) {
    return emptyAdvice(safetyAccounts);
  }
  // 三次搜索的倍增阶段会重复同样的倍数，缓存模拟结果
  const memo = new Map<string, SimStats>();
  const run = (multiplier: number, bound: Bound) => {
    const key = `${bound}:${multiplier}`;
    let stats = memo.get(key);
    if (!stats) {
      stats = simulate(usable, now, until, (time) => base(time) * multiplier, bound, false).stats;
      memo.set(key, stats);
    }
    return stats;
  };
  const baseline = run(0, 'min');
  const safetyFloor = Math.min(safetyAccounts, baseline.minSchedulable);
  let bottleneckAt: number | null = null;
  const maxLow = searchMultiplier((multiplier) => {
    const stats = run(multiplier, 'min');
    const ok = fits(stats);
    if (!ok) {
      // 二分过程中最后一次失败对应最小的失败倍数，即刚超过上限时的瓶颈
      bottleneckAt = stats.firstShortfallAt ?? stats.firstOutageAt;
    }
    return ok;
  });
  const maxHigh = searchMultiplier((multiplier) => fits(run(multiplier, 'max')));
  const safe = searchMultiplier((multiplier) => {
    const stats = run(multiplier, 'min');
    return fits(stats) && stats.minSchedulable >= safetyFloor;
  });
  const suggested =
    safe >= MAX_SEARCH_MULTIPLIER ? MAX_SEARCH_MULTIPLIER : Math.floor((safe + EPSILON) / SUGGEST_STEP) * SUGGEST_STEP;
  return {
    maxMultiplier: orderedRange(maxLow, maxHigh),
    suggestedMultiplier: Math.round(suggested * 100) / 100,
    bottleneckAt,
    structuralOutageAt: baseline.firstEmptyAt,
    safetyFloor,
    searchCap: MAX_SEARCH_MULTIPLIER,
  };
}

/** 补充账号的上限：超过仍未解决时如实报告 */
export const MAX_REPLENISH = 120;
/** 最多补充几批（每批一次重新模拟） */
const MAX_REPLENISH_ROUNDS = 60;

/**
 * 每个套餐的新账号模板：取同套餐、同窗口已跑到冷却线账号满额的中位数（它们最接近真实满额），
 * 没有用满的样本时退到任意有自估样本的账号。
 */
export function accountTemplates(forecasts: AccountForecast[]): AccountTemplate[] {
  const groups = new Map<string, AccountForecast[]>();
  for (const forecast of forecasts) {
    const list = groups.get(forecast.planLabel) ?? [];
    list.push(forecast);
    groups.set(forecast.planLabel, list);
  }
  const templates: AccountTemplate[] = [];
  for (const [planLabel, members] of groups) {
    const pick = (key: UsageWindowKey) => {
      const own = members.filter((member) => member.windows[key].budgetSource === 'self');
      const saturated = own.filter((member) => member.windows[key].utilization >= 90 || member.windows[key].resetsAt === null);
      const pool = saturated.length ? saturated : own;
      return {
        budget: { min: median(pool.map((member) => member.windows[key].budget.min)), max: median(pool.map((member) => member.windows[key].budget.max)) },
        samples: pool.length,
      };
    };
    const fiveHour = pick('5h');
    const sevenDay = pick('7d');
    if (fiveHour.samples === 0 || fiveHour.budget.max <= 0) {
      continue;
    }
    templates.push({
      planLabel,
      accounts: members.length,
      fiveHour: fiveHour.budget,
      sevenDay: sevenDay.budget,
      samples: { fiveHour: fiveHour.samples, sevenDay: sevenDay.samples },
    });
  }
  // 默认用账号最多的套餐，其次 7d 额度大的
  return templates.sort((left, right) => right.accounts - left.accounts || right.sevenDay.max - left.sevenDay.max);
}

/** 新账号：从 at 起可调度，5h / 7d 都是满额且未开始计时，存活 30 天 */
function newAccount(template: AccountTemplate, at: number, index: number): AccountForecast {
  const window = (budget: Range) => ({
    utilization: 0,
    resetsAt: null,
    usedCost: 0,
    budget,
    remaining: budget,
    budgetSource: 'peer' as const,
    peerId: null,
  });
  return {
    id: -(index + 1),
    name: `新增 ${template.planLabel} #${index + 1}`,
    planLabel: template.planLabel,
    state: 'cooling',
    label: '补充账号',
    recoverAt: at,
    expiresAt: at + ACCOUNT_LIFETIME_DAYS * 24 * HOUR_MS,
    blockedBy: ['temp'],
    windows: { '5h': window(template.fiveHour), '7d': window(template.sevenDay) },
  };
}

/**
 * 分批补充：每次模拟找出首个问题时间（断档 / 缺口优先，没有时看是否低于预警线），
 * 按该时间起 5h 内的缺口 ÷ 新账号 5h 满额算出这一批要补几个，在问题前 leadHours 到位，重新模拟，
 * 直到分析期内没有问题或达到上限。按偏小额度估算，偏保守。
 * 冷却 / 到期本身就会低于预警线的时段（与需求无关）也会触发补充，这正是需要提前补号的地方。
 */
function planReplenishment(
  usable: AccountForecast[],
  now: number,
  until: number,
  demand: (time: number) => number,
  safetyAccounts: number,
  leadHours: number,
): ReplenishPlan {
  const templates = accountTemplates(usable);
  const runs = templates.map((template) => replenishWith(template, usable, now, until, demand, safetyAccounts, leadHours));
  const primary = runs[0];
  const low = primary?.low ?? simulate(usable, now, until, demand, 'min', true);
  const added = primary?.added ?? [];
  const high = simulate([...usable, ...added], now, until, demand, 'max', true);
  const total = low.stats.demand;
  return {
    template: templates[0] ?? null,
    templates,
    steps: primary?.steps ?? [],
    accounts: added.length,
    alternatives: runs.slice(1).map((run, index) => ({
      planLabel: templates[index + 1]!.planLabel,
      accounts: run.added.length,
      resolved: run.resolved,
    })),
    resolved: primary?.resolved ?? false,
    maxSteps: MAX_REPLENISH,
    leadHours,
    buckets: buildBucketEdges(now, until).map(([start, end]) =>
      summarizeBucket(low.ticks, high.ticks, start, end, safetyAccounts),
    ),
    totals: {
      served: orderedRange(low.stats.served, high.stats.served),
      shortfall: orderedRange(Math.max(0, total - high.stats.served), Math.max(0, total - low.stats.served)),
      outageMinutes: orderedRange(high.stats.outageSteps * GAP_STEP_MINUTES, low.stats.outageSteps * GAP_STEP_MINUTES),
    },
    firstShortfallAt: low.stats.firstShortfallAt,
    firstOutageAt: low.stats.firstOutageAt,
  };
}

function replenishWith(
  template: AccountTemplate,
  usable: AccountForecast[],
  now: number,
  until: number,
  demand: (time: number) => number,
  safetyAccounts: number,
  leadHours: number,
): { steps: ReplenishStep[]; added: AccountForecast[]; low: ReturnType<typeof simulate>; resolved: boolean } {
  const steps: ReplenishStep[] = [];
  const added: AccountForecast[] = [];
  const step = GAP_STEP_MINUTES * MINUTE_MS;
  const lead = Math.max(leadHours * HOUR_MS, step);
  const perAccount = Math.max(1, template.fiveHour.min);
  let current = simulate(usable, now, until, demand, 'min', true);
  for (let round = 0; round < MAX_REPLENISH_ROUNDS && added.length < MAX_REPLENISH; round += 1) {
    const issue = firstIssue(current.ticks, current.stats, safetyAccounts);
    if (!issue) {
      break;
    }
    // 这一批补几个：问题开始后 5h 内的缺口按新账号 5h 满额折算；只是低于预警线时补到预警线
    const windowEnd = issue.at + WINDOW_MS['5h'];
    const gap = current.ticks
      .filter((tick) => tick.at >= issue.at && tick.at < windowEnd)
      .reduce((total, tick) => total + Math.max(0, tick.demand - tick.served), 0);
    const missing = issue.trigger === 'safety'
      ? Math.max(1, safetyAccounts - (current.ticks.find((tick) => tick.at === issue.at)?.schedulable ?? 0))
      : Math.max(1, Math.ceil(gap / perAccount));
    const count = Math.min(missing, MAX_REPLENISH - added.length);
    // 对齐到模拟步，保证新账号在出问题的那一步已经可调度
    const at = Math.max(now, now + Math.floor((issue.at - lead - now) / step) * step);
    steps.push({ at, count, triggerAt: issue.at, trigger: issue.trigger, planLabel: template.planLabel });
    for (let index = 0; index < count; index += 1) {
      added.push(newAccount(template, at, added.length));
    }
    current = simulate([...usable, ...added], now, until, demand, 'min', true);
  }
  return { steps: mergeSteps(steps), added, low: current, resolved: firstIssue(current.ticks, current.stats, safetyAccounts) === null };
}

/** 同一小时内到位的批次合并显示，取最早的到位时间 */
function mergeSteps(steps: ReplenishStep[]): ReplenishStep[] {
  const merged: ReplenishStep[] = [];
  for (const step of [...steps].sort((left, right) => left.at - right.at)) {
    const last = merged.at(-1);
    if (last && step.at - last.at < HOUR_MS) {
      last.count += step.count;
      last.triggerAt = Math.min(last.triggerAt, step.triggerAt);
    } else {
      merged.push({ ...step });
    }
  }
  return merged;
}

/** 首个需要补账号的时间：断档 / 缺口优先；都没有时看是否低于预警线（有需求时） */
function firstIssue(
  ticks: Tick[],
  stats: SimStats,
  safetyAccounts: number,
): { at: number; trigger: ReplenishStep['trigger'] } | null {
  const outage = stats.firstOutageAt;
  const shortfall = stats.firstShortfallAt;
  if (outage !== null || shortfall !== null) {
    const at = Math.min(outage ?? Number.POSITIVE_INFINITY, shortfall ?? Number.POSITIVE_INFINITY);
    return { at, trigger: outage === at ? 'outage' : 'shortfall' };
  }
  const low = ticks.find((tick) => tick.demand > EPSILON && tick.schedulable < safetyAccounts);
  return low ? { at: low.at, trigger: 'safety' } : null;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * 把一次 5h 高峰（每小时取 max(原需求, 高峰值)）依次放到分析期内各个开始时间，逐个模拟。
 * 只统计高峰带来的额外断档 / 缺口，原本就有的不重复计入；按偏小额度估算，偏保守。
 */
function scanPeakRisk(
  usable: AccountForecast[],
  now: number,
  until: number,
  scaled: (time: number) => number,
  multiplier: number,
  peak: PeakDemand,
  baseline: SimStats,
): PeakRisk {
  const scaledHourly = peak.hourly * multiplier;
  const duration = PEAK_HOURS * HOUR_MS;
  const baseShortfall = Math.max(0, baseline.demand - baseline.served);
  const slots: PeakSlot[] = [];
  for (const start of peakStarts(now, until)) {
    const end = start + duration;
    const demand = (time: number) => {
      const value = scaled(time);
      return time >= start && time < end ? Math.max(value, scaledHourly) : value;
    };
    const stats = simulate(usable, now, until, demand, 'min', false).stats;
    const extraOutageMinutes = Math.max(0, stats.outageSteps - baseline.outageSteps) * GAP_STEP_MINUTES;
    const extraShortfall = Math.max(0, stats.demand - stats.served - baseShortfall);
    const level: PeakLevel =
      extraOutageMinutes > 0 ? 'outage' : extraShortfall > Math.max(1, stats.demand * 0.001) ? 'short' : 'ok';
    slots.push({ start, level, extraOutageMinutes, extraShortfall });
  }
  const risky = slots.filter((slot) => slot.level !== 'ok');
  const worst = risky.reduce<PeakSlot | null>(
    (current, slot) =>
      !current ||
      slot.extraOutageMinutes > current.extraOutageMinutes ||
      (slot.extraOutageMinutes === current.extraOutageMinutes && slot.extraShortfall > current.extraShortfall)
        ? slot
        : current,
    null,
  );
  return {
    peak,
    scaledHourly,
    slots,
    outageSlots: slots.filter((slot) => slot.level === 'outage').length,
    shortfallSlots: slots.filter((slot) => slot.level === 'short').length,
    firstRiskStart: risky[0]?.start ?? null,
    worst,
  };
}

/** 高峰开始时间：前 24h 每 1h 一个，之后每 3h 一个，保证整段高峰落在分析期内 */
function peakStarts(now: number, until: number): number[] {
  const starts: number[] = [];
  const last = until - PEAK_HOURS * HOUR_MS;
  for (let start = now; start <= last + EPSILON; ) {
    starts.push(start);
    start += (start - now < 24 * HOUR_MS - EPSILON ? 1 : 3) * HOUR_MS;
  }
  return starts;
}

function emptyAdvice(safetyAccounts: number): CapacityAdvice {
  return {
    maxMultiplier: null,
    suggestedMultiplier: null,
    bottleneckAt: null,
    structuralOutageAt: null,
    safetyFloor: safetyAccounts,
    searchCap: MAX_SEARCH_MULTIPLIER,
  };
}

/** 全部需求都被满足（容许极小的取整误差），且没有出现无账号可用 */
function fits(stats: SimStats): boolean {
  return stats.outageSteps === 0 && stats.demand - stats.served <= Math.max(1, stats.demand * 0.001);
}

function searchMultiplier(test: (multiplier: number) => boolean): number {
  let low = 0;
  let high = 1;
  while (test(high)) {
    low = high;
    if (high >= MAX_SEARCH_MULTIPLIER) {
      return MAX_SEARCH_MULTIPLIER;
    }
    high = Math.min(MAX_SEARCH_MULTIPLIER, high * 2);
  }
  while (high - low > SEARCH_PRECISION) {
    const middle = (low + high) / 2;
    if (test(middle)) {
      low = middle;
    } else {
      high = middle;
    }
  }
  return low;
}

/** 逐步推进：每个时间步先处理重置 / 恢复，再把该步需求分配给可调度账号 */
function simulate(
  forecasts: AccountForecast[],
  now: number,
  until: number,
  demandPerHour: (time: number) => number,
  bound: Bound,
  collect: boolean,
): { ticks: Tick[]; stats: SimStats } {
  const accounts = forecasts.map((forecast) => initAccount(forecast, now, bound));
  const ticks: Tick[] = [];
  const stats: SimStats = {
    demand: 0,
    served: 0,
    outageSteps: 0,
    minSchedulable: Number.POSITIVE_INFINITY,
    firstShortfallAt: null,
    firstOutageAt: null,
    firstEmptyAt: null,
    capacity: 0,
  };
  const step = GAP_STEP_MINUTES * MINUTE_MS;
  let previous = new Set<SimAccount>();
  for (let at = now; at < until; at += step) {
    for (const account of accounts) {
      rollWindows(account, at);
    }
    const schedulable = accounts.filter((account) => isSchedulable(account, at));
    const demand = (demandPerHour(at) * step) / HOUR_MS;
    let remaining = demand;
    if (demand > EPSILON) {
      // 先用 5h 窗口最早重置的账号：它的剩余额度最快过期，优先消耗不浪费
      const order = schedulable.length > 1 ? [...schedulable].sort(byFiveHourEnd) : schedulable;
      for (const account of order) {
        if (remaining <= EPSILON) {
          break;
        }
        remaining -= consume(account, remaining, at);
      }
    }
    const served = demand - Math.max(0, remaining);
    stats.demand += demand;
    stats.served += served;
    // 按本步开始时的可调度账号判断断档；本步内被用满的账号体现在缺口里
    stats.minSchedulable = Math.min(stats.minSchedulable, schedulable.length);
    if (schedulable.length === 0) {
      stats.firstEmptyAt ??= at;
      if (demand > EPSILON) {
        stats.outageSteps += 1;
        stats.firstOutageAt ??= at;
      }
    }
    if (demand - served > Math.max(0.01, demand * 0.001)) {
      stats.firstShortfallAt ??= at;
    }
    if (collect) {
      ticks.push({
        at,
        served,
        demand,
        schedulable: schedulable.length,
        blocked: blockedReasons(accounts, at),
        recovered: at === now ? 0 : schedulable.filter((account) => !previous.has(account)).length,
        sevenDayLeft: accounts.reduce(
          (total, account) =>
            at < account.expiresAt && !account.sevenDay.unlimited ? total + account.sevenDay.left : total,
          0,
        ),
        headroom: schedulable.reduce((total, account) => total + usableNow(account), 0),
      });
      previous = new Set(schedulable);
    }
  }
  if (!Number.isFinite(stats.minSchedulable)) {
    stats.minSchedulable = 0;
  }
  stats.capacity = accounts.reduce((total, account) => total + account.capacity, 0);
  return { ticks, stats };
}

function initAccount(forecast: AccountForecast, now: number, bound: Bound): SimAccount {
  const window = (key: UsageWindowKey, unlimited: boolean): WindowState => {
    const estimate = forecast.windows[key];
    const budget = estimate.budget[bound];
    const active = estimate.resetsAt !== null && estimate.resetsAt > now;
    return {
      budget,
      unlimited,
      // 冷却中的账号：阻塞窗口在恢复时已重置，按满额；仍在计时的窗口沿用当前剩余
      left: active ? estimate.remaining[bound] : budget,
      end: active ? estimate.resetsAt : null,
    };
  };
  return {
    fiveHour: window('5h', false),
    sevenDay: window('7d', forecast.windows['7d'].budgetSource === 'none'),
    readyAt: forecast.recoverAt ?? Number.POSITIVE_INFINITY,
    expiresAt: forecast.expiresAt ?? Number.POSITIVE_INFINITY,
    capacity: 0,
    granted: false,
  };
}

/** 窗口到期：额度回到满额，等下一笔消耗再开启新窗口 */
function rollWindows(account: SimAccount, at: number): void {
  const ready = at >= account.readyAt && at < account.expiresAt;
  resetIfDue(account.fiveHour, at);
  // 可调度之后的 7d 重置才是新增额度；之前的重置只是刷新起始剩余
  if (resetIfDue(account.sevenDay, at) && ready && account.granted && !account.sevenDay.unlimited) {
    account.capacity += account.sevenDay.budget;
  }
  if (ready && !account.granted) {
    account.granted = true;
    account.capacity += account.sevenDay.unlimited ? 0 : account.sevenDay.left;
  }
}

function resetIfDue(window: WindowState, at: number): boolean {
  if (window.end === null || window.end > at) {
    return false;
  }
  window.end = null;
  window.left = window.budget;
  return true;
}

function isSchedulable(account: SimAccount, at: number): boolean {
  if (at < account.readyAt || at >= account.expiresAt) {
    return false;
  }
  return account.fiveHour.left > EPSILON && (account.sevenDay.unlimited || account.sevenDay.left > EPSILON);
}

/** 该账号现在还能立即用多少：5h 剩余与 7d 剩余取较小值 */
function usableNow(account: SimAccount): number {
  return account.sevenDay.unlimited
    ? account.fiveHour.left
    : Math.min(account.fiveHour.left, account.sevenDay.left);
}

function blockedReasons(accounts: SimAccount[], at: number): Record<BlockReason, number> {
  const reasons: Record<BlockReason, number> = { '5h': 0, '7d': 0, temp: 0, expired: 0 };
  for (const account of accounts) {
    if (at >= account.expiresAt) {
      reasons.expired += 1;
    } else if (at < account.readyAt) {
      reasons.temp += 1;
    } else if (!account.sevenDay.unlimited && account.sevenDay.left <= EPSILON) {
      reasons['7d'] += 1;
    } else if (account.fiveHour.left <= EPSILON) {
      reasons['5h'] += 1;
    }
  }
  return reasons;
}

/** 本次最多能用 min(需求, 5h 剩余, 7d 剩余)：5h 永远受 7d 剩余约束 */
function consume(account: SimAccount, wanted: number, at: number): number {
  const amount = Math.max(0, Math.min(wanted, usableNow(account)));
  if (amount <= EPSILON) {
    return 0;
  }
  // 窗口从本轮首次使用起计时
  account.fiveHour.end ??= at + WINDOW_MS['5h'];
  account.fiveHour.left = Math.max(0, account.fiveHour.left - amount);
  account.sevenDay.end ??= at + WINDOW_MS['7d'];
  if (!account.sevenDay.unlimited) {
    account.sevenDay.left = Math.max(0, account.sevenDay.left - amount);
  }
  return amount;
}

function byFiveHourEnd(left: SimAccount, right: SimAccount): number {
  const a = left.fiveHour.end ?? Number.POSITIVE_INFINITY;
  const b = right.fiveHour.end ?? Number.POSITIVE_INFINITY;
  return a === b ? 0 : a < b ? -1 : 1;
}

function sumDemand(perHour: (time: number) => number, now: number, until: number): number {
  const step = GAP_STEP_MINUTES * MINUTE_MS;
  let total = 0;
  for (let at = now; at < until; at += step) {
    total += (perHour(at) * step) / HOUR_MS;
  }
  return total;
}

function buildBucketEdges(now: number, until: number): Array<[number, number]> {
  const edges: Array<[number, number]> = [];
  for (let start = now; start < until; ) {
    const elapsed = (start - now) / HOUR_MS;
    const size = (BUCKET_TIERS.find(([limit]) => elapsed < limit - EPSILON)?.[1] ?? 6) * HOUR_MS;
    const end = Math.min(until, start + size);
    edges.push([start, end]);
    start = end;
  }
  return edges;
}

function summarizeBucket(
  lowTicks: Tick[],
  highTicks: Tick[],
  start: number,
  end: number,
  safetyAccounts: number,
): GapBucket {
  const inside = (ticks: Tick[]) => ticks.filter((tick) => tick.at >= start && tick.at < end);
  const low = inside(lowTicks);
  const high = inside(highTicks);
  const sum = (ticks: Tick[], pick: (tick: Tick) => number) => ticks.reduce((total, tick) => total + pick(tick), 0);
  const least = (ticks: Tick[], pick: (tick: Tick) => number) => (ticks.length ? Math.min(...ticks.map(pick)) : 0);
  const demand = sum(low, (tick) => tick.demand);
  const servedLow = sum(low, (tick) => tick.served);
  const servedHigh = sum(high, (tick) => tick.served);
  const outage = (ticks: Tick[]) =>
    ticks.filter((tick) => tick.schedulable === 0 && tick.demand > EPSILON).length * GAP_STEP_MINUTES;
  const minAccounts = least(low, (tick) => tick.schedulable);
  const tightestTick = low.reduce<Tick | undefined>(
    (worst, tick) => (!worst || tick.schedulable < worst.schedulable ? tick : worst),
    undefined,
  );
  const shortfall = orderedRange(Math.max(0, demand - servedHigh), Math.max(0, demand - servedLow));
  const outageMinutes = orderedRange(outage(high), outage(low));
  let level: BucketLevel = 'ok';
  if (outageMinutes.max > 0) {
    level = 'outage';
  } else if (shortfall.max > Math.max(0.5, demand * 0.001)) {
    level = 'short';
  } else if (minAccounts < safetyAccounts) {
    level = 'warn';
  }
  return {
    start,
    end,
    demand,
    served: orderedRange(servedLow, servedHigh),
    shortfall,
    headroom: orderedRange(least(low, (tick) => tick.headroom), least(high, (tick) => tick.headroom)),
    minAccounts,
    avgAccounts: low.length ? sum(low, (tick) => tick.schedulable) / low.length : 0,
    outageMinutes,
    level,
    blocked: tightestTick?.blocked ?? { '5h': 0, '7d': 0, temp: 0, expired: 0 },
    recovered: sum(low, (tick) => tick.recovered),
    sevenDayLeft: orderedRange(low.at(-1)?.sevenDayLeft ?? 0, high.at(-1)?.sevenDayLeft ?? 0),
  };
}

function pickTightest(buckets: GapBucket[]): GapBucket | null {
  if (buckets.length === 0) {
    return null;
  }
  const withShortfall = buckets.filter((bucket) => bucket.shortfall.max > 0.5);
  if (withShortfall.length) {
    return withShortfall.reduce((worst, bucket) => (bucket.shortfall.max > worst.shortfall.max ? bucket : worst));
  }
  return buckets.reduce((worst, bucket) => (bucket.minAccounts < worst.minAccounts ? bucket : worst));
}

function orderedRange(left: number, right: number): Range {
  return { min: Math.min(left, right), max: Math.max(left, right) };
}

/* ----------------------------- 需求来源 ----------------------------- */

export interface HourlyPoint {
  /** 该小时起点 */
  at: number;
  cost: number;
}

/**
 * 统计区间：
 * - 数字：从现在往前推若干小时（滚动区间，最新但会跨两个自然日）；
 * - yesterday：昨天 0:00 ~ 24:00 一个完整的自然日，与站点“昨日”统计口径一致，但不含今天的变化。
 */
export type Lookback = number | 'yesterday';

interface LookbackWindow {
  from: number;
  to: number;
  hours: number;
  name: string;
}

export function lookbackWindow(lookback: Lookback, now: number): LookbackWindow {
  if (lookback === 'yesterday') {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    return { from: yesterday.getTime(), to: today.getTime(), hours: (today.getTime() - yesterday.getTime()) / HOUR_MS, name: '昨天' };
  }
  return { from: now - lookback * HOUR_MS, to: now, hours: lookback, name: `最近 ${lookbackLabel(lookback)}` };
}

/** 统计区间内已结束的整点小时，按时间排序 */
function completeHours(history: HourlyPoint[], now: number, lookback: Lookback): HourlyPoint[] {
  const window = lookbackWindow(lookback, now);
  const to = Math.min(window.to, now);
  return history
    .filter((point) => point.at + HOUR_MS > window.from && point.at + HOUR_MS <= to)
    .sort((left, right) => left.at - right.at);
}

/** 3 天 / 24h / 12h ...：整天且超过 1 天时按天显示 */
export function lookbackLabel(hours: number): string {
  return hours > 24 && hours % 24 === 0 ? `${hours / 24} 天` : `${hours}h`;
}

/** 统计区间内的平均消耗，作为固定的每小时需求 */
export function recentDemand(history: HourlyPoint[], now: number, lookback: Lookback = 6): DemandProfile {
  const recent = completeHours(history, now, lookback);
  const average = recent.length ? recent.reduce((total, point) => total + point.cost, 0) / recent.length : 0;
  return {
    source: 'recent',
    hourlyAt: () => average,
    averageHourly: average,
    label: joinSuffix(lookbackWindow(lookback, now).name, '平均'),
  };
}

/** 统计区间内消耗最高的连续 5h（按整点小时滑动），区间不足 5h 时取整个区间 */
export function peakDemand(history: HourlyPoint[], now: number, lookback: Lookback): PeakDemand | null {
  const points = completeHours(history, now, lookback);
  const { hours: lookbackHours, name: lookbackName } = lookbackWindow(lookback, now);
  if (points.length === 0) {
    return null;
  }
  const size = Math.min(PEAK_HOURS, points.length);
  let best: PeakDemand | null = null;
  for (let index = 0; index + size <= points.length; index += 1) {
    const window = points.slice(index, index + size);
    // 中间缺小时的数据视为该小时消耗为 0，按实际跨度求平均
    const span = (window.at(-1)!.at - window[0]!.at) / HOUR_MS + 1;
    const hourly = window.reduce((total, point) => total + point.cost, 0) / Math.max(size, span);
    if (!best || hourly > best.hourly) {
      best = { hourly, start: window[0]!.at, end: window.at(-1)!.at + HOUR_MS, lookbackHours, lookbackName };
    }
  }
  return best;
}

/**
 * 按统计区间内同一钟点（0~23 点）的平均消耗，保留一天内的高峰低谷；区间至少 24h 才能覆盖每个钟点，
 * 没有样本的钟点用区间平均补齐。
 */
export function historyDemand(history: HourlyPoint[], now: number, lookback: Lookback = 72): DemandProfile {
  const buckets = Array.from({ length: 24 }, () => ({ total: 0, count: 0 }));
  for (const point of completeHours(history, now, lookback)) {
    const slot = buckets[new Date(point.at).getHours()]!;
    slot.total += point.cost;
    slot.count += 1;
  }
  const fallback = recentDemand(history, now, lookback).averageHourly;
  const byHour = buckets.map((slot) => (slot.count ? slot.total / slot.count : fallback));
  return {
    source: 'history',
    hourlyAt: (time) => byHour[new Date(time).getHours()] ?? fallback,
    averageHourly: byHour.reduce((total, value) => total + value, 0) / 24,
    label: joinSuffix(lookbackWindow(lookback, now).name, '同时段'),
  };
}

export function manualDemand(perHour: number): DemandProfile {
  const value = Math.max(0, perHour);
  return { source: 'manual', hourlyAt: () => value, averageHourly: value, label: '手动设定' };
}
