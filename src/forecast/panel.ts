import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from 'wxt/utils/content-script-ui/shadow-root';
import { fetchForecastInput, type ForecastInput } from './api';
import { computeForecast, createSeededRandom } from './engine';
import {
  blockedLabel,
  formatClock,
  formatCountRange,
  formatCountdown,
  formatMoneyRange,
  horizonLabel,
  horizonSpan,
} from './format';
import type {
  DepletionItem,
  ExpiryItem,
  ForecastMode,
  ForecastResult,
  HorizonForecast,
  PlanBreakdown,
  RecoveryItem,
} from './types';
import panelCss from './panel.css?inline';

/** 面板打开期间每分钟按当前时间重算一次；数据超过该时长再重新拉取接口 */
const RECOMPUTE_INTERVAL_MS = 60_000;
const REFETCH_AFTER_MS = 5 * 60_000;
const PANEL_ID = 'sub2api-forecast-panel';
// 顺序即切换按钮顺序，第一个为默认
const MODE_LABELS: Record<ForecastMode, string> = {
  depletion: '最快用完 · 累计',
  snapshot: '按时刻剩余',
};
const MODE_DESCRIPTIONS: Record<ForecastMode, string> = {
  depletion:
    '假设每个账号满负荷使用、每个 5h 一开就用满，统计到该时间点累计最多能用多少；一个 7d 内的 5h 合计不超过 7d 剩余，用完即 7d 冷却。',
  snapshot: '假设之后不再消耗，看该时间点各可调度账号的 5h 窗口还剩多少（不超过各自 7d 剩余）。',
};
const DEFAULT_MODE: ForecastMode = 'depletion';

type Child = Node | string | null | undefined | false;

let activeUi: Promise<ShadowRootContentScriptUi<ForecastPanel>> | null = null;

/** 由插件菜单触发：首次打开时才创建面板，已打开则刷新数据 */
export async function openForecastPanel(ctx: ContentScriptContext): Promise<void> {
  if (activeUi) {
    (await activeUi).mounted?.refresh();
    return;
  }
  const pending = createShadowRootUi(ctx, {
    name: 'sub2api-forecast',
    position: 'inline',
    anchor: 'body',
    css: panelCss,
    onMount: (container, shadow) => new ForecastPanel(ctx, container, shadow, closeForecastPanel),
    onRemove: (panel) => panel?.destroy(),
  });
  activeUi = pending;
  try {
    const ui = await pending;
    // 创建期间又被新一次注入顶替时不再挂载，避免留下失联的面板
    if (ctx.isInvalid) {
      activeUi = null;
      return;
    }
    ui.mount();
  } catch (error) {
    activeUi = null;
    throw error;
  }
}

/** 关闭即整体移除，数据和 DOM 一起释放 */
function closeForecastPanel(): void {
  const pending = activeUi;
  activeUi = null;
  void pending?.then((ui) => ui.remove());
}

class ForecastPanel {
  private readonly body: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly refreshButton: HTMLButtonElement;
  private readonly expanded = new Set<number>();
  private readonly modeButtons: HTMLButtonElement[];
  private readonly modeHelp: HTMLElement[];
  private mode: ForecastMode = DEFAULT_MODE;
  private input: ForecastInput | null = null;
  private fetchedAt = 0;
  private abort: AbortController | null = null;
  private readonly timer: number;

  constructor(
    private readonly ctx: ContentScriptContext,
    container: HTMLElement,
    shadow: ShadowRoot,
    onClose: () => void,
  ) {
    this.subtitle = el('p', { class: 'subtitle' });
    this.refreshButton = el('button', { class: 'icon-button', type: 'button' }, '刷新') as HTMLButtonElement;
    const closeButton = el('button', { class: 'icon-button', type: 'button', 'aria-label': '关闭额度预估' }, '✕');
    this.body = el('div', { class: 'panel-body', role: 'region', 'aria-live': 'polite' });
    this.modeButtons = (Object.keys(MODE_LABELS) as ForecastMode[]).map((mode) => {
      const button = el(
        'button',
        { class: 'mode-option', type: 'button', role: 'radio', 'data-mode': mode },
        MODE_LABELS[mode],
      ) as HTMLButtonElement;
      button.addEventListener('click', () => this.setMode(mode));
      return button;
    });
    this.modeHelp = (Object.keys(MODE_LABELS) as ForecastMode[]).map((mode) =>
      el('li', { 'data-mode': mode }, el('b', {}, `${MODE_LABELS[mode]}：`), MODE_DESCRIPTIONS[mode]),
    );
    const modeSwitch = el(
      'div',
      {
        class: 'mode-switch',
        role: 'radiogroup',
        'aria-label': '计算方式',
        'aria-describedby': `${PANEL_ID}-mode-help`,
      },
      ...this.modeButtons,
    );
    modeSwitch.addEventListener('keydown', (event) => this.onModeKey(event as KeyboardEvent));
    this.syncModeButtons();
    const panel = el(
      'section',
      { class: 'panel', id: PANEL_ID, role: 'dialog', 'aria-labelledby': `${PANEL_ID}-title` },
      el(
        'header',
        { class: 'panel-header' },
        el(
          'div',
          {},
          el('p', { class: 'eyebrow' }, 'SUB2API FORECAST'),
          el('h2', { id: `${PANEL_ID}-title` }, '额度预估'),
          this.subtitle,
        ),
        el('div', { class: 'header-actions' }, this.refreshButton, closeButton),
      ),
      el(
        'div',
        { class: 'panel-toolbar' },
        el('div', { class: 'toolbar-row' }, el('span', { class: 'toolbar-label' }, '计算方式'), modeSwitch),
        el('ul', { class: 'mode-help', id: `${PANEL_ID}-mode-help` }, ...this.modeHelp),
      ),
      this.body,
    );
    container.append(panel);

    closeButton.addEventListener('click', onClose);
    this.refreshButton.addEventListener('click', () => this.refresh());
    shadow.addEventListener('keydown', (event) => {
      if ((event as KeyboardEvent).key === 'Escape') {
        onClose();
      }
    });
    this.timer = this.ctx.setInterval(() => this.tick(), RECOMPUTE_INTERVAL_MS);
    this.refreshButton.focus();
    this.refresh();
  }

  refresh(): void {
    void this.load();
  }

  private setMode(mode: ForecastMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.syncModeButtons();
    this.render();
  }

  private syncModeButtons(): void {
    for (const button of this.modeButtons) {
      const active = button.dataset.mode === this.mode;
      button.setAttribute('aria-checked', String(active));
      button.tabIndex = active ? 0 : -1;
    }
    for (const item of this.modeHelp) {
      item.classList.toggle('active', item.dataset.mode === this.mode);
    }
  }

  /** 单选组的方向键切换 */
  private onModeKey(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const index = this.modeButtons.findIndex((button) => button.dataset.mode === this.mode);
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = this.modeButtons[(index + step + this.modeButtons.length) % this.modeButtons.length];
    if (next?.dataset.mode) {
      this.setMode(next.dataset.mode as ForecastMode);
      next.focus();
    }
  }

  destroy(): void {
    this.release();
  }

  private release(): void {
    window.clearInterval(this.timer);
    this.abort?.abort();
    this.abort = null;
    this.input = null;
    this.expanded.clear();
    this.body.replaceChildren();
  }

  private tick(): void {
    if (document.hidden || this.abort) {
      return;
    }
    if (Date.now() - this.fetchedAt > REFETCH_AFTER_MS) {
      void this.load();
    } else {
      this.render();
    }
  }

  private async load(): Promise<void> {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.refreshButton.disabled = true;
    if (!this.input) {
      this.body.replaceChildren(el('p', { class: 'state-message', role: 'status' }, '正在读取账号与用量…'));
    }
    try {
      const input = await fetchForecastInput(controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      this.input = input;
      this.fetchedAt = Date.now();
      this.render();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.body.replaceChildren(el('p', { class: 'state-message error', role: 'alert' }, `预测失败：${message}`));
    } finally {
      if (this.abort === controller) {
        this.abort = null;
        this.refreshButton.disabled = false;
      }
    }
  }

  private render(): void {
    if (!this.input) {
      return;
    }
    const now = Date.now();
    // 抽样种子跟随数据拉取时间：同一份数据重算、切换方式时抽到同一个参照账号
    const result = computeForecast(this.input.accounts, this.input.usage, now, {
      mode: this.mode,
      random: createSeededRandom(this.fetchedAt),
    });
    this.subtitle.textContent = `数据更新于 ${formatClock(this.fetchedAt, now)} · 共 ${result.totals.all} 个账号`;
    this.body.replaceChildren(
      renderSummary(result),
      el('p', { class: 'section-title' }, `未来可用账号与额度 · ${MODE_LABELS[result.mode]}（点击时间查看明细）`),
      this.renderTable(result, now),
      renderNotes(result, now),
    );
  }

  private renderTable(result: ForecastResult, now: number): HTMLElement {
    const showPlans = hasMultiplePlans(result);
    const rows: HTMLElement[] = [];
    for (const horizon of result.horizons) {
      const isOpen = this.expanded.has(horizon.hours);
      const detailId = `${PANEL_ID}-detail-${horizon.hours}`;
      const toggle = el(
        'button',
        { class: 'horizon-toggle', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': detailId },
        el('span', { class: 'horizon-name' }, `${isOpen ? '▾' : '▸'} ${horizonLabel(horizon.hours)}`),
        el('span', { class: 'horizon-time' }, formatClock(horizon.at, now)),
      );
      toggle.addEventListener('click', () => {
        if (this.expanded.has(horizon.hours)) {
          this.expanded.delete(horizon.hours);
        } else {
          this.expanded.add(horizon.hours);
        }
        this.render();
        this.body.querySelector<HTMLElement>(`[aria-controls="${detailId}"]`)?.focus();
      });

      const depletion = result.mode === 'depletion';
      const gained = horizon.newlyRecovered.length + horizon.newlyRestored.length;
      rows.push(
        el(
          'tr',
          { class: 'horizon-row' },
          el('th', { scope: 'row' }, toggle),
          el(
            'td',
            {},
            el('span', { class: 'count' }, formatCountRange(horizon.availableAccounts)),
            gained > 0 && el('span', { class: 'delta', title: '较上一个时间点新增可调度' }, `+${gained}`),
            horizon.newlyDepleted.length > 0 &&
              el('span', { class: 'delta depleted', title: '较上一个时间点 7d 用完' }, `−${horizon.newlyDepleted.length}`),
            horizon.newlyExpired.length > 0 &&
              el(
                'span',
                { class: 'delta expired', title: `较上一个时间点存活满 ${result.expiry.lifetimeDays} 天` },
                `−${horizon.newlyExpired.length}`,
              ),
            horizon.hours > 0 && renderCountMeta(result, horizon),
            planSplit(horizon.byPlan, showPlans, (plan) => formatCountRange(plan.accounts)),
          ),
          el(
            'td',
            {},
            el('span', { class: 'money' }, formatMoneyRange(horizon.quota)),
            depletion &&
              horizon.hours > 0 &&
              horizon.cap7d &&
              el(
                'span',
                { class: 'count-meta', title: '累计额度不会超过 7d 最多可用（当前 7d 剩余 + 已发生的 7d 重置）' },
                '累计最多可用 · 7d 上限 ',
                el('b', { class: 'cap' }, formatMoneyRange(horizon.cap7d)),
              ),
            planSplit(horizon.byPlan, showPlans, (plan) => formatMoneyRange(plan.quota)),
          ),
        ),
      );
      if (isOpen) {
        rows.push(el('tr', { class: 'detail-row', id: detailId }, el('td', { colspan: '3' }, renderChanges(horizon, now, result))));
      }
    }

    return el(
      'table',
      {},
      el('caption', {}, '各时间点的可用账号数与剩余额度'),
      el(
        'colgroup',
        {},
        el('col', { class: 'col-time' }),
        el('col', { class: 'col-count' }),
        el('col', { class: 'col-money' }),
      ),
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { scope: 'col' }, '时间'),
          el('th', { scope: 'col' }, '可用账号'),
          el('th', { scope: 'col' }, result.mode === 'depletion' ? '累计额度' : '5h 额度'),
        ),
      ),
      el('tbody', {}, ...rows),
      renderRollingRow(result, showPlans, now),
    );
  }
}

/** 可用账号数的组成：现有 + 恢复 − 7d 用完 − 到期 */
function renderCountMeta(result: ForecastResult, horizon: HorizonForecast): HTMLElement {
  const depleted = horizon.depletedNow;
  return el(
    'span',
    { class: 'count-meta' },
    `现有 ${result.totals.available} + 累计恢复 `,
    el('b', {}, String(horizon.recoveredSinceNow)),
    depleted.max > 0 && ' − 7d 用完 ',
    depleted.max > 0 && el('b', { class: 'depleted' }, formatCountRange(depleted)),
    horizon.expiredSinceNow > 0 && ' − 到期 ',
    horizon.expiredSinceNow > 0 && el('b', { class: 'expired' }, String(horizon.expiredSinceNow)),
  );
}

/**
 * 7d 是各账号独立滚动的窗口。
 * - 按时刻剩余：各账号当前 7d 剩余之和，以及预测期内重置后回到满额的增量；
 * - 最快用完：预测期内 7d 最多可用 = 当前剩余 + 重置后的完整新额度，与累计额度同一口径，累计额度不会超过它。
 */
function renderRollingRow(result: ForecastResult, showPlans: boolean, now: number): HTMLElement {
  const rolling = result.rolling7d;
  const lastAt = result.horizons.at(-1)?.at ?? now;
  const resets = rolling.resetsInHorizon;
  const maxUsable = rolling.maxUsable;
  const within = horizonSpan(result.horizons.at(-1)?.hours ?? 0, '内');
  return el(
    'tfoot',
    {},
    el(
      'tr',
      { class: 'weekly-row' },
      el(
        'th',
        { scope: 'row' },
        el('span', { class: 'horizon-name' }, '7d 额度'),
        el('span', { class: 'horizon-time' }, maxUsable ? `${within}最多可用` : '滚动 7d 剩余'),
      ),
      el(
        'td',
        {},
        el('span', { class: 'count' }, String(rolling.accounts)),
        el('span', { class: 'count-meta' }, maxUsable ? `${within}能被调度的账号` : '可用 + 冷却中的账号'),
        planSplit(rolling.byPlan, showPlans, (plan) => formatCountRange(plan.accounts)),
      ),
      el(
        'td',
        {},
        el('span', { class: 'money' }, formatMoneyRange(maxUsable ?? rolling.remaining)),
        maxUsable
          ? el(
              'span',
              { class: 'count-meta' },
              `当前剩余 ${formatMoneyRange(rolling.remaining)} + ${resets.accounts} 个账号 7d 重置 `,
              el('b', {}, `+${formatMoneyRange(resets.gain)}`),
            )
          : resets.accounts > 0 &&
              el(
                'span',
                { class: 'count-meta' },
                `${formatClock(lastAt, now)} 前 ${resets.accounts} 个账号 7d 重置 `,
                el('b', {}, `+${formatMoneyRange(resets.gain)}`),
              ),
        planSplit(rolling.byPlan, showPlans, (plan) => formatMoneyRange(plan.quota)),
      ),
    ),
  );
}

function renderSummary(result: ForecastResult): HTMLElement {
  const { totals } = result;
  const current = result.horizons[0];
  const currentPlans = current?.byPlan
    .map((plan) => `${plan.planLabel} ${formatCountRange(plan.accounts)}`)
    .join(' · ');
  const unpredictable = Object.entries(totals.unpredictableByLabel)
    .sort((left, right) => right[1] - left[1])
    .map(([label, count]) => `${label} ${count}`)
    .join(' · ');
  return el(
    'div',
    { class: 'summary' },
    summaryCard('available', totals.available, '当前可用', hasMultiplePlans(result) ? currentPlans ?? '' : ''),
    summaryCard('cooling', totals.cooling, '临时不可调度', '可预估恢复时间'),
    summaryCard('unpredictable', totals.unpredictable, '不可预估', unpredictable || '无'),
  );
}

function summaryCard(tone: string, value: number, label: string, detail: string): HTMLElement {
  return el(
    'div',
    { class: `summary-card ${tone}` },
    el('span', { class: 'value' }, String(value)),
    el('span', { class: 'label' }, label),
    detail && el('span', { class: 'detail' }, detail),
  );
}

type ChangeEvent =
  | { kind: 'recover'; at: number; item: RecoveryItem }
  | { kind: 'restore'; at: number; item: DepletionItem }
  | { kind: 'deplete'; at: number; item: DepletionItem }
  | { kind: 'expire'; at: number; item: ExpiryItem };

const SOON_LABELS: Record<ChangeEvent['kind'], string> = {
  recover: '即将恢复',
  restore: '即将恢复',
  deplete: '即将用完',
  expire: '即将到期',
};

function renderChanges(horizon: HorizonForecast, now: number, result: ForecastResult): HTMLElement {
  const events: ChangeEvent[] = [
    ...horizon.newlyRecovered.map((item): ChangeEvent => ({ kind: 'recover', at: item.recoverAt, item })),
    ...horizon.newlyRestored.map((item): ChangeEvent => ({ kind: 'restore', at: item.until, item })),
    ...horizon.newlyDepleted.map((item): ChangeEvent => ({ kind: 'deplete', at: item.depletedAt, item })),
    ...horizon.newlyExpired.map((item): ChangeEvent => ({ kind: 'expire', at: item.expiresAt, item })),
  ].sort((left, right) => left.at - right.at);
  if (events.length === 0) {
    return el(
      'p',
      { class: 'detail-empty' },
      horizon.hours === 0 ? '当前可用账号即上表数量' : '与上一个时间点相比没有账号恢复、用完或到期',
    );
  }
  return el(
    'ul',
    { class: 'detail-list' },
    ...groupByMinute(events).map((group) => {
      const kinds = new Set(group.events.map((event) => event.kind));
      const only = kinds.size === 1 ? [...kinds][0] : undefined;
      const tone = only === 'expire' ? ' expired' : only === 'deplete' ? ' depleted' : '';
      return el(
        'li',
        { class: 'recover-group' },
        el(
          'span',
          { class: 'when' },
          el('span', { class: `countdown${tone}` }, formatCountdown(group.at - now, SOON_LABELS[only ?? 'recover'])),
          el('span', { class: 'clock' }, formatClock(group.at, now)),
          group.events.length > 1 && el('span', { class: 'group-count' }, `${group.events.length} 个账号`),
        ),
        el(
          'ul',
          { class: 'group-accounts' },
          ...group.events.map((event) => renderChangeItem(event, now, result)),
        ),
      );
    }),
  );
}

function renderChangeItem(event: ChangeEvent, now: number, result: ForecastResult): HTMLElement {
  const { item } = event;
  let reason: HTMLElement;
  let detail: HTMLElement;
  switch (event.kind) {
    case 'recover':
      reason = el('span', { class: 'block' }, `${blockedLabel(event.item.blockedBy)} 冷却`);
      detail = el(
        'span',
        { class: 'gain' },
        `5h ${formatMoneyRange(event.item.quota5h)} / 7d ${formatMoneyRange(event.item.quota7d)}`,
      );
      break;
    case 'restore':
      reason = el('span', { class: 'block' }, '7d 用完冷却');
      detail = el('span', { class: 'gain' }, '7d 窗口重置，额度回满');
      break;
    case 'deplete': {
      const latest = event.item.latestAt;
      reason = el('span', { class: 'block depleted' }, '7d 用完');
      detail = el(
        'span',
        { class: 'gain depleted' },
        latest !== null && Math.abs(latest - event.item.depletedAt) >= 60_000
          ? `最晚 ${formatClock(latest, now)} · 冷却至 ${formatClock(event.item.until, now)}`
          : `冷却至 ${formatClock(event.item.until, now)}`,
      );
      break;
    }
    case 'expire':
      reason = el('span', { class: 'block expired' }, `存活满 ${result.expiry.lifetimeDays} 天`);
      detail = el('span', { class: 'gain expired' }, `移出 5h ${formatMoneyRange(event.item.quota5h)}`);
      break;
  }
  const who = el(
    'span',
    { class: 'who', title: item.name },
    el('span', { class: 'tag' }, item.planLabel),
    `#${item.id} ${item.name} `,
    reason,
  );
  return el('li', {}, who, detail);
}

/** 同一分钟发生的恢复 / 用完 / 到期合并到一个时间点下（列表已按时间排序） */
function groupByMinute(events: ChangeEvent[]): Array<{ at: number; events: ChangeEvent[] }> {
  const groups: Array<{ at: number; events: ChangeEvent[] }> = [];
  for (const event of events) {
    const last = groups.at(-1);
    if (last && Math.floor(last.at / 60_000) === Math.floor(event.at / 60_000)) {
      last.events.push(event);
    } else {
      groups.push({ at: event.at, events: [event] });
    }
  }
  return groups;
}

function renderNotes(result: ForecastResult, now: number): HTMLElement {
  const items: string[] = [];
  // 跟随最远的预测时间点，避免写死“24h”
  const within = horizonSpan(result.horizons.at(-1)?.hours ?? 0, '内');
  if (result.coolingBeyond.count > 0 && result.coolingBeyond.earliestRecoverAt !== null) {
    items.push(
      `另有 ${result.coolingBeyond.count} 个账号 ${within}不会恢复，最早 ${formatClock(result.coolingBeyond.earliestRecoverAt, now)}。`,
    );
  }
  const { expiry } = result;
  if (expiry.inHorizon > 0) {
    items.push(`${within}有 ${expiry.inHorizon} 个账号存活满 ${expiry.lifetimeDays} 天，到期后从可用账号和额度中移出。`);
  } else if (expiry.nextAt !== null) {
    items.push(`${within}没有账号存活满 ${expiry.lifetimeDays} 天，最早 ${formatClock(expiry.nextAt, now)}。`);
  }
  if (expiry.neverRecover > 0) {
    items.push(`${expiry.neverRecover} 个冷却账号在恢复前就会存活满 ${expiry.lifetimeDays} 天，不再计入预测。`);
  }
  if (result.mode === 'depletion') {
    const depleted = result.depletedAccounts;
    items.push(
      depleted.max > 0
        ? `按最快用完，${within}有 ${formatCountRange(depleted)} 个账号会用完 7d 剩余，进入 7d 冷却直到各自的 7d 窗口重置。`
        : `按最快用完，${within}没有账号会用完 7d 剩余。`,
      '累计额度是从现在到该时间点最多能用的金额（“现在”为当前 5h 窗口剩余），是满负荷下的上限；实际用得慢时账号会撑得更久。',
      '7d 上限 = 到该时间点已可调度账号的 7d 剩余 + 已发生的 7d 重置（每次重置给一整份新 7d）；累计额度不会超过它，差额是 5h 轮次不够把 7d 用完的部分。',
      '底部 7d 额度 = 预测期内 7d 最多可用，等于最后一个时间点的 7d 上限；冷却中的账号要等恢复后才计入。',
    );
  }
  items.push(
    `额度按各账号当前窗口的已用金额 ÷ 利用率 × 90% 估算完整 5h / 7d，窗口不完整也照用；利用率是取整值，按 ±${result.utilizationPrecision}% 给出范围。`,
    result.mode === 'depletion'
      ? '7d 是滚动窗口：每个账号从本轮首次使用起各自计 7 天，到期才重置，重置后得到一整份新 7d。'
      : '7d 是滚动窗口：每个账号从本轮首次使用起各自计 7 天，到期才重置；底部 7d 额度是各账号当前 7d 窗口剩余之和。',
    '5h / 7d 任一进度条 ≥ 90% 即冷却，7d 冷却期间 5h 恢复也不可调度；7d F 不参与判断。',
    '只有临时不可调度的账号会预估恢复；错误、限流、过载、停用、暂停调度等状态不计入。',
    `存活时间按创建时间计算，最多 ${result.expiry.lifetimeDays} 天；已满的账号计入不可预估。`,
  );
  if (result.peerEstimatedAccounts > 0) {
    items.push(
      `${result.peerEstimatedAccounts} 个账号的部分窗口周期消耗为 0，无法自估，随机抽取同套餐已用满的账号估算满额。`,
    );
  }
  if (result.noSampleAccounts > 0) {
    items.push(`${result.noSampleAccounts} 个账号的部分窗口没有可参照的同套餐账号，该窗口额度按 0 计。`);
  }
  return el('div', { class: 'notes' }, el('ul', {}, ...items.map((text) => el('li', {}, text))));
}

/** 每个套餐一行，账号里只有一种套餐时不拆分 */
function planSplit(
  plans: PlanBreakdown[],
  showPlans: boolean,
  value: (plan: PlanBreakdown) => string,
): HTMLElement | null {
  if (!showPlans || plans.length === 0) {
    return null;
  }
  return el(
    'span',
    { class: 'plan-split' },
    ...plans.map((plan) => el('span', {}, `${plan.planLabel} ${value(plan)}`)),
  );
}

function hasMultiplePlans(result: ForecastResult): boolean {
  const labels = new Set(result.horizons.flatMap((horizon) => horizon.byPlan.map((plan) => plan.planLabel)));
  return labels.size > 1;
}

/** 用 DOM API 构建节点，账号名等文本一律走 textContent，避免注入 */
function el(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === '') {
      continue;
    }
    element.append(child);
  }
  return element;
}
