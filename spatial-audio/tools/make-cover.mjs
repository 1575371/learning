/* =========================================================
   make-cover.mjs — 把 tools/share-cover.html 渲染成分享封面

   用法：npm run cover     → 输出 assets/img/share-cover.png（1200×630）

   说明：这一步只用于「改封面文案后重新出图」，运行演示本身不需要它。
   Playwright 不是项目依赖（项目零依赖），所以这里用 require 的方式查找，
   允许通过 NODE_PATH 指向任意已安装位置；找不到时给出明确提示。
   ========================================================= */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('未找到 playwright。任选一种方式后重试：');
  console.error('  npm i -D playwright && npx playwright install msedge');
  console.error('  或 NODE_PATH=<已装 playwright 的 node_modules> node tools/make-cover.mjs');
  process.exit(1);
}

const src = 'file://' + path.join(root, 'tools/share-cover.html').replace(/\\/g, '/');
const out = path.join(root, 'assets/img/share-cover.jpg');

const browser = await chromium.launch({ channel: 'msedge' });
/* 1x 就够：平台展示宽度通常 < 600px，2x 只会把体积翻四倍 */
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto(src);
await page.waitForTimeout(400);
await page.screenshot({ path: out, type: 'jpeg', quality: 90 });
await browser.close();
console.log('已生成', path.relative(root, out), (fs.statSync(out).size / 1024).toFixed(0) + ' KB');
