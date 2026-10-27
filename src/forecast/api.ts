import type { HourlyPoint } from './gap';
import type { ApiAccount, ApiAccountUsage } from './types';

// 页面前端调用的 /admin/* 在该站点实际映射到 /api/v1/manager/*
const API_BASE = '/api/v1/manager';

/**
 * 接口来源：
 * - 在 sub2api 页面里（额度预估面板）：同源请求，登录信息取页面 localStorage；
 * - 在插件独立页面里（断档分析）：请求站点完整地址，登录信息由调用方从已登录的 sub2api 标签页读取。
 */
export interface ApiSource {
  /** 站点地址；空字符串表示当前页面同源 */
  origin: string;
  /** 取登录 token；forceRefresh 为 true 时表示上次的 token 已失效，需要重新读取 */
  getToken: (forceRefresh: boolean) => Promise<string | null>;
}

const pageSource: ApiSource = {
  origin: '',
  getToken: async () => window.localStorage.getItem('auth_token'),
};
let source: ApiSource = pageSource;

export function useApiSource(next: ApiSource): void {
  source = next;
}
const PAGE_SIZE = 100;
const USAGE_BATCH_SIZE = 100;
const MAX_PAGES = 50;

interface ApiEnvelope<T> {
  code: number;
  message?: string;
  data: T;
}

interface AccountPage {
  items: ApiAccount[];
  pages: number;
}

interface UsageBatch {
  usage: Record<string, ApiAccountUsage>;
  errors?: Record<string, unknown>;
}

export interface ForecastInput {
  accounts: ApiAccount[];
  usage: Record<string, ApiAccountUsage>;
}

/** 在内容脚本里以当前登录身份读取全部账号及其 5h / 7d 用量（只读接口，force=false 不触发上游刷新） */
export async function fetchForecastInput(signal?: AbortSignal): Promise<ForecastInput> {
  const accounts: ApiAccount[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const query = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      lite: '1',
      include_scheduler_score: '0',
      sort_by: 'id',
      sort_order: 'asc',
    });
    const data = await request<AccountPage>(`/accounts?${query}`, { signal });
    accounts.push(...data.items);
    if (data.items.length === 0 || page >= data.pages) {
      break;
    }
  }

  const usage: Record<string, ApiAccountUsage> = {};
  const ids = accounts.map((account) => account.id);
  for (let start = 0; start < ids.length; start += USAGE_BATCH_SIZE) {
    const data = await request<UsageBatch>('/accounts/usage/batch', {
      method: 'POST',
      body: JSON.stringify({ account_ids: ids.slice(start, start + USAGE_BATCH_SIZE), force: false }),
      signal,
    });
    Object.assign(usage, data.usage);
  }
  return { accounts, usage };
}

interface TrendSnapshot {
  trend?: Array<{ date: string; cost?: number; actual_cost?: number }>;
}

/**
 * 站点全部账号按小时的消耗（dashboard snapshot-v2 的 trend），用于估算未来需求。
 * date 为 "YYYY-MM-DD HH:00"，按请求的时区解释。
 */
export async function fetchHourlyUsage(days: number, signal?: AbortSignal): Promise<HourlyPoint[]> {
  const today = new Date();
  const start = new Date(today.getTime() - days * 24 * 3_600_000);
  const query = new URLSearchParams({
    start_date: localDate(start),
    end_date: localDate(today),
    granularity: 'hour',
    include_stats: 'false',
    include_trend: 'true',
    include_model_stats: 'false',
    include_group_stats: 'false',
    include_users_trend: 'false',
  });
  const data = await request<TrendSnapshot>(`/dashboard/snapshot-v2?${query}`, { signal });
  const points: HourlyPoint[] = [];
  for (const item of data.trend ?? []) {
    const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2})/.exec(item.date);
    const cost = item.cost ?? item.actual_cost;
    if (!match || typeof cost !== 'number' || !Number.isFinite(cost)) {
      continue;
    }
    const [, year, month, day, hour] = match;
    points.push({ at: new Date(Number(year), Number(month) - 1, Number(day), Number(hour)).getTime(), cost });
  }
  return points;
}

function localDate(time: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())}`;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const separator = path.includes('?') ? '&' : '?';
  const url = `${source.origin}${API_BASE}${path}${separator}timezone=${encodeURIComponent(timezone)}`;
  const send = async (forceRefresh: boolean) => {
    const token = await source.getToken(forceRefresh);
    if (!token) {
      throw new Error('未找到登录信息，请先在浏览器中打开并登录 sub2api 管理后台');
    }
    return fetch(url, {
      ...init,
      credentials: source.origin ? 'include' : 'same-origin',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });
  };
  let response = await send(false);
  if (response.status === 401) {
    // 页面可能已经刷新过 token，重新读取一次再试
    response = await send(true);
  }
  if (response.status === 401) {
    throw new Error('登录已过期，请在 sub2api 页面重新登录后再刷新');
  }
  if (!response.ok) {
    throw new Error(`接口请求失败（HTTP ${response.status}）`);
  }
  const body = (await response.json()) as ApiEnvelope<T>;
  if (body.code !== 0) {
    throw new Error(body.message || '接口返回异常');
  }
  return body.data;
}
