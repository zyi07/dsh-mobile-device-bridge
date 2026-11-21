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

// 浏览器可达的 RPC 只有共享的 /api 通道（自定义 channel 不产生 HTTP 路由，
// 实测 POST /mobile-bridge/poll 落到 fallback 返回 405），所以用 intercept。
const API_CHANNEL = '/api';
const EP_PREFIX = 'mobile-bridge';
const ROUTE_PREFIX = '/mbridge';
const BROWSER_STALE_MS = 8000;

export function apply(ctx) {
  /** id → { resolve, reject, timer } */
  const jobs = new Map();
  /** 等待浏览器取走的任务 */
  const queue = [];
  let seq = 0;
  let lastSeen = 0;
  let device = null;
  /** 自诊断：intercept 是否注册成功、match/handler 各被调多少次、看到过什么端点 */
  const diag = {
    connectionService: false,
    fetchRoutes: 0,
    fetchCalls: 0,
    lastMethod: null,
    fetchErrors: [],
  };

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
              diag,
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
    diag.connectionService = true;

    // /api 通道只允许一个 interceptor（已被网关占用），所以走精确 Fetch 路由。
    // Fetch 路由返回的是原始 Response，需要自己拼 RPC 信封，并回显 rpcId
    // （客户端会校验 rpcId 一致，不一致直接抛错）。
    const rpcRoute = (handler) => async (request) => {
      let body = {};
      try { body = await request.json(); } catch { /* 空体 */ }
      const rpcId = body && body.rpcId;
      const method = (body && body.method) || '';
      let result;
      try {
        result = await handler(method, (body && body.payload) || {});
      } catch (e) {
        result = fail('handler-failed', String(e && e.message ? e.message : e));
      }
      return new Response(JSON.stringify({ type: 'server-response', rpcId, result }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    };

    const pollRoute = rpcRoute(async (method, payload) => {
      diag.fetchCalls += 1;
      diag.lastMethod = method;
      lastSeen = now();
      device = payload.device || null;
      // 把最近一次 poll 的 payload 落盘：可以据此判断浏览器跑的客户端版本
      // （旧客户端只发 device，新客户端还会带 log 数组）
      try {
        const snap = process.env.MOBILE_BRIDGE_POLL_SNAPSHOT
          || path.join(process.env.HOME || '/root', '.dsh', 'mbridge-poll.json');
        fs.writeFileSync(snap, JSON.stringify(payload), 'utf8');
        diag.pollKeys = Object.keys(payload || {});
      } catch { /* 落盘失败不影响轮询 */ }
      return okValue({ job: queue.shift() || null, deviceSeen: device });
    });

    const resultRoute = rpcRoute(async (method, payload) => {
      diag.fetchCalls += 1;
      diag.lastMethod = method;
      lastSeen = now();
      return okValue({ accepted: settle(payload.id, payload) });
    });

    // 浏览器把 HDC 收发日志送到这里落盘，方便智能体直接读取而不必截屏。
    const logRoute = rpcRoute(async (method, payload) => {
      diag.fetchCalls += 1;
      diag.lastMethod = method;
      lastSeen = now();
      const lines = Array.isArray(payload.lines) ? payload.lines : [];
      const file = process.env.MOBILE_BRIDGE_HDC_LOG
        || path.join(process.env.HOME || '/root', '.dsh', 'mbridge-hdc.log');
      try {
        fs.appendFileSync(file, lines.map((l) => String(l)).join('\n') + '\n', 'utf8');
        return okValue({ file, written: lines.length });
      } catch (e) {
        return fail('write-failed', String(e && e.message ? e.message : e));
      }
    });

    // path 到底要不要带 /api 前缀，文档与实现字面不一致，两种都注册。
    const paths = [
      ['/api/mobile-bridge/poll', pollRoute],
      ['/mobile-bridge/poll', pollRoute],
      ['/api/mobile-bridge/result', resultRoute],
      ['/mobile-bridge/result', resultRoute],
      ['/api/mobile-bridge/log', logRoute],
      ['/mobile-bridge/log', logRoute],
    ];

    connCtx.effect(() => {
      const disposers = [];
      for (const [path, fetch] of paths) {
        try {
          const p = connCtx.connection.fetch.register({
            path,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch,
          });
          diag.fetchRoutes += 1;
          if (p && typeof p.then === 'function') {
            p.then((dispose) => { if (typeof dispose === 'function') disposers.push(dispose); },
                   (e) => { diag.fetchErrors.push(String(e && e.message ? e.message : e)); });
          }
        } catch (e) {
          diag.fetchErrors.push(String(e && e.message ? e.message : e));
        }
      }
      return () => {
        for (const dispose of disposers) {
          try { const r = dispose(); if (r && r.then) r.catch(() => {}); } catch { /* ignore */ }
        }
      };
    }, 'mobile-bridge: fetch routes');
  });
}
