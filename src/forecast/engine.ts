import type {
  AccountForecast,
  AccountForecastState,
  ApiAccount,
  ApiAccountExtra,
  ApiAccountUsage,
  ApiUsageWindow,
  BudgetSource,
  DepletionItem,
  ExpiryItem,
  ForecastMode,
  ForecastResult,
  HorizonForecast,
  PlanBreakdown,
  Range,
  RecoveryItem,
  RollingQuota,
  UsageWindowKey,
  WindowForecast,
} from './types';

export const FORECAST_HORIZON_HOURS = [0, 1, 2, 3, 5, 24, 48, 72] as const;
/** 5h / 7d 任一进度条达到该值即进入冷却（7d F 不参与） */
export const COOLDOWN_UTILIZATION = 90;
/** 利用率低于该值（即为 0）或周期消耗为 0 时无法自估，改用同套餐已用满账号抽样 */
export const MIN_SAMPLE_UTILIZATION = 1;
/** 接口利用率取整到整数，真实值在 ±0.5 个百分点内，估算结果按此给出范围 */
export const UTILIZATION_PRECISION = 0.5;
/** 账号从创建开始最多存活 30 天，之后不再可用 */
export const ACCOUNT_LIFETIME_DAYS = 30;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const WINDOW_MS: Record<UsageWindowKey, number> = { '5h': 5 * HOUR_MS, '7d': 7 * DAY_MS };
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
const ZERO: Range = { min: 0, max: 0 };

export interface ForecastOptions {
  mode?: ForecastMode;
  horizonHours?: readonly number[];
  /** 抽样用的随机数，测试时注入以保证结果稳定 */
  random?: () => number;
}

interface WindowSample {
  /** 当前窗口利用率；窗口已过重置时间则为 0 */
  utilization: number;
  /** 当前窗口重置时间；已重置或未知为 null */
  resetsAt: number | null;
  usedCost: number;
  /** 由该窗口已用金额推出的完整窗口额度；样本不足为 null */
  selfBudget: Range | null;
  /** 已跑到冷却线，可作为同套餐抽样的参照 */
  saturated: boolean;
}

interface AccountDraft {
  account: ApiAccount;
  planKey: string;
  planLabel: string;
  samples: Record<UsageWindowKey, WindowSample>;
}

interface PeerSample {
  id: number;
  budget: Range;
}

/** 最快用完模拟结果：每个 5h 窗口开启时立即用满，记录每笔消耗和 7d 用完的冷却区间 */
interface DepletionTrack {
  spends: Array<{ at: number; amount: number }>;
  /**
   * 可用的 7d 额度：起点时的当前剩余，以及每次 7d 窗口重置后的完整新额度（reset = true）。
   * 累计消耗永远不会超过已发放的额度之和。
   */
  grants: Array<{ at: number; amount: number; reset: boolean }>;
  /** 7d 剩余用完后的冷却区间 [from, until)，until 为该账号 7d 窗口重置时间 */
  depletions: Array<{ from: number; until: number }>;
}

interface AccountTracks {
  /** 额度取下限 / 上限两种估算 */
  min: DepletionTrack;
  max: DepletionTrack;
}

type Classification = Pick<AccountForecast, 'state' | 'label' | 'recoverAt' | 'blockedBy'>;

export function computeForecast(
  accounts: ApiAccount[],
  usage: Record<string, ApiAccountUsage | undefined>,
  now: number,
  options: ForecastOptions = {},
): ForecastResult {
  const mode = options.mode ?? 'snapshot';
  const horizonHours = options.horizonHours ?? FORECAST_HORIZON_HOURS;
  const random = options.random ?? Math.random;
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

  const peers = collectPeers(drafts);
  const forecasts = drafts.map((draft) => buildAccountForecast(draft, peers, now, random));
  return summarize(forecasts, now, horizonHours, mode);
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
  const utilization = finiteOr(window?.utilization, 0);
  const usedCost = finiteOr(window?.window_stats?.cost, 0);
  const selfBudget = window ? windowBudget(utilization, usedCost) : null;
  const saturated = selfBudget !== null && utilization >= COOLDOWN_UTILIZATION;
  if (!window || expired) {
    return { utilization: 0, resetsAt: null, usedCost: 0, selfBudget, saturated };
  }
  return { utilization, resetsAt, usedCost, selfBudget, saturated };
}

/**
 * 一个完整窗口到 90% 冷却线的额度 = 已用金额 ÷ 利用率 × 90%，窗口不完整也照用。
 * 利用率是取整值，真实值在 ±0.5% 内，所以给出范围：利用率取大时额度偏小，取小时偏大；
 * 利用率越低范围越宽。周期消耗为 0 时无法估算，返回 null 交给同套餐抽样。
 */
function windowBudget(utilization: number, usedCost: number): Range | null {
  if (usedCost <= 0 || utilization < MIN_SAMPLE_UTILIZATION) {
    return null;
  }
  return {
    min: (usedCost * COOLDOWN_UTILIZATION) / (utilization + UTILIZATION_PRECISION),
    max: (usedCost * COOLDOWN_UTILIZATION) / Math.max(utilization - UTILIZATION_PRECISION, 0.5),
  };
}

/** 同套餐、同窗口里已跑到冷却线的账号：它们的满额最接近真实值，作为无样本账号的抽样来源 */
function collectPeers(drafts: AccountDraft[]): Map<string, { saturated: PeerSample[]; any: PeerSample[] }> {
  const groups = new Map<string, { saturated: PeerSample[]; any: PeerSample[] }>();
  for (const draft of drafts) {
    for (const key of WINDOW_KEYS) {
      const sample = draft.samples[key];
      if (sample.selfBudget === null) {
        continue;
      }
      const groupKey = `${draft.planKey}|${key}`;
      const group = groups.get(groupKey) ?? { saturated: [], any: [] };
      const peer = { id: draft.account.id, budget: sample.selfBudget };
      group.any.push(peer);
      if (sample.saturated) {
        group.saturated.push(peer);
      }
      groups.set(groupKey, group);
    }
  }
  return groups;
}

function buildAccountForecast(
  draft: AccountDraft,
  peers: Map<string, { saturated: PeerSample[]; any: PeerSample[] }>,
  now: number,
  random: () => number,
): AccountForecast {
  const windows = {} as Record<UsageWindowKey, WindowForecast>;
  for (const key of WINDOW_KEYS) {
    const sample = draft.samples[key];
    let budget = ZERO;
    let budgetSource: BudgetSource = 'none';
    let peerId: number | null = null;
    if (sample.selfBudget !== null) {
      budget = sample.selfBudget;
      budgetSource = 'self';
    } else {
      // 周期消耗为 0 时无法自估：随机抽一个同套餐已用满的账号，没有用满的再退到任意有样本的账号
      const group = peers.get(`${draft.planKey}|${key}`);
      const pool = group?.saturated.length ? group.saturated : group?.any ?? [];
      const peer = pickRandom(pool.filter((item) => item.id !== draft.account.id), random);
      if (peer) {
        budget = peer.budget;
        budgetSource = 'peer';
        peerId = peer.id;
      }
    }
    windows[key] = {
      utilization: sample.utilization,
      resetsAt: sample.resetsAt,
      usedCost: sample.usedCost,
      budget,
      remaining: remainingIn(budget, sample.utilization),
      budgetSource,
      peerId,
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

/** 当前窗口到冷却线的剩余 = 满额 × (90% − 利用率) ÷ 90%，利用率同样按 ±0.5% 取范围 */
function remainingIn(budget: Range, utilization: number): Range {
  const headroom = (value: number) => Math.max(0, COOLDOWN_UTILIZATION - value) / COOLDOWN_UTILIZATION;
  if (utilization <= 0) {
    return { min: budget.min, max: budget.max };
  }
  // 已到冷却线的窗口在重置前不可再用
  if (utilization >= COOLDOWN_UTILIZATION) {
    return { min: 0, max: 0 };
  }
  return {
    min: budget.min * headroom(utilization + UTILIZATION_PRECISION),
    max: budget.max * headroom(Math.max(0, utilization - UTILIZATION_PRECISION)),
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

/**
 * 最快用完：从账号可调度时起满负荷使用，每个 5h 窗口一开启就用满。
 * - 每个 5h 窗口最多用 min(该窗口剩余, 7d 剩余)，同时扣减 7d 剩余，所以一个 7d 内的 5h 额度合计不会超过 7d；
 * - 7d 剩余用完后进入 7d 冷却，直到该账号自己的 7d 窗口重置（滚动窗口，各账号独立计时），重置后按满额继续，
 *   预测期内可能多次用完；
 * - 存活满 30 天即停止。
 */
function simulateDepletion(forecast: AccountForecast, until: number, bound: keyof Range): DepletionTrack {
  const track: DepletionTrack = { spends: [], grants: [], depletions: [] };
  const fiveHour = forecast.windows['5h'];
  const sevenDay = forecast.windows['7d'];
  const start = forecast.recoverAt;
  const stop = Math.min(until, forecast.expiresAt ?? Number.POSITIVE_INFINITY);
  const fiveBudget = fiveHour.budget[bound];
  const sevenBudget = sevenDay.budget[bound];
  if (start === null || start >= stop || fiveBudget <= 0) {
    return track;
  }
  // 7d 完全没有样本时只按 5h 轮次推进，不做 7d 约束
  const sevenKnown = sevenDay.budgetSource !== 'none';

  // 起点时窗口仍未重置则沿用当前剩余；冷却恢复的账号，阻塞它的窗口在起点已重置
  const fiveActive = fiveHour.resetsAt !== null && fiveHour.resetsAt > start;
  let fiveLeft = fiveActive ? fiveHour.remaining[bound] : fiveBudget;
  let fiveEnd = fiveActive ? (fiveHour.resetsAt as number) : start + WINDOW_MS['5h'];
  const sevenActive = sevenDay.resetsAt !== null && sevenDay.resetsAt > start;
  let sevenLeft = sevenActive ? sevenDay.remaining[bound] : sevenBudget;
  // 新的 7d 窗口从首次使用开始计时
  let sevenEnd = sevenActive ? (sevenDay.resetsAt as number) : start + WINDOW_MS['7d'];
  if (sevenKnown) {
    // 起点前 7d 已在预测期内重置（如 7d 冷却到期恢复），这份满额也算重置新增
    track.grants.push({ at: start, amount: sevenLeft, reset: !sevenActive && sevenDay.resetsAt !== null });
  }

  let cursor = start;
  // 3 天内最多十几个 5h 窗口，上限只防异常数据
  for (let guard = 0; guard < 1000 && cursor < stop; guard += 1) {
    const amount = sevenKnown ? Math.min(fiveLeft, sevenLeft) : fiveLeft;
    if (amount > 0) {
      track.spends.push({ at: cursor, amount });
      if (!sevenKnown) {
        // 没有 7d 样本时不设上限，额度记为实际消耗
        track.grants.push({ at: cursor, amount, reset: false });
      }
      fiveLeft -= amount;
      sevenLeft -= amount;
    }
    if (sevenKnown && sevenLeft <= 1e-9) {
      track.depletions.push({ from: cursor, until: sevenEnd });
      if (sevenEnd >= stop) {
        break;
      }
      cursor = sevenEnd;
      sevenLeft = sevenBudget;
      track.grants.push({ at: cursor, amount: sevenBudget, reset: true });
      sevenEnd = cursor + WINDOW_MS['7d'];
      fiveLeft = fiveBudget;
      fiveEnd = cursor + WINDOW_MS['5h'];
      continue;
    }
    // 下一个 5h 窗口紧接着开启
    cursor = fiveEnd;
    if (cursor >= stop) {
      break;
    }
    fiveLeft = fiveBudget;
    fiveEnd = cursor + WINDOW_MS['5h'];
    if (sevenKnown && cursor >= sevenEnd) {
      // 7d 没用完也会按时重置：旧窗口剩余作废，按新的满额继续
      track.grants.push({ at: sevenEnd, amount: sevenBudget, reset: true });
      sevenLeft = sevenBudget;
      sevenEnd = cursor + WINDOW_MS['7d'];
    }
  }
  return track;
}

/** 截至 at 累计用掉的金额（窗口开启时一次用满，所以是阶梯值） */
function usedBy(track: DepletionTrack, at: number): number {
  let used = 0;
  for (const spend of track.spends) {
    if (spend.at > at) {
      break;
    }
    used += spend.amount;
  }
  return used;
}

/** 截至 at 已发放的 7d 额度，即累计消耗的上限 */
function grantedBy(track: DepletionTrack, at: number): number {
  return track.grants.reduce((sum, grant) => (grant.at <= at ? sum + grant.amount : sum), 0);
}

/** 两种估算的结果合成范围（偏小 / 偏大的估算不一定对应数值的大小） */
function pairRange(pair: AccountTracks, pick: (track: DepletionTrack) => number): Range {
  const low = pick(pair.min);
  const high = pick(pair.max);
  return { min: Math.min(low, high), max: Math.max(low, high) };
}

/** 该时间点是否因 7d 用完而处于冷却 */
function isDepletedAt(track: DepletionTrack, at: number): boolean {
  return track.depletions.some((interval) => at >= interval.from && at < interval.until);
}

function summarize(
  forecasts: AccountForecast[],
  now: number,
  horizonHours: readonly number[],
  mode: ForecastMode,
): ForecastResult {
  const unpredictableByLabel: Record<string, number> = {};
  for (const forecast of forecasts) {
    if (forecast.state === 'unpredictable') {
      unpredictableByLabel[forecast.label] = (unpredictableByLabel[forecast.label] ?? 0) + 1;
    }
  }
  const count = (state: AccountForecastState) =>
    forecasts.filter((forecast) => forecast.state === state).length;

  const lastAt = now + (horizonHours.at(-1) ?? 0) * HOUR_MS;
  const tracks = new Map<number, AccountTracks>();
  if (mode === 'depletion') {
    for (const forecast of forecasts) {
      if (recoversBeforeExpiry(forecast)) {
        tracks.set(forecast.id, {
          min: simulateDepletion(forecast, lastAt, 'min'),
          max: simulateDepletion(forecast, lastAt, 'max'),
        });
      }
    }
  }

  const coolingAccounts = forecasts.filter((forecast) => forecast.state === 'cooling');
  const horizons: HorizonForecast[] = [];
  let previousAt = now;
  for (const hours of horizonHours) {
    const at = now + hours * HOUR_MS;
    horizons.push(forecastHorizon(forecasts, coolingAccounts, tracks, mode, hours, at, previousAt));
    previousAt = at;
  }

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
  const trackList = [...tracks.values()];

  return {
    generatedAt: now,
    mode,
    totals: {
      all: forecasts.length,
      available: count('available'),
      cooling: coolingAccounts.length,
      unpredictable: count('unpredictable'),
      unpredictableByLabel,
    },
    horizons,
    rolling7d: mode === 'depletion' ? rollingMaxUsable(forecasts, tracks, lastAt) : rollingQuota(forecasts, now, lastAt),
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
    depletedAccounts: {
      min: trackList.filter((pair) => pair.min.depletions.length > 0 && pair.max.depletions.length > 0).length,
      max: trackList.filter((pair) => pair.min.depletions.length > 0 || pair.max.depletions.length > 0).length,
    },
    utilizationPrecision: UTILIZATION_PRECISION,
    peerEstimatedAccounts: predictable.filter((forecast) => usesSource(forecast, 'peer')).length,
    noSampleAccounts: predictable.filter((forecast) => usesSource(forecast, 'none')).length,
  };
}

function forecastHorizon(
  forecasts: AccountForecast[],
  coolingAccounts: AccountForecast[],
  tracks: Map<number, AccountTracks>,
  mode: ForecastMode,
  hours: number,
  at: number,
  previousAt: number,
): HorizonForecast {
  const available: Range = { min: 0, max: 0 };
  const quota: Range = { min: 0, max: 0 };
  const cap7d: Range = { min: 0, max: 0 };
  const depletedNow: Range = { min: 0, max: 0 };
  const plans = new Map<string, PlanBreakdown>();
  for (const forecast of forecasts) {
    const pair = mode === 'depletion' ? tracks.get(forecast.id) : undefined;
    const ready = isAvailableAt(forecast, at);
    if (pair) {
      // 累计口径：到期 / 7d 用完之前用掉的也算，所以不要求该时间点仍可用
      const used = pairRange(pair, (track) => usedBy(track, at));
      addRange(cap7d, pairRange(pair, (track) => grantedBy(track, at)));
      const outLow = isDepletedAt(pair.min, at);
      const outHigh = isDepletedAt(pair.max, at);
      const accounts = {
        min: ready && !outLow && !outHigh ? 1 : 0,
        max: ready && (!outLow || !outHigh) ? 1 : 0,
      };
      if (ready) {
        depletedNow.min += outLow && outHigh ? 1 : 0;
        depletedNow.max += outLow || outHigh ? 1 : 0;
      }
      addRange(available, accounts);
      addRange(quota, used);
      if (accounts.max > 0 || used.max > 0) {
        addToPlan(plans, forecast.planLabel, accounts, used);
      }
      continue;
    }
    if (!ready) {
      continue;
    }
    const value = quotaAt(forecast, at).quota5h;
    addRange(available, { min: 1, max: 1 });
    addRange(quota, value);
    addToPlan(plans, forecast.planLabel, { min: 1, max: 1 }, value);
  }

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

  const newlyDepleted: DepletionItem[] = [];
  const newlyRestored: DepletionItem[] = [];
  for (const forecast of forecasts) {
    const pair = tracks.get(forecast.id);
    if (!pair) {
      continue;
    }
    // 两种估算的第 k 次用完一一对应：先用完的作为时间点，另一种作为范围的另一端
    const count = Math.max(pair.min.depletions.length, pair.max.depletions.length);
    for (let index = 0; index < count; index += 1) {
      const candidates = [pair.min.depletions[index], pair.max.depletions[index]].filter(
        (interval): interval is { from: number; until: number } => interval !== undefined,
      );
      const first = candidates.reduce((left, right) => (right.from < left.from ? right : left));
      const other = candidates.length > 1 ? candidates.find((interval) => interval !== first) ?? null : null;
      const item = {
        id: forecast.id,
        name: forecast.name,
        planLabel: forecast.planLabel,
        depletedAt: first.from,
        latestAt: other?.from ?? null,
        until: first.until,
      };
      if (first.from > previousAt && first.from <= at && isAliveAt(forecast, first.from)) {
        newlyDepleted.push(item);
      }
      if (first.until > previousAt && first.until <= at && isAliveAt(forecast, first.until)) {
        newlyRestored.push(item);
      }
    }
  }
  newlyDepleted.sort((left, right) => left.depletedAt - right.depletedAt);
  newlyRestored.sort((left, right) => left.until - right.until);

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

  return {
    hours,
    at,
    availableAccounts: available,
    recoveredSinceNow: reached.filter((forecast) => forecast.state === 'cooling').length,
    depletedNow,
    expiredSinceNow: reached.filter((forecast) => !isAliveAt(forecast, at)).length,
    byPlan: sortPlans(plans),
    quota,
    cap7d: mode === 'depletion' ? cap7d : null,
    newlyRecovered,
    newlyDepleted,
    newlyRestored,
    newlyExpired,
  };
}

/**
 * 7d 是各账号独立滚动的窗口：按所有可预估账号（含冷却中）当前 7d 窗口剩余累加，冷却账号恢复不会改变它；
 * 只有 7d 窗口重置才会让额度回到满额，单独统计预测时间内的重置增量。
 */
function rollingQuota(forecasts: AccountForecast[], now: number, until: number): RollingQuota {
  const plans = new Map<string, PlanBreakdown>();
  const remaining: Range = { min: 0, max: 0 };
  const gain: Range = { min: 0, max: 0 };
  let accounts = 0;
  let resetAccounts = 0;
  for (const forecast of forecasts) {
    if (!recoversBeforeExpiry(forecast)) {
      continue;
    }
    const window = forecast.windows['7d'];
    const current = window.resetsAt !== null && window.resetsAt <= now ? window.budget : window.remaining;
    accounts += 1;
    addRange(remaining, current);
    addToPlan(plans, forecast.planLabel, { min: 1, max: 1 }, current);
    if (
      window.resetsAt !== null &&
      window.resetsAt > now &&
      window.resetsAt <= until &&
      isAliveAt(forecast, window.resetsAt)
    ) {
      resetAccounts += 1;
      addRange(gain, {
        min: Math.max(0, window.budget.min - current.min),
        max: Math.max(0, window.budget.max - current.max),
      });
    }
  }
  return {
    accounts,
    remaining,
    resetsInHorizon: { accounts: resetAccounts, gain },
    maxUsable: null,
    byPlan: sortPlans(plans),
  };
}

/**
 * 最快用完下的 7d 最多可用：预测期内每个能被调度的账号，当前 7d 剩余 + 每次 7d 重置后的完整新额度。
 * 7d 是滚动窗口，预测期内重置的账号会多出一整份 7d，所以它可以大于当前剩余之和；
 * 累计额度永远不超过它，差额是 5h 轮次不够把 7d 用完的部分。
 */
function rollingMaxUsable(
  forecasts: AccountForecast[],
  tracks: Map<number, AccountTracks>,
  until: number,
): RollingQuota {
  const plans = new Map<string, PlanBreakdown>();
  const remaining: Range = { min: 0, max: 0 };
  const gain: Range = { min: 0, max: 0 };
  const maxUsable: Range = { min: 0, max: 0 };
  let accounts = 0;
  let resetAccounts = 0;
  for (const forecast of forecasts) {
    const pair = tracks.get(forecast.id);
    if (!pair || (pair.min.grants.length === 0 && pair.max.grants.length === 0)) {
      continue;
    }
    const sum = (track: DepletionTrack, reset: boolean) =>
      track.grants.reduce(
        (total, grant) => (grant.at <= until && grant.reset === reset ? total + grant.amount : total),
        0,
      );
    const current = pairRange(pair, (track) => sum(track, false));
    const resets = pairRange(pair, (track) => sum(track, true));
    const total = pairRange(pair, (track) => grantedBy(track, until));
    accounts += 1;
    addRange(remaining, current);
    addRange(gain, resets);
    addRange(maxUsable, total);
    if (resets.max > 0) {
      resetAccounts += 1;
    }
    addToPlan(plans, forecast.planLabel, { min: 1, max: 1 }, total);
  }
  return {
    accounts,
    remaining,
    resetsInHorizon: { accounts: resetAccounts, gain },
    maxUsable,
    byPlan: sortPlans(plans),
  };
}

function addRange(target: Range, value: Range): void {
  target.min += value.min;
  target.max += value.max;
}

function addToPlan(
  plans: Map<string, PlanBreakdown>,
  planLabel: string,
  accounts: Range,
  quota: Range,
): void {
  const plan = plans.get(planLabel) ?? { planLabel, accounts: { min: 0, max: 0 }, quota: { min: 0, max: 0 } };
  addRange(plan.accounts, accounts);
  addRange(plan.quota, quota);
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

/** 按时刻剩余，不计未来消耗：窗口在 at 之前重置则拿到完整新额度，否则沿用当前窗口剩余 */
function quotaAt(forecast: AccountForecast, at: number): { quota5h: Range; quota7d: Range } {
  const valueAt = (window: WindowForecast) =>
    window.resetsAt !== null && window.resetsAt <= at ? window.budget : window.remaining;
  const sevenDay = forecast.windows['7d'];
  const quota7d = valueAt(sevenDay);
  const fiveHour = valueAt(forecast.windows['5h']);
  // 5h 能用的金额不会超过 7d 剩余；7d 完全没有样本时不做约束，避免误压成 0
  const quota5h =
    sevenDay.budgetSource === 'none'
      ? fiveHour
      : { min: Math.min(fiveHour.min, quota7d.min), max: Math.min(fiveHour.max, quota7d.max) };
  return { quota5h, quota7d };
}

/** 可复现的随机数（mulberry32）：同一份数据每次重算抽到同一个参照账号，避免数字每分钟跳动 */
export function createSeededRandom(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pickRandom<T>(items: T[], random: () => number): T | undefined {
  if (items.length === 0) {
    return undefined;
  }
  const index = Math.min(items.length - 1, Math.floor(random() * items.length));
  return items[index];
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
