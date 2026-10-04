import { defaultSettings } from '../../src/shared/defaults';
import { getSettings, saveSettings } from '../../src/shared/storage';
import type { NumberRange, PluginSettings, SubscriptionProfile } from '../../src/shared/types';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Options mount point is missing');
}

void renderOptions(app);

async function renderOptions(root: HTMLDivElement): Promise<void> {
  const settings = await getSettings();
  root.innerHTML = `
    <div class="page">
      <header class="page-header">
        <div>
          <p class="eyebrow">SUB2API DISPLAY TOOL / SETTINGS</p>
          <h1>账号显示调节器</h1>
          <p class="subtitle">为 max 5x、max 20x 分别设置随机展示范围，修改只作用于当前页面 DOM。</p>
        </div>
        <div class="header-actions">
          <button class="button secondary" id="reset">恢复默认</button>
          <button class="button primary" id="save">保存设置</button>
        </div>
      </header>

      <section class="notice">
        <span class="notice-icon">i</span>
        <span>5h / 7d 百分比每次纯随机，下面配置的是对应的美元金额范围。7d F 不单独配置，选择 max 20x 时会自动生成。</span>
      </section>

      <section class="settings-grid">
        ${profileMarkup('max5x', 'max 5x', '适合较轻量的账号展示')}
        ${profileMarkup('max20x', 'max 20x', '适合较高额度的账号展示')}
      </section>

      <section class="card">
        <div class="card-heading">
          <div>
            <h2>账号数量与页面元素</h2>
            <p>popup 勾选“账号数量”后，会在这个区间内随机生成展示数量，并同步状态统计与分页。</p>
          </div>
        </div>
        <div class="inline-fields">
          <div class="range-field standalone-range">
            <div class="range-label">
              <span>账号数量范围</span>
              <small>最小和最大值都会包含在随机结果内</small>
            </div>
            <div class="range-inputs">
              <input class="input number-input" id="account-count-min" type="number" min="0" max="500" step="1" />
              <span>至</span>
              <input class="input number-input" id="account-count-max" type="number" min="0" max="500" step="1" />
            </div>
          </div>
          <label class="toggle-field">
            <input id="clear-owner" type="checkbox" />
            <span class="toggle" aria-hidden="true"></span>
            <span>
              <strong>隐藏右上角子站长标识</strong>
              <small>只隐藏页面右上角的“子站长”文字，不改变账号数据</small>
            </span>
          </label>
          <label class="toggle-field">
            <input id="mask-email" type="checkbox" />
            <span class="toggle" aria-hidden="true"></span>
            <span>
              <strong>账号邮箱部分脱敏</strong>
              <small>只显示邮箱前 6 个字符，后面的本地部分用星号隐藏</small>
            </span>
          </label>
        </div>
      </section>

      <section class="card">
        <div class="card-heading">
          <div>
            <h2>账号状态比例</h2>
            <p>按权重随机分配状态；默认临时不可调度 30、限流 10、正常 50，其余状态为 0。</p>
          </div>
        </div>
        <div class="range-grid">
          ${statusRatioMarkup('temp_unschedulable', '临时不可调度')}
          ${statusRatioMarkup('rate_limited', '限流中')}
          ${statusRatioMarkup('active', '正常')}
          ${statusRatioMarkup('unschedulable', '不可调度')}
          ${statusRatioMarkup('error', '错误')}
          ${statusRatioMarkup('inactive', '停用')}
        </div>
      </section>

      <section class="card">
        <div class="card-heading">
          <div>
            <h2>自定义订阅类型</h2>
            <p>popup 中选择“自定义”时使用这里的名称和随机范围。</p>
          </div>
        </div>
        <div class="inline-fields">
          <label class="field">
            <span>显示名称</span>
            <input class="input" id="custom-label" type="text" />
          </label>
          <label class="field">
            <span>使用哪组范围</span>
            <select class="input" id="custom-profile">
              <option value="max5x">max 5x 范围</option>
              <option value="max20x">max 20x 范围</option>
            </select>
          </label>
        </div>
      </section>

      <section class="card">
        <div class="card-heading">
          <div>
            <h2>显示格式</h2>
            <p>金额会尽量沿用页面原本的货币前缀。</p>
          </div>
        </div>
        <div class="inline-fields three">
          <label class="field">
            <span>默认货币符号</span>
            <input class="input" id="currency" type="text" maxlength="5" />
          </label>
          <label class="field">
            <span>金额小数位</span>
            <input class="input" id="decimals" type="number" min="0" max="4" step="1" />
          </label>
          <label class="toggle-field">
            <input id="notify" type="checkbox" />
            <span class="toggle" aria-hidden="true"></span>
            <span>
              <strong>修改后提示</strong>
              <small>页面右上角显示完成数量</small>
            </span>
          </label>
        </div>
      </section>

      <p class="save-status" id="save-status" role="status"></p>
    </div>
  `;

  hydrateForm(settings);

  document.querySelector<HTMLButtonElement>('#save')?.addEventListener('click', () => {
    const nextSettings = readForm(settings);
    void saveSettings(nextSettings).then(() => {
      setStatus('设置已保存，下次点击一键修改时生效', 'success');
    });
  });

  document.querySelector<HTMLButtonElement>('#reset')?.addEventListener('click', () => {
    hydrateForm(structuredClone(defaultSettings));
    setStatus('已恢复默认值，点击保存后生效', 'neutral');
  });
}

function profileMarkup(profile: SubscriptionProfile, title: string, description: string): string {
  return `
    <section class="card profile-card" data-profile="${profile}">
      <div class="card-heading">
        <div>
          <div class="title-line">
            <h2>${title}</h2>
            <span class="tag">${profile === 'max5x' ? '基础档' : '高额度档'}</span>
          </div>
          <p>${description}</p>
        </div>
      </div>
      <div class="range-grid">
        ${rangeMarkup(profile, 'usage5h', '5h 金额范围（美元）', 0, 10000, '百分比纯随机，金额从此范围生成')}
        ${rangeMarkup(profile, 'usage7d', '7d 金额范围（美元）', 0, 10000, '百分比纯随机，金额从此范围生成')}
        ${rangeMarkup(profile, 'survivalDays', '存活时间（天）', 0, 365, '每个账号单独随机生成')}
        ${rangeMarkup(profile, 'today', '今日消耗', 0, 10000, '每次先生成今日消耗')}
        ${rangeMarkup(profile, 'totalExtra', '累计增量', 0, 10000, '累计值 = 今日消耗 + 这里的随机增量')}
        ${rangeMarkup(profile, 'concurrencyTotal', '并发总数', 1, 50, '当前占用值不会超过它')}
      </div>
    </section>
  `;
}

function rangeMarkup(
  profile: SubscriptionProfile,
  key: keyof Pick<
    PluginSettings['profiles']['max5x'],
    'usage5h' | 'usage7d' | 'survivalDays' | 'today' | 'totalExtra' | 'concurrencyTotal'
  >,
  label: string,
  min: number,
  max: number,
  description: string,
): string {
  return `
    <div class="range-field">
      <div class="range-label">
        <span>${label}</span>
        <small>${description}</small>
      </div>
      <div class="range-inputs">
        <input class="input number-input" id="${profile}-${key}-min" type="number" min="${min}" max="${max}" step="${key === 'concurrencyTotal' || key === 'survivalDays' ? 1 : '0.01'}" />
        <span>至</span>
        <input class="input number-input" id="${profile}-${key}-max" type="number" min="${min}" max="${max}" step="${key === 'concurrencyTotal' || key === 'survivalDays' ? 1 : '0.01'}" />
      </div>
    </div>
  `;
}

function statusRatioMarkup(
  key:
    | 'active'
    | 'rate_limited'
    | 'temp_unschedulable'
    | 'unschedulable'
    | 'error'
    | 'inactive',
  label: string,
): string {
  return `
    <label class="field">
      <span>${label}权重</span>
      <small>填 0 表示不主动生成</small>
      <input class="input number-input" id="status-ratio-${key}" type="number" min="0" max="100" step="1" />
    </label>
  `;
}

function hydrateForm(settings: PluginSettings): void {
  for (const profile of ['max5x', 'max20x'] as const) {
    const profileSettings = settings.profiles[profile];
    for (const key of [
      'usage5h',
      'usage7d',
      'survivalDays',
      'today',
      'totalExtra',
      'concurrencyTotal',
    ] as const) {
      setInput(`${profile}-${key}-min`, profileSettings[key].min);
      setInput(`${profile}-${key}-max`, profileSettings[key].max);
    }
  }
  setInput('account-count-min', settings.accountCount.min);
  setInput('account-count-max', settings.accountCount.max);
  for (const key of [
    'active',
    'rate_limited',
    'temp_unschedulable',
    'unschedulable',
    'error',
    'inactive',
  ] as const) {
    setInput(`status-ratio-${key}`, settings.statusRatios[key]);
  }
  setInput('custom-label', settings.customLabel);
  setInput('custom-profile', settings.customProfile);
  setInput('currency', settings.currency);
  setInput('decimals', settings.decimals);
  const notify = document.querySelector<HTMLInputElement>('#notify');
  if (notify) {
    notify.checked = settings.notifyAfterApply;
  }
  const clearOwner = document.querySelector<HTMLInputElement>('#clear-owner');
  if (clearOwner) {
    clearOwner.checked = settings.clearSubsiteOwner;
  }
  const maskEmail = document.querySelector<HTMLInputElement>('#mask-email');
  if (maskEmail) {
    maskEmail.checked = settings.maskAccountEmail;
  }
}

function readForm(previous: PluginSettings): PluginSettings {
  const next = structuredClone(previous);
  for (const profile of ['max5x', 'max20x'] as const) {
    for (const key of [
      'usage5h',
      'usage7d',
      'survivalDays',
      'today',
      'totalExtra',
      'concurrencyTotal',
    ] as const) {
      next.profiles[profile][key] = readRange(`${profile}-${key}-min`, `${profile}-${key}-max`);
    }
  }

  next.accountCount = readRange('account-count-min', 'account-count-max');
  next.accountCount.min = clampInt(next.accountCount.min, 0, 500);
  next.accountCount.max = clampInt(next.accountCount.max, 0, 500);
  if (next.accountCount.min > next.accountCount.max) {
    [next.accountCount.min, next.accountCount.max] = [
      next.accountCount.max,
      next.accountCount.min,
    ];
  }
  for (const key of [
    'active',
    'rate_limited',
    'temp_unschedulable',
    'unschedulable',
    'error',
    'inactive',
  ] as const) {
    next.statusRatios[key] = clampInt(readNumber(`status-ratio-${key}`), 0, 100);
  }
  next.clearSubsiteOwner = document.querySelector<HTMLInputElement>('#clear-owner')?.checked ?? false;
  next.maskAccountEmail = document.querySelector<HTMLInputElement>('#mask-email')?.checked ?? false;
  next.customLabel = readText('custom-label') || defaultSettings.customLabel;
  next.customProfile = readText('custom-profile') === 'max5x' ? 'max5x' : 'max20x';
  next.currency = readText('currency') || '$';
  next.decimals = clampInt(readNumber('decimals'), 0, 4);
  next.notifyAfterApply = document.querySelector<HTMLInputElement>('#notify')?.checked ?? true;
  return next;
}

function readRange(minId: string, maxId: string): NumberRange {
  const min = readNumber(minId);
  const max = readNumber(maxId);
  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
  };
}

function setStatus(message: string, tone: 'success' | 'neutral'): void {
  const element = document.querySelector<HTMLParagraphElement>('#save-status');
  if (!element) {
    return;
  }
  element.textContent = message;
  element.className = `save-status ${tone}`;
}

function setInput(id: string, value: string | number): void {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (element) {
    element.value = String(value);
  }
}

function readText(id: string): string {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  return element?.value.trim() ?? '';
}

function readNumber(id: string): number {
  const value = Number(readText(id));
  return Number.isFinite(value) ? value : 0;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}
