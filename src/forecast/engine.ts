import type {
  AccountForecast,
  AccountForecastState,
  ApiAccount,
  ApiAccountExtra,
  ApiAccountUsage,
  ApiUsageWindow,
  BudgetSource,
  ExpiryItem,
  ForecastResult,
  HorizonForecast,
  PlanBreakdown,
  RecoveryItem,
  UsageWindowKey,
  WeeklyQuota,
  WindowForecast,
} from './types';

export const FORECAST_HORIZON_HOURS = [0, 1, 2, 3, 5, 24] as const;
/** 5h / 7d 任一进度条达到该值即进入冷却（7d F 不参与） */
export const COOLDOWN_UTILIZATION = 90;
/** 利用率是取整的，低于该值时按已用金额折算误差过大，改用同套餐中位数 */
export const MIN_SAMPLE_UTILIZATION = 5;
/** 账号从创建开始最多存活 30 天，之后不再可用 */
export const ACCOUNT_LIFETIME_DAYS = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_KEYS: UsageWindowKey[] = ['5h', '7d'];
// 与页面 AccountsView 的判定保持一致
const PROXY_FAULT_REASON_PREFIX = 'upstream transport error (proxy/network):';
const DAILY_COST_CAP_SOURCE = 'daily_standard_cost_cap';
const STATUS_LABELS: Record<string, string> = {
  inactive: '停用',
  disabled: '停用',
  unschedulable: '不可调度',
};
const PLAN_LABELS: Record<string, string> = {
  max_20x: 'Max 20x',
  max_5x: 'Max 5x',
  max: 'Max',
  pro: 'Pro',
  free: 'Free',
  team_standard: 'Team S',
  team_premium: 'Team P',
  team: 'Team',
  enterprise: 'Enterprise',
};
const PLAN_PATTERNS: Array<[RegExp, string]> = [
  [/20x/, 'max_20x'],
  [/5x/, 'max_5x'],
  [/max/, 'max'],
  [/team/, 'team'],
  [/enterprise/, 'enterprise'],
  [/pro/, 'pro'],
  [/free/, 'free'],
];

interface WindowSample {
  /** 当前窗口利用率；窗口已过重置时间则为 0 */
  utilization: number;
  /** 当前窗口重置时间；已重置或未知为 null */
  resetsAt: number | null;
  usedCost: number;
  /** 由该窗口已用金额推出的“一个窗口到冷却线的额度”；样本不足为 null */
  selfBudget: number | null;
}

interface AccountDraft {
  account: ApiAccount;
  planKey: string;
  planLabel: string;
  samples: Record<UsageWindowKey, WindowSample>;
}

type Classification = Pick<AccountForecast, 'state' | 'label' | 'recoverAt' | 'blockedBy'>;

export function computeForecast(
  accounts: ApiAccount[],
  usage: Record<string, ApiAccountUsage | undefined>,
  now: number,
  horizonHours: readonly number[] = FORECAST_HORIZON_HOURS,
): ForecastResult {
  const drafts = accounts.map((account): AccountDraft => {
    const plan = resolvePlan(account.extra);
    const accountUsage = usage[String(account.id)];
    return {
      account,
      planKey: `${account.platform ?? ''}:${plan.key}`,
      planLabel: plan.label,
      samples: {
        '5h': sampleWindow(accountUsage?.five_hour, now),
        '7d': sampleWindow(accountUsage?.seven_day, now),
      },
    };
  });

  const peerBudgets = collectPeerBudgets(drafts);
  const forecasts = drafts.map((draft) => buildAccountForecast(draft, peerBudgets, now));
  return summarize(forecasts, now, horizonHours);
}

/** 与页面套餐徽标（Team S / Team P / Max 20x ...）的识别规则一致 */
export function resolvePlan(extra: ApiAccountExtra | null | undefined): {
  key: string;
  label: string;
} {
  const subscription = (extra?.subscription_type ?? '').trim().toLowerCase();
  let key = '';
  if (subscription === 'team') {
    const seat = (extra?.seat_tier ?? '').trim().toLowerCase();
    key = seat ? (seat === 'team_standard' ? 'team_standard' : 'team_premium') : 'team';
  } else if (subscription === 'enterprise') {
    key = 'enterprise';
  } else {
    const text = `${extra?.rate_limit_tier ?? ''} ${subscription}`.toLowerCase();
    key = PLAN_PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? '';
  }
  return { key: key || 'unknown', label: PLAN_LABELS[key] ?? '未知套餐' };
}

function sampleWindow(window: ApiUsageWindow | null | undefined, now: number): WindowSample {
  const resetsAt = parseTime(window?.resets_at);
  // 已过重置时间但接口数据还没刷新：按已重置处理，旧窗口的金额仍可作为额度样本
  const expired = resetsAt !== null && resetsAt <= now;
  const selfBudget = window ? windowBudget(window) : null;
  if (!window || expired) {
    return { utilization: 0, resetsAt: null, usedCost: 0, selfBudget };
  }
  return {
    utilization: finiteOr(window.utilization, 0),
    resetsAt,
    usedCost: finiteOr(window.window_stats?.cost, 0),
    selfBudget,
  };
}

/**
 * 一个窗口到 90% 冷却线可用的金额，取该账号上一个（或当前）窗口的已用金额，窗口不完整也照用；
 * 没跑到冷却线的窗口按利用率等比折算到 90%。利用率太低时样本不可信，返回 null 交给同套餐中位数。
 */
function windowBudget(window: ApiUsageWindow): number | null {
  const utilization = finiteOr(window.utilization, 0);
  const usedCost = finiteOr(window.window_stats?.cost, 0);
  if (usedCost <= 0 || utilization < MIN_SAMPLE_UTILIZATION) {
    return null;
  }
  return (usedCost * COOLDOWN_UTILIZATION) / utilization;
}

function collectPeerBudgets(drafts: AccountDraft[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const draft of drafts) {
    for (const key of WINDOW_KEYS) {
      const budget = draft.samples[key].selfBudget;
      if (budget === null) {
        continue;
      }
      const groupKey = `${draft.planKey}|${key}`;
      const values = groups.get(groupKey) ?? [];
      values.push(budget);
      groups.set(groupKey, values);
    }
  }
  const medians = new Map<string, number>();
  for (const [groupKey, values] of groups) {
    medians.set(groupKey, median(values));
  }
  return medians;
}

function buildAccountForecast(
  draft: AccountDraft,
  peerBudgets: Map<string, number>,
  now: number,
): AccountForecast {
  const windows = {} as Record<UsageWindowKey, WindowForecast>;
  for (const key of WINDOW_KEYS) {
    const sample = draft.samples[key];
    const peer = peerBudgets.get(`${draft.planKey}|${key}`);
    let budget = 0;
    let budgetSource: BudgetSource = 'none';
    if (sample.selfBudget !== null) {
      budget = sample.selfBudget;
      budgetSource = 'self';
    } else if (peer !== undefined) {
      budget = peer;
      budgetSource = 'peer';
    }
    const headroom = Math.max(0, COOLDOWN_UTILIZATION - sample.utilization);
    windows[key] = {
      utilization: sample.utilization,
      resetsAt: sample.resetsAt,
      usedCost: sample.usedCost,
      budget,
      remaining: (budget * headroom) / COOLDOWN_UTILIZATION,
      budgetSource,
    };
  }

  const createdAt = parseTime(draft.account.created_at);
  const expiresAt = createdAt === null ? null : createdAt + ACCOUNT_LIFETIME_DAYS * DAY_MS;
  return {
    id: draft.account.id,
    name: draft.account.name,
    planLabel: draft.planLabel,
    windows,
    expiresAt,
    ...classify(draft.account, windows, now, expiresAt),
  };
}

function classify(
  account: ApiAccount,
  windows: Record<UsageWindowKey, WindowForecast>,
  now: number,
  expiresAt: number | null,
): Classification {
  const tempUntil = parseTime(account.temp_unschedulable_until);
  const tempActive = tempUntil !== null && tempUntil > now;
  const reason = account.temp_unschedulable_reason ?? '';

  if (expiresAt !== null && expiresAt <= now) {
    return unpredictable(`已满 ${ACCOUNT_LIFETIME_DAYS} 天`);
  }
  if (account.status === 'error') {
    return unpredictable('错误');
  }
  if (
    account.proxy?.fault ||
    (tempActive && reason.trimStart().startsWith(PROXY_FAULT_REASON_PREFIX))
  ) {
    return unpredictable('代理故障');
  }
  if (isFuture(account.rate_limit_reset_at, now)) {
    return unpredictable('限流中');
  }
  if (isFuture(account.overload_until, now)) {
    return unpredictable('过载中');
  }
  // 停用 / 手动暂停的账号即使临时冷却结束也不会恢复调度
  if (account.status !== 'active') {
    return unpredictable(STATUS_LABELS[account.status] ?? account.status);
  }
  if (!account.schedulable) {
    return unpredictable('暂停调度');
  }
  if (tempActive) {
    return cooling(windows, tempUntil, isDailyCostCap(reason) ? '日费用上限' : '临时不可调度');
  }
  if (isQuotaExceeded(account)) {
    return unpredictable('额度超限');
  }
  if (WINDOW_KEYS.some((key) => windows[key].utilization >= COOLDOWN_UTILIZATION)) {
    // 后端状态还没刷新，但按 90% 规则已经不可调度
    return cooling(windows, null, '临时不可调度');
  }
  return { state: 'available', label: '正常', recoverAt: now, blockedBy: [] };
}

/** 恢复时间取所有阻塞条件里最晚的：7d 冷却时，5h 先恢复也不能调度 */
function cooling(
  windows: Record<UsageWindowKey, WindowForecast>,
  tempUntil: number | null,
  label: string,
): Classification {
  const blocked = WINDOW_KEYS.filter((key) => windows[key].utilization >= COOLDOWN_UTILIZATION);
  let recoverAt = tempUntil;
  for (const key of blocked) {
    const resetsAt = windows[key].resetsAt;
    if (resetsAt === null) {
      // 重置时间未知时只能信任后端给的冷却截止时间
      if (tempUntil === null) {
        return unpredictable('冷却时间未知');
      }
      continue;
    }
    recoverAt = Math.max(recoverAt ?? resetsAt, resetsAt);
  }
  if (recoverAt === null) {
    return unpredictable('冷却时间未知');
  }
  return {
    state: 'cooling',
    label,
    recoverAt,
    blockedBy: blocked.length > 0 ? blocked : ['temp'],
  };
}

function unpredictable(label: string): Classification {
  return { state: 'unpredictable', label, recoverAt: null, blockedBy: [] };
}

function summarize(
  forecasts: AccountForecast[],
  now: number,
  horizonHours: readonly number[],
): ForecastResult {
  const unpredictableByLabel: Record<string, number> = {};
  for (const forecast of forecasts) {
    if (forecast.state === 'unpredictable') {
      unpredictableByLabel[forecast.label] = (unpredictableByLabel[forecast.label] ?? 0) + 1;
    }
  }
  const count = (state: AccountForecastState) =>
    forecasts.filter((forecast) => forecast.state === state).length;

  const coolingAccounts = forecasts.filter((forecast) => forecast.state === 'cooling');
  const horizons: HorizonForecast[] = [];
  let previousAt = now;
  for (const hours of horizonHours) {
    const at = now + hours * HOUR_MS;
    horizons.push(forecastHorizon(forecasts, coolingAccounts, hours, at, previousAt));
    previousAt = at;
  }

  const lastAt = horizons.at(-1)?.at ?? now;
  const beyond = coolingAccounts.filter(
    (forecast) => recoversBeforeExpiry(forecast) && (forecast.recoverAt ?? 0) > lastAt,
  );
  // 只统计还会被调度的账号；恢复前就到期的单独计入 neverRecover
  const expiring = forecasts
    .filter((forecast) => recoversBeforeExpiry(forecast) && forecast.expiresAt !== null)
    .map((forecast) => forecast.expiresAt as number);
  const predictable = forecasts.filter((forecast) => forecast.state !== 'unpredictable');
  const usesSource = (forecast: AccountForecast, source: BudgetSource) =>
    WINDOW_KEYS.some((key) => forecast.windows[key].budgetSource === source);

  return {
    generatedAt: now,
    totals: {
      all: forecasts.length,
      available: count('available'),
      cooling: coolingAccounts.length,
      unpredictable: count('unpredictable'),
      unpredictableByLabel,
    },
    horizons,
    weekly: weeklyQuota(forecasts, now, lastAt),
    coolingBeyond: {
      count: beyond.length,
      earliestRecoverAt: beyond.length
        ? Math.min(...beyond.map((forecast) => forecast.recoverAt ?? Number.POSITIVE_INFINITY))
        : null,
    },
    expiry: {
      lifetimeDays: ACCOUNT_LIFETIME_DAYS,
      inHorizon: forecasts.filter(
        (forecast) =>
          recoversBeforeExpiry(forecast) &&
          forecast.expiresAt !== null &&
          forecast.expiresAt <= lastAt,
      ).length,
      nextAt: expiring.length ? Math.min(...expiring) : null,
      neverRecover: coolingAccounts.filter((forecast) => !recoversBeforeExpiry(forecast)).length,
    },
    peerEstimatedAccounts: predictable.filter((forecast) => usesSource(forecast, 'peer')).length,
    noSampleAccounts: predictable.filter((forecast) => usesSource(forecast, 'none')).length,
  };
}

function forecastHorizon(
  forecasts: AccountForecast[],
  coolingAccounts: AccountForecast[],
  hours: number,
  at: number,
  previousAt: number,
): HorizonForecast {
  let availableAccounts = 0;
  let quota5h = 0;
  const plans = new Map<string, PlanBreakdown>();
  for (const forecast of forecasts) {
    if (!isAvailableAt(forecast, at)) {
      continue;
    }
    const quota = quotaAt(forecast, at).quota5h;
    availableAccounts += 1;
    quota5h += quota;
    addToPlan(plans, forecast.planLabel, quota);
  }

  // 可用账号数 = 现有可用 + 累计恢复 - 累计到期
  const reached = forecasts.filter(
    (forecast) => recoversBeforeExpiry(forecast) && isReadyAt(forecast, at),
  );
  const newlyRecovered: RecoveryItem[] = coolingAccounts
    .filter(
      (forecast) =>
        recoversBeforeExpiry(forecast) &&
        forecast.recoverAt !== null &&
        forecast.recoverAt > previousAt &&
        forecast.recoverAt <= at,
    )
    .sort((left, right) => (left.recoverAt ?? 0) - (right.recoverAt ?? 0))
    .map((forecast) => {
      const recoverAt = forecast.recoverAt ?? at;
      return {
        id: forecast.id,
        name: forecast.name,
        planLabel: forecast.planLabel,
        blockedBy: forecast.blockedBy,
        recoverAt,
        ...quotaAt(forecast, recoverAt),
      };
    });
  const newlyExpired: ExpiryItem[] = forecasts
    .filter(
      (forecast) =>
        recoversBeforeExpiry(forecast) &&
        forecast.expiresAt !== null &&
        forecast.expiresAt > previousAt &&
        forecast.expiresAt <= at,
    )
    .sort((left, right) => (left.expiresAt ?? 0) - (right.expiresAt ?? 0))
    .map((forecast) => {
      const expiresAt = forecast.expiresAt ?? at;
      return {
        id: forecast.id,
        name: forecast.name,
        planLabel: forecast.planLabel,
        expiresAt,
        quota5h: quotaAt(forecast, expiresAt).quota5h,
      };
    });

  const recoveredSinceNow = reached.filter((forecast) => forecast.state === 'cooling').length;
  return {
    hours,
    at,
    availableAccounts,
    stillCooling: coolingAccounts.length - recoveredSinceNow,
    recoveredSinceNow,
    expiredSinceNow: reached.filter((forecast) => !isAliveAt(forecast, at)).length,
    byPlan: sortPlans(plans),
    quota5h,
    newlyRecovered,
    newlyExpired,
  };
}

/**
 * 本周剩余按所有可预估账号（含冷却中）的 7d 剩余累加，冷却账号恢复不会改变它；
 * 只有 7d 窗口重置才会让额度回到满额，单独统计预测时间内的重置增量。
 */
function weeklyQuota(forecasts: AccountForecast[], now: number, until: number): WeeklyQuota {
  const plans = new Map<string, PlanBreakdown>();
  let remaining = 0;
  let accounts = 0;
  let resetAccounts = 0;
  let gain = 0;
  for (const forecast of forecasts) {
    if (!recoversBeforeExpiry(forecast)) {
      continue;
    }
    const window = forecast.windows['7d'];
    const current = window.resetsAt !== null && window.resetsAt <= now ? window.budget : window.remaining;
    accounts += 1;
    remaining += current;
    addToPlan(plans, forecast.planLabel, current);
    if (
      window.resetsAt !== null &&
      window.resetsAt > now &&
      window.resetsAt <= until &&
      isAliveAt(forecast, window.resetsAt)
    ) {
      resetAccounts += 1;
      gain += Math.max(0, window.budget - current);
    }
  }
  return {
    remaining,
    accounts,
    byPlan: sortPlans(plans),
    resetsInHorizon: { accounts: resetAccounts, gain },
  };
}

function addToPlan(plans: Map<string, PlanBreakdown>, planLabel: string, quota: number): void {
  const plan = plans.get(planLabel) ?? { planLabel, accounts: 0, quota: 0 };
  plan.accounts += 1;
  plan.quota += quota;
  plans.set(planLabel, plan);
}

function sortPlans(plans: Map<string, PlanBreakdown>): PlanBreakdown[] {
  return [...plans.values()].sort((left, right) => left.planLabel.localeCompare(right.planLabel));
}

function isAvailableAt(forecast: AccountForecast, at: number): boolean {
  return recoversBeforeExpiry(forecast) && isReadyAt(forecast, at) && isAliveAt(forecast, at);
}

/** 不考虑存活期限时，该时间点是否已经可调度 */
function isReadyAt(forecast: AccountForecast, at: number): boolean {
  if (forecast.state === 'available') {
    return true;
  }
  return forecast.state === 'cooling' && forecast.recoverAt !== null && forecast.recoverAt <= at;
}

function isAliveAt(forecast: AccountForecast, at: number): boolean {
  return forecast.expiresAt === null || at < forecast.expiresAt;
}

/** 可用账号，或在存活满 30 天之前能结束冷却的账号 */
function recoversBeforeExpiry(forecast: AccountForecast): boolean {
  if (forecast.state === 'available') {
    return true;
  }
  return (
    forecast.state === 'cooling' &&
    forecast.recoverAt !== null &&
    (forecast.expiresAt === null || forecast.recoverAt < forecast.expiresAt)
  );
}

/** 不计未来消耗：窗口在 at 之前重置则拿到完整新额度，否则沿用当前窗口剩余 */
function quotaAt(forecast: AccountForecast, at: number): { quota5h: number; quota7d: number } {
  const valueAt = (window: WindowForecast) =>
    window.resetsAt !== null && window.resetsAt <= at ? window.budget : window.remaining;
  const sevenDay = forecast.windows['7d'];
  const quota7d = valueAt(sevenDay);
  const quota5h = valueAt(forecast.windows['5h']);
  // 5h 能用的金额不会超过 7d 剩余；7d 完全没有样本时不做约束，避免误压成 0
  return {
    quota5h: sevenDay.budgetSource === 'none' ? quota5h : Math.min(quota5h, quota7d),
    quota7d,
  };
}

function isDailyCostCap(reason: string): boolean {
  try {
    const parsed = JSON.parse(reason) as { source?: unknown } | null;
    return parsed?.source === DAILY_COST_CAP_SOURCE;
  } catch {
    return false;
  }
}

function isQuotaExceeded(account: ApiAccount): boolean {
  const reached = (used: number | undefined, limit: number | undefined) =>
    typeof limit === 'number' && limit > 0 && typeof used === 'number' && used >= limit;
  return (
    reached(account.quota_used, account.quota_limit) ||
    reached(account.quota_daily_used, account.quota_daily_limit) ||
    reached(account.quota_weekly_used, account.quota_weekly_limit)
  );
}

function isFuture(value: string | null | undefined, now: number): boolean {
  const time = parseTime(value);
  return time !== null && time > now;
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
