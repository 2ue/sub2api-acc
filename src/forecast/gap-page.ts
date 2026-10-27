import { fetchForecastInput, fetchHourlyUsage, type ForecastInput } from './api';
import { el } from './dom';
import { createSeededRandom } from './engine';
import { formatClock, formatDuration, formatMoney, formatMoneyRange, horizonSpan, joinSuffix } from './format';
import {
  analyzeGaps,
  historyDemand,
  lookbackLabel,
  manualDemand,
  peakDemand,
  recentDemand,
  type BlockReason,
  type CapacityAdvice,
  type DemandProfile,
  type DemandSource,
  type GapBucket,
  type GapResult,
  type HourlyPoint,
  type Lookback,
  type PeakRisk,
  type PeakSlot,
  type ReplenishPlan,
  type ReplenishStep,
} from './gap';
import {
  DEFAULT_STATE,
  HORIZONS,
  LOOKBACKS,
  MULTIPLIER_RANGE,
  parseGapParams,
  serializeGapParams,
  type GapPageState,
} from './gap-params';
import { SITE_ORIGIN } from './site-auth';

const PAGE_ID = 'sub2api-gap-page';
/** 拉取的历史要覆盖最长的统计区间 */
const HISTORY_FETCH_DAYS = 4;
const MULTIPLIERS = [1, 1.5, 2] as const;
/** 页面打开期间每分钟按当前时间重算一次；数据超过该时长再重新拉取接口 */
const RECOMPUTE_INTERVAL_MS = 60_000;
const REFETCH_AFTER_MS = 5 * 60_000;
const SOURCE_LABELS: Record<DemandSource, string> = {
  history: '同时段',
  recent: '平均',
  manual: '手动设定',
};
const TRIGGER_LABELS: Record<ReplenishStep['trigger'], string> = {
  outage: '断档',
  shortfall: '缺额度',
  safety: '低于预警线',
};
const LEVEL_LABELS: Record<GapBucket['level'], string> = {
  ok: '充足',
  warn: '偏紧',
  short: '有缺口',
  outage: '断档',
};
const BLOCK_LABELS: Record<BlockReason, string> = {
  '5h': '5h 冷却',
  '7d': '7d 用完',
  temp: '临时冷却',
  expired: '满 30 天',
};

/** 在插件独立页面里挂载断档分析；条件从 URL 参数读取，修改后写回 URL，可收藏或分享 */
export function mountGapPage(container: HTMLElement): GapPage {
  return new GapPage(container, parseGapParams(window.location.search));
}

export class GapPage {
  private readonly body: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly controls: HTMLElement;
  private readonly expanded = new Set<number>();
  private state: GapPageState;
  /** 扩容建议与当前倍数无关，只在需求曲线 / 时长 / 预警线 / 数据变化时重算 */
  private adviceCache: { key: string; advice: CapacityAdvice } | null = null;
  private input: (ForecastInput & { history: HourlyPoint[] }) | null = null;
  private fetchedAt = 0;
  private abort: AbortController | null = null;

  constructor(container: HTMLElement, initial: GapPageState) {
    this.state = initial;
    this.subtitle = el('p', { class: 'subtitle' }, '正在读取账号、用量与历史消耗…');
    this.refreshButton = el('button', { class: 'button secondary', type: 'button' }, '刷新数据') as HTMLButtonElement;
    const copyButton = el('button', { class: 'button secondary', type: 'button', title: '复制带当前条件的链接' }, '复制链接') as HTMLButtonElement;
    const resetButton = el('button', { class: 'button secondary', type: 'button', title: '恢复默认条件' }, '重置条件');
    const siteLink = el('a', { class: 'button secondary', href: `${SITE_ORIGIN}/manager/accounts`, target: '_blank', rel: 'noopener' }, '打开账号管理');
    this.controls = el('div', { class: 'controls', role: 'group', 'aria-label': '分析条件' });
    this.body = el('div', { class: 'page-body', role: 'region', 'aria-live': 'polite' });
    const page = el(
      'main',
      { class: 'page', id: PAGE_ID, 'aria-labelledby': `${PAGE_ID}-title` },
      el(
        'div',
        { class: 'page-inner' },
        el(
          'header',
          { class: 'page-header' },
          el(
            'div',
            {},
            el('p', { class: 'eyebrow' }, 'SUB2API FORECAST / GAP ANALYSIS'),
            el('h1', { id: `${PAGE_ID}-title` }, '断档分析'),
            this.subtitle,
          ),
          el('div', { class: 'header-actions' }, this.refreshButton, copyButton, resetButton, siteLink),
        ),
        el(
          'p',
          { class: 'intro' },
          '按需求逐段模拟未来每个时间段能消耗多少：需求按“先用 5h 快重置的账号”分配，每笔消耗同时扣 5h 和 7d，',
          el('b', {}, '5h 能用的永远不超过该账号的 7d 剩余'),
          '；5h / 7d 到 90% 即冷却，窗口从本轮首次使用起计时，重置后下一笔消耗才开启新窗口。',
        ),
        this.controls,
        this.body,
      ),
    );
    container.append(page);

    this.refreshButton.addEventListener('click', () => this.refresh());
    copyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(window.location.href);
        copyButton.textContent = '已复制';
      } catch {
        copyButton.textContent = '复制失败';
      }
      window.setTimeout(() => {
        copyButton.textContent = '复制链接';
      }, 1500);
    });
    resetButton.addEventListener('click', () => this.update({ ...DEFAULT_STATE }));
    // 浏览器前进 / 后退时按 URL 恢复条件
    window.addEventListener('popstate', () => {
      this.state = parseGapParams(window.location.search);
      this.renderControls();
      this.render();
    });
    window.setInterval(() => this.tick(), RECOMPUTE_INTERVAL_MS);
    this.renderControls();
    this.syncUrl(false);
    this.refresh();
  }

  refresh(): void {
    void this.load();
  }

  private tick(): void {
    if (document.hidden || this.abort || !this.input) {
      return;
    }
    if (Date.now() - this.fetchedAt > REFETCH_AFTER_MS) {
      void this.load();
    } else {
      this.render();
    }
  }

  /** 条件写进地址栏：刷新、收藏、分享都能还原同样的条件；不新增历史记录，避免后退时逐条回放 */
  private syncUrl(push: boolean): void {
    const query = serializeGapParams(this.state);
    const next = `${window.location.pathname}${query}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history[push ? 'pushState' : 'replaceState'](null, '', next);
    }
    document.title = `断档分析${query ? ` · ${describeState(this.state)}` : ''}`;
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.refreshButton.disabled = true;
    if (!this.input) {
      this.body.replaceChildren(el('p', { class: 'state-message', role: 'status' }, '正在读取账号、用量与历史消耗…'));
    }
    try {
      const [input, history] = await Promise.all([
        fetchForecastInput(controller.signal),
        fetchHourlyUsage(HISTORY_FETCH_DAYS, controller.signal),
      ]);
      if (controller.signal.aborted) {
        return;
      }
      this.input = { ...input, history };
      this.fetchedAt = Date.now();
      this.adviceCache = null;
      if (this.state.manualPerHour <= 0) {
        // 手动需求默认取最近 6h 平均，方便在此基础上调整；不写入 URL，只有用户改过才写
        this.state = { ...this.state, manualPerHour: Math.round(recentDemand(history, this.fetchedAt, 6).averageHourly) };
        this.renderControls();
      }
      this.render();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.body.replaceChildren(el('p', { class: 'state-message error', role: 'alert' }, `分析失败：${message}`));
    } finally {
      if (this.abort === controller) {
        this.abort = null;
        this.refreshButton.disabled = false;
      }
    }
  }

  private update(patch: Partial<GapPageState>): void {
    this.state = { ...this.state, ...patch };
    this.expanded.clear();
    this.syncUrl(false);
    this.renderControls();
    this.render();
  }

  private demandProfile(now: number): DemandProfile {
    const history = this.input?.history ?? [];
    switch (this.state.source) {
      case 'recent':
        return recentDemand(history, now, this.state.lookback);
      case 'manual':
        return manualDemand(this.state.manualPerHour);
      default:
        return historyDemand(history, now, this.state.lookback);
    }
  }

  private renderControls(): void {
    const segmented = <T extends string | number>(
      label: string,
      options: readonly T[],
      current: T,
      text: (value: T) => string,
      pick: (value: T) => void,
    ) => {
      const buttons = options.map((value) => {
        const button = el(
          'button',
          { class: 'segment', type: 'button', role: 'radio', 'aria-checked': String(value === current) },
          text(value),
        ) as HTMLButtonElement;
        button.tabIndex = value === current ? 0 : -1;
        button.addEventListener('click', () => pick(value));
        return button;
      });
      const group = el('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label }, ...buttons);
      group.addEventListener('keydown', (event) => {
        const key = (event as KeyboardEvent).key;
        if (!['ArrowLeft', 'ArrowRight'].includes(key)) {
          return;
        }
        event.preventDefault();
        const index = options.indexOf(current);
        const next = options[(index + (key === 'ArrowLeft' ? -1 : 1) + options.length) % options.length]!;
        pick(next);
        this.controls.querySelector<HTMLElement>(`[aria-label="${label}"] [aria-checked="true"]`)?.focus();
      });
      return el('div', { class: 'control' }, el('span', { class: 'control-label' }, label), group);
    };

    const manual = el('input', {
      class: 'number-input',
      type: 'number',
      min: '0',
      step: '10',
      inputmode: 'decimal',
      'aria-label': '手动需求（美元每小时）',
      value: String(this.state.manualPerHour),
    }) as HTMLInputElement;
    manual.disabled = this.state.source !== 'manual';
    manual.addEventListener('change', () => {
      const value = Number(manual.value);
      this.update({ manualPerHour: Number.isFinite(value) && value >= 0 ? value : 0 });
    });

    const multiplierInput = el('input', {
      class: 'number-input small',
      type: 'number',
      min: String(MULTIPLIER_RANGE.min),
      max: String(MULTIPLIER_RANGE.max),
      step: '0.05',
      inputmode: 'decimal',
      'aria-label': '自定义需求倍数',
      value: String(this.state.multiplier),
    }) as HTMLInputElement;
    multiplierInput.addEventListener('change', () => {
      const value = Number(multiplierInput.value);
      if (Number.isFinite(value) && value > 0) {
        const clamped = Math.min(MULTIPLIER_RANGE.max, Math.max(MULTIPLIER_RANGE.min, Math.round(value * 100) / 100));
        this.update({ multiplier: clamped });
      } else {
        multiplierInput.value = String(this.state.multiplier);
      }
    });

    const safety = el('input', {
      class: 'number-input small',
      type: 'number',
      min: '0',
      step: '1',
      inputmode: 'numeric',
      'aria-label': '预警线（可调度账号数）',
      value: String(this.state.safetyAccounts),
    }) as HTMLInputElement;
    safety.addEventListener('change', () => {
      const value = Math.round(Number(safety.value));
      this.update({ safetyAccounts: Number.isFinite(value) && value >= 0 ? value : 0 });
    });

    this.controls.replaceChildren(
      segmented('统计区间', LOOKBACKS, this.state.lookback, (value) => (value === 'yesterday' ? '昨天' : `最近 ${lookbackLabel(value)}`), (lookback) => this.update({ lookback })),
      segmented('需求来源', ['history', 'recent', 'manual'] as const, this.state.source, (value) => SOURCE_LABELS[value], (source) => this.update({ source })),
      el(
        'div',
        { class: 'control' },
        el('span', { class: 'control-label' }, '手动需求'),
        el('span', { class: 'input-with-unit' }, manual, el('span', { class: 'unit' }, '$/h')),
      ),
      segmented('需求倍数', MULTIPLIERS, this.state.multiplier as (typeof MULTIPLIERS)[number], (value) => `×${value}`, (multiplier) => this.update({ multiplier })),
      el(
        'div',
        { class: 'control' },
        el('span', { class: 'control-label' }, '自定义倍数'),
        el('span', { class: 'input-with-unit' }, el('span', { class: 'unit' }, '×'), multiplierInput),
      ),
      segmented('分析时长', HORIZONS, this.state.hours as (typeof HORIZONS)[number], (value) => spanLabel(value), (hours) => this.update({ hours })),
      el(
        'div',
        { class: 'control' },
        el('span', { class: 'control-label' }, '预警线'),
        el('span', { class: 'input-with-unit' }, safety, el('span', { class: 'unit' }, '个账号')),
      ),
    );
  }

  private render(): void {
    if (!this.input) {
      return;
    }
    const now = Date.now();
    const demand = this.demandProfile(now);
    const { source, lookback, manualPerHour, hours, safetyAccounts } = this.state;
    // 分钟级重算时建议几乎不变，按分钟取整缓存，避免每次都跑几十次模拟
    const adviceKey = [this.fetchedAt, source, lookback, source === 'manual' ? manualPerHour : '', hours, safetyAccounts, Math.floor(now / 60_000)].join('|');
    const cached = this.adviceCache?.key === adviceKey ? this.adviceCache.advice : undefined;
    const result = analyzeGaps(this.input.accounts, this.input.usage, now, demand, {
      hours,
      demandMultiplier: this.state.multiplier,
      safetyAccounts,
      advice: cached,
      peak: peakDemand(this.input.history, now, lookback),
      plan: true,
      random: createSeededRandom(this.fetchedAt),
    });
    this.adviceCache = { key: adviceKey, advice: result.advice };
    this.subtitle.textContent = `数据更新于 ${formatClock(this.fetchedAt, now)} · ${result.accounts.predictable} 个可预估账号参与模拟`;
    this.body.replaceChildren(
      renderVerdict(result, now),
      renderAdvice(result, now, (multiplier) => this.update({ multiplier })),
      renderSummary(result),
      renderPlan(result, now),
      renderPeakRisk(result, now),
      renderTimeline(result, now),
      this.renderTable(result, now),
      renderNotes(result),
    );
  }

  private renderTable(result: GapResult, now: number): HTMLElement {
    const rows: HTMLElement[] = [];
    const peakAccounts = Math.max(1, ...result.buckets.map((bucket) => bucket.avgAccounts));
    let previousDay = '';
    result.buckets.forEach((bucket, index) => {
      // 跨天时插入日期分隔行，方便按天扫读
      const day = new Date(bucket.start).toDateString();
      if (day !== previousDay) {
        previousDay = day;
        rows.push(el('tr', { class: 'day-row' }, el('th', { colspan: '7', scope: 'colgroup' }, formatDay(bucket.start, now))));
      }
      const open = this.expanded.has(index);
      const detailId = `${PAGE_ID}-detail-${index}`;
      const toggle = el(
        'button',
        { class: 'row-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': detailId },
        `${open ? '▾' : '▸'} ${formatSpan(bucket, now)}`,
      );
      toggle.addEventListener('click', () => {
        if (this.expanded.has(index)) {
          this.expanded.delete(index);
        } else {
          this.expanded.add(index);
        }
        this.render();
        this.body.querySelector<HTMLElement>(`[aria-controls="${detailId}"]`)?.focus();
      });
      rows.push(
        el(
          'tr',
          { class: `bucket-row level-${bucket.level}` },
          el('th', { scope: 'row' }, toggle),
          el('td', {}, el('span', { class: `level-badge level-${bucket.level}` }, LEVEL_LABELS[bucket.level])),
          el('td', { class: 'num' }, formatMoney(bucket.demand)),
          el('td', { class: 'num' }, formatMoneyRange(bucket.served), meter(servedRatio(bucket), `meter level-${bucket.level}`)),
          el(
            'td',
            { class: `num${bucket.shortfall.max > 0.5 ? ' negative' : ' quiet'}` },
            bucket.shortfall.max > 0.5 ? formatMoneyRange(bucket.shortfall) : '—',
          ),
          el(
            'td',
            { class: `num accounts ${accountTone(bucket, result.safetyAccounts)}` },
            el('b', {}, String(bucket.minAccounts)),
            el('span', { class: 'muted' }, ` / 均 ${bucket.avgAccounts.toFixed(1)}`),
            meter(bucket.avgAccounts / peakAccounts, 'meter accounts-meter'),
          ),
          el('td', { class: 'reason' }, ...reasonChips(bucket)),
        ),
      );
      if (open) {
        rows.push(el('tr', { class: 'detail-row', id: detailId }, el('td', { colspan: '7' }, renderBucketDetail(bucket, result))));
      }
    });
    return el(
      'section',
      { class: 'card' },
      el('h2', {}, '时间段明细'),
      el('p', { class: 'card-hint' }, '前 24h 每 1h 一段，24h~3 天每 3h 一段，之后每 6h 一段；可调度账号取段内最少值（偏小估算），点击时间段查看原因。'),
      renderLevelRules(result),
      el(
        'div',
        { class: 'table-wrap' },
        el(
          'table',
          {},
          el('caption', {}, '各时间段的需求、可消耗金额与缺口'),
          el(
            'thead',
            {},
            el(
              'tr',
              {},
              el('th', { scope: 'col' }, '时间段'),
              el('th', { scope: 'col' }, '状态'),
              el('th', { scope: 'col', class: 'num' }, '需求'),
              el('th', { scope: 'col', class: 'num' }, '可消耗'),
              el('th', { scope: 'col', class: 'num' }, '缺口'),
              el('th', { scope: 'col', class: 'num' }, '可调度账号'),
              el('th', { scope: 'col' }, '最紧张时刻不可调度原因'),
            ),
          ),
          el('tbody', {}, ...rows),
        ),
      ),
    );
  }
}

function renderVerdict(result: GapResult, now: number): HTMLElement {
  const hours = result.hours;
  const demand = `按 ${result.demand.label}${result.demand.multiplier !== 1 ? ` ×${result.demand.multiplier}` : ''}（平均 ${formatMoney(result.demand.averageHourly)}/h）`;
  let tone = 'ok';
  let headline: string;
  const details: string[] = [];
  if (result.firstOutageAt !== null) {
    tone = 'outage';
    headline = `${formatCountdownText(result.firstOutageAt - now)}（${formatClock(result.firstOutageAt, now)}）可能出现无账号可用`;
    details.push(`${spanWith(hours, '内累计断档 ')}${formatMinutesRange(result.totals.outageMinutes)}`);
  } else if (result.firstShortfallAt !== null) {
    tone = 'short';
    headline = `${formatCountdownText(result.firstShortfallAt - now)}（${formatClock(result.firstShortfallAt, now)}）开始额度跟不上需求`;
  } else {
    headline = `${spanWith(hours, '内不会断档，需求可以全部消化')}`;
  }
  if (result.totals.shortfall.max > 0.5) {
    details.push(`总缺口 ${formatMoneyRange(result.totals.shortfall)}`);
  }
  if (result.firstShortfallAt !== null && result.firstShortfallAtOptimistic !== result.firstShortfallAt) {
    details.push(
      result.firstShortfallAtOptimistic === null
        ? '按额度偏大的估算则不会出现缺口'
        : `按额度偏大的估算最早 ${formatClock(result.firstShortfallAtOptimistic, now)}`,
    );
  }
  if (result.tightest) {
    const tight = result.tightest;
    details.push(
      tight.shortfall.max > 0.5
        ? `最紧张：${formatSpan(tight, now)}，缺口 ${formatMoneyRange(tight.shortfall)}`
        : `最紧张：${formatSpan(tight, now)}，最少 ${tight.minAccounts} 个账号可调度`,
    );
  }
  return el(
    'section',
    { class: `verdict tone-${tone}`, role: 'status' },
    el('p', { class: 'verdict-demand' }, demand),
    el('p', { class: 'verdict-headline' }, headline),
    details.length > 0 && el('p', { class: 'verdict-details' }, details.join(' · ')),
  );
}

/**
 * 富余与扩容建议：以 ×1 需求为基准，反复模拟找出不缺口的最大倍数。
 * 建议倍数另外要求可调度账号不低于预警线，偏小估算并向下取整。
 */
function renderAdvice(result: GapResult, now: number, apply: (multiplier: number) => void): HTMLElement {
  const { advice, demand } = result;
  const hours = result.hours;
  const card = (body: Array<HTMLElement | string | false | null>) =>
    el('section', { class: 'card advice' }, el('h2', {}, '富余与扩容建议'), ...body.filter((item): item is HTMLElement | string => Boolean(item)));
  if (!advice.maxMultiplier || advice.suggestedMultiplier === null) {
    return card([el('p', { class: 'card-hint' }, '需求为 0 或没有可模拟的账号，无法给出扩容建议。')]);
  }
  const capped = advice.maxMultiplier.min >= advice.searchCap;
  const suggested = advice.suggestedMultiplier;
  const maxText = capped
    ? `≥ ×${advice.searchCap}`
    : advice.maxMultiplier.max - advice.maxMultiplier.min < 0.05
      ? `×${advice.maxMultiplier.min.toFixed(2)}`
      : `×${advice.maxMultiplier.min.toFixed(2)} ~ ×${advice.maxMultiplier.max.toFixed(2)}`;
  const tone = suggested >= 1.1 ? 'surplus' : advice.maxMultiplier.min >= 1 ? 'tight' : 'deficit';
  const headline =
    tone === 'surplus'
      ? `有富余：需求可以扩大到 ×${suggested.toFixed(2)}（多 ${Math.round((suggested - 1) * 100)}%）`
      : tone === 'tight'
        ? `基本持平：当前需求能消化，但余量不足 10%`
        : `供给不足：只能承载当前需求的 ${Math.round(advice.maxMultiplier.min * 100)}%`;
  const facts = [
    `以 ${demand.label}（平均 ${formatMoney(demand.baseAverageHourly)}/h，${spanWith(hours, '共 ')}${formatMoney(demand.baseTotal)}）为 ×1 基准`,
    `${spanWith(hours, '内不出现缺口的最大倍数 ')}${maxText}（偏小 ~ 偏大额度估算）`,
    `建议 ×${suggested.toFixed(2)} ≈ 平均 ${formatMoney(demand.baseAverageHourly * suggested)}/h：不缺口，且可调度账号不低于 ${advice.safetyFloor} 个`,
  ];
  if (advice.safetyFloor < result.safetyAccounts) {
    facts.push(`冷却本身就会让可调度账号降到 ${advice.safetyFloor} 个，预警线按 ${advice.safetyFloor} 计`);
  }
  if (!capped && advice.bottleneckAt !== null) {
    facts.push(`超过最大倍数后，最先在 ${formatClock(advice.bottleneckAt, now)} 出现缺口，那里是瓶颈`);
  }
  if (advice.structuralOutageAt !== null) {
    facts.push(`即使没有需求，${formatClock(advice.structuralOutageAt, now)} 起也会因冷却 / 到期没有账号可调度`);
  }
  const options = [...new Set([suggested, 1].filter((value) => value > 0))];
  return card([
    el('p', { class: `advice-headline tone-${tone}` }, headline),
    el('ul', { class: 'advice-facts' }, ...facts.map((text) => el('li', {}, text))),
    el(
      'div',
      { class: 'advice-actions' },
      ...options.map((value) => {
        const button = el(
          'button',
          { class: 'button secondary', type: 'button', 'aria-pressed': String(Math.abs(result.demand.multiplier - value) < 1e-6) },
          value === 1 ? '查看 ×1 当前需求' : `按建议 ×${value.toFixed(2)} 模拟`,
        );
        button.addEventListener('click', () => apply(value));
        return button;
      }),
    ),
  ]);
}

/**
 * 补充账号方案：需要补几个、补什么套餐、什么时候补；补充前后的可调度账号与满足比例趋势对比。
 */
function renderPlan(result: GapResult, now: number): HTMLElement {
  const plan = result.plan;
  const title = el('h2', {}, '补充账号方案');
  if (!plan) {
    return el('section', { class: 'card' }, title);
  }
  if (!plan.template) {
    return el('section', { class: 'card' }, title, el('p', { class: 'card-hint' }, '没有可参照的已用满账号，无法估算新账号的额度。'));
  }
  const hours = result.hours;
  const template = plan.template;
  const demandText = `按当前需求${result.demand.multiplier !== 1 ? ` ×${result.demand.multiplier}` : ''}（平均 ${formatMoney(result.demand.averageHourly)}/h）`;
  const headline =
    plan.accounts === 0
      ? `${demandText}，${spanWith(hours, '内不需要补充账号')}`
      : plan.resolved
        ? `${demandText}，${spanWith(hours, '内需要补充 ')}${plan.accounts} 个 ${template.planLabel} 账号，分 ${plan.steps.length} 批`
        : `${demandText}，补充 ${plan.accounts} 个 ${template.planLabel} 后仍有缺口（已达上限 ${plan.maxSteps} 个）`;
  const tone = plan.accounts === 0 ? 'ok' : plan.resolved ? 'tight' : 'deficit';
  const templateText = `新账号按 ${template.planLabel} 已用满账号的中位数估算：5h ${formatMoneyRange(template.fiveHour)}、7d ${formatMoneyRange(template.sevenDay)}（样本 ${template.samples.fiveHour} / ${template.samples.sevenDay} 个），5h / 7d 从首次使用起计时，同样受 7d 上限约束，存活 30 天。`;
  const others = plan.templates.slice(1).map((item) => {
    const alternative = plan.alternatives.find((entry) => entry.planLabel === item.planLabel);
    const need = alternative
      ? alternative.accounts === 0
        ? '，不需要补'
        : `，全部改用它要 ${alternative.accounts} 个${alternative.resolved ? '' : '（仍不足）'}`
      : '';
    return `${item.planLabel}（5h ${formatMoneyRange(item.fiveHour)}、7d ${formatMoneyRange(item.sevenDay)}${need}）`;
  });
  const firstStep = plan.steps[0];
  const stats = el(
    'div',
    { class: 'plan-stats' },
    planStat('需补充', plan.accounts > 0 ? `${plan.accounts} 个` : '0', template.planLabel, plan.accounts > 0 ? 'accent' : 'ok'),
    planStat('分几批', String(plan.steps.length), plan.steps.length ? '同一小时内到位的合并为一批' : '无需补充', 'neutral'),
    planStat(
      '最早到位',
      firstStep ? formatClock(firstStep.at, now) : '—',
      firstStep ? (firstStep.at - now < 60_000 ? '立即' : `${formatDuration(firstStep.at - now)} 后`) : '当前账号足够',
      firstStep && firstStep.at - now < 6 * 3_600_000 ? 'urgent' : 'neutral',
    ),
    planStat(
      '补充后',
      plan.resolved ? '无断档无缺口' : '仍有缺口',
      plan.resolved ? `最少 ${Math.min(...plan.buckets.map((bucket) => bucket.minAccounts))} 个账号可调度` : `已达上限 ${plan.maxSteps} 个`,
      plan.resolved ? 'ok' : 'bad',
    ),
  );
  return el(
    'section',
    { class: `card plan tone-${tone}` },
    title,
    el('p', { class: `advice-headline tone-${tone === 'ok' ? 'surplus' : tone}` }, headline),
    stats,
    el('p', { class: 'card-hint' }, templateText, others.length ? ` 其它套餐：${others.join('；')}。` : ''),
    plan.accounts > 0 && renderPlanSteps(plan, now),
    plan.accounts > 0 && renderPlanComparison(result, plan),
    renderTrendChart(result, plan, now),
  );
}

function planStat(label: string, value: string, detail: string, tone: string): HTMLElement {
  return el(
    'div',
    { class: `plan-stat tone-${tone}` },
    el('span', { class: 'plan-stat-label' }, label),
    el('span', { class: 'plan-stat-value' }, value),
    el('span', { class: 'plan-stat-detail' }, detail),
  );
}

function renderPlanSteps(plan: ReplenishPlan, now: number): HTMLElement {
  let cumulative = 0;
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'plan-table' },
      el('caption', {}, '补充账号的批次、时间与数量'),
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { scope: 'col' }, '批次'),
          el('th', { scope: 'col' }, '最晚到位时间'),
          el('th', { scope: 'col' }, '距现在'),
          el('th', { scope: 'col', class: 'num' }, '本批数量'),
          el('th', { scope: 'col', class: 'num' }, '累计'),
          el('th', { scope: 'col' }, '原因（不补时）'),
        ),
      ),
      el(
        'tbody',
        {},
        ...plan.steps.map((step, index) => {
          cumulative += step.count;
          const urgent = step.at - now < 6 * 3_600_000;
          return el(
            'tr',
            { class: `plan-row trigger-${step.trigger}` },
            el('th', { scope: 'row' }, el('span', { class: 'batch-badge' }, `第 ${index + 1} 批`)),
            el('td', { class: 'plan-time' }, formatClock(step.at, now)),
            el('td', {}, el('span', { class: `eta${urgent ? ' urgent' : ''}` }, step.at - now < 60_000 ? '立即' : `${formatDuration(step.at - now)} 后`)),
            el('td', { class: 'num' }, el('span', { class: 'count-pill' }, `+${step.count}`), ` ${step.planLabel}`),
            el('td', { class: 'num' }, String(cumulative), meter(cumulative / Math.max(1, plan.accounts), 'meter plan-meter')),
            el(
              'td',
              { class: 'reason' },
              el('span', { class: `chip trigger-${step.trigger}` }, TRIGGER_LABELS[step.trigger]),
              ` ${formatClock(step.triggerAt, now)} 起`,
            ),
          );
        }),
      ),
    ),
    el('p', { class: 'card-hint' }, `建议在“最晚到位时间”前约 ${plan.leadHours}h 内补上：太早补会白白消耗新账号的 30 天存活，太晚则来不及。每批数量 = 问题开始后 5h 内的缺口 ÷ 新账号 5h 满额，向上取整。`),
  );
}

function renderPlanComparison(result: GapResult, plan: ReplenishPlan): HTMLElement {
  const before = result.totals;
  const after = plan.totals;
  // 补充前有问题的标红，补充后已解决的标绿
  const row = (label: string, beforeText: string, afterText: string, beforeBad: boolean, afterBad: boolean) =>
    el(
      'tr',
      {},
      el('th', { scope: 'row' }, label),
      el('td', { class: `num ${beforeBad ? 'cell-bad' : 'cell-neutral'}` }, beforeText),
      el('td', { class: `num ${afterBad ? 'cell-bad' : beforeBad ? 'cell-good' : 'cell-neutral'}` }, afterText),
    );
  const minutes = (range: { min: number; max: number }) => (range.max > 0 ? formatMinutesRange(range) : '无');
  const money = (range: { min: number; max: number }) => (range.max > 0.5 ? formatMoneyRange(range) : '—');
  const least = (buckets: GapBucket[]) => (buckets.length ? Math.min(...buckets.map((bucket) => bucket.minAccounts)) : 0);
  const minAccounts = (buckets: GapBucket[]) => String(least(buckets));
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      { class: 'plan-table compare' },
      el('caption', {}, '补充前后对比'),
      el('thead', {}, el('tr', {}, el('th', { scope: 'col' }, ''), el('th', { scope: 'col', class: 'num' }, '补充前'), el('th', { scope: 'col', class: 'num' }, '补充后'))),
      el(
        'tbody',
        {},
        row('可消耗', formatMoneyRange(before.served), formatMoneyRange(after.served), before.shortfall.max > 0.5, after.shortfall.max > 0.5),
        row('缺口', money(before.shortfall), money(after.shortfall), before.shortfall.max > 0.5, after.shortfall.max > 0.5),
        row('断档时长', minutes(before.outageMinutes), minutes(after.outageMinutes), before.outageMinutes.max > 0, after.outageMinutes.max > 0),
        row(
          '最少可调度账号',
          minAccounts(result.buckets),
          minAccounts(plan.buckets),
          least(result.buckets) < result.safetyAccounts,
          least(plan.buckets) < result.safetyAccounts,
        ),
      ),
    ),
  );
}

/** 补充前后趋势：柱为可调度账号（段内最少），线为需求满足比例；补号时间点标在横轴上 */
function renderTrendChart(result: GapResult, plan: ReplenishPlan, now: number): HTMLElement {
  const width = 1080;
  const height = 220;
  const padding = { top: 16, right: 44, bottom: 26, left: 36 };
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const start = result.buckets[0]?.start ?? now;
  const end = result.buckets.at(-1)?.end ?? now;
  const span = Math.max(1, end - start);
  const x = (time: number) => padding.left + ((time - start) / span) * innerWidth;
  const maxAccounts = Math.max(
    result.safetyAccounts,
    ...result.buckets.map((bucket) => bucket.avgAccounts),
    ...plan.buckets.map((bucket) => bucket.avgAccounts),
    1,
  );
  const yAccounts = (value: number) => padding.top + innerHeight - (value / maxAccounts) * innerHeight;
  const yRatio = (value: number) => padding.top + innerHeight - Math.min(1, value) * innerHeight;
  const ratio = (bucket: GapBucket) => (bucket.demand > 0 ? bucket.served.min / bucket.demand : 1);
  const path = (buckets: GapBucket[], value: (bucket: GapBucket) => number, y: (value: number) => number) =>
    buckets
      .map((bucket, index) => `${index === 0 ? 'M' : 'L'}${x((bucket.start + bucket.end) / 2).toFixed(1)},${y(value(bucket)).toFixed(1)}`)
      .join(' ');

  const svg = svgEl('svg', {
    class: 'trend-chart',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `补充前后趋势：补充前最少 ${Math.min(...result.buckets.map((b) => b.minAccounts))} 个账号可调度，补充后最少 ${Math.min(...plan.buckets.map((b) => b.minAccounts))} 个`,
  });
  // 网格与预警线
  for (const fraction of [0, 0.5, 1]) {
    const y = padding.top + innerHeight * (1 - fraction);
    svg.append(svgEl('line', { class: 'grid', x1: padding.left, x2: width - padding.right, y1: y, y2: y }));
    svg.append(svgEl('text', { class: 'axis-label', x: width - padding.right + 6, y: y + 4 }, `${Math.round(fraction * 100)}%`));
    svg.append(svgEl('text', { class: 'axis-label', x: padding.left - 6, y: y + 4, 'text-anchor': 'end' }, String(Math.round(maxAccounts * fraction))));
  }
  const safetyY = yAccounts(result.safetyAccounts);
  svg.append(svgEl('line', { class: 'safety-line', x1: padding.left, x2: width - padding.right, y1: safetyY, y2: safetyY }));
  // 可调度账号：补充前为浅色面积，补充后为折线
  svg.append(svgEl('path', {
    class: 'area-before',
    d: `${path(result.buckets, (bucket) => bucket.avgAccounts, yAccounts)} L${x(end).toFixed(1)},${yAccounts(0)} L${x(start).toFixed(1)},${yAccounts(0)} Z`,
  }));
  svg.append(svgEl('path', { class: 'line-accounts-after', d: path(plan.buckets, (bucket) => bucket.avgAccounts, yAccounts) }));
  // 满足比例：补充前红色虚线，补充后绿色实线
  svg.append(svgEl('path', { class: 'line-ratio-before', d: path(result.buckets, ratio, yRatio) }));
  svg.append(svgEl('path', { class: 'line-ratio-after', d: path(plan.buckets, ratio, yRatio) }));
  // 补号时间点
  const marks = plan.steps;
  for (const step of marks) {
    svg.append(svgEl('line', { class: 'add-mark', x1: x(step.at), x2: x(step.at), y1: padding.top, y2: padding.top + innerHeight }));
    svg.append(svgEl('text', { class: 'add-label', x: x(step.at) + 3, y: padding.top + 10 }, `+${step.count}`));
  }
  // 横轴时间
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const time = start + span * fraction;
    svg.append(svgEl('text', { class: 'axis-label', x: x(time), y: height - 8, 'text-anchor': fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle' }, formatClock(time, now)));
  }
  return el(
    'div',
    { class: 'trend' },
    el('p', { class: 'trend-title' }, '补充前后趋势'),
    svg,
    el(
      'div',
      { class: 'legend' },
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch area-before' }), '补充前可调度账号（段内平均，左轴）'),
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch line-accounts-after' }), '补充后可调度账号'),
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch line-ratio-before' }), '补充前需求满足比例（右轴）'),
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch line-ratio-after' }), '补充后需求满足比例'),
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch safety-line' }), `预警线 ${result.safetyAccounts} 个`),
      marks.length > 0 && el('span', { class: 'legend-item' }, el('span', { class: 'swatch add-mark' }), '补号时间'),
    ),
  );
}

function svgEl(tag: string, attrs: Record<string, string | number>, text?: string): SVGElement {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, String(value));
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

/** 统计区间的 5h 高峰放到分析期内各个时间点：哪些时间撞上高峰会额外断档 */
function renderPeakRisk(result: GapResult, now: number): HTMLElement {
  const risk = result.peakRisk;
  const title = el('h2', {}, '5h 高峰断档风险');
  if (!risk) {
    return el('section', { class: 'card' }, title, el('p', { class: 'card-hint' }, '统计区间内没有历史消耗数据，无法分析高峰。'));
  }
  const hours = result.hours;
  const peakText = `${joinSuffix(risk.peak.lookbackName, '消耗最高的连续 5h')}：${formatClock(risk.peak.start, now)} – ${formatClock(risk.peak.end, now)}，平均 ${formatMoney(risk.peak.hourly)}/h${result.demand.multiplier !== 1 ? `，×${result.demand.multiplier} 后 ${formatMoney(risk.scaledHourly)}/h` : ''}`;
  const riskyCount = risk.outageSlots + risk.shortfallSlots;
  const headline =
    riskyCount === 0
      ? `高峰落在${spanWith(hours, '内任何时间都不会额外断档')}`
      : `${risk.slots.length} 个可能的高峰开始时间里，${risk.outageSlots} 个会额外断档、${risk.shortfallSlots} 个会额外缺额度`;
  const worst = risk.worst;
  const details: string[] = [];
  if (risk.firstRiskStart !== null) {
    details.push(`最早风险：高峰若在 ${formatClock(risk.firstRiskStart, now)} 开始`);
  }
  if (worst) {
    details.push(
      `最严重：${formatClock(worst.start, now)} 开始的高峰${worst.extraOutageMinutes > 0 ? `，额外断档 ${formatDuration(worst.extraOutageMinutes * 60_000)}` : ''}，额外缺口 ${formatMoney(worst.extraShortfall)}`,
    );
  }
  const cells = risk.slots.map((slot) => peakCell(slot, now));
  return el(
    'section',
    { class: 'card' },
    title,
    el('p', { class: 'card-hint' }, `${peakText}。把这次 5h 高峰（每小时取与原需求的较大值）依次放到分析期内的各个时间点重新模拟，只统计高峰额外带来的断档和缺口，按偏小额度估算。`),
    el('p', { class: `peak-headline ${riskyCount ? 'tone-risk' : 'tone-ok'}` }, headline),
    details.length > 0 && el('p', { class: 'peak-details' }, details.join(' · ')),
    el('div', { class: 'peak-strip', role: 'list', 'aria-label': '各个高峰开始时间的风险' }, ...cells),
    el(
      'div',
      { class: 'legend' },
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch level-ok' }), '高峰可承受'),
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch level-short' }), '额外缺额度'),
      el('span', { class: 'legend-item' }, el('span', { class: 'swatch level-outage' }), '额外断档'),
    ),
  );
}

function peakCell(slot: PeakSlot, now: number): HTMLElement {
  const label =
    slot.level === 'ok'
      ? `${formatClock(slot.start, now)} 开始的高峰可承受`
      : `${formatClock(slot.start, now)} 开始的高峰：${slot.extraOutageMinutes > 0 ? `额外断档 ${formatDuration(slot.extraOutageMinutes * 60_000)}，` : ''}额外缺口 ${formatMoney(slot.extraShortfall)}`;
  const level = slot.level === 'outage' ? 'outage' : slot.level === 'short' ? 'short' : 'ok';
  return el('span', { class: `peak-cell level-${level}`, role: 'listitem', title: label, 'aria-label': label });
}

function renderSummary(result: GapResult): HTMLElement {
  const hours = result.hours;
  const coverage = result.demand.total > 0 ? result.totals.served.min / result.demand.total : 1;
  return el(
    'div',
    { class: 'summary' },
    summaryCard(`${spanWith(hours, '总需求')}`, formatMoney(result.demand.total), `平均 ${formatMoney(result.demand.averageHourly)}/h`),
    summaryCard('可消耗', formatMoneyRange(result.totals.served), `满足 ${(coverage * 100).toFixed(1)}% 以上`),
    summaryCard(
      '7d 最多可用',
      formatMoneyRange(result.totals.sevenDayCapacity),
      '当前 7d 剩余 + 期间 7d 重置，总消耗不会超过它',
    ),
    summaryCard(
      '断档时长',
      result.totals.outageMinutes.max > 0 ? formatMinutesRange(result.totals.outageMinutes) : '无',
      `${result.accounts.predictable} 个可预估 · ${result.accounts.unpredictable} 个不计入`,
    ),
  );
}

function summaryCard(label: string, value: string, detail: string): HTMLElement {
  return el(
    'div',
    { class: 'summary-card' },
    el('span', { class: 'summary-label' }, label),
    el('span', { class: 'summary-value' }, value),
    el('span', { class: 'summary-detail' }, detail),
  );
}

/** 时间轴：每段一格，颜色表示状态，高度表示满足比例 */
function renderTimeline(result: GapResult, now: number): HTMLElement {
  const cells = result.buckets.map((bucket) => {
    const ratio = bucket.demand > 0 ? Math.min(1, bucket.served.min / bucket.demand) : 1;
    const label = `${formatSpan(bucket, now)} · ${LEVEL_LABELS[bucket.level]} · 可消耗 ${formatMoneyRange(bucket.served)} / 需求 ${formatMoney(bucket.demand)} · 最少 ${bucket.minAccounts} 个账号`;
    const cell = el(
      'span',
      { class: `cell level-${bucket.level}`, title: label, role: 'img', 'aria-label': label },
      el('span', { class: 'fill', style: `height: ${Math.max(6, Math.round(ratio * 100))}%` }),
    );
    cell.style.flexGrow = String((bucket.end - bucket.start) / 3_600_000);
    return cell;
  });
  const first = result.buckets[0];
  const last = result.buckets.at(-1);
  return el(
    'section',
    { class: 'card' },
    el('h2', {}, '时间轴'),
    el('p', { class: 'card-hint' }, '每格一个时间段，宽度按时长，高度为需求满足比例（偏小估算）。'),
    el('div', { class: 'timeline' }, ...cells),
    first &&
      last &&
      el(
        'div',
        { class: 'timeline-axis' },
        el('span', {}, formatClock(first.start, now)),
        el('span', {}, formatClock(first.start + (last.end - first.start) / 2, now)),
        el('span', {}, formatClock(last.end, now)),
      ),
    el(
      'div',
      { class: 'legend' },
      ...(Object.keys(LEVEL_LABELS) as Array<GapBucket['level']>).map((level) =>
        el('span', { class: 'legend-item' }, el('span', { class: `swatch level-${level}` }), LEVEL_LABELS[level]),
      ),
    ),
  );
}

function renderBucketDetail(bucket: GapBucket, result: GapResult): HTMLElement {
  const reasons = (Object.keys(BLOCK_LABELS) as BlockReason[])
    .filter((key) => bucket.blocked[key] > 0)
    .map((key) => `${BLOCK_LABELS[key]} ${bucket.blocked[key]}`);
  const items = [
    `需求 ${formatMoney(bucket.demand)}，可消耗 ${formatMoneyRange(bucket.served)}${bucket.shortfall.max > 0.5 ? `，缺口 ${formatMoneyRange(bucket.shortfall)}` : ''}。`,
    `可调度账号最少 ${bucket.minAccounts} 个、平均 ${bucket.avgAccounts.toFixed(1)} 个${bucket.minAccounts < result.safetyAccounts ? `，低于预警线 ${result.safetyAccounts}` : ''}。`,
    bucket.outageMinutes.max > 0 ? `段内无账号可用约 ${formatMinutesRange(bucket.outageMinutes)}。` : '段内一直有账号可调度。',
    reasons.length ? `最紧张时刻不可调度：${reasons.join('、')}。` : '最紧张时刻所有可预估账号都可调度。',
    bucket.recovered > 0 ? `段内有 ${bucket.recovered} 次账号重新可调度（5h / 7d 重置或临时冷却结束）。` : '段内没有账号重新可调度。',
    `段末 7d 剩余合计 ${formatMoneyRange(bucket.sevenDayLeft)}（未到期账号）。`,
  ];
  return el('ul', { class: 'detail-list' }, ...items.map((text) => el('li', {}, text)));
}

function renderNotes(result: GapResult): HTMLElement {
  const items = [
    `模拟步长 ${result.stepMinutes} 分钟；需求优先分配给 5h 最快重置的账号，用满一个再用下一个，与实际调度可能不同。`,
    '每笔消耗同时扣 5h 和 7d：一个 7d 窗口内的所有 5h 轮次合计不超过 7d 剩余，7d 用完即冷却到该账号自己的 7d 重置（滚动窗口）。',
    '额度沿用额度预估的估算：已用金额 ÷ 利用率 × 90%，利用率按 ±0.5% 给出范围；周期消耗为 0 的窗口抽同套餐已用满账号估算。',
    '统计区间：“最近 xx”从现在往前推，最新但会跨两个自然日；“昨天”是 0:00~24:00 完整的一天，与站点“昨日”统计一致，但不含今天的变化。',
    '需求来源：同时段按统计区间内同一钟点的平均，保留一天内的高峰低谷（区间不足 24h 的钟点用区间平均补齐）；平均为统计区间的固定速率；手动可按计划设定。历史消耗来自站点按小时的统计，含所有账号。',
    '富余与扩容：以 ×1 需求为基准反复模拟，找出不缺口的最大倍数；建议倍数还要求可调度账号不低于预警线，偏小估算并按 0.05 向下取整。倍数最多搜索到 ×20。',
    '5h 高峰风险：取统计区间内消耗最高的连续 5h 平均，假设它在分析期内任一时间出现，逐个模拟高峰额外带来的断档和缺口。',
    `补充账号：按当前需求倍数，每次在首个断档 / 缺口 / 低于预警线之前补一批新账号再重新模拟，最多 ${result.plan?.maxSteps ?? 120} 个；新账号按同套餐已用满账号的中位数估算，偏小额度估算。`,
    '只有临时不可调度和正常账号参与模拟；错误、限流、过载、停用、暂停调度、已满 30 天的账号不计入，并发上限未考虑。',
  ];
  return el('section', { class: 'notes' }, el('ul', {}, ...items.map((text) => el('li', {}, text))));
}

/** 状态判定规则：按断档 → 有缺口 → 偏紧 → 充足的优先级，命中第一条即为该段状态 */
function renderLevelRules(result: GapResult): HTMLElement {
  const rules: Array<[GapBucket['level'], string]> = [
    ['outage', `段内有任意一个 ${result.stepMinutes} 分钟模拟步，有需求但没有任何账号可调度（两种额度估算任一出现即算）`],
    ['short', '不断档，但段内需求没能全部消化：缺口超过 $0.5 且超过需求的 0.1%（取额度偏小的估算）'],
    ['warn', `需求全部消化，但段内可调度账号最少时低于预警线 ${result.safetyAccounts} 个`],
    ['ok', `需求全部消化，且段内可调度账号始终不低于预警线 ${result.safetyAccounts} 个`],
  ];
  return el(
    'div',
    { class: 'level-rules', role: 'list', 'aria-label': '状态判定规则' },
    ...rules.map(([level, text], index) =>
      el(
        'div',
        { class: `level-rule level-${level}`, role: 'listitem' },
        el('span', { class: `level-badge level-${level}` }, LEVEL_LABELS[level]),
        el('span', { class: 'rule-text' }, text),
        index < rules.length - 1 && el('span', { class: 'rule-order', 'aria-hidden': 'true' }, '优先'),
      ),
    ),
    el('p', { class: 'rule-note' }, '按 断档 → 有缺口 → 偏紧 → 充足 的顺序判断，命中第一条即为该段状态；预警线可在上方调整。'),
  );
}

function servedRatio(bucket: GapBucket): number {
  return bucket.demand > 0 ? Math.min(1, bucket.served.min / bucket.demand) : 1;
}

/** 0 个可调度为红，低于预警线为橙，其余正常 */
function accountTone(bucket: GapBucket, safetyAccounts: number): string {
  if (bucket.minAccounts === 0) {
    return 'tone-outage';
  }
  return bucket.minAccounts < safetyAccounts ? 'tone-warn' : 'tone-ok';
}

function meter(ratio: number, className: string): HTMLElement {
  const percent = Math.round(Math.max(0, Math.min(1, ratio)) * 100);
  return el(
    'span',
    { class: className, role: 'presentation' },
    el('span', { class: 'meter-fill', style: `width: ${percent}%` }),
  );
}

/** 不可调度原因：按数量从多到少，每种原因一种颜色 */
function reasonChips(bucket: GapBucket): Array<HTMLElement | string> {
  const keys = (Object.keys(BLOCK_LABELS) as BlockReason[])
    .filter((key) => bucket.blocked[key] > 0)
    .sort((left, right) => bucket.blocked[right] - bucket.blocked[left]);
  if (keys.length === 0) {
    return ['—'];
  }
  return keys.map((key) => el('span', { class: `chip reason-${key}` }, `${BLOCK_LABELS[key]} ${bucket.blocked[key]}`));
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function formatDay(time: number, now: number): string {
  const date = new Date(time);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const offset = Math.round((new Date(date).setHours(0, 0, 0, 0) - today.getTime()) / 86_400_000);
  const relative = offset === 0 ? '今天' : offset === 1 ? '明天' : offset === 2 ? '后天' : `${offset} 天后`;
  return `${date.getMonth() + 1}/${date.getDate()} ${WEEKDAYS[date.getDay()]} · ${relative}`;
}

function describeBlocked(bucket: GapBucket): string {
  const parts = (Object.keys(BLOCK_LABELS) as BlockReason[])
    .filter((key) => bucket.blocked[key] > 0)
    .sort((left, right) => bucket.blocked[right] - bucket.blocked[left])
    .map((key) => `${BLOCK_LABELS[key]} ${bucket.blocked[key]}`);
  return parts.length ? parts.join(' · ') : '—';
}

/** 写进页面标题的简短条件描述 */
function describeState(state: GapPageState): string {
  const lookback = state.lookback === 'yesterday' ? '昨天' : `最近 ${lookbackLabel(state.lookback)}`;
  const demand = state.source === 'manual' ? `手动 $${state.manualPerHour}/h` : joinSuffix(lookback, SOURCE_LABELS[state.source]);
  return `${demand} ×${state.multiplier} · ${spanLabel(state.hours)}`;
}

function spanLabel(hours: number): string {
  return hours > 24 && hours % 24 === 0 ? `${hours / 24} 天` : `${hours}h`;
}

/** “3 天内 / 24h 内”：小时单位后加空格 */
function spanWith(hours: number, suffix: string): string {
  return horizonSpan(hours, suffix);
}

function formatSpan(bucket: GapBucket, now: number): string {
  return `${formatClock(bucket.start, now)} – ${formatClock(bucket.end, now)}`;
}

function formatCountdownText(ms: number): string {
  return ms < 60_000 ? '现在' : `${formatDuration(ms)} 后`;
}

function formatMinutesRange(range: { min: number; max: number }): string {
  const text = (minutes: number) => formatDuration(minutes * 60_000);
  return range.min === range.max ? text(range.max) : `${text(range.min)} ~ ${text(range.max)}`;
}
