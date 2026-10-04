import { defaultModifyOptions } from '../../src/shared/defaults';
import { getModifyOptions, getSettings, saveModifyOptions } from '../../src/shared/storage';
import type {
  ApplyMessage,
  ApplyResult,
  ModifyOptions,
  PluginSettings,
  SubscriptionMode,
} from '../../src/shared/types';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Popup mount point is missing');
}

void renderPopup(app);

async function renderPopup(root: HTMLDivElement): Promise<void> {
  const [settings, savedOptions] = await Promise.all([getSettings(), getModifyOptions()]);
  const options: ModifyOptions = { ...defaultModifyOptions, ...savedOptions };

  root.innerHTML = `
    <section class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">SUB2API DISPLAY TOOL</p>
          <h1>账号显示调节器</h1>
        </div>
        <button class="icon-button" id="open-options" title="打开系统设置" aria-label="打开系统设置">⚙</button>
      </header>

      <div class="hint">
        <span class="status-dot"></span>
        仅修改当前管理页的展示 DOM，不会写入后端数据
      </div>

      <section class="panel">
        <div class="panel-heading">
          <div>
            <h2>这次修改</h2>
            <p>每个账号都会单独随机生成</p>
          </div>
          <span class="profile-pill" id="profile-pill"></span>
        </div>

        <label class="field-label" for="subscription-mode">订阅类型</label>
        <select class="select" id="subscription-mode">
          <option value="max5x">max 5x</option>
          <option value="max20x">max 20x</option>
          <option value="custom">自定义</option>
        </select>
        <div class="custom-row hidden" id="custom-row">
          <input class="input" id="custom-label" type="text" placeholder="例如：max 8x" />
          <select class="select compact" id="custom-profile">
            <option value="max5x">使用 5x 范围</option>
            <option value="max20x">使用 20x 范围</option>
          </select>
        </div>
      </section>

      <section class="panel">
        <div class="panel-heading compact-heading">
          <div>
            <h2>要修改的项目</h2>
            <p>取消勾选即可保留页面原值</p>
          </div>
          <button class="text-button" id="select-all">全选</button>
        </div>
        <div class="check-grid">
          ${checkboxMarkup('subscription', '订阅类型', '把 Team / Pro 等徽标替换为所选名称')}
          ${checkboxMarkup('usage5h', '5h 百分比 + 金额', '百分比纯随机，金额按设置范围生成')}
          ${checkboxMarkup('usage7d', '7d 百分比 + 金额', '百分比纯随机，金额按设置范围生成')}
          ${checkboxMarkup('usage7dF', '7d F 百分比', '只修改百分比，不包含金额')}
          ${checkboxMarkup('survivalDays', '存活时间', '按系统设置随机生成天数')}
          ${checkboxMarkup('concurrency', '并发', '当前占用不会超过总允许数')}
          ${checkboxMarkup('today', '今日消耗', '按系统设置的金额区间随机')}
          ${checkboxMarkup('total', '累计消耗', '一定不小于本次今日消耗')}
          ${checkboxMarkup('accountCount', '账号数量', '按系统设置的范围随机生成并同步统计')}
          ${checkboxMarkup('maskEmail', '隐藏账号邮箱', '保留部分字符和完整域名')}
        </div>
      </section>

      <button class="primary-button" id="apply">
        <span class="button-icon">✦</span>
        一键修改当前页面
      </button>
      <p class="status" id="status" role="status"></p>
    </section>
  `;

  const modeSelect = getElement<HTMLSelectElement>('subscription-mode');
  const customRow = getElement<HTMLDivElement>('custom-row');
  const customLabel = getElement<HTMLInputElement>('custom-label');
  const customProfile = getElement<HTMLSelectElement>('custom-profile');
  const pill = getElement<HTMLSpanElement>('profile-pill');
  const status = getElement<HTMLParagraphElement>('status');

  modeSelect.value = options.subscriptionMode;
  customLabel.value = options.customLabel ?? settings.customLabel;
  customProfile.value = options.customProfile ?? settings.customProfile;
  updateModeFields();
  updatePill();

  modeSelect.addEventListener('change', () => {
    options.subscriptionMode = modeSelect.value as SubscriptionMode;
    updateModeFields();
    updatePill();
  });
  customLabel.addEventListener('input', () => {
    options.customLabel = customLabel.value;
    updatePill();
  });
  customProfile.addEventListener('change', () => {
    options.customProfile = customProfile.value as 'max5x' | 'max20x';
  });

  for (const key of checkboxKeys) {
    const checkbox = getElement<HTMLInputElement>(`modify-${key}`);
    checkbox.checked = options[key];
    checkbox.addEventListener('change', () => {
      options[key] = checkbox.checked;
    });
  }

  getElement<HTMLButtonElement>('select-all').addEventListener('click', () => {
    const shouldCheck = checkboxKeys.some((key) => !options[key]);
    for (const key of checkboxKeys) {
      options[key] = shouldCheck;
      getElement<HTMLInputElement>(`modify-${key}`).checked = shouldCheck;
    }
  });

  getElement<HTMLButtonElement>('open-options').addEventListener('click', () => {
    void browser.runtime.openOptionsPage();
  });

  getElement<HTMLButtonElement>('apply').addEventListener('click', async () => {
    const button = getElement<HTMLButtonElement>('apply');
    button.disabled = true;
    status.className = 'status';
    status.textContent = '正在查找当前管理页…';
    await saveModifyOptions(options);

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !tab.url?.startsWith('https://sub2api-max.xiaofengai.cc/manager/accounts')) {
        throw new Error('请先打开账号管理页');
      }
      const message: ApplyMessage = { type: 'APPLY_MODIFICATIONS', options };
      const result = await browser.tabs.sendMessage<ApplyMessage, ApplyResult>(tab.id, message);
      status.className = result.modified > 0 ? 'status success' : 'status warning';
      status.textContent =
        result.modified > 0
          ? `完成：已修改 ${result.modified} 个账号`
          : '当前页面没有识别到可修改的账号卡片或列表行';
    } catch (error) {
      status.className = 'status error';
      status.textContent =
        error instanceof Error && error.message.includes('账号管理页')
          ? error.message
          : '无法连接当前页面，请刷新管理页后重试';
    } finally {
      button.disabled = false;
    }
  });

  function updateModeFields(): void {
    customRow.classList.toggle('hidden', modeSelect.value !== 'custom');
  }

  function updatePill(): void {
    const mode = modeSelect.value as SubscriptionMode;
    pill.textContent =
      mode === 'custom'
        ? customLabel.value.trim() || settings.customLabel
        : settings.profiles[mode].label;
  }
}

const checkboxKeys = [
  'subscription',
  'usage5h',
  'usage7d',
  'usage7dF',
  'survivalDays',
  'concurrency',
  'today',
  'total',
  'accountCount',
  'maskEmail',
] as const;

function checkboxMarkup(key: (typeof checkboxKeys)[number], label: string, description: string): string {
  return `
    <label class="check-item">
      <input id="modify-${key}" type="checkbox" />
      <span class="check-box" aria-hidden="true"></span>
      <span class="check-copy">
        <strong>${label}</strong>
        <small>${description}</small>
      </span>
    </label>
  `;
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing popup element: ${id}`);
  }
  return element as T;
}
