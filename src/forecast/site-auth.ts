import type { ApiSource } from './api';

export const SITE_ORIGIN = 'https://sub2api-max.xiaofengai.cc';

/**
 * 插件独立页面不在 sub2api 域下，读不到它的 localStorage：
 * 找一个已打开的 sub2api 标签页，在页面里读出登录 token，只保存在当前页面内存中，不写入任何存储。
 * 这里只需要已有的 host_permissions + scripting 权限，不会把 token 发给站点以外的任何地址。
 */
export function siteApiSource(): ApiSource {
  let cached: string | null = null;
  return {
    origin: SITE_ORIGIN,
    getToken: async (forceRefresh) => {
      if (cached && !forceRefresh) {
        return cached;
      }
      cached = await readSiteToken();
      return cached;
    },
  };
}

async function readSiteToken(): Promise<string | null> {
  const tabs = await browser.tabs.query({ url: `${SITE_ORIGIN}/*` });
  // 优先最近使用的标签页：它的登录状态最新
  const ordered = [...tabs].sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0));
  for (const tab of ordered) {
    if (tab.id === undefined || tab.discarded) {
      continue;
    }
    try {
      const [result] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.localStorage.getItem('auth_token'),
      });
      const token = result?.result;
      if (typeof token === 'string' && token) {
        return token;
      }
    } catch {
      // 页面被休眠插件挂起或正在加载时注入会失败，换下一个标签页
    }
  }
  return null;
}
