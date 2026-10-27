import { useApiSource } from '../../src/forecast/api';
import { mountGapPage } from '../../src/forecast/gap-page';
import { siteApiSource } from '../../src/forecast/site-auth';
import '../../src/forecast/gap-page.css';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) {
  throw new Error('Gap page mount point is missing');
}
// 独立页面不在 sub2api 域下：接口请求站点完整地址，登录信息从已打开的 sub2api 标签页读取
useApiSource(siteApiSource());
mountGapPage(app);
