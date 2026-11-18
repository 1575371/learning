/* =========================================================
   tools/serve.mjs — 本地静态服务器（零依赖）

   项目本身双击 index.html 就能跑，这个脚本只是给两种情况用：
     · 想用 http:// 打开（某些浏览器对 file:// 的音视频策略更严）
     · 手机上通过局域网试听

   用法：npm start [端口]
   ========================================================= */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = normalize(url === '/' ? 'index.html' : url.replace(/^\/+/, ''));

    // 目录穿越防护
    if (rel.startsWith('..' + sep) || rel.includes('..' + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    const file = join(ROOT, rel);
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');

    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache'
    }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`空间音频实验室 → http://127.0.0.1:${PORT}/`);
  console.log('按 Ctrl+C 停止');
});
