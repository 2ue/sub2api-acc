import type { ContentScriptContext } from 'wxt/utils/content-script-context';
import {
  createShadowRootUi,
  type ShadowRootContentScriptUi,
} from 'wxt/utils/content-script-ui/shadow-root';
import { fetchForecastInput, type ForecastInput } from './api';
import { computeForecast } from './engine';
import { blockedLabel, formatClock, formatCountdown, formatMoney, horizonLabel } from './format';
import type {
  ExpiryItem,
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
    const result = computeForecast(this.input.accounts, this.input.usage, now);
    this.subtitle.textContent = `数据更新于 ${formatClock(this.fetchedAt, now)} · 共 ${result.totals.all} 个账号`;
    this.body.replaceChildren(
      renderSummary(result),
      el('p', { class: 'section-title' }, '未来可用账号与额度（点击时间查看恢复明细）'),
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

      rows.push(
        el(
          'tr',
          { class: 'horizon-row' },
          el('th', { scope: 'row' }, toggle),
          el(
            'td',
            {},
            el('span', { class: 'count' }, String(horizon.availableAccounts)),
            horizon.newlyRecovered.length > 0 &&
              el('span', { class: 'delta', title: '较上一个时间点新增恢复' }, `+${horizon.newlyRecovered.length}`),
            horizon.newlyExpired.length > 0 &&
              el(
                'span',
                { class: 'delta expired', title: `较上一个时间点存活满 ${result.expiry.lifetimeDays} 天` },
                `−${horizon.newlyExpired.length}`,
              ),
            horizon.hours > 0 &&
              el(
                'span',
                { class: 'count-meta' },
                `现有 ${result.totals.available} + 累计恢复 `,
                el('b', {}, String(horizon.recoveredSinceNow)),
                horizon.expiredSinceNow > 0 && ' − 到期 ',
                horizon.expiredSinceNow > 0 && el('b', { class: 'expired' }, String(horizon.expiredSinceNow)),
              ),
            planSplit(horizon.byPlan, showPlans, (plan) => String(plan.accounts)),
          ),
          el(
            'td',
            {},
            el('span', { class: 'money' }, formatMoney(horizon.quota5h)),
            planSplit(horizon.byPlan, showPlans, (plan) => formatMoney(plan.quota)),
          ),
        ),
      );
      if (isOpen) {
        rows.push(el('tr', { class: 'detail-row', id: detailId }, el('td', { colspan: '3' }, renderChanges(horizon, now, result.expiry.lifetimeDays))));
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
          el('th', { scope: 'col' }, '5h 额度'),
        ),
      ),
      el('tbody', {}, ...rows),
      renderWeeklyRow(result, showPlans, now),
    );
  }
}

/** 7d 额度不随小时变化，单独一行展示本周剩余与预测时间内的重置增量 */
function renderWeeklyRow(result: ForecastResult, showPlans: boolean, now: number): HTMLElement {
  const { weekly } = result;
  const lastAt = result.horizons.at(-1)?.at ?? now;
  const resets = weekly.resetsInHorizon;
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
        el('span', { class: 'horizon-time' }, '本周剩余'),
      ),
      el(
        'td',
        {},
        el('span', { class: 'count' }, String(weekly.accounts)),
        el('span', { class: 'count-meta' }, '可用 + 冷却中的账号'),
        planSplit(weekly.byPlan, showPlans, (plan) => String(plan.accounts)),
      ),
      el(
        'td',
        {},
        el('span', { class: 'money' }, formatMoney(weekly.remaining)),
        resets.accounts > 0 &&
          el(
            'span',
            { class: 'count-meta' },
            `${formatClock(lastAt, now)} 前 ${resets.accounts} 个账号 7d 重置 `,
            el('b', {}, `+${formatMoney(resets.gain)}`),
          ),
        planSplit(weekly.byPlan, showPlans, (plan) => formatMoney(plan.quota)),
      ),
    ),
  );
}

function renderSummary(result: ForecastResult): HTMLElement {
  const { totals } = result;
  const current = result.horizons[0];
  const currentPlans = current?.byPlan.map((plan) => `${plan.planLabel} ${plan.accounts}`).join(' · ');
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
  | { kind: 'expire'; at: number; item: ExpiryItem };

function renderChanges(horizon: HorizonForecast, now: number, lifetimeDays: number): HTMLElement {
  const events: ChangeEvent[] = [
    ...horizon.newlyRecovered.map((item): ChangeEvent => ({ kind: 'recover', at: item.recoverAt, item })),
    ...horizon.newlyExpired.map((item): ChangeEvent => ({ kind: 'expire', at: item.expiresAt, item })),
  ].sort((left, right) => left.at - right.at);
  if (events.length === 0) {
    return el(
      'p',
      { class: 'detail-empty' },
      horizon.hours === 0 ? '当前可用账号即上表数量' : '与上一个时间点相比没有账号恢复或到期',
    );
  }
  return el(
    'ul',
    { class: 'detail-list' },
    ...groupByMinute(events).map((group) => {
      const allExpire = group.events.every((event) => event.kind === 'expire');
      return el(
        'li',
        { class: 'recover-group' },
        el(
          'span',
          { class: 'when' },
          el(
            'span',
            { class: allExpire ? 'countdown expired' : 'countdown' },
            formatCountdown(group.at - now, allExpire ? '即将到期' : '即将恢复'),
          ),
          el('span', { class: 'clock' }, formatClock(group.at, now)),
          group.events.length > 1 && el('span', { class: 'group-count' }, `${group.events.length} 个账号`),
        ),
        el(
          'ul',
          { class: 'group-accounts' },
          ...group.events.map((event) => renderChangeItem(event, lifetimeDays)),
        ),
      );
    }),
  );
}

function renderChangeItem(event: ChangeEvent, lifetimeDays: number): HTMLElement {
  const { item } = event;
  const who = el(
    'span',
    { class: 'who', title: item.name },
    el('span', { class: 'tag' }, item.planLabel),
    `#${item.id} ${item.name} `,
    event.kind === 'recover'
      ? el('span', { class: 'block' }, `${blockedLabel(event.item.blockedBy)} 冷却`)
      : el('span', { class: 'block expired' }, `存活满 ${lifetimeDays} 天`),
  );
  const gain =
    event.kind === 'recover'
      ? el('span', { class: 'gain' }, `5h ${formatMoney(event.item.quota5h)} / 7d ${formatMoney(event.item.quota7d)}`)
      : el('span', { class: 'gain expired' }, `移出 5h ${formatMoney(event.item.quota5h)}`);
  return el('li', {}, who, gain);
}

/** 同一分钟发生的恢复 / 到期合并到一个时间点下（列表已按时间排序） */
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
  if (result.coolingBeyond.count > 0 && result.coolingBeyond.earliestRecoverAt !== null) {
    items.push(
      `另有 ${result.coolingBeyond.count} 个账号 24h 内不会恢复，最早 ${formatClock(result.coolingBeyond.earliestRecoverAt, now)}。`,
    );
  }
  const { expiry } = result;
  if (expiry.inHorizon > 0) {
    items.push(`24h 内有 ${expiry.inHorizon} 个账号存活满 ${expiry.lifetimeDays} 天，到期后从可用账号和额度中移出。`);
  } else if (expiry.nextAt !== null) {
    items.push(`24h 内没有账号存活满 ${expiry.lifetimeDays} 天，最早 ${formatClock(expiry.nextAt, now)}。`);
  }
  if (expiry.neverRecover > 0) {
    items.push(`${expiry.neverRecover} 个冷却账号在恢复前就会存活满 ${expiry.lifetimeDays} 天，不再计入预测。`);
  }
  items.push(
    `存活时间按创建时间计算，最多 ${expiry.lifetimeDays} 天；已满的账号计入不可预估。`,
    '只有临时不可调度的账号会预估恢复；错误、限流、过载、停用、暂停调度等状态不计入。',
    '每个时间点的可用账号是累计值：现有可用 + 累计恢复 − 累计到期；“+N / −N”是较上一个时间点的变化，展开可看明细。',
    '5h / 7d 任一进度条 ≥ 90% 即冷却，7d 冷却期间 5h 恢复也不可调度；7d F 不参与判断。',
    '额度按各账号当前 5h / 7d 窗口的已用金额折算到 90% 冷却线估算，窗口不完整也照用；窗口重置后按同样金额恢复。',
    '5h 额度是该时间点可调度账号还能用的金额，假设期间不再消耗；单账号不超过其 7d 剩余。',
    '7d 额度是本周总剩余，冷却账号恢复不会改变它，只有 7d 窗口重置才会增加。',
  );
  if (result.peerEstimatedAccounts > 0) {
    items.push(`${result.peerEstimatedAccounts} 个账号的部分窗口用量太少，按同套餐账号的中位数补齐。`);
  }
  if (result.noSampleAccounts > 0) {
    items.push(`${result.noSampleAccounts} 个账号的部分窗口没有任何样本，该窗口额度按 0 计。`);
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
