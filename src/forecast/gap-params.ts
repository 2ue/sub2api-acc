import type { DemandSource, Lookback } from './gap';

/**
 * 断档分析页的条件与 URL 参数一一对应，可以收藏或分享链接直接打开同样的条件：
 *
 *   lookback  统计区间：72 / yesterday / 24 / 12 / 8 / 6（小时）        默认 72
 *   source    需求来源：history（同时段）/ recent（平均）/ manual（手动）   默认 history
 *   manual    手动需求（$/h），source=manual 时生效                        默认最近 6h 平均
 *   x         需求倍数：0.1 ~ 20，可以是按钮之外的值（如 1.3）              默认 1
 *   hours     分析时长：24 / 48 / 72 / 120 / 168                         默认 72
 *   safety    预警线（可调度账号数）：0 ~ 500                              默认 3
 *
 * 例：options.html 同级的 gap.html?lookback=yesterday&x=1.5&hours=168
 */
export interface GapPageState {
  source: DemandSource;
  lookback: Lookback;
  /** 0 表示未设定，加载数据后取最近 6h 平均 */
  manualPerHour: number;
  multiplier: number;
  hours: number;
  safetyAccounts: number;
}

export const LOOKBACKS: readonly Lookback[] = [72, 'yesterday', 24, 12, 8, 6];
export const HORIZONS = [24, 48, 72, 120, 168] as const;
export const SOURCES: readonly DemandSource[] = ['history', 'recent', 'manual'];
export const MULTIPLIER_RANGE = { min: 0.1, max: 20 } as const;

export const DEFAULT_STATE: GapPageState = {
  source: 'history',
  lookback: 72,
  manualPerHour: 0,
  multiplier: 1,
  hours: 72,
  safetyAccounts: 3,
};

/** 解析 URL 参数；非法或缺失的值回退到默认值，不会让页面报错 */
export function parseGapParams(search: string): GapPageState {
  const params = new URLSearchParams(search);
  const state: GapPageState = { ...DEFAULT_STATE };

  const lookback = params.get('lookback');
  if (lookback === 'yesterday') {
    state.lookback = 'yesterday';
  } else if (lookback !== null) {
    const hours = Number(lookback);
    if (LOOKBACKS.includes(hours)) {
      state.lookback = hours;
    }
  }

  const source = params.get('source');
  if (source && (SOURCES as readonly string[]).includes(source)) {
    state.source = source as DemandSource;
  }

  const manual = Number(params.get('manual'));
  if (params.has('manual') && Number.isFinite(manual) && manual > 0) {
    state.manualPerHour = Math.round(manual * 100) / 100;
  }

  const multiplier = Number(params.get('x'));
  if (params.has('x') && Number.isFinite(multiplier)) {
    state.multiplier = clamp(Math.round(multiplier * 100) / 100, MULTIPLIER_RANGE.min, MULTIPLIER_RANGE.max);
  }

  const hours = Number(params.get('hours'));
  if ((HORIZONS as readonly number[]).includes(hours)) {
    state.hours = hours;
  }

  const safety = Number(params.get('safety'));
  if (params.has('safety') && Number.isInteger(safety) && safety >= 0 && safety <= 500) {
    state.safetyAccounts = safety;
  }
  return state;
}

/** 只写与默认值不同的参数，链接保持简短 */
export function serializeGapParams(state: GapPageState): string {
  const params = new URLSearchParams();
  if (state.lookback !== DEFAULT_STATE.lookback) {
    params.set('lookback', String(state.lookback));
  }
  if (state.source !== DEFAULT_STATE.source) {
    params.set('source', state.source);
  }
  if (state.source === 'manual' && state.manualPerHour > 0) {
    params.set('manual', String(state.manualPerHour));
  }
  if (state.multiplier !== DEFAULT_STATE.multiplier) {
    params.set('x', String(state.multiplier));
  }
  if (state.hours !== DEFAULT_STATE.hours) {
    params.set('hours', String(state.hours));
  }
  if (state.safetyAccounts !== DEFAULT_STATE.safetyAccounts) {
    params.set('safety', String(state.safetyAccounts));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
