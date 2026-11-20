/**
 * Host half of dsh-mobile-bridge.
 *
 * 目的：让智能体（或任何本机脚本）能间接驱动浏览器里那条 WebUSB 连接。
 *
 * 通道设计：
 *   浏览器 → 宿主：ctx.connection 的已认证 RPC 通道 `/mobile-bridge`
 *                  （client 用 connection.rpc.call 轮询取任务、回传结果）
 *   宿主 → 本机： ctx.webServer 上的 loopback-only 路由
 *                  （curl http://127.0.0.1:3080/mobile-bridge/... 即可）
 *
 * 为什么不让宿主直接碰 USB：WebUSB 只在浏览器进程里可用，宿主没有任何
 * 途径访问用户电脑上的 USB 设备，所以必须由页面代跑。
 *
 * 注意：两个服务都用 `ctx.inject([...], cb)` 取。模块级
 * `export const inject` 与 patch 行级 inject 在这条加载路径上都没生效
 * （实测报 cannot get property "webServer" without inject）。
 */

const CHANNEL = '/mobile-bridge';
const ROUTE_PREFIX = '/mobile-bridge';
const BROWSER_STALE_MS = 8000;

export function apply(ctx) {
  /** id → { resolve, reject, timer } */
  const jobs = new Map();
  /** 等待浏览器取走的任务 */
  const queue = [];
  let seq = 0;
  let lastSeen = 0;
  let device = null;

  const now = () => Date.now();
  const browserAlive = () => now() - lastSeen < BROWSER_STALE_MS;

  function enqueue(kind, data, timeoutMs) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        jobs.delete(id);
        const at = queue.findIndex((j) => j.id === id);
        if (at !== -1) queue.splice(at, 1);
        reject(new Error(`超时 ${timeoutMs}ms：浏览器没有在时限内回传结果（页面是否还开着？）`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      jobs.set(id, { resolve, reject, timer });
      queue.push({ id, kind, data });
    });
  }

  function settle(id, payload) {
    const job = jobs.get(id);
    if (!job) return false;
    jobs.delete(id);
    clearTimeout(job.timer);
    if (payload && payload.ok) job.resolve(payload);
    else job.reject(new Error((payload && payload.error) || '浏览器执行失败'));
    return true;
  }

  const okValue = (value) => ({ ok: true, value });
  const fail = (code, message) => ({ ok: false, error: { code, message, details: {} } });

  function readBody(req, limit = 1 << 20) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!text) { resolve({}); return; }
        try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
      });
      req.on('error', reject);
    });
  }

  function send(res, code, obj) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(obj));
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        const addr = (req.socket && req.socket.remoteAddress) || '';
        const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
        if (!loopback) {
          send(res, 403, { ok: false, error: '该端点只接受本机 127.0.0.1 调用' });
          return;
        }
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const path = url.pathname;

        try {
          if (path === ROUTE_PREFIX + '/status' && req.method === 'GET') {
            send(res, 200, {
              ok: true,
              browserAlive: browserAlive(),
              lastSeenMsAgo: lastSeen ? now() - lastSeen : null,
              device,
              queued: queue.length,
              inflight: jobs.size,
            });
            return;
          }

          const needBrowser = () => {
            if (!browserAlive()) {
              throw new Error(
                '浏览器端没有在轮询：请打开 DSH 页面并保持标签页在前台（移动设备那一栏不用打开）',
              );
            }
            if (!device) {
              throw new Error('浏览器没有报告已连接设备，请先在设置页点「连接设备」');
            }
          };

          if (path === ROUTE_PREFIX + '/exec' && req.method === 'POST') {
            const body = await readBody(req);
            const cmd = String(body.cmd || '').trim();
            if (!cmd) { send(res, 400, { ok: false, error: '缺少 cmd' }); return; }
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 60000, 1000), 300000);
            const r = await enqueue('shell', { cmd }, timeoutMs);
            send(res, 200, { ok: true, device, output: r.output });
            return;
          }

          if (path === ROUTE_PREFIX + '/screenshot' && req.method === 'POST') {
            const body = await readBody(req);
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 90000, 1000), 300000);
            const r = await enqueue('screenshot', {}, timeoutMs);
            const fs = await import('node:fs/promises');
            const file = `/tmp/mobile-shot-${Date.now()}.png`;
            const bytes = Buffer.from(r.base64 || '', 'base64');
            await fs.writeFile(file, bytes);
            send(res, 200, { ok: true, path: file, bytes: bytes.length, device });
            return;
          }

          send(res, 404, {
            ok: false,
            error: '未知路径。可用：GET /mobile-bridge/status, POST /mobile-bridge/exec, POST /mobile-bridge/screenshot',
          });
        } catch (e) {
          send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
        }
      },
    }), 'mobile-bridge: local routes');
  });

  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => connCtx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
      const body = payload && typeof payload === 'object' ? payload : {};
      try {
        if (endpoint === 'poll') {
          lastSeen = now();
          device = body.device || null;
          return okValue({ job: queue.shift() || null, deviceSeen: device });
        }
        if (endpoint === 'result') {
          lastSeen = now();
          return okValue({ accepted: settle(body.id, body) });
        }
        return fail('unknown-endpoint', `未知端点 ${endpoint}`);
      } catch (e) {
        return fail('handler-failed', String(e && e.message ? e.message : e));
      }
    }), 'mobile-bridge: rpc channel');
  });
}