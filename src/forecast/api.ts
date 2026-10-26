import type { ApiAccount, ApiAccountUsage } from './types';

// 页面前端调用的 /admin/* 在该站点实际映射到 /api/v1/manager/*
const API_BASE = '/api/v1/manager';
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

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const token = window.localStorage.getItem('auth_token');
  if (!token) {
    throw new Error('未找到登录信息，请先登录管理页');
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetch(
    `${API_BASE}${path}${separator}timezone=${encodeURIComponent(timezone)}`,
    {
      ...init,
      credentials: 'same-origin',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );
  if (response.status === 401) {
    throw new Error('登录已过期，请刷新管理页后重试');
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
