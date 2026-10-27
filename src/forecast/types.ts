// Subset of the sub2api manager API payloads used by the forecast.

export interface ApiAccountExtra {
  subscription_type?: string;
  seat_tier?: string;
  rate_limit_tier?: string;
  email_address?: string;
}

export interface ApiAccount {
  id: number;
  name: string;
  platform?: string;
  status: string;
  schedulable: boolean;
  extra?: ApiAccountExtra | null;
  proxy?: { fault?: unknown } | null;
  temp_unschedulable_until?: string | null;
  temp_unschedulable_reason?: string | null;
  rate_limit_reset_at?: string | null;
  overload_until?: string | null;
  /** 存活时间按创建时间计算，满 30 天后不再可用 */
  created_at?: string | null;
  quota_used?: number;
  quota_limit?: number;
  quota_daily_used?: number;
  quota_daily_limit?: number;
  quota_weekly_used?: number;
  quota_weekly_limit?: number;
}

export interface ApiWindowStats {
  requests?: number;
  tokens?: number;
  cost?: number;
  stats_cost?: number;
}

export interface ApiUsageWindow {
  utilization: number;
  resets_at: string | null;
  remaining_seconds?: number;
  window_stats?: ApiWindowStats;
}

export interface ApiAccountUsage {
  source?: string;
  updated_at?: string;
  five_hour?: ApiUsageWindow | null;
  seven_day?: ApiUsageWindow | null;
  // 7d F（seven_day_fable）不参与冷却判断，这里只保留类型便于识别。
  seven_day_fable?: ApiUsageWindow | null;
}

export type UsageWindowKey = '5h' | '7d';

/**
 * 计算方式：
 * - snapshot：按时刻剩余，期间不消耗，看该时间点各账号当前窗口还能用多少；
 * - depletion：最快用完 · 累计，每个账号满负荷使用，所有 5h 轮次合计不超过 7d 剩余。
 */
export type ForecastMode = 'snapshot' | 'depletion';

/** 估算范围；利用率是取整值，按 ±0.5% 推出上下限 */
export interface Range {
  min: number;
  max: number;
}

/** 每个窗口满额的来源：自身已用金额 / 同套餐已用满账号抽样 / 无样本 */
export type BudgetSource = 'self' | 'peer' | 'none';

export type AccountForecastState = 'available' | 'cooling' | 'unpredictable';

export interface WindowForecast {
  utilization: number;
  resetsAt: number | null;
  usedCost: number;
  /** 一个完整窗口到 90% 冷却线的额度 */
  budget: Range;
  /** 当前窗口到 90% 冷却线还能用的金额 */
  remaining: Range;
  budgetSource: BudgetSource;
  /** budgetSource 为 peer 时抽到的账号 */
  peerId: number | null;
}

export interface AccountForecast {
  id: number;
  name: string;
  planLabel: string;
  state: AccountForecastState;
  label: string;
  /** 冷却账号的恢复时间；可用账号为当前时间；null 表示无法确定 */
  recoverAt: number | null;
  /** 创建时间 + 30 天；创建时间未知为 null */
  expiresAt: number | null;
  blockedBy: Array<UsageWindowKey | 'temp'>;
  windows: Record<UsageWindowKey, WindowForecast>;
}

export interface RecoveryItem {
  id: number;
  name: string;
  planLabel: string;
  blockedBy: Array<UsageWindowKey | 'temp'>;
  recoverAt: number;
  quota5h: Range;
  quota7d: Range;
}

/** 最快用完模式下 7d 剩余被用完、进入 7d 冷却的账号 */
export interface DepletionItem {
  id: number;
  name: string;
  planLabel: string;
  /** 两种估算里较早用完的时间 */
  depletedAt: number;
  /** 另一种估算的用完时间；null 表示该估算在预测期内不会用完 */
  latestAt: number | null;
  /** 7d 冷却结束（该账号 7d 窗口重置） */
  until: number;
}

export interface ExpiryItem {
  id: number;
  name: string;
  planLabel: string;
  expiresAt: number;
  /** 到期时损失的 5h 额度 */
  quota5h: Range;
}

export interface PlanBreakdown {
  planLabel: string;
  accounts: Range;
  quota: Range;
}

/** 滚动 7d 窗口额度（各账号窗口独立计时） */
export interface RollingQuota {
  /** 计入的账号数：snapshot 为可用 + 冷却中；depletion 为预测期内能被调度的 */
  accounts: number;
  /** 当前 7d 窗口剩余之和 */
  remaining: Range;
  /** 预测期内 7d 窗口重置的账号数与额度增量（snapshot：重置后回到满额的差值；depletion：重置后的完整新额度） */
  resetsInHorizon: { accounts: number; gain: Range };
  /** depletion：预测期内 7d 最多可用 = 当前剩余 + 重置新增，累计额度不会超过它；snapshot 为 null */
  maxUsable: Range | null;
  /** snapshot 按当前剩余拆分，depletion 按最多可用拆分 */
  byPlan: PlanBreakdown[];
}

export interface HorizonForecast {
  hours: number;
  at: number;
  /** 该时间点可调度的账号数；最快用完模式下按最早 / 最晚用完给出范围 */
  availableAccounts: Range;
  /** 相对现在新增恢复（结束临时冷却）的账号数 */
  recoveredSinceNow: number;
  /** 最快用完模式下该时间点因 7d 用完而冷却的账号数（两种估算都用完 / 任一用完） */
  depletedNow: Range;
  /** 相对现在因存活满 30 天而移出的账号数 */
  expiredSinceNow: number;
  /** 按套餐（Team S / Team P ...）拆分的可用账号与额度 */
  byPlan: PlanBreakdown[];
  /** snapshot：该时刻各可用账号 5h 剩余之和；depletion：从现在到该时间点累计最多能用的金额 */
  quota: Range;
  /** depletion：到该时间点为止 7d 最多可用（当前剩余 + 已发生的重置），quota 不会超过它；snapshot 为 null */
  cap7d: Range | null;
  /** 在上一个时间点之后、本时间点之前发生的变化 */
  newlyRecovered: RecoveryItem[];
  newlyDepleted: DepletionItem[];
  /** 7d 用完冷却后，7d 窗口重置、重新可调度的账号 */
  newlyRestored: DepletionItem[];
  newlyExpired: ExpiryItem[];
}

export interface ForecastResult {
  generatedAt: number;
  mode: ForecastMode;
  totals: {
    all: number;
    available: number;
    cooling: number;
    unpredictable: number;
    unpredictableByLabel: Record<string, number>;
  };
  horizons: HorizonForecast[];
  rolling7d: RollingQuota;
  /** 超出最大预测时间仍在冷却的账号数，以及其中最早的恢复时间 */
  coolingBeyond: { count: number; earliestRecoverAt: number | null };
  expiry: {
    lifetimeDays: number;
    /** 最大预测时间内存活满 30 天的账号数 */
    inHorizon: number;
    /** 可预估账号里最早满 30 天的时间 */
    nextAt: number | null;
    /** 冷却结束前就满 30 天、不会再恢复的账号数 */
    neverRecover: number;
  };
  /** 最快用完模式下，预测期内会用完 7d 剩余的账号数（最早 / 最晚用完的情形） */
  depletedAccounts: Range;
  /** 利用率取整带来的不确定度（百分点），范围按 ±该值估算 */
  utilizationPrecision: number;
  /** 至少一个窗口满额来自同套餐抽样的账号数 */
  peerEstimatedAccounts: number;
  /** 至少一个窗口完全没有样本的账号数 */
  noSampleAccounts: number;
}
