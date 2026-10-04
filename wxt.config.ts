import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'Sub2API 账号显示调节器',
    description: '仅修改 sub2api 管理页的账号展示 DOM，不触碰后端数据。',
    version: '0.1.0',
    permissions: ['storage', 'activeTab'],
    host_permissions: ['https://sub2api-max.xiaofengai.cc/*'],
    options_ui: {
      page: 'options.html',
      open_in_tab: true,
    },
  },
});
