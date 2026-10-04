import { defineContentScript } from 'wxt/utils/define-content-script';
import { getSettings } from '../src/shared/storage';
import { generateValues, randomInRange, resolveProfile } from '../src/shared/randomizer';
import type {
  AccountStatusKey,
  ApplyMessage,
  ApplyResult,
  ModifyOptions,
  PluginSettings,
} from '../src/shared/types';

const ACCOUNT_PATH = 'https://sub2api-max.xiaofengai.cc/manager/accounts';

export default defineContentScript({
  matches: [`${ACCOUNT_PATH}*`],
  runAt: 'document_idle',
  main() {
    injectDisplayStyles();
    const modifier = new AccountDomModifier();
    browser.runtime.onMessage.addListener((message: ApplyMessage) => {
      if (message?.type !== 'APPLY_MODIFICATIONS') {
        return undefined;
      }
      return modifier.apply(message.options);
    });
  },
});

class AccountDomModifier {
  async apply(options: ModifyOptions): Promise<ApplyResult> {
    const settings = await getSettings();
    const profile = resolveProfile(
      settings,
      options.subscriptionMode,
      options.customLabel,
      options.customProfile,
    );
    resetGeneratedAccounts();
    applySubsiteOwnerVisibility(settings.clearSubsiteOwner);
    const maskEmail = options.maskEmail || settings.maskAccountEmail;
    if (maskEmail) {
      maskAccountEmails();
    }
    if (options.accountCount) {
      resizeAccountContainers(randomAccountCount(settings), findAllAccountContainers());
    }

    const accounts = findAccountContainers();
    const result: ApplyResult = {
      matched: accounts.length,
      modified: 0,
      skipped: 0,
      details: [],
    };
    const statusPlan =
      options.usage5h || options.usage7d
        ? createStatusPlan(accounts.length, settings.statusRatios)
        : [];

    for (const [index, account] of accounts.entries()) {
      const values = generateValues(profile.profile);
    const changed = modifyAccount(
      account,
      options,
      settings,
      values,
      profile.label,
      profile.profileKey,
      statusPlan[index],
      );
      if (changed > 0) {
        result.modified += 1;
      } else {
        result.skipped += 1;
      }
    }

    syncDerivedDisplay();
    scheduleDerivedDisplaySync();

    const message =
      result.modified > 0
        ? `已修改 ${result.modified} 个账号${result.matched !== result.modified ? `，识别到 ${result.matched} 个` : ''}`
        : '没有识别到可修改的账号卡片或列表行';
    if (settings.notifyAfterApply) {
      showToast(message, result.modified > 0 ? 'success' : 'warning');
    }
    return result;
  }
}

function findAccountContainers(): HTMLElement[] {
  const explicit = findAllAccountContainers().filter(isModifiableAccount);
  if (explicit.length > 0) {
    return explicit;
  }

  const candidates = new Set<HTMLElement>();
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      'input[type="checkbox"], [role="checkbox"], button, [data-testid*="checkbox" i]',
    ),
  );

  for (const control of controls) {
    let current: HTMLElement | null = control;
    for (let depth = 0; current && depth < 10; depth += 1) {
      if (isAccountContainer(current)) {
        candidates.add(current);
        break;
      }
      current = current.parentElement;
    }
  }

  if (candidates.size === 0) {
    for (const element of Array.from(
      document.querySelectorAll<HTMLElement>('article, li, tr, section, [class*="card" i]'),
    )) {
      if (isAccountContainer(element)) {
        candidates.add(element);
      }
    }
  }

  return [...candidates].filter((element) => !hasAccountContainerAncestor(element));
}

function findAllAccountContainers(options: { includePageHidden?: boolean } = {}): HTMLElement[] {
  const explicit = [
    ...Array.from(document.querySelectorAll<HTMLElement>('[data-test="account-card"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('tbody tr[data-row-id]')),
  ];
  const unique = [...new Set(explicit)];
  if (unique.length > 0) {
    return unique.filter((element) => {
      if (element.hasAttribute('data-sub2api-count-hidden')) {
        return false;
      }
      if (options.includePageHidden && element.hasAttribute('data-sub2api-page-hidden')) {
        return true;
      }
      return window.getComputedStyle(element).display !== 'none';
    });
  }

  return Array.from(
    document.querySelectorAll<HTMLElement>('article, li, tr, section, [class*="card" i]'),
  ).filter((element) => isAccountContainer(element));
}

function isModifiableAccount(element: HTMLElement): boolean {
  const text = getElementText(element);
  return /\b5h\b/i.test(text) && /\b7d\b/i.test(text);
}

function syncDerivedDisplay(): void {
  const accounts = findAllAccountContainers({ includePageHidden: true });
  syncStatusTabs(accounts);
  syncPagination(accounts.length);
}

function scheduleDerivedDisplaySync(): void {
  for (const delay of [80, 250, 700, 1200, 2000, 3500]) {
    window.setTimeout(syncDerivedDisplay, delay);
  }
}

function isAccountContainer(element: HTMLElement): boolean {
  const text = getElementText(element);
  if (text.length < 25 || text.length > 2600) {
    return false;
  }
  if (!/\b5h\b/i.test(text) || !/\b7d\b/i.test(text)) {
    return false;
  }
  if (!/(?:今日|累计|并发|Team(?:\s+[SP])?|ChatGPT|Pro|#\d+|@)/i.test(text)) {
    return false;
  }

  const nested = element.querySelectorAll('input[type="checkbox"], [role="checkbox"]').length;
  return nested <= 2;
}

function hasAccountContainerAncestor(element: HTMLElement): boolean {
  let parent = element.parentElement;
  while (parent) {
    if (isAccountContainer(parent)) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function randomAccountCount(settings: PluginSettings): number {
  const min = clampNumber(Math.round(settings.accountCount.min), 0, 500);
  const max = clampNumber(Math.round(settings.accountCount.max), 0, 500);
  return Math.round(randomInRange({ min: Math.min(min, max), max: Math.max(min, max) }));
}

function resetGeneratedAccounts(): void {
  resetGeneratedSevenDayFMetrics();
  restoreMaskedAccountEmails();
  for (const generated of Array.from(
    document.querySelectorAll<HTMLElement>('[data-sub2api-generated-account]'),
  )) {
    generated.remove();
  }
  for (const hidden of Array.from(
    document.querySelectorAll<HTMLElement>('[data-sub2api-count-hidden]'),
  )) {
    hidden.style.display = hidden.dataset.sub2apiOriginalDisplay ?? '';
    delete hidden.dataset.sub2apiOriginalDisplay;
    hidden.removeAttribute('data-sub2api-count-hidden');
  }
  for (const hidden of Array.from(
    document.querySelectorAll<HTMLElement>('[data-sub2api-page-hidden]'),
  )) {
    hidden.style.display = hidden.dataset.sub2apiPageOriginalDisplay ?? '';
    delete hidden.dataset.sub2apiPageOriginalDisplay;
    hidden.removeAttribute('data-sub2api-page-hidden');
  }
}

function maskAccountEmails(): void {
  for (const account of findAllAccountContainers({ includePageHidden: true })) {
    const emailElements = findAccountEmailElements(account);
    const target = emailElements.at(-1);
    if (!target) {
      continue;
    }
    const original = target.dataset.sub2apiOriginalText ?? normalizeText(target);
    const masked = maskEmailValue(original);
    if (masked === original) {
      continue;
    }
    target.dataset.sub2apiOriginalText = original;
    target.dataset.sub2apiEmailMasked = 'true';
    target.textContent = masked;
    target.setAttribute('title', masked);
    target.setAttribute('aria-label', masked);
    target.classList.add('sub2api-display-modified');
  }
}

function restoreMaskedAccountEmails(): void {
  for (const element of Array.from(
    document.querySelectorAll<HTMLElement>('[data-sub2api-email-masked="true"]'),
  )) {
    const original = element.dataset.sub2apiOriginalText;
    if (original) {
      element.textContent = original;
      element.setAttribute('title', original);
      element.setAttribute('aria-label', original);
    }
    delete element.dataset.sub2apiOriginalText;
    delete element.dataset.sub2apiEmailMasked;
  }
}

function findAccountEmailElements(container: HTMLElement): HTMLElement[] {
  return visibleTextElements(container).filter((element) => {
    const text = normalizeText(element);
    if (!/^[^@\s]+@[^@\s]+$/.test(text)) {
      return false;
    }
    return !Array.from(element.children).some((child) =>
      /^[^@\s]+@[^@\s]+$/.test(normalizeText(child as HTMLElement)),
    );
  });
}

function maskEmailValue(value: string): string {
  const at = value.lastIndexOf('@');
  if (at <= 0 || at >= value.length - 1) {
    return value;
  }
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.includes('*')) {
    return value;
  }
  const visibleLength = Math.min(6, local.length);
  const maskedLength = Math.max(0, local.length - visibleLength);
  return `${local.slice(0, visibleLength)}${'*'.repeat(maskedLength)}@${domain}`;
}

function resetGeneratedSevenDayFMetrics(): void {
  for (const metric of Array.from(
    document.querySelectorAll<HTMLElement>('[data-sub2api-generated-7df]'),
  )) {
    metric.remove();
  }
}

function resizeAccountContainers(target: number, current: HTMLElement[]): HTMLElement[] {
  if (current.length === 0) {
    return current;
  }

  if (target < current.length) {
    for (const account of current.slice(target)) {
      account.dataset.sub2apiOriginalDisplay = account.style.display;
      account.dataset.sub2apiCountHidden = 'true';
      account.style.display = 'none';
    }
    return findAllAccountContainers();
  }

  const template = current.find(isModifiableAccount) ?? current[0];
  if (!template) {
    return current;
  }
  const parent = template.parentElement;
  if (!parent) {
    return current;
  }

  for (let index = current.length; index < target; index += 1) {
    const clone = template.cloneNode(true) as HTMLElement;
    clone.dataset.sub2apiGeneratedAccount = 'true';
    clone.removeAttribute('data-sub2api-display-modified');
    clearModifierMarks(clone);
    updateGeneratedIdentity(clone, index);
    parent.append(clone);
  }
  return findAllAccountContainers();
}

function clearModifierMarks(root: HTMLElement): void {
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]) {
    element.classList.remove(
      'sub2api-display-modified',
      'sub2api-percent-low',
      'sub2api-percent-medium',
      'sub2api-percent-high',
    );
    element.removeAttribute('data-sub2api-original-text');
  }
}

function updateGeneratedIdentity(root: HTMLElement, index: number): void {
  const id = 10000 + index;
  const name = `display-account-${index + 1}@example.local`;
  root.dataset.accountId = String(id);
  root.dataset.rowId = String(id);
  root.dataset.index = String(index);

  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>('[data-test="account-card-name"]'),
  )) {
    element.textContent = name;
    element.setAttribute('title', name);
  }
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('td:nth-child(2) span.font-medium'))) {
    element.textContent = name;
    element.setAttribute('title', name);
  }
  for (const element of Array.from(root.querySelectorAll<HTMLElement>('input[aria-label]'))) {
    if (element.getAttribute('aria-label')?.includes('@')) {
      element.setAttribute('aria-label', name);
    }
  }
  for (const element of visibleTextElements(root)) {
    if (/^#\d+$/.test(normalizeText(element))) {
      element.textContent = `#${id}`;
    }
  }
}

function applySubsiteOwnerVisibility(hidden: boolean): void {
  for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    if (normalizeText(element) !== '子站长') {
      continue;
    }
    if (hidden) {
      element.dataset.sub2apiOwnerOriginalDisplay ??= element.style.display;
      element.style.display = 'none';
      element.dataset.sub2apiOwnerHidden = 'true';
    } else if (element.dataset.sub2apiOwnerHidden === 'true') {
      element.style.display = element.dataset.sub2apiOwnerOriginalDisplay ?? '';
      delete element.dataset.sub2apiOwnerOriginalDisplay;
      delete element.dataset.sub2apiOwnerHidden;
    }
  }
}

function syncStatusTabs(accounts: HTMLElement[]): void {
  const counts: Record<AccountStatusKey, number> = {
    active: 0,
    rate_limited: 0,
    temp_unschedulable: 0,
    unschedulable: 0,
    error: 0,
    inactive: 0,
  };
  for (const account of accounts) {
    counts[classifyAccountStatus(account)] += 1;
  }

  const values: Record<string, number> = {
    all: accounts.length,
    active: counts.active,
    rate_limited: counts.rate_limited,
    temp_unschedulable: counts.temp_unschedulable,
    unschedulable: counts.unschedulable,
    error: counts.error,
    inactive: counts.inactive,
  };
  for (const [key, count] of Object.entries(values)) {
    const tab = document.querySelector<HTMLElement>(`[data-test="account-status-tab-${key}"]`);
    const countElement = tab?.querySelector<HTMLElement>('span:last-child');
    if (countElement) {
      countElement.textContent = String(count);
    }
  }
}

function classifyAccountStatus(account: HTMLElement): AccountStatusKey {
  const text = getElementText(account);
  if (/临时不可调度/i.test(text)) {
    return 'temp_unschedulable';
  }
  if (/限流中/i.test(text)) {
    return 'rate_limited';
  }
  if (/不可调度/i.test(text)) {
    return 'unschedulable';
  }
  if (/错误/i.test(text)) {
    return 'error';
  }
  if (/停用/i.test(text)) {
    return 'inactive';
  }
  return 'active';
}

function createStatusPlan(
  count: number,
  ratios: PluginSettings['statusRatios'],
): AccountStatusKey[] {
  if (count <= 0) {
    return [];
  }

  const keys: AccountStatusKey[] = [
    'active',
    'rate_limited',
    'temp_unschedulable',
    'unschedulable',
    'error',
    'inactive',
  ];
  const weights = keys.map((key) => Math.max(0, Number(ratios[key]) || 0));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return Array.from({ length: count }, () => 'active');
  }

  const plan: AccountStatusKey[] = [];
  const remainders: Array<{ key: AccountStatusKey; remainder: number }> = [];
  let assigned = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const weight = weights[index]!;
    const exact = (count * weight) / totalWeight;
    const base = Math.floor(exact);
    assigned += base;
    plan.push(...Array.from({ length: base }, () => key));
    remainders.push({ key, remainder: exact - base });
  }

  remainders.sort((left, right) => right.remainder - left.remainder);
  for (let index = assigned; index < count; index += 1) {
    const remainder = remainders[(index - assigned) % remainders.length]!;
    plan.push(remainder.key);
  }

  for (let index = plan.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = plan[index]!;
    plan[index] = plan[swapIndex]!;
    plan[swapIndex] = current;
  }
  return plan;
}

function syncPagination(total: number): void {
  const summary = findPaginationSummary();
  const summaryValues = summary ? Array.from(summary.querySelectorAll<HTMLElement>('span')) : [];
  const pageSizeText = document.querySelector<HTMLElement>('.page-size-select .select-value')?.textContent;
  const pageSize = Math.max(1, Number.parseInt(pageSizeText ?? '50', 10) || 50);
  const nav = document.querySelector<HTMLElement>('nav[aria-label="Pagination"]');
  if (!nav) {
    updatePaginationSummary(summary, summaryValues, total, pageSize, 1);
    applyVirtualPage(total, pageSize, 1);
    return;
  }
  const previous = nav.querySelector<HTMLButtonElement>('button[aria-label="上一页"]');
  const next = nav.querySelector<HTMLButtonElement>('button[aria-label="下一页"]');
  const template = nav.querySelector<HTMLButtonElement>('button[aria-label^="跳转到第"]');
  for (const pageButton of Array.from(
    nav.querySelectorAll<HTMLButtonElement>('button[aria-label^="跳转到第"]'),
  )) {
    pageButton.remove();
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageAnchor = next ?? null;
  const renderPage = (page: number): void => {
    const safePage = Math.min(totalPages, Math.max(1, page));
    updatePaginationSummary(summary, summaryValues, total, pageSize, safePage);
    applyVirtualPage(total, pageSize, safePage);
    for (const button of Array.from(
      nav.querySelectorAll<HTMLButtonElement>('button[aria-label^="跳转到第"]'),
    )) {
      const buttonPage = Number.parseInt(button.textContent ?? '1', 10) || 1;
      if (buttonPage === safePage) {
        button.setAttribute('aria-current', 'page');
        button.classList.add('z-10', 'bg-[color:var(--tint)]', 'text-[color:var(--tint-text)]');
      } else {
        button.removeAttribute('aria-current');
        button.classList.remove('z-10', 'bg-[color:var(--tint)]', 'text-[color:var(--tint-text)]');
      }
    }
    if (previous) {
      previous.disabled = safePage <= 1;
      previous.onclick = () => renderPage(safePage - 1);
    }
    if (next) {
      next.disabled = safePage >= totalPages;
      next.onclick = () => renderPage(safePage + 1);
    }
  };

  for (let page = 1; page <= totalPages; page += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className =
      template?.className ??
      'relative inline-flex min-w-[2.25rem] items-center justify-center rounded-full px-3 py-1.5 text-sm font-medium';
    button.textContent = String(page);
    button.setAttribute('aria-label', `跳转到第 ${page} 页`);
    button.addEventListener('click', () => renderPage(page));
    nav.insertBefore(button, pageAnchor);
  }
  renderPage(1);
}

function findPaginationSummary(): HTMLElement | undefined {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('p, div, span')).filter(
    (element) => {
      const text = getElementText(element);
      return (
        text.length <= 80 &&
        text.startsWith('显示') &&
        text.includes('至') &&
        text.includes('共') &&
        text.includes('条结果') &&
        (element.querySelectorAll('span').length >= 3 || /\d+/.test(text))
      );
    },
  );

  return candidates.find(
    (element) =>
      !candidates.some((candidate) => candidate !== element && element.contains(candidate)),
  );
}

function updatePaginationSummary(
  summary: HTMLElement | undefined,
  summaryValues: HTMLElement[],
  total: number,
  pageSize: number,
  page: number,
): void {
  const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const end = total === 0 ? 0 : Math.min(total, page * pageSize);
  if (summaryValues.length < 3) {
    if (summary) {
      summary.textContent = `显示 ${start} 至 ${end} 共 ${total} 条结果`;
    }
    return;
  }
  const first = summaryValues[0];
  const last = summaryValues[1];
  const count = summaryValues[2];
  if (!first || !last || !count) {
    if (summary) {
      summary.textContent = `显示 ${start} 至 ${end} 共 ${total} 条结果`;
    }
    return;
  }
  first.textContent = String(start);
  last.textContent = String(end);
  count.textContent = String(total);
}

function applyVirtualPage(total: number, pageSize: number, page: number): void {
  const accounts = findAllAccountContainers({ includePageHidden: true });
  const start = (page - 1) * pageSize;
  const end = Math.min(total, page * pageSize);
  accounts.forEach((account, index) => {
    if (index >= total || index < start || index >= end) {
      account.dataset.sub2apiPageOriginalDisplay ??= account.style.display;
      account.dataset.sub2apiPageHidden = 'true';
      account.style.display = 'none';
      return;
    }
    if (account.dataset.sub2apiPageHidden === 'true') {
      account.style.display = account.dataset.sub2apiPageOriginalDisplay ?? '';
      delete account.dataset.sub2apiPageOriginalDisplay;
      account.removeAttribute('data-sub2api-page-hidden');
    }
  });
}

function modifyAccount(
  container: HTMLElement,
  options: ModifyOptions,
  settings: PluginSettings,
  values: ReturnType<typeof generateValues>,
  label: string,
  profileKey: 'max5x' | 'max20x',
  plannedStatus?: AccountStatusKey,
): number {
  let changed = 0;
  if (plannedStatus) {
    applyStatusConstraints(values, plannedStatus, options);
  }
  const existingSevenDayAmount = findSevenDayAmount(container);
  const sevenDayAmount = options.usage7d ? values.usage7dAmount : existingSevenDayAmount;
  const existingToday = readMoneyValue(findAmountTarget(container, '今日'));
  const todayLimit =
    generatedSurvivalLimit(values.survivalDays, sevenDayAmount, existingToday) ?? undefined;
  const generatedToday =
    todayLimit === undefined ? values.today : Math.min(values.today, todayLimit);
  const effectiveToday = options.today ? generatedToday : existingToday ?? generatedToday;
  const generated = {
    ...values,
    today: generatedToday,
    total:
      todayLimit === undefined
        ? Math.max(values.total, effectiveToday * 2)
        : Math.min(
            Math.max(values.total, effectiveToday * 2),
            Math.max(todayLimit, effectiveToday),
          ),
    usage5h:
      !options.today && hasPositiveTodayAmount(container)
        ? Math.max(1, values.usage5h)
        : values.usage5h,
  };

  if (options.subscription && setSubscriptionLabel(container, label)) {
    changed += 1;
  }
  if (options.usage5h && setUsagePercent(container, '5h', generated.usage5h)) {
    changed += 1;
  }
  if (
    options.usage5h &&
    setUsageAmount(container, '5h', generated.usage5hAmount, settings)
  ) {
    changed += 1;
  }
  if (options.usage7d && setUsagePercent(container, '7d', generated.usage7d)) {
    changed += 1;
  }
  if (
    options.usage7d &&
    setUsageAmount(container, '7d', generated.usage7dAmount, settings)
  ) {
    changed += 1;
  }
  const shouldModifySevenDayF =
    options.usage7dF || profileKey === 'max20x';
  if (
    shouldModifySevenDayF &&
    (profileKey === 'max20x' || findMetricValue(container, '7d F'))
  ) {
    if (profileKey === 'max20x') {
      ensureSevenDayFMetric(container);
    }
    if (setUsagePercent(container, '7d F', generated.usage7dF)) {
      changed += 1;
    }
  }
  if (options.survivalDays && setSurvivalDays(container, generated.survivalDays)) {
    changed += 1;
  }
  if (options.today && setAmount(container, '今日', generated.today, settings)) {
    changed += 1;
  }
  if (options.total && setAmount(container, '累计', generated.total, settings)) {
    changed += 1;
  }
  if (
    options.concurrency &&
    setConcurrency(container, generated.concurrencyCurrent, generated.concurrencyTotal)
  ) {
    changed += 1;
  }

  const usage5h = readMetricPercent(container, '5h');
  const usage7d = readMetricPercent(container, '7d');
  const temporaryByQuotaRule =
    usage5h !== undefined &&
    usage7d !== undefined &&
    (usage5h === 100 || usage7d === 90);
  const shouldBeTemporary =
    plannedStatus === 'temp_unschedulable' || temporaryByQuotaRule;
  if (shouldBeTemporary) {
    changed += capAllProgressPercentages(container, 90);
    const concurrencyTotal =
      options.concurrency
        ? generated.concurrencyTotal
        : findConcurrencyTotal(container) ?? generated.concurrencyTotal;
    if (setConcurrency(container, 0, concurrencyTotal)) {
      changed += 1;
    }
    if (setAccountStatus(container, 'temp_unschedulable')) {
      changed += 1;
    }
  } else if (plannedStatus) {
    if (setAccountStatus(container, plannedStatus)) {
      changed += 1;
    }
  } else if (usage5h !== undefined && usage7d !== undefined) {
    if (setAvailabilityStatus(container, false)) {
      changed += 1;
    }
  }

  if (changed > 0) {
    container.dataset.sub2apiDisplayModified = 'true';
  }
  return changed;
}

function applyStatusConstraints(
  values: ReturnType<typeof generateValues>,
  status: AccountStatusKey,
  options: ModifyOptions,
): void {
  if (status === 'temp_unschedulable') {
    values.usage5h = Math.min(90, values.usage5h);
    values.usage7d = Math.min(90, values.usage7d);
    values.usage7dF = Math.min(90, values.usage7dF);
    if (options.usage7d) {
      values.usage7d = 90;
    }
    return;
  }

  if (status === 'rate_limited') {
    if (options.usage5h) {
      values.usage5h = 90 + Math.floor(Math.random() * 10);
    }
    if (options.usage7d) {
      values.usage7d = Math.min(89, values.usage7d);
    }
    return;
  }

  if (options.usage5h && values.usage5h === 100) {
    values.usage5h = 99;
  }
  if (options.usage7d && values.usage7d === 90) {
    values.usage7d = 89;
  }
}

function hasPositiveTodayAmount(container: HTMLElement): boolean {
  const today = readMoneyValue(findAmountTarget(container, '今日'));
  return today !== undefined && today > 0;
}

function setSubscriptionLabel(container: HTMLElement, label: string): boolean {
  const candidates = visibleTextElements(container).filter((element) =>
    /^(?:Team(?:\s+[SP])?|Pro|ChatGPT|max(?:\s+\w+)?)$/i.test(normalizeText(element)),
  );
  const target = candidates[0];
  if (!target) {
    return false;
  }
  const toneClass = /20x/i.test(label)
    ? 'sub2api-subscription-tag-20x'
    : /5x/i.test(label)
      ? 'sub2api-subscription-tag-5x'
      : 'sub2api-subscription-tag-custom';
  const sameLabel = normalizeText(target) === label;
  const hadTag = target.classList.contains('sub2api-subscription-tag');
  target.dataset.sub2apiOriginalText ??= target.textContent?.trim() ?? '';
  target.textContent = label;
  target.setAttribute('title', label);
  target.classList.add('sub2api-display-modified', 'sub2api-subscription-tag');
  target.classList.remove(
    'sub2api-subscription-tag-5x',
    'sub2api-subscription-tag-20x',
    'sub2api-subscription-tag-custom',
  );
  target.classList.add(toneClass);
  return !sameLabel || !hadTag;
}

type UsageMetricLabel = '5h' | '7d' | '7d F';

function setUsagePercent(container: HTMLElement, label: UsageMetricLabel, value: number): boolean {
  const target = findMetricValue(container, label);
  if (!target) {
    return false;
  }
  const next = `${Math.round(value)}%`;
  const sameValue = normalizeText(target) === next;
  if (!sameValue) {
    target.dataset.sub2apiOriginalText ??= target.textContent?.trim() ?? '';
    target.textContent = next;
  }
  target.classList.remove('sub2api-percent-low', 'sub2api-percent-medium', 'sub2api-percent-high');
  target.classList.add(`sub2api-percent-${percentTone(value)}`);
  target.setAttribute('title', `随机展示值：${next}`);

  const row = findMetricRow(target, label) ?? target.parentElement;
  if (row) {
    updateMetricAccessibility(row, label, next);
    row.classList.add('sub2api-display-modified');
    updateProgressBars(row, value);
  }
  return !sameValue;
}

function capAllProgressPercentages(container: HTMLElement, maximum: number): number {
  let changed = 0;
  for (const label of ['5h', '7d', '7d F'] as const) {
    const current = readMetricPercent(container, label);
    if (current === undefined || current <= maximum) {
      if (current !== undefined) {
        setUsagePercent(container, label, current);
      }
      continue;
    }
    if (setUsagePercent(container, label, maximum)) {
      changed += 1;
    }
  }
  return changed;
}

function updateProgressBars(row: HTMLElement, value: number): void {
  const width = `${Math.round(value)}%`;
  const color = toneColor(value);
  const bars = findProgressBars(row);

  for (const bar of bars) {
    // The page uses inline width bindings for its bars. Reassert the value
    // with !important so a framework refresh cannot leave the bar stale.
    bar.style.setProperty('width', width, 'important');
    bar.style.setProperty('background-color', color, 'important');
    bar.style.setProperty('transition', 'none', 'important');
    bar.setAttribute('aria-valuenow', String(Math.round(value)));
  }
}

function ensureSevenDayFMetric(container: HTMLElement): boolean {
  if (findMetricValue(container, '7d F')) {
    return true;
  }

  const sevenDayValue = findMetricValue(container, '7d');
  const sevenDayRow = sevenDayValue ? findMetricRow(sevenDayValue, '7d') : undefined;
  if (!sevenDayRow) {
    return false;
  }

  if (sevenDayRow.getAttribute('data-test') === 'compact-primary') {
    const clone = sevenDayRow.cloneNode(true) as HTMLElement;
    prepareGeneratedSevenDayFRow(clone);
    clone.setAttribute('data-sub2api-generated-7df', 'true');
    sevenDayRow.after(clone);
    return true;
  }

  const wrapper = sevenDayRow.parentElement;
  if (!wrapper) {
    return false;
  }
  const clone = wrapper.cloneNode(true) as HTMLElement;
  const clonedRow = clone.querySelector<HTMLElement>('.flex.items-center') ?? clone;
  prepareGeneratedSevenDayFRow(clonedRow);
  clone.setAttribute('data-sub2api-generated-7df', 'true');
  wrapper.after(clone);
  return true;
}

function prepareGeneratedSevenDayFRow(row: HTMLElement): void {
  row.setAttribute('title', '7d F');
  row.setAttribute('data-test', 'compact-secondary');
  row.className = row.className.replace(
    /grid-cols-\[[^\]]+\]/,
    'grid-cols-[2.75rem_minmax(0,1fr)_2.25rem]',
  );

  const children = Array.from(row.children) as HTMLElement[];
  const label = children[0];
  if (label) {
    label.textContent = '7d F';
    label.classList.remove(
      'bg-indigo-100',
      'text-indigo-700',
      'dark:bg-indigo-900/40',
      'dark:text-indigo-300',
      'bg-emerald-100',
      'text-emerald-700',
      'dark:bg-emerald-900/40',
      'dark:text-emerald-300',
    );
    label.classList.add(
      'bg-amber-100',
      'text-amber-700',
      'dark:bg-amber-900/40',
      'dark:text-amber-300',
    );
  }
  for (const child of children.slice(3)) {
    child.remove();
  }
}

function setAmount(
  container: HTMLElement,
  label: '今日' | '累计',
  value: number,
  settings: PluginSettings,
): boolean {
  const amounts = findCurrencyElements(container);
  if (amounts.length === 0) {
    return false;
  }

  const labeled = findLabeledAmount(container, label);
  const target =
    findAmountTarget(container, label) ??
    labeled ??
    (label === '今日' ? amounts.at(-2) : amounts.at(-1));
  if (!target) {
    return false;
  }

  const original = target.textContent?.trim() ?? '';
  const next = replaceMoneyValue(original, value, settings);
  if (next === original) {
    return false;
  }
  target.dataset.sub2apiOriginalText ??= original;
  target.textContent = next;
  target.classList.add('sub2api-display-modified');
  return true;
}

function setUsageAmount(
  container: HTMLElement,
  label: UsageMetricLabel,
  value: number,
  settings: PluginSettings,
): boolean {
  const metric = findMetricValue(container, label);
  const row = metric ? findMetricRow(metric, label) : undefined;
  const target =
    row?.querySelector<HTMLElement>('[data-test="estimated-total-cost"]') ??
    (row ? findCurrencyElements(row)[0] : undefined);
  if (!target) {
    return false;
  }

  const original = target.textContent?.trim() ?? '';
  const next = formatUsageMoney(original, value, settings);
  if (next === original) {
    return false;
  }
  target.dataset.sub2apiOriginalText ??= original;
  target.textContent = next;
  target.classList.add('sub2api-display-modified');
  if (row) {
    updateUsageAmountAccessibility(row, value, settings);
  }
  return true;
}

function formatUsageMoney(
  original: string,
  value: number,
  settings: PluginSettings,
): string {
  const decimals = Math.max(0, Math.min(4, Math.round(settings.decimals)));
  const formatted = value.toFixed(decimals);
  const prefix = original.match(/^(?:US\$|[$¥￥])\s*/)?.[0] ?? settings.currency;
  return `${prefix}${formatted}`;
}

function updateUsageAmountAccessibility(
  row: HTMLElement,
  value: number,
  settings: PluginSettings,
): void {
  const formatted = formatUsageMoney('', value, settings);
  for (const element of [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]) {
    for (const attribute of ['aria-label', 'title']) {
      const current = element.getAttribute(attribute);
      if (!current) {
        continue;
      }
      if (/(?:US\$|[$¥￥])\s*\d[\d,]*(?:\.\d+)?/.test(current)) {
        element.setAttribute(
          attribute,
          current.replace(/(?:US\$|[$¥￥])\s*\d[\d,]*(?:\.\d+)?/, formatted),
        );
      }
    }
  }
}

function setSurvivalDays(container: HTMLElement, days: number): boolean {
  const text = days < 1 ? '不到 1 天' : `${Math.round(days)} 天`;
  const targets = [
    ...Array.from(container.querySelectorAll<HTMLElement>('[data-test="account-card-fact-age"]')),
    ...Array.from(container.querySelectorAll<HTMLElement>('[data-test="account-lifetime-age"]')),
  ];
  if (targets.length === 0) {
    const fallback = visibleTextElements(container).find((element) =>
      /^(?:不到 1 天|\d+\s*天)$/.test(normalizeText(element)),
    );
    if (fallback) {
      targets.push(fallback);
    }
  }
  const target = targets[0];
  if (!target || normalizeText(target) === text) {
    return false;
  }
  target.dataset.sub2apiOriginalText ??= target.textContent?.trim() ?? '';
  target.textContent = text;
  target.setAttribute('title', `随机展示存活时间：${text}`);
  target.classList.add('sub2api-display-modified');
  return true;
}

function generatedSurvivalLimit(
  survivalDays: number,
  sevenDayAmount: number | undefined,
  _existingToday: number | undefined,
): number | undefined {
  return survivalDays < 7 ? sevenDayAmount : undefined;
}

function findAmountTarget(container: HTMLElement, label: '今日' | '累计'): HTMLElement | undefined {
  if (label === '今日') {
    const cardTarget = container.querySelector<HTMLElement>('[data-test="account-card-fact-today"]');
    if (cardTarget) {
      return cardTarget;
    }
    const stats = container.querySelector<HTMLElement>('[data-test="today-stats-compact"]');
    const statAmounts = stats ? findCurrencyElements(stats) : [];
    if (statAmounts.length > 0) {
      return statAmounts.at(-1);
    }
  } else {
    const cardTarget = container.querySelector<HTMLElement>(
      '[data-test="account-card-fact-lifetime"]',
    );
    if (cardTarget) {
      return cardTarget;
    }
    const tableTarget = container.querySelector<HTMLElement>('[data-test="account-lifetime-cost"]');
    if (tableTarget) {
      return tableTarget;
    }
  }
  return undefined;
}

function findSevenDayAmount(container: HTMLElement): number | undefined {
  const usageRows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-test="compact-primary"]'),
  );
  for (const row of usageRows) {
    const label = row.querySelector<HTMLElement>('span')?.textContent?.trim().toLowerCase();
    if (label !== '7d') {
      continue;
    }
    const amount = row.querySelector<HTMLElement>('[data-test="estimated-total-cost"]');
    const parsed = readMoneyValue(amount ?? undefined);
    if (parsed !== undefined) {
      return parsed;
    }
  }

  const metric = findMetricValue(container, '7d');
  const row = metric ? findMetricRow(metric, '7d') : undefined;
  const amount = row ? findCurrencyElements(row)[0] : undefined;
  return readMoneyValue(amount);
}

function readMoneyValue(element: HTMLElement | undefined): number | undefined {
  if (!element) {
    return undefined;
  }
  const match = normalizeText(element).match(/\d[\d,]*(?:\.\d+)?/);
  return match ? Number(match[0].replace(/,/g, '')) : undefined;
}

function setConcurrency(container: HTMLElement, current: number, total: number): boolean {
  const ratio = `${current}/${total}`;
  const labeledRatio = findConcurrencyRatioElement(container);

  if (labeledRatio) {
    if (normalizeText(labeledRatio) === ratio) {
      return false;
    }
    labeledRatio.dataset.sub2apiOriginalText ??= labeledRatio.textContent?.trim() ?? '';
    labeledRatio.textContent = ratio;
    labeledRatio.classList.add('sub2api-display-modified');
    return true;
  }

  const combined = visibleTextElements(container).find((element) => {
    const text = normalizeText(element);
    return /并发/i.test(text) && /\d+\s*\/\s*\d+/.test(text);
  });
  if (!combined) {
    return false;
  }
  const original = combined.textContent ?? '';
  const next = original.replace(/(并发\b[^0-9/]*)\d+\s*\/\s*\d+/, `$1${ratio}`);
  if (next === original) {
    return false;
  }
  combined.dataset.sub2apiOriginalText ??= original.trim();
  combined.textContent = next;
  combined.classList.add('sub2api-display-modified');
  return true;
}

function findConcurrencyRatioElement(container: HTMLElement): HTMLElement | undefined {
  const ratioElements = visibleTextElements(container).filter((element) =>
    /^\d+\s*\/\s*\d+$/.test(normalizeText(element)),
  );
  return ratioElements.find((element) => isConcurrencyRatio(element));
}

function findConcurrencyTotal(container: HTMLElement): number | undefined {
  const ratio = findConcurrencyRatioElement(container);
  const ratioMatch = ratio
    ? normalizeText(ratio).match(/^\d+\s*\/\s*(\d+)$/)
    : undefined;
  const combined = visibleTextElements(container).find((element) => {
    const text = normalizeText(element);
    return /并发/i.test(text) && /\d+\s*\/\s*\d+/.test(text);
  });
  const match =
    ratioMatch ??
    (combined
      ? normalizeText(combined).match(/\d+\s*\/\s*(\d+)/)
      : undefined);
  if (!match) {
    return undefined;
  }
  const total = Number(match[1]);
  return Number.isFinite(total) && total >= 1 ? total : undefined;
}

function readMetricPercent(container: HTMLElement, label: UsageMetricLabel): number | undefined {
  const target = findMetricValue(container, label);
  if (!target) {
    return undefined;
  }
  const match = normalizeText(target).match(/\d{1,3}/);
  return match ? Number(match[0]) : undefined;
}

function setAvailabilityStatus(container: HTMLElement, temporary: boolean): boolean {
  const current = findAvailabilityStatusElement(container);
  const currentText = current ? normalizeText(current) : '';
  const isKnownStatus = currentText === '正常' || currentText === '临时不可调度';
  if (current && !isKnownStatus) {
    return false;
  }

  return setAccountStatus(
    container,
    temporary ? 'temp_unschedulable' : 'active',
  );
}

function setAccountStatus(container: HTMLElement, status: AccountStatusKey): boolean {
  const current = findAccountStatusElement(container);
  const currentText = current ? normalizeText(current) : '';
  const nextText = accountStatusLabel(status);
  if (currentText === nextText) {
    return false;
  }
  const statusRoot =
    container.querySelector<HTMLElement>('[data-test="account-card-status"]') ??
    current?.closest('td') ??
    current?.parentElement;
  if (!statusRoot) {
    return false;
  }

  const line =
    current?.closest<HTMLElement>('div.flex.items-center') ??
    statusRoot.querySelector<HTMLElement>('div.flex.items-center') ??
    statusRoot;
  const badge = document.createElement('span');
  if (status === 'temp_unschedulable') {
    badge.title = '根据 5h / 7d 展示百分比自动计算';
  }
  badge.className = `badge text-xs ${statusClass(status)}`;
  badge.textContent = nextText;
  badge.dataset.sub2apiDisplayModified = 'true';
  line.replaceChildren(badge);
  return true;
}

function findAvailabilityStatusElement(container: HTMLElement): HTMLElement | undefined {
  return [container, ...Array.from(container.querySelectorAll<HTMLElement>('*'))].find((element) => {
    const text = normalizeText(element);
    return text === '正常' || text === '临时不可调度';
  });
}

function findAccountStatusElement(container: HTMLElement): HTMLElement | undefined {
  return [container, ...Array.from(container.querySelectorAll<HTMLElement>('*'))].find((element) => {
    const text = normalizeText(element);
    return (
      text === '正常' ||
      text === '限流中' ||
      text === '临时不可调度' ||
      text === '不可调度' ||
      text === '错误' ||
      text === '停用'
    );
  });
}

function accountStatusLabel(status: AccountStatusKey): string {
  const labels: Record<AccountStatusKey, string> = {
    active: '正常',
    rate_limited: '限流中',
    temp_unschedulable: '临时不可调度',
    unschedulable: '不可调度',
    error: '错误',
    inactive: '停用',
  };
  return labels[status];
}

function statusClass(status: AccountStatusKey): string {
  const classes: Record<AccountStatusKey, string> = {
    active: 'badge-success',
    rate_limited: 'sub2api-status-rate',
    temp_unschedulable: 'badge-warning',
    unschedulable: 'sub2api-status-unavailable',
    error: 'sub2api-status-error',
    inactive: 'sub2api-status-inactive',
  };
  return classes[status];
}

function findMetricValue(container: HTMLElement, label: UsageMetricLabel): HTMLElement | undefined {
  const labels = visibleTextElements(container).filter((element) => {
    const text = normalizeText(element).toLowerCase();
    return text === label.toLowerCase();
  });

  for (const labelElement of labels) {
    let parent: HTMLElement | null = labelElement;
    for (let depth = 0; parent && depth < 6; depth += 1) {
      const values = percentElements(parent);
      if (values.length === 1) {
        return values[0];
      }
      if (values.length > 1 && depth >= 2) {
        return values[0];
      }
      parent = parent.parentElement;
    }
  }

  if (label === '5h') {
    return percentElements(container)[0];
  }
  if (label === '7d') {
    return percentElements(container)[1];
  }
  return undefined;
}

function findMetricRow(value: HTMLElement, label: string): HTMLElement | undefined {
  let parent: HTMLElement | null = value.parentElement;
  for (let depth = 0; parent && depth < 5; depth += 1) {
    const text = getElementText(parent);
    if (text.toLowerCase().includes(label.toLowerCase()) && percentElements(parent).length <= 1) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return undefined;
}

function findProgressBars(row: HTMLElement): HTMLElement[] {
  return Array.from(row.querySelectorAll<HTMLElement>('*')).filter((element) => {
    const className = typeof element.className === 'string' ? element.className : '';
    const style = element.getAttribute('style') ?? '';
    return (
      element.getAttribute('role') === 'progressbar' ||
      /progress|bar|track/i.test(className) ||
      /(?:^|;)\s*width\s*:/i.test(style)
    );
  });
}

function findLabeledAmount(container: HTMLElement, label: '今日' | '累计'): HTMLElement | undefined {
  const labels = visibleTextElements(container).filter((element) => normalizeText(element) === label);
  for (const labelElement of labels) {
    let parent: HTMLElement | null = labelElement;
    for (let depth = 0; parent && depth < 5; depth += 1) {
      const amounts = findCurrencyElements(parent);
      if (amounts.length === 1) {
        return amounts[0];
      }
      parent = parent.parentElement;
    }
  }
  return undefined;
}

function percentElements(root: HTMLElement): HTMLElement[] {
  return visibleTextElements(root).filter((element) => /^\d{1,3}%$/.test(normalizeText(element)));
}

function findCurrencyElements(root: HTMLElement): HTMLElement[] {
  const candidates = visibleTextElements(root).filter((element) =>
    /(?:US\$|[$¥￥])\s*\d[\d,]*(?:\.\d+)?/.test(normalizeText(element)),
  );
  return candidates.filter(
    (element) =>
      !Array.from(element.querySelectorAll<HTMLElement>('*')).some((descendant) =>
        /(?:US\$|[$¥￥])\s*\d[\d,]*(?:\.\d+)?/.test(normalizeText(descendant)),
      ),
  );
}

function isConcurrencyRatio(element: HTMLElement): boolean {
  let parent = element.parentElement;
  for (let depth = 0; parent && depth < 4; depth += 1) {
    const text = getElementText(parent);
    if (/并发/i.test(text) && !/会话/i.test(text)) {
      return true;
    }
    if (/会话/i.test(text) && !/并发/i.test(text)) {
      return false;
    }
    parent = parent.parentElement;
  }
  return false;
}

function updateMetricAccessibility(row: HTMLElement, label: UsageMetricLabel, value: string): void {
  for (const element of [row, ...Array.from(row.querySelectorAll<HTMLElement>('*'))]) {
    for (const attribute of ['aria-label', 'title']) {
      const current = element.getAttribute(attribute);
      if (
        current &&
        current.toLowerCase().includes(label.toLowerCase()) &&
        /\d{1,3}%/.test(current)
      ) {
        element.setAttribute(attribute, current.replace(/\d{1,3}%/, value));
      }
    }
  }
}

function visibleTextElements(root: HTMLElement): HTMLElement[] {
  return [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter((element) => {
    const text = normalizeText(element);
    if (!text || text.length > 120) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function replaceMoneyValue(original: string, value: number, settings: PluginSettings): string {
  const decimals = Math.max(0, Math.min(4, Math.round(settings.decimals)));
  const formatted = value.toFixed(decimals);
  return original.replace(/\d[\d,]*(?:\.\d+)?/, formatted);
}

function getElementText(element: HTMLElement): string {
  return (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
}

function normalizeText(element: HTMLElement): string {
  return (element.textContent || '').replace(/\s+/g, ' ').trim();
}

function percentTone(value: number): 'low' | 'medium' | 'high' {
  if (value <= 60) {
    return 'low';
  }
  if (value <= 80) {
    return 'medium';
  }
  return 'high';
}

function toneColor(value: number): string {
  const tone = percentTone(value);
  if (tone === 'low') {
    return '#19b46b';
  }
  if (tone === 'medium') {
    return '#f59e0b';
  }
  return '#ef4444';
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function showToast(message: string, type: 'success' | 'warning'): void {
  const existing = document.querySelector<HTMLElement>('[data-sub2api-toast]');
  existing?.remove();
  const toast = document.createElement('div');
  toast.dataset.sub2apiToast = 'true';
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed',
    top: '18px',
    right: '18px',
    zIndex: '2147483647',
    padding: '10px 16px',
    borderRadius: '10px',
    color: '#fff',
    background: type === 'success' ? '#12895c' : '#b45309',
    boxShadow: '0 12px 36px rgba(15, 23, 42, .18)',
    font: '600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  document.body.append(toast);
  window.clearTimeout(thisToastTimer);
  thisToastTimer = window.setTimeout(() => toast.remove(), 2600);
}

let thisToastTimer: number | undefined;

function injectDisplayStyles(): void {
  if (document.querySelector('style[data-sub2api-display-styles]')) {
    return;
  }
  const style = document.createElement('style');
  style.dataset.sub2apiDisplayStyles = 'true';
  style.textContent = `
    .sub2api-display-modified { transition: color .15s ease, background-color .15s ease; }
    .sub2api-percent-low { color: #16a365 !important; }
    .sub2api-percent-medium { color: #d97706 !important; }
    .sub2api-percent-high { color: #ef4444 !important; }
    .sub2api-subscription-tag {
      display: inline-flex !important;
      align-items: center;
      border-radius: 999px;
      padding: 1px 6px;
      font-weight: 700 !important;
      line-height: 1.35;
    }
    .sub2api-subscription-tag-5x {
      color: #4f46e5 !important;
      background: #eef2ff !important;
    }
    .sub2api-subscription-tag-20x {
      color: #047857 !important;
      background: #d1fae5 !important;
    }
    .sub2api-subscription-tag-custom {
      color: #b45309 !important;
      background: #fef3c7 !important;
    }
    .sub2api-status-rate {
      color: #1d4ed8 !important;
      background: #dbeafe !important;
    }
    .sub2api-status-unavailable,
    .sub2api-status-error {
      color: #b91c1c !important;
      background: #fee2e2 !important;
    }
    .sub2api-status-inactive {
      color: #475569 !important;
      background: #e2e8f0 !important;
    }
  `;
  document.head.append(style);
}
