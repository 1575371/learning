/* =========================================================
   tools/verify.mjs — 交付前自检（零依赖）

   检查的是"打包发出去会不会坏"，不涉及听感：
     1. 关键文件齐不齐
     2. index.html 里引用的资源是否都存在
     3. 每个 JS 能不能通过语法检查
     4. 脚本加载顺序是否符合依赖（core 必须早于使用它的模块）
     5. DOM id 有没有重复
     6. 内嵌音频的 base64 能否解出合法的 MP3 头
     7. 顺带列出体积

   用法：npm run verify
   ========================================================= */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const rel = (p) => relative(ROOT, p).split('\\').join('/');

let failed = 0;
const ok = (msg) => console.log('  ✓ ' + msg);
const bad = (msg) => { failed++; console.log('  ✗ ' + msg); };
const head = (msg) => console.log('\n' + msg);

const exists = async (p) => {
  try { return (await stat(join(ROOT, p))).isFile(); } catch { return false; }
};

/* 1) 关键文件 */
head('1. 关键文件');
const REQUIRED = [
  'index.html', 'README.md', 'package.json',
  'assets/js/core.js', 'assets/js/synth.js', 'assets/js/spatial.js',
  'assets/js/engine.js', 'assets/js/view.js', 'assets/js/app.js', 'assets/js/samples.js',
  'assets/css/base.css', 'assets/css/panels.css', 'assets/css/stage.css', 'assets/css/responsive.css',
  'assets/audio/dog_barking.mp3', 'assets/audio/footsteps.mp3',
  'docs/tech-notes.md'
];
for (const f of REQUIRED) {
  if (await exists(f)) ok(f); else bad('缺失 ' + f);
}

/* 2) index.html 的资源引用 */
head('2. index.html 资源引用');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));
if (!refs.length) bad('没有找到任何资源引用，index.html 可能被改坏了');
for (const r of refs) {
  if (await exists(r)) ok(r); else bad('引用失效 ' + r);
}

/* 3) JS 语法 */
head('3. JavaScript 语法');
const jsFiles = (await readdir(join(ROOT, 'assets/js')))
  .filter((f) => f.endsWith('.js'))
  .sort();
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', join(ROOT, 'assets/js', f)], { stdio: 'pipe' });
    ok('assets/js/' + f);
  } catch (e) {
    bad('assets/js/' + f + ' → ' + String(e.stderr || e.message).split('\n')[0]);
  }
}

/* 4) 加载顺序：每个模块在加载时就会读 window.SALab 上的常量，顺序错了会崩 */
head('4. 脚本加载顺序');
const ORDER = ['core.js', 'synth.js', 'spatial.js', 'engine.js', 'view.js', 'app.js'];
const idx = ORDER.map((n) => html.indexOf('assets/js/' + n));
if (idx.some((i) => i < 0)) {
  bad('index.html 里缺少某个脚本标签');
} else {
  const sorted = [...idx].sort((a, b) => a - b);
  if (idx.every((v, i) => v === sorted[i])) ok(ORDER.join(' → '));
  else bad('加载顺序与依赖不符：' + ORDER.join(' → '));
}
if (idx[0] > html.indexOf('assets/js/samples.js') && html.includes('samples.js')) {
  ok('samples.js 最先加载');
}

/* 5) id 唯一性 */
head('5. DOM id 唯一性');
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dup = ids.filter((v, i) => ids.indexOf(v) !== i);
if (dup.length) bad('重复 id：' + [...new Set(dup)].join(', '));
else ok(ids.length + ' 个 id，无重复');

/* 6) 内嵌音频 */
head('6. 内嵌音频（samples.js）');
const samples = await readFile(join(ROOT, 'assets/js/samples.js'), 'utf8');
const uris = [...samples.matchAll(/data:audio\/mpeg;base64,([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
if (uris.length !== 2) {
  bad('期望 2 段音频，实际 ' + uris.length);
} else {
  uris.forEach((b64, i) => {
    const buf = Buffer.from(b64, 'base64');
    const mp3 = buf.subarray(0, 3).toString('latin1') === 'ID3'
      || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    const name = i === 0 ? 'bark' : 'steps';
    if (mp3) ok(name + '：' + (buf.length / 1024).toFixed(0) + ' KB，MP3 头正常');
    else bad(name + '：base64 解出来不是 MP3');
  });
}

/* 7) 体积 */
head('7. 体积');
const KB = async (p) => (await stat(join(ROOT, p))).size / 1024;
const big = [
  ['assets/js/samples.js', await KB('assets/js/samples.js')],
  ['assets/audio', (await Promise.all(['dog_barking.mp3', 'footsteps.mp3'].map((f) => KB('assets/audio/' + f)))).reduce((a, b) => a + b)],
  ['docs', (await Promise.all(['tech-notes.md', 'preview-bark.wav', 'preview-steps.wav'].map((f) => KB('docs/' + f)))).reduce((a, b) => a + b)]
];
big.forEach(([n, v]) => ok(n + '：' + v.toFixed(0) + ' KB'));

/* 结论 */
console.log('\n' + (failed ? `✗ ${failed} 项未通过` : '✓ 全部通过'));
process.exit(failed ? 1 : 0);
