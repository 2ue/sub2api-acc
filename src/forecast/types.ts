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

/** 每个窗口预算的来源：自身上一个窗口的已用金额 / 同套餐中位数 / 无样本 */
export type BudgetSource = 'self' | 'peer' | 'none';

export type AccountForecastState = 'available' | 'cooling' | 'unpredictable';

export interface WindowForecast {
  utilization: number;
  resetsAt: number | null;
  usedCost: number;
  /** 窗口重置后的新额度，按上一个窗口已用金额估算 */
  budget: number;
  /** 当前窗口到 90% 冷却线还能用的金额 */
  remaining: number;
  budgetSource: BudgetSource;
}

export interface AccountForecast {
  id: number;
  name: string;
  planLabel: string;
  state: AccountForecastState;
  label: string;
  /** 冷却账号的恢复时间；null 表示无法确定 */
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
  quota5h: number;
  quota7d: number;
}

export interface ExpiryItem {
  id: number;
  name: string;
  planLabel: string;
  expiresAt: number;
  /** 到期时损失的 5h 额度 */
  quota5h: number;
}

export interface PlanBreakdown {
  planLabel: string;
  accounts: number;
  quota: number;
}

/** 本周（7d）剩余额度：不随小时变化，只在 7d 窗口重置时增加 */
export interface WeeklyQuota {
  /** 可预估账号（可用 + 冷却中）当前 7d 剩余之和 */
  remaining: number;
  accounts: number;
  byPlan: PlanBreakdown[];
  /** 最大预测时间内 7d 窗口重置的账号数及额度增量 */
  resetsInHorizon: { accounts: number; gain: number };
}

export interface HorizonForecast {
  hours: number;
  at: number;
  availableAccounts: number;
  /** 到该时间点仍在冷却的账号数 */
  stillCooling: number;
  /** 相对现在新增恢复的账号数 */
  recoveredSinceNow: number;
  /** 相对现在因存活满 30 天而移出的账号数 */
  expiredSinceNow: number;
  /** 按套餐（Team S / Team P ...）拆分的可用账号与 5h 额度 */
  byPlan: PlanBreakdown[];
  /** 各可用账号 5h 窗口剩余金额之和（受 7d 剩余约束） */
  quota5h: number;
  /** 在上一个时间点之后、本时间点之前恢复的账号 */
  newlyRecovered: RecoveryItem[];
  /** 在上一个时间点之后、本时间点之前存活满 30 天的账号 */
  newlyExpired: ExpiryItem[];
}

export interface ForecastResult {
  generatedAt: number;
  totals: {
    all: number;
    available: number;
    cooling: number;
    unpredictable: number;
    unpredictableByLabel: Record<string, number>;
  };
  horizons: HorizonForecast[];
  weekly: WeeklyQuota;
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
  /** 至少一个窗口预算来自同套餐中位数的账号数 */
  peerEstimatedAccounts: number;
  /** 至少一个窗口完全没有样本的账号数 */
  noSampleAccounts: number;
}
