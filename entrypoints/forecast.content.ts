import { defineContentScript } from 'wxt/utils/define-content-script';
import { openForecastPanel } from '../src/forecast/panel';

// 由插件菜单按需注入：额度预估只依赖接口，sub2api 站点任意页面都能打开，
// 也不受插件重载后旧脚本失联的影响；不在页面加载时常驻。
export default defineContentScript({
  matches: ['https://sub2api-max.xiaofengai.cc/*'],
  registration: 'runtime',
  main(ctx) {
    return openForecastPanel(ctx);
  },
});
