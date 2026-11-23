import { spawn as nodeSpawn } from 'node:child_process';
import nodePath from 'node:path';
import nodeOs from 'node:os';
import { fileURLToPath as nodeFileURLToPath } from 'node:url';

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
const BROWSER_STALE_MS = 75000;

export function apply(ctx) {
  /** id → { resolve, reject, timer } */
  const jobs = new Map();
  /** 等待浏览器取走的任务 */
  const queue = [];
  let seq = 0;
  let lastSeen = 0;
  let device = null;
  let devices = [];
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

  // ---- 华为账号扫码登录（宿主侧起真实浏览器，插件里显示二维码）----
  let agcLoginProc = null;
  let agcLoginBuf = "";
  let agcLoginWaiters = [];

  function agcEnsureProc() {
    if (agcLoginProc && !agcLoginProc.killed) { return agcLoginProc; }
    const here = nodePath.dirname(nodeFileURLToPath(import.meta.url));
    const script = nodePath.join(here, 'tools', 'agc_login.py');
    const proc = nodeSpawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    agcLoginProc = proc;
    let stderrBuf = "";
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      agcLoginBuf += chunk;
      let idx;
      while ((idx = agcLoginBuf.indexOf('\n')) >= 0) {
        const line = agcLoginBuf.slice(0, idx).trim();
        agcLoginBuf = agcLoginBuf.slice(idx + 1);
        if (!line) { continue; }
        let obj = null;
        try { obj = JSON.parse(line); } catch { obj = { ok: false, error: line.slice(0, 200) }; }
        const w = agcLoginWaiters.shift();
        if (w) { w(obj); }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c) => { stderrBuf = (stderrBuf + c).slice(-4000); });
    proc.on('exit', () => {
      agcLoginProc = null;
      const ws = agcLoginWaiters;
      agcLoginWaiters = [];
      ws.forEach((w) => w({ ok: false, error: '登录服务已退出: ' + stderrBuf.slice(-300) }));
    });
    return proc;
  }

  function agcCommand(cmd, timeoutMs = 150000) {
    const proc = agcEnsureProc();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`登录服务超时（${timeoutMs}ms）`)), timeoutMs);
      if (timer.unref) { timer.unref(); }
      agcLoginWaiters.push((obj) => { clearTimeout(timer); resolve(obj); });
      try { proc.stdin.write(cmd + '\n'); } catch (e) { clearTimeout(timer); reject(e); }
    });
  }

  function agcSessionFile() { return nodePath.join(nodeOs.homedir(), '.dsh', 'agc-session.json'); }

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
              devices,
              queued: queue.length,
              inflight: jobs.size,
              diag,
            });
            return;
          }

          const needBrowser = () => {
            if (!browserAlive()) {
              throw new Error(
                '浏览器端没有在轮询（超过 75 秒没收到心跳）：请把 DSH 标签页切到前台再试。'
                + '后台标签页会被 Chrome 节流/冻结，这是浏览器行为，不是插件故障。',
              );
            }
            if (!device && devices.length === 0) {
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

          // ---- 多设备：切换活跃设备 ----
          if (path === ROUTE_PREFIX + '/activate' && req.method === 'POST') {
            const body = await readBody(req);
            const id = String(body.id || '');
            if (!id) { send(res, 400, { ok: false, error: '缺少 id' }); return; }
            if (!browserAlive()) {
              send(res, 503, { ok: false, error: '浏览器没有在轮询，请把 DSH 标签页切到前台' });
              return;
            }
            const r = await enqueue('activate', { id }, 15000);
            send(res, 200, { ok: r.ok !== false, activeId: r.activeId || id, output: r.output, error: r.error });
            return;
          }

          // ---- 文件传输与安装（鸿蒙走 shell+base64，已真机实测）----
          if (path === ROUTE_PREFIX + '/push' && req.method === 'POST') {
            const body = await readBody(req, 128 << 20);   // 允许大文件（base64 膨胀 ~1.33x）
            if (!body.path || !body.base64) {
              send(res, 400, { ok: false, error: '缺少 path 或 base64' });
              return;
            }
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 600000, 1000), 1800000);
            // 支持分片上传：index/chunkSize 存在时只写这一块（幂等，写到精确偏移）
            const payload = { path: String(body.path), base64: String(body.base64) };
            if (typeof body.index === 'number' && body.chunkSize) {
              payload.index = body.index;
              payload.chunkSize = Number(body.chunkSize);
            }
            const r = await enqueue('push', payload, timeoutMs);
            send(res, 200, {
              ok: true, device, bytes: r.bytes, chunks: r.chunks, chunk: r.chunk,
            });
            return;
          }

          if (path === ROUTE_PREFIX + '/pull' && req.method === 'POST') {
            const body = await readBody(req);
            if (!body.path) { send(res, 400, { ok: false, error: '缺少 path' }); return; }
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 300000, 1000), 1800000);
            const r = await enqueue('pull', { path: String(body.path) }, timeoutMs);
            send(res, 200, { ok: true, device, bytes: r.bytes, base64: r.base64 });
            return;
          }

          if (path === ROUTE_PREFIX + '/install' && req.method === 'POST') {
            const body = await readBody(req, 128 << 20);   // HAP 安装包可能几十 MB
            if (!body.base64) { send(res, 400, { ok: false, error: '缺少 base64（HAP 内容）' }); return; }
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 900000, 1000), 1800000);
            const r = await enqueue('install', {
              filename: String(body.filename || 'bundle.hap'),
              base64: String(body.base64),
              replace: !!body.replace,
            }, timeoutMs);
            send(res, 200, { ok: true, device, output: r.output });
            return;
          }

          if (path === ROUTE_PREFIX + '/uninstall' && req.method === 'POST') {
            const body = await readBody(req);
            if (!body.bundle) { send(res, 400, { ok: false, error: '缺少 bundle' }); return; }
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 120000, 1000), 600000);
            const r = await enqueue('uninstall', { bundle: String(body.bundle) }, timeoutMs);
            send(res, 200, { ok: true, device, output: r.output });
            return;
          }

          // ---- 华为账号登录（扫码）----
          if (path === ROUTE_PREFIX + '/agc/login/start' && req.method === 'POST') {
            // 用户主动点「开始登录」：强制重开，保证拿到的是全新二维码
            const r = await agcCommand('start-force', 180000);
            send(res, 200, r);
            return;
          }
          if (path === ROUTE_PREFIX + '/agc/login/status' && req.method === 'GET') {
            const r = await agcCommand('status', 60000);
            send(res, 200, r);
            return;
          }
          if (path === ROUTE_PREFIX + '/agc/login/password' && req.method === 'POST') {
            const body = await readBody(req);
            const account = String(body.account || '').trim();
            const password = String(body.password || '');
            if (!account || !password) {
              send(res, 400, { ok: false, error: '缺少 account 或 password' });
              return;
            }
            // 密码只经内存传给登录进程，不写日志、不落盘
            const r = await agcCommand(
              'login-password ' + JSON.stringify({ account, password }), 180000);
            send(res, 200, r);
            return;
          }
          if (path === ROUTE_PREFIX + '/agc/login/code' && req.method === 'POST') {
            const body = await readBody(req);
            const code = String(body.code || '').trim();
            if (!code) { send(res, 400, { ok: false, error: '缺少 code' }); return; }
            const r = await agcCommand('login-code ' + JSON.stringify({ code }), 180000);
            send(res, 200, r);
            return;
          }
          // 浏览器扩展把本机浏览器的 AGC 登录态发过来（用户在自己浏览器原生登录）
          // 浏览器把 WebUSB 真实状态上报到宿主（写文件，便于服务端直接读）
          if (path === ROUTE_PREFIX + '/agc/usbstate' && req.method === 'POST') {
            const body = await readBody(req, 1 << 20);
            const fs = await import('node:fs/promises');
            const file = nodePath.join(nodeOs.homedir(), '.dsh', 'usbstate.log');
            try {
              await fs.mkdir(nodePath.dirname(file), { recursive: true });
              const line = `[${new Date().toISOString()}] ${JSON.stringify(body)}\n`;
              await fs.appendFile(file, line);
            } catch { /* ignore */ }
            send(res, 200, { ok: true });
            return;
          }

          // 提供已签名 HAP 下载（用本机 hdc 安装，绕开 WebUSB 抢设备）
          if (path === ROUTE_PREFIX + '/agc/hap' && req.method === 'GET') {
            const fs = await import('node:fs/promises');
            const here = nodePath.dirname(nodeFileURLToPath(import.meta.url));
            const file = nodePath.join(here, 'assets', 'dsh_demo_signed.hap');
            try {
              const buf = await fs.readFile(file);
              res.writeHead(200, {
                'content-type': 'application/octet-stream',
                'content-disposition': 'attachment; filename="dsh_demo_signed.hap"',
                'content-length': String(buf.length),
              });
              res.end(buf);
            } catch (e) {
              send(res, 404, { ok: false, error: '安装包不存在：' + String(e && e.message ? e.message : e) });
            }
            return;
          }

          if (path === ROUTE_PREFIX + '/agc/cookie' && req.method === 'POST') {
            const body = await readBody(req, 4 << 20);
            const cookieHeader = String(body.cookieHeader || '');
            if (!cookieHeader) {
              send(res, 400, { ok: false, error: '缺少 cookieHeader' });
              return;
            }
            const fs = await import('node:fs/promises');
            const file = agcSessionFile();
            await fs.mkdir(nodePath.dirname(file), { recursive: true });
            await fs.writeFile(file, JSON.stringify({
              cookieHeader,
              csrf: String(body.csrf || ''),
              cookies: Array.isArray(body.cookies) ? body.cookies : [],
              savedAt: Number(body.savedAt) || Date.now() / 1000,
              source: String(body.source || 'extension'),
            }), { mode: 0o600 });
            send(res, 200, {
              ok: true,
              count: Array.isArray(body.cookies) ? body.cookies.length : 0,
              savedAt: Date.now() / 1000,
            });
            return;
          }

          // 下载扩展压缩包（浏览器直接从本机 DSH 取，不用传文件）
          if (path === ROUTE_PREFIX + '/agc/extension.zip' && req.method === 'GET') {
            const fs = await import('node:fs/promises');
            const here = nodePath.dirname(nodeFileURLToPath(import.meta.url));
            const tmpZip = nodePath.join(nodeOs.tmpdir(), 'dsh-agc-helper.zip');
            try {
              await new Promise((resolve, reject) => {
                const py = nodeSpawn('python3', ['-c',
                  `import shutil;shutil.make_archive(r"${tmpZip.replace(/\.zip$/, '')}", "zip", r"${nodePath.join(here, 'extension')}")`,
                ]);
                py.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('zip 失败 ' + code))));
                py.on('error', reject);
              });
              const buf = await fs.readFile(tmpZip);
              res.writeHead(200, {
                'content-type': 'application/zip',
                'content-disposition': 'attachment; filename="dsh-agc-helper.zip"',
                'content-length': String(buf.length),
              });
              res.end(buf);
            } catch (e) {
              send(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
            }
            return;
          }

          if (path === ROUTE_PREFIX + '/agc/view' && req.method === 'GET') {
            const r = await agcCommand('view', 60000);
            send(res, 200, r);
            return;
          }
          if (path === ROUTE_PREFIX + '/agc/act' && req.method === 'POST') {
            const body = await readBody(req);
            const r = await agcCommand('act ' + JSON.stringify(body), 60000);
            send(res, 200, r);
            return;
          }
          if (path === ROUTE_PREFIX + '/agc/login/close' && req.method === 'POST') {
            try {
              await agcCommand('close', 30000);
            } catch { /* 进程可能已退出 */ }
            if (agcLoginProc) { try { agcLoginProc.stdin.end(); } catch { /* ignore */ } }
            agcLoginProc = null;
            send(res, 200, { ok: true });
            return;
          }
          if (path === ROUTE_PREFIX + '/agc/session' && req.method === 'GET') {
            // 只报告是否存在与采集时间，绝不回传 Cookie 内容
            try {
              const fs = await import('node:fs/promises');
              const raw = await fs.readFile(agcSessionFile(), 'utf8');
              const d = JSON.parse(raw);
              send(res, 200, {
                ok: true,
                present: true,
                cookieCount: (d.cookies || []).length,
                savedAt: d.savedAt,
              });
            } catch {
              send(res, 200, { ok: true, present: false });
            }
            return;
          }

          if (path === ROUTE_PREFIX + '/screenshot' && req.method === 'POST') {
            const body = await readBody(req);
            needBrowser();
            const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 90000, 1000), 300000);
            const r = await enqueue('screenshot', {}, timeoutMs);
            const fs = await import('node:fs/promises');
            const bytes = Buffer.from(r.base64 || '', 'base64');
            // 按实际内容决定扩展名：鸿蒙返回 JPEG，安卓返回 PNG
            const isJpeg = bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
            const isPng = bytes.length > 8 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
            const ext = isJpeg ? 'jpg' : (isPng ? 'png' : (r.mime === 'image/jpeg' ? 'jpg' : 'bin'));
            const file = `/tmp/mobile-shot-${Date.now()}.${ext}`;
            await fs.writeFile(file, bytes);
            send(res, 200, {
              ok: true, path: file, bytes: bytes.length, mime: r.mime || (isJpeg ? 'image/jpeg' : 'image/png'), device,
            });
            return;
          }

          send(res, 404, {
            ok: false,
            error: '未知路径。可用：GET /mobile-bridge/status；POST /mobile-bridge/exec | screenshot'
              + ' | push | pull | install | uninstall',
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
      devices = Array.isArray(payload.devices) ? payload.devices : (device ? [device] : []);
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
