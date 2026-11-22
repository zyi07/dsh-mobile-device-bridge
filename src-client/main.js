import React from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { HdcTransport, HdcSession, diagnoseUsb } from './hdc/transport.js';
import { generateKeyPair as hdcGenerateKeyPair, DAEMON_VERSION, importHdcKey } from './hdc/session.js';
import { pushFile, pullFile, installHap, uninstallBundle, sha256Remote, writeChunkAt } from './hdc/files.js';

/** 客户端构建标记：显示在面板并随 poll 上报，用来确认浏览器加载的是哪一版 */
const BUILD_TAG = 'r78';

/** 浏览器里持久化的 HDC 私钥（PKCS#8 PEM）。同一把密钥只授权一次。 */
const HDC_KEY_STORE = 'mobile-bridge.hdc.pkcs8';

function readStoredHdcKey() {
  try { return localStorage.getItem(HDC_KEY_STORE) || ''; } catch { return ''; }
}

function storeHdcKey(pem) {
  try { localStorage.setItem(HDC_KEY_STORE, pem); return true; } catch { return false; }
}

function clearStoredHdcKey() {
  try { localStorage.removeItem(HDC_KEY_STORE); return true; } catch { return false; }
}

export const inject = ['slots', 'locale'];

const NS = 'mobile-bridge';
const h = React.createElement;

/**
 * 把 Tango / WebUSB 的英文异常翻译成可执行的下一步。
 * 认不出来的原样返回，便于贴到 Console 里排查。
 */
export function friendly(raw, t, kind = 'adb') {
  // 第 7 轮实测结论：hdc server 常驻时，连 open 都拿不到句柄。
  // open 失败 = 设备被别的程序独占，与驱动无关（interface 0 已确认是 WINUSB）。
  if (/open 失败（设备被独占）/.test(raw)) return t('errExclusive');
  if (/already in use[d]? by another program|device in use|resource busy/i.test(raw)) return t('errBusy');
  // 浏览器接管接口失败：Android 侧通常是驱动问题；HarmonyOS 侧几乎总是 hdc server 占着
  if (/claim interface|failed to claim|unable to claim|access denied|not allowed|security/i.test(raw)) {
    return kind === 'hdc' ? t('errHdcBusy') : t('errDriver');
  }
  if (/no device selected|no device/i.test(raw)) return '';
  if (/user gesture/i.test(raw)) return t('errGesture');
  return '';
}

/**
 * 连接状态放在模块作用域，而不是组件 state。
 *
 * 设置页关闭时这个 section 会被卸载；如果连接挂在组件里，卸载就等于
 * 主动断开（之前的 bug）。放在模块里以后：关掉设置再打开、切到别的
 * 设置页再切回来，都还是连着的。只有刷新页面才会真正断开，
 * 那种情况交给挂载时的静默重连。
 */
const STATE = {
  adb: null,          // Android: Tango 的 Adb 实例
  hdc: null,          // HarmonyOS: HdcSession 实例
  device: null,       // 当前占用的 USBDevice
  info: null,         // 面板展示用的设备信息
  pending: null,      // 挂载时静默重连的进行中 Promise
  kind: null,         // 'adb' | 'hdc'
  log: [],            // HDC 收发日志（失败时显示到输出区）
  notify: null,       // 面板注册的实时刷新回调
  hdcKeyText: '',     // 保留字段（已不再暴露 UI）
  connectToken: 0,    // 每次连接自增；旧任务发现令牌变化即放弃
  connectInFlight: null,  // 串行化：同一时刻只允许一个连接流程
  hdcPending: null,   // 进行中的 HDC 会话（自动重连/手动连接都可能留下）
  keepAlive: null,    // 后台保活句柄
  agc: { state: 'idle', qr: '', message: '' },   // 华为账号登录状态
  agcView: null,   // 遥控浏览器截图 { image, width, height }
  connection: null,   // 宿主 RPC 连接（用于把 HDC 日志送到宿主落盘）
};

/**
 * 串行化连接：同一时刻只允许一个连接流程在跑。
 * 并发连接会让两个握手在同一设备上互相 RESET，双方都收不到应答。
 */
async function withConnectLock(fn) {
  if (STATE.connectInFlight) {
    try { await STATE.connectInFlight; } catch { /* 前一个失败无所谓 */ }
  }
  const run = (async () => fn())();
  STATE.connectInFlight = run.finally(() => {
    if (STATE.connectInFlight === run) { STATE.connectInFlight = null; }
  });
  return run;
}

/**
 * 后台保活：Chrome 会在标签页隐藏一段时间后冻结定时器，导致宿主桥停止轮询。
 * 播放一段几乎无声的 AudioContext 可以显著延缓冻结（业界常用做法）。
 * 必须在用户手势里首次调用。
 */
function startKeepAlive() {
  if (STATE.keepAlive) { return; }
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { return; }
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.00005;          // 几乎无声
    osc.frequency.value = 40;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    STATE.keepAlive = { ctx, osc };
    pushHdcLog('INFO', '已启用后台保活（阻止标签页被冻结）');
  } catch { /* 不支持就算了 */ }
}

/**
 * USB 掉线自愈：WebUSB 的 transfer 抛错后句柄即失效，此时用 getDevices() 取已授权设备
 * 重新走一遍连接（密钥已保存，通常无需上机确认）。
 */
async function tryReconnectHdc() {
  if (typeof navigator === 'undefined' || !navigator.usb) { return false; }
  try {
    const list = await navigator.usb.getDevices();
    const dev = list.find((d) => d.vendorId === 0x12d1);
    if (!dev) { return false; }
    pushHdcLog('INFO', 'USB 句柄失效，尝试自动重连');
    const next = await withConnectLock(async () => {
      const token = ++STATE.connectToken;
      if (STATE.hdc) { try { STATE.hdc.abort('掉线重连'); } catch { /* ignore */ } STATE.hdc = null; }
      return connectHarmony(dev, token);
    });
    STATE.info = next;
    STATE.kind = 'hdc';
    pushHdcLog('INFO', '自动重连成功');
    return true;
  } catch (e) {
    pushHdcLog('INFO', `自动重连失败：${(e && e.message) || e}`);
    return false;
  }
}

const AGC_API = '/mbridge/agc';

/** 发起华为账号扫码登录（宿主起真实浏览器，我们显示二维码） */
async function agcStartLogin() {
  STATE.agc = { state: 'loading', qr: '', message: '正在打开华为登录页…' };
  try {
    const r = await fetch(AGC_API + '/login/start', { method: 'POST' });
    const d = await r.json();
    STATE.agc = {
      state: d.state || (d.ok ? 'waiting' : 'failed'),
      qr: d.qr || '',
      message: d.message || d.error || '',
      url: d.url || '',
    };
    startAgcPolling();
  } catch (e) {
    STATE.agc = { state: 'failed', qr: '', message: String(e && e.message ? e.message : e) };
  }
}

let agcPollTimer = null;
function startAgcPolling() {
  if (agcPollTimer) { return; }
  agcPollTimer = setInterval(async () => {
    if (STATE.agc.state !== 'waiting' && STATE.agc.state !== 'loading') {
      clearInterval(agcPollTimer);
      agcPollTimer = null;
      return;
    }
    try {
      const r = await fetch(AGC_API + '/login/status');
      const d = await r.json();
      STATE.agc = {
        state: d.state || STATE.agc.state,
        qr: d.qr || STATE.agc.qr,
        message: d.message || '',
        cookieCount: d.cookieCount,
        phase: d.phase || 'waiting',
        qrLeft: d.qrLeft,
      };
    } catch { /* 忽略单次失败 */ }
  }, 3000);
}

async function agcPasswordLogin(account, password) {
  STATE.agc = { state: 'loading', qr: '', message: '正在提交账号密码…', mode: 'pwd' };
  try {
    const r = await fetch(AGC_API + '/login/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account, password }),
    });
    const d = await r.json();
    STATE.agc = {
      state: d.state || (d.ok ? 'waiting' : 'failed'),
      qr: d.qr || '',
      message: d.message || d.error || '',
      mode: d.mode || 'pwd',
      cookieCount: d.cookieCount,
    };
    if (STATE.agc.state === 'waiting') { startAgcPolling(); }
  } catch (e) {
    STATE.agc = { state: 'failed', qr: '', message: String(e && e.message ? e.message : e), mode: 'pwd' };
  }
}

async function agcSubmitCode(code) {
  try {
    const r = await fetch(AGC_API + '/login/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const d = await r.json();
    STATE.agc = {
      state: d.state || (d.ok ? 'waiting' : 'failed'),
      qr: d.qr || '',
      message: d.message || d.error || '',
      cookieCount: d.cookieCount,
    };
    if (STATE.agc.state === 'waiting') { startAgcPolling(); }
  } catch (e) {
    STATE.agc = { ...STATE.agc, state: 'failed', message: String(e && e.message ? e.message : e) };
  }
}

/** 拉取遥控画面（登录页 / 滑块验证） */
async function agcRefreshView() {
  try {
    const r = await fetch(AGC_API + '/view');
    const d = await r.json();
    if (d.ok) { STATE.agcView = { image: d.image, width: d.width, height: d.height, url: d.url }; }
    else { STATE.agc.message = d.error || '画面获取失败'; }
  } catch (e) { /* ignore */ }
  if (STATE.agc.state === 'success') { STATE.agcView = null; }
}

/** 把插件里的鼠标动作发给宿主执行 */
async function agcAct(action) {
  try {
    const r = await fetch(AGC_API + '/act', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    });
    const d = await r.json();
    if (!d.ok) { STATE.agc.message = d.error || '操作失败'; }
    else if (d.state === 'success') { STATE.agc.state = 'success'; }
  } catch { /* ignore */ }
}

let agcViewTimer = null;
function startAgcViewLoop() {
  if (agcViewTimer) { return; }
  agcRefreshView();
  agcViewTimer = setInterval(() => {
    if (!STATE.agcView && STATE.agc.state !== 'need_captcha' && STATE.agc.state !== 'waiting') {
      clearInterval(agcViewTimer); agcViewTimer = null; return;
    }
    agcRefreshView();
  }, 2500);
}

async function agcCheckSession() {
  try {
    const r = await fetch(AGC_API + '/session');
    const d = await r.json();
    if (d.present) {
      const t = d.savedAt ? new Date(d.savedAt * 1000).toLocaleString() : '';
      STATE.agc = { ...STATE.agc, state: 'success', message: `已有登录态（${d.cookieCount} 条 Cookie，采集于 ${t}）` };
    } else {
      STATE.agc = { ...STATE.agc, state: 'failed', message: '还没有登录态：请按上面步骤在浏览器里登录并点扩展发送' };
    }
  } catch (e) {
    STATE.agc = { ...STATE.agc, state: 'failed', message: '检查失败：' + String(e && e.message ? e.message : e) };
  }
}

async function agcClearSession() {
  try {
    await fetch(AGC_API + '/login/close', { method: 'POST' });
  } catch { /* ignore */ }
  STATE.agc = { state: 'idle', qr: '', message: '已清除登录态' };
}

/** 把 HDC 日志送到宿主写文件，便于直接读取而不必截屏。 */
async function flushHdcLog() {
  const conn = STATE.connection;
  if (!conn || !STATE.log || !STATE.log.length) { return; }
  try {
    await conn.rpc.call(BRIDGE, EP + '/log', { lines: STATE.log });
  } catch { /* 日志上报失败不影响主流程 */ }
}

/** Android 侧日志：与 HDC 用同一份面板日志，前缀区分 */
function pushAdbLog(text) { pushHdcLog('ADB', text); }

function pushHdcLog(dir, text) {
  const d = new Date();
  const ts = String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
  STATE.log.push(`${ts} ${dir} ${text}`);
  if (STATE.log.length > 400) { STATE.log.shift(); }
  // 实时推到面板，用户能看到"请在手机上点允许"这类提示
  if (STATE.notify) { try { STATE.notify(STATE.log.join('\n')); } catch { /* ignore */ } }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    const adb = STATE.adb;
    const hdc = STATE.hdc;
    STATE.adb = null;
    STATE.hdc = null;
    STATE.device = null;
    STATE.info = null;
    STATE.kind = null;
    if (adb) { try { adb.close(); } catch { /* best effort */ } }
    if (hdc) { try { hdc.close(); } catch { /* best effort */ } }
  });
}

async function readInfo(adb, device) {
  const prop = async (key) => { try { return await adb.getProp(key); } catch { return ''; } };
  return {
    serial: device.serial,
    vendorId: device.raw.vendorId,
    productId: device.raw.productId,
    model: await prop('ro.product.model'),
    android: await prop('ro.build.version.release'),
  };
}

/** 建立连接并认证；成功后写入模块级 STATE。 */
async function attach(device) {
  pushAdbLog(`=== Android 连接开始 build=${BUILD_TAG} serial="${device.serial || ''}" ===`);
  const connection = await device.connect();
  pushAdbLog('USB 已连接，开始 ADB 认证');
  const credentialStore = new AdbWebCredentialStore('dsh-mobile-bridge');
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore,
  });
  const adb = new Adb(transport);
  pushAdbLog('ADB 认证完成');
  const info = await readInfo(adb, device);
  pushAdbLog(`机型=${info.model || '?'} Android=${info.android || '?'}`);
  STATE.adb = adb;
  STATE.device = device;
  STATE.info = info;
  return info;
}

async function detach() {
  const adb = STATE.adb;
  const hdc = STATE.hdc;
  STATE.adb = null;
  STATE.hdc = null;
  STATE.device = null;
  STATE.info = null;
  STATE.kind = null;
  if (hdc) { try { hdc.abort('主动断开'); } catch { /* ignore */ } }
  if (adb) { try { await adb.close(); } catch { /* ignore */ } }
  if (hdc) { try { await hdc.close(); } catch { /* ignore */ } }
}

/**
 * 连接 HarmonyOS 设备（HDC over WebUSB）。
 *
 * 与 Android 分支的关键差别：
 *   · 不走 Tango，走自研 HdcTransport/HdcSession（协议来自真机抓包）
 *   · 首次要现场生成 RSA-3072 密钥对并用它应答 daemon 的 AUTH
 *   · 连上后先跑一条 param get 拿型号，作为面板展示信息
 */
async function connectHarmony(device, token) {
  const attempt = async (dev) => {
    checkToken();
    // 作废任何残留会话（包括自动重连留下的），否则它的心跳会一直写进端点，
    // 干扰本次握手（真机日志里出现过"认证前就发心跳"的现象）。
    if (STATE.hdcPending && STATE.hdcPending !== STATE.hdc) {
      try { STATE.hdcPending.abort('被新连接取代'); } catch { /* ignore */ }
    }
    STATE.hdcPending = null;
    STATE.log = [];
    pushHdcLog('INFO', `=== 尝试连接开始 build=${BUILD_TAG} serial=${JSON.stringify(dev.serialNumber || '')} ===`);
    await flushHdcLog();          // 先落一条，确保宿主侧能看到"这次确实跑了"
    const t = new HdcTransport(dev, { logger: pushHdcLog });
    try {
      return await connectHarmonyInner(t, dev);
    } catch (e) {
      // 失败必须释放：否则设备句柄留在 open 状态，之后每次 claim 都会失败
      try { await t.close(); } catch { /* ignore */ }
      throw e;
    }
  };

  const checkToken = () => {
    if (typeof token === 'number' && STATE.connectToken !== token) {
      throw new Error('已被新的连接操作取代，本次放弃');
    }
  };

  try {
    return await attempt(device);
  } catch (e) {
    const raw = String(e && e.message ? e.message : e);
    // 只在"接口/枚举"类错误上重试一次：手机授权后可能重新枚举，旧句柄已失效
    if (!/claim|Unable|NetworkError|disconnect|in use|busy/i.test(raw)) { throw e; }
    await new Promise((r) => setTimeout(r, 700));
    const list = await navigator.usb.getDevices().catch(() => []);
    const fresh = list.find((d) => d.vendorId === 0x12d1);
    if (!fresh) { throw e; }
    return await attempt(fresh);
  }
}

async function connectHarmonyInner(t, device) {
  t.emit('INFO', `vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)} `
    + `serial="${device.serialNumber || ''}" 版本=${DAEMON_VERSION}`); 
  // 密钥：复用浏览器里保存的（同一把只授权一次），没有就生成并保存
  let keyPair = null;
  let publicKeyPem = null;
  const stored = readStoredHdcKey();
  if (stored) {
    try {
      const imported = await importHdcKey(stored);
      keyPair = { privateKey: imported.privateKey };
      publicKeyPem = imported.publicKeyPem;
      t.emit('INFO', '复用浏览器已保存的密钥');
    } catch (e) {
      t.emit('INFO', `已保存的密钥不可用（${(e && e.message) || e}），改为新生成`);
    }
  }
  if (!keyPair) {
    keyPair = await hdcGenerateKeyPair();
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keyPair.privateKey));
    let bin = '';
    for (const c of pkcs8) { bin += String.fromCharCode(c); }
    const b64 = btoa(bin).replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
    const pem = '-----BEGIN ' + 'PRIVATE KEY' + '-----\n' + b64 + '\n'
      + '-----END ' + 'PRIVATE KEY' + '-----\n';
    const saved = storeHdcKey(pem);
    t.emit('INFO', `已生成并保存 RSA-3072 密钥（${saved ? '已存入浏览器' : '仅本次有效'}）`);
  }
  const hostname = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'dsh-web';
  const session = new HdcSession(t, {
    serial: device.serialNumber || '',
    hostname,
    keyPair,
    publicKeyPem,
  });
  STATE.hdcPending = session;
  let authText;
  try {
    authText = await session.connect();
  } catch (e) {
    try { session.abort('连接失败'); } catch { /* ignore */ }
    if (STATE.hdcPending === session) { STATE.hdcPending = null; }
    throw e;
  }
  if (STATE.hdcPending === session) { STATE.hdcPending = null; }

  // 机型/系统：多个候选参数依次尝试（不同版本参数名不同），并过滤掉报错行
  const probe = async (keys) => {
    for (const key of keys) {
      try {
        if (STATE.connectToken !== token) { return ''; }
        const r = await session.shell(`param get ${key}`, { timeoutMs: 6000, attempts: 3 });
        const lines = String(r.text || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        const val = lines.filter((l) => !l.includes('param get')).pop() || '';
        if (val && !/^\[?E\d/.test(val) && !/^error/i.test(val)) { return val; }
      } catch { /* 换下一个 */ }
    }
    return '';
  };
  // 连接刚建立时设备侧 shell 服务可能还没就绪（抓包显示真 hdc 会等 ~4 秒），
  // 所以这里先预热 + 多轮重试，直到取到机型为止。
  // 注意：探测失败**不应**导致连接失败——模型/API 只是展示信息。
  let model = '';
  let api = '';
  let online = '';
  try {
    for (let round = 1; round <= 5; round++) {
      if (STATE.connectToken !== token) { break; }
      model = await probe(['const.product.model', 'const.product.name', 'const.product.brand']);
      if (model) {
        api = await probe(['const.ohos.apiversion', 'const.product.software.version']);
        online = await probe(['const.product.devicetype']);
        break;
      }
      t.emit('INFO', `机型探测第 ${round}/5 轮未取到，1.5 秒后重试`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    t.emit('INFO', `设备信息探测失败（不影响连接）：${(e && e.message) || e}`);
  }
  t.emit('INFO', `探测结果 机型=${model || '?'} API=${api || '?'} 类型=${online || '?'}`);

  STATE.hdc = session;
  STATE.hdcPending = null;
  STATE.device = device;
  STATE.kind = 'hdc';
  STATE.info = {
    kind: 'hdc',
    serial: device.serialNumber || '',
    vendorId: device.vendorId,
    productId: device.productId,
    model: model
      || ((device.productName && !/HDC|Interface/i.test(device.productName)) ? device.productName : '')
      || 'HarmonyOS 设备',
    os: api ? `HarmonyOS (API ${api})` : 'HarmonyOS',
    devtype: online,
    auth: authText.split('\n').filter(Boolean).slice(-1)[0] || '',
  };
  return STATE.info;
}

/** 统一执行一条 shell 命令（ADB 或 HDC）。 */
/**
 * 截图：ADB 用 screencap，HDC 用 snapshot_display + base64 读回。
 * 返回 { bytes, mime }。
 */
async function captureScreen() {
  if (STATE.kind === 'hdc' && STATE.hdc) {
    const s = STATE.hdc;
    const path = `/data/local/tmp/dsh_shot_${Date.now()}.jpeg`;
    pushHdcLog('INFO', `截图：snapshot_display → ${path}`);
    const r1 = await s.shell(`snapshot_display -f ${path}`, { timeoutMs: 20000, attempts: 1 });
    pushHdcLog('INFO', `snapshot_display 输出: ${JSON.stringify(String(r1.text || '').slice(0, 120))}`);

    const rLs = await s.shell(`ls -l ${path}`, { timeoutMs: 8000, attempts: 1 });
    pushHdcLog('INFO', `ls -l: ${JSON.stringify(String(rLs.text || '').slice(0, 160))}`);

    let b64 = '';
    for (const cmd of [`base64 ${path}`, `base64 -w0 ${path}`, `cat ${path} | base64`]) {
      const r = await s.shell(cmd, { timeoutMs: 90000, attempts: 1 });
      const cand = String(r.text || '').replace(/[^A-Za-z0-9+/=]/g, '');
      pushHdcLog('INFO', `${cmd} → ${cand.length} 字符`);
      if (cand.length > 1000) { b64 = cand; break; }
    }
    s.shell(`rm -f ${path}`, { timeoutMs: 8000, attempts: 1 }).catch(() => {});
    if (!b64) {
      throw new Error('截图文件读回为空。'
        + `snapshot 输出=${JSON.stringify(String(r1.text || '').slice(0, 80))}；`
        + `ls -l=${JSON.stringify(String(rLs.text || '').slice(0, 80))}`);
    }
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { bytes[i] = bin.charCodeAt(i); }
    return { bytes, mime: 'image/jpeg' };
  }

  const adb = STATE.adb;
  if (!adb) { throw new Error('未连接设备'); }
  const bytes = await adb.subprocess.noneProtocol.spawnWait('screencap -p');
  return { bytes, mime: 'image/png' };
}

async function execShell(cmd) {
  if (STATE.kind === 'hdc' && STATE.hdc) {
    const r = await STATE.hdc.shell(cmd);
    return '$ ' + cmd + '\n' + (r.text || '');
  }
  if (STATE.adb) {
    return runShellText(STATE.adb, cmd);
  }
  throw new Error('未连接设备');
}

async function runShellText(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp) {
    const r = await sp.spawnWaitText(cmd);
    return (
      '$ ' + cmd + '\n' +
      (r.stdout || '') +
      (r.stderr ? '\n[stderr] ' + r.stderr : '') +
      '\n[exit ' + r.exitCode + ']'
    );
  }
  const text = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
  return '$ ' + cmd + '\n' + text;
}

function fromBase64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

function toBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 浏览器可达的 RPC 只有共享 /api 通道；宿主用 intercept 接管这些端点。
const BRIDGE = '/api';
const EP = 'mobile-bridge';

/** 桥接诊断：面板会显示，console 也会打，避免"静默失败"。 */
const DIAG = { state: 'init', polls: 0, lastOk: 0, error: null, injected: null };
const POLL_INTERVAL_MS = 1500;

/** 执行一条宿主派下来的任务。 */
async function runJob(job) {
  if (!STATE.adb && !STATE.hdc) { return { ok: false, error: '浏览器端尚未连接设备（请在设置页点「连接设备」）' }; }
  const token = STATE.connectToken;
  const stale = () => STATE.connectToken !== token;
  try {
    if (job.kind === 'shell') {
      const output = await execShell(job.data.cmd);
      if (stale()) { return { ok: false, error: '连接已切换，任务作废' }; }
      return { ok: true, output };
    }
    if (job.kind === 'screenshot') {
      const shot = await captureScreen();
      if (stale()) { return { ok: false, error: '连接已切换，任务作废' }; }
      if (shot.bytes.length > 12 * 1024 * 1024) {
        return { ok: false, error: `截图过大（${shot.bytes.length} 字节），未回传` };
      }
      return { ok: true, base64: toBase64(shot.bytes), mime: shot.mime };
    }
    if (job.kind === 'push' || job.kind === 'pull' || job.kind === 'install' || job.kind === 'uninstall') {
      if (STATE.kind !== 'hdc' || !STATE.hdc) {
        return { ok: false, error: '文件传输/安装目前只支持 HarmonyOS 通道（Android 侧待接入 Tango sync）' };
      }
      const log = (m) => pushHdcLog('INFO', m);
      if (job.kind === 'push') {
        const bytes = fromBase64(job.data.base64);
        // 分片模式：只写这一块（幂等，写到精确偏移）
        if (typeof job.data.index === 'number' && job.data.chunkSize) {
          const r = await writeChunkAt(STATE.hdc, job.data.path, bytes, job.data.chunkSize, job.data.index, { log });
          return { ok: true, bytes: r.bytes, chunk: job.data.index };
        }
        log(`开始上传 ${bytes.length} 字节 → ${job.data.path}`);
        const r = await pushFile(STATE.hdc, job.data.path, bytes, { log });
        if (stale()) { return { ok: false, error: '连接已切换，任务作废' }; }
        return { ok: true, bytes: r.bytes, chunks: r.chunks };
      }
      if (job.kind === 'pull') {
        log(`开始下载 ${job.data.path}`);
        const r = await pullFile(STATE.hdc, job.data.path, { log });
        if (stale()) { return { ok: false, error: '连接已切换，任务作废' }; }
        return { ok: true, bytes: r.bytes.length, base64: toBase64(r.bytes) };
      }
      if (job.kind === 'install') {
        const bytes = fromBase64(job.data.base64);
        log(`开始安装 ${job.data.filename}（${bytes.length} 字节）`);
        const r = await installHap(STATE.hdc, {
          bytes, filename: job.data.filename, replace: !!job.data.replace,
        }, { log });
        return { ok: true, output: r.output };
      }
      if (job.kind === 'uninstall') {
        const out = await uninstallBundle(STATE.hdc, job.data.bundle);
        return { ok: true, output: out };
      }
    }
    return { ok: false, error: '未知任务类型 ' + job.kind };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // USB 掉线：句柄已失效，尝试自动重连后重试一次同一个任务
    if (/transferIn|transferOut|USBDevice|disconnect|lost|No device/i.test(msg)
        && STATE.kind === 'hdc' && !stale()) {
      const ok = await tryReconnectHdc();
      if (ok) {
        try {
          if (job.kind === 'shell') {
            return { ok: true, output: await execShell(job.data.cmd) };
          }
          if (job.kind === 'pull') {
            const r = await pullFile(STATE.hdc, job.data.path, { log: (m) => pushHdcLog('INFO', m) });
            return { ok: true, bytes: r.bytes.length, base64: toBase64(r.bytes) };
          }
          if (job.kind === 'push') {
            const bytes = fromBase64(job.data.base64);
            const r = await pushFile(STATE.hdc, job.data.path, bytes, { log: (m) => pushHdcLog('INFO', m) });
            return { ok: true, bytes: r.bytes, chunks: r.chunks };
          }
        } catch (e2) {
          return { ok: false, error: `重连后重试仍失败：${String(e2 && e2.message ? e2.message : e2)}` };
        }
      }
    }
    return { ok: false, error: msg };
  }
}

function startBridge(connection) {
  STATE.connection = connection;
  let stopped = false;
  DIAG.state = 'polling';
  (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const res = await connection.rpc.call(BRIDGE, EP + '/poll', {
          device: STATE.info
            ? { model: STATE.info.model, android: STATE.info.android, serial: STATE.info.serial }
            : null,
          // 带上客户端身份与最近日志：宿主会落盘，便于判断浏览器跑的是哪一版
          build: BUILD_TAG,
          log: STATE.log && STATE.log.length ? STATE.log.slice(-80) : undefined,
        });
        DIAG.polls += 1;
        DIAG.lastOk = Date.now();
        DIAG.error = null;
        if (res && res.ok && res.value && res.value.job) {
          const job = res.value.job;
          const outcome = await runJob(job);
          await connection.rpc.call(BRIDGE, EP + '/result', Object.assign({ id: job.id }, outcome));
        }
      } catch (e) {
        DIAG.error = String(e && e.message ? e.message : e);
        if (DIAG.polls === 0 || DIAG.polls % 20 === 0) {
          console.warn('[mobile-bridge] poll failed:', e);
        }
      }
      await sleep(Math.max(0, POLL_INTERVAL_MS - (Date.now() - started)));
    }
  })();
  return () => { stopped = true; };
}

const CSS = `
.mb-root { display: flex; flex-direction: column; gap: 14px; font-size: 13px; }
.mb-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.mb-btn {
  padding: 7px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-fill-l2); color: var(--dsw-alias-label-primary);
  font-size: 13px; cursor: pointer;
}
.mb-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.mb-btn:disabled { opacity: .45; cursor: not-allowed; }
.mb-btn--primary { background: var(--dsw-alias-brand-primary); color: #fff; border-color: transparent; }
.mb-card {
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px;
  padding: 12px 14px; background: var(--dsw-alias-fill-l1);
}
.mb-kv { display: grid; grid-template-columns: 92px 1fr; row-gap: 4px; }
.mb-k { color: var(--dsw-alias-label-tertiary); }
.mb-v { color: var(--dsw-alias-label-primary); word-break: break-all; }
.mb-note { color: var(--dsw-alias-label-tertiary); line-height: 1.6; }
.mb-err { color: var(--dsw-alias-label-error, #d9534f); white-space: pre-wrap; line-height: 1.6; }
.mb-input {
  flex: 1; min-width: 220px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-l1, transparent); color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
}
.mb-out {
  margin: 0; padding: 10px; border-radius: 8px; max-height: 260px; overflow: auto;
  background: var(--dsw-alias-fill-l2); color: var(--dsw-alias-label-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; white-space: pre-wrap; word-break: break-all;
}
.mb-badge {
  display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-secondary);
}
`;

function MobileBridgeSection(props) {
  const t = props.t;
  const [phase, setPhase] = React.useState((STATE.adb || STATE.hdc) ? 'connected' : 'idle');
  const [kind, setKind] = React.useState(STATE.kind || 'adb');
  const [error, setError] = React.useState('');
  const [info, setInfo] = React.useState(STATE.info);
  const [cmd, setCmd] = React.useState(
    (STATE.kind === 'hdc') ? 'param get const.product.model' : 'getprop ro.product.model',
  );
  const [out, setOut] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [agcAccount, setAgcAccount] = React.useState('');
  const [agcPassword, setAgcPassword] = React.useState('');
  const [agcCode, setAgcCode] = React.useState('');
  const [usbSupported] = React.useState(
    typeof navigator !== 'undefined' && !!navigator.usb,
  );
  // 诊断心跳：DIAG 是模块级对象，没有它面板不会重渲染
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    STATE.notify = (text) => setOut(text);
    return () => { clearInterval(id); if (STATE.notify) { STATE.notify = null; } };
  }, []);

  // 挂载时：若模块里已有连接就复用；否则尝试静默重连（不需要用户手势，
  // 之前授权过的设备可以用 getDevices() 取到）。
  React.useEffect(() => {
    let alive = true;
    (async () => {
      if (STATE.adb || STATE.hdc) { return; }
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) { return; }
      setPhase('reconnecting');
      try {
        const token = STATE.connectToken;
        const devices = await manager.getDevices();
        if (devices.length > 0 && !STATE.pending && STATE.connectToken === token) {
          STATE.pending = attach(devices[0]).finally(() => { STATE.pending = null; });
          const next = await STATE.pending;
          if (STATE.connectToken !== token) { await detach(); return; }   // 用户已手动连接
          if (alive) { setInfo(next); setPhase('connected'); return; }
        }
      } catch { /* 静默失败：交回手动连接 */ }

      // ADB 没连上时再试 HDC：之前授权过的设备可以用 getDevices() 直接拿到，
      // 密钥已保存在浏览器里，所以重连通常不需要再上机确认。
      try {
        if (typeof navigator !== 'undefined' && navigator.usb) {
          const granted = await navigator.usb.getDevices();
          const dev = granted.find((d) => d.vendorId === 0x12d1);
          if (dev && !STATE.hdc && !STATE.adb) {
            pushHdcLog('INFO', '检测到已授权的鸿蒙设备，尝试自动重连');
            const next = await withConnectLock(async () => {
              const token = ++STATE.connectToken;
              return connectHarmony(dev, token);
            });
            if (STATE.connectToken !== token) { await detach(); return; }
            if (alive) { setInfo(next); setKind('hdc'); setCmd('param get const.product.model'); setPhase('connected'); return; }
          }
        }
      } catch (e) {
        pushHdcLog('INFO', `HDC 自动重连未成功：${(e && e.message) || e}`);
      }

      if (alive) { setPhase('idle'); }
    })();
    return () => { alive = false; };  // 注意：这里不再断开连接
  }, []);

  async function connect() {
    return withConnectLock(runConnect);
  }

  async function runConnect() {
    setError('');
    setPhase('connecting');
    startKeepAlive();
    // 作废上一次会话：避免它的重试循环继续往端点写旧 sid 的帧
    const token = ++STATE.connectToken;
    if (STATE.hdc) { try { STATE.hdc.abort('用户发起新连接'); } catch { /* ignore */ } STATE.hdc = null; }
    STATE.info = null;
    try {
      if (kind === 'hdc') {
        // HarmonyOS：直接用 WebUSB 选设备（华为 VID），再走 HDC 协议
        if (typeof navigator === 'undefined' || !navigator.usb) { throw new Error(t('noWebusb')); }
        const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x12d1 }] });
        if (!device) { setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle'); return; }
        if (STATE.adb || STATE.hdc) { await detach(); }
        const next = await connectHarmony(device, token);
        await flushHdcLog();
        setInfo(next);
        setCmd('param get const.product.model');
        setPhase('connected');
        return;
      }
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) { throw new Error(t('noWebusb')); }
      const device = await manager.requestDevice();
      if (STATE.connectToken !== token) { return; }        // 期间已发起新连接
      if (!device) { setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle'); return; }
      if (STATE.adb || STATE.hdc) { await detach(); }
      const next = await attach(device);
      if (STATE.connectToken !== token) { await detach(); return; }   // 连接被取代
      setInfo(next);
      setCmd('getprop ro.product.model');
      setPhase('connected');
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      const hint = friendly(raw, t, kind);
      // 日志与原始错误在下面统一设置（并把日志复制到剪贴板）
      const logText = (STATE.log && STATE.log.length)
        ? STATE.log.join('\n')
        : '（本次未产生收发日志：说明失败发生在创建传输层之前）';
      setOut(logText);
      try {
        // 方便用户直接粘贴给开发者：失败即把完整日志放进剪贴板
        await navigator.clipboard.writeText(logText);
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw
          + '\n\n完整收发日志已复制到剪贴板，直接 Ctrl+V 粘贴即可。');
      } catch {
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw);
      }
      await flushHdcLog();
      setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle');
    }
  }

  async function disconnect() {
    await detach();
    setInfo(null);
    setOut('');
    setPhase('idle');
  }

  async function runShell() {
    if (!STATE.adb && !STATE.hdc) { setPhase('idle'); return; }
    setBusy(true);
    setError('');
    const token = STATE.connectToken;
    try {
      const text = await execShell(cmd);
      if (STATE.connectToken !== token) { return; }   // 连接已切换，丢弃旧结果
      setOut(text);
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      const hint = friendly(raw, t, kind);
      // 日志与原始错误在下面统一设置（并把日志复制到剪贴板）
      const logText = (STATE.log && STATE.log.length)
        ? STATE.log.join('\n')
        : '（本次未产生收发日志：说明失败发生在创建传输层之前）';
      setOut(logText);
      try {
        // 方便用户直接粘贴给开发者：失败即把完整日志放进剪贴板
        await navigator.clipboard.writeText(logText);
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw
          + '\n\n完整收发日志已复制到剪贴板，直接 Ctrl+V 粘贴即可。');
      } catch {
        setError((hint ? (hint + '\n\n') : '') + '原始错误：' + raw);
      }
      await flushHdcLog();
    } finally {
      setBusy(false);
    }
  }

  async function screenshot() {
    if (!STATE.adb && !STATE.hdc) { setPhase('idle'); return; }
    setBusy(true);
    setError('');
    const token = STATE.connectToken;
    try {
      const shot = await captureScreen();
      // 期间连接被切换 → 丢弃结果，避免把旧设备屏幕当成新设备
      if (STATE.connectToken !== token) { return; }
      const url = URL.createObjectURL(new Blob([shot.bytes], { type: shot.mime }));
      window.open(url, '_blank');
      pushHdcLog('INFO', `截图完成：${shot.bytes.length} 字节`);
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      const hint = friendly(raw, t, kind);
      setError(hint ? (hint + '\n\n原始错误：' + raw) : '截图失败：' + raw);
      setOut((STATE.log || []).slice(-30).join('\n') || raw);
    } finally {
      setBusy(false);
    }
  }

  async function copyOut() {
    try {
      await navigator.clipboard.writeText(out);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(t('copyFailed'));
    }
  }

  const phaseLabel = {
    idle: t('stateIdle'),
    reconnecting: t('stateReconnecting'),
    connecting: t('connecting'),
    connected: t('stateConnected'),
  }[phase] || t('stateIdle');

  const children = [
    h('style', { key: 's' }, CSS),
    h('div', { key: 'row', className: 'mb-row' },
      h('span', { key: 't0', className: 'mb-note' }, t('kindLabel')),
      h('button', {
        key: 'kadb',
        className: 'mb-btn' + (kind === 'adb' ? ' mb-btn--primary' : ''),
        disabled: !!STATE.adb || !!STATE.hdc,
        onClick: () => { setKind('adb'); },
      }, t('kindAdb')),
      h('button', {
        key: 'khdc',
        className: 'mb-btn' + (kind === 'hdc' ? ' mb-btn--primary' : ''),
        disabled: !!STATE.adb || !!STATE.hdc,
        onClick: () => { setKind('hdc'); },
      }, t('kindHdc')),
      h('button', {
        key: 'diag',
        className: 'mb-btn',
        onClick: async () => {
          setError('');
          try {
            const d = await diagnoseUsb();
            setOut('USB 诊断：\n' + JSON.stringify(d, null, 2));
          } catch (e) {
            setError(String(e && e.message ? e.message : e));
          }
        },
      }, t('diagnose')),
      h('button', {
        key: 'c',
        className: 'mb-btn mb-btn--primary',
        disabled: phase === 'connecting' || !usbSupported,
        onClick: connect,
      }, phase === 'connecting' ? t('connecting') : t('connect')),
      phase === 'connected'
        ? h('button', { key: 'd', className: 'mb-btn', onClick: disconnect }, t('disconnect'))
        : null,
      h('span', { key: 'b', className: 'mb-badge' }, phaseLabel),
      h('span', { key: 'build', className: 'mb-badge' }, BUILD_TAG),
    ),
  ];

  if (phase === 'reconnecting') {
    children.push(h('div', { key: 'rc', className: 'mb-note' }, t('reconnectingHint')));
  }

  if (!usbSupported) {
    children.push(h('div', { key: 'nu', className: 'mb-note' }, t('noWebusb')));
  }

  if (error) {
    children.push(h('div', { key: 'e', className: 'mb-err' }, error));
  }

  // 连接过程中实时显示日志与提示（直接从模块级 STATE.log 取，
  // 不依赖回调注册，避免组件重挂载导致回调为 null 而看不到任何提示）
  if (phase === 'connecting' && STATE.log && STATE.log.length) {
    const needConfirm = STATE.log.some((l) => l.indexOf('请在手机上点') >= 0);
    if (needConfirm) {
      children.push(h('div', {
        key: 'nc',
        className: 'mb-err',
        style: { marginTop: '6px' },
      }, '📱 请在手机上点「允许 / 始终信任」，然后保持本页面不要关闭'));
    }
    const tail = STATE.log.slice(-40).join('\n');
    children.push(h('pre', { key: 'live', className: 'mb-out' }, tail));
  }

  if (info) {
    children.push(h('div', { key: 'i', className: 'mb-card' },
      h('div', { className: 'mb-kv' },
        h('span', { className: 'mb-k' }, t('model')),
        h('span', { className: 'mb-v' }, info.model || '—'),
        h('span', { className: 'mb-k' }, info.kind === 'hdc' ? t('os') : t('android')),
        h('span', { className: 'mb-v' }, info.os || info.android || '—'),
        h('span', { className: 'mb-k' }, t('serial')),
        h('span', { className: 'mb-v' }, info.serial || '—'),
        h('span', { className: 'mb-k' }, t('usbId')),
        h('span', { className: 'mb-v' },
          '0x' + info.vendorId.toString(16) + ' / 0x' + info.productId.toString(16)),
      ),
    ));

    // ---- 华为账号登录（自动签名用）----
    const agc = STATE.agc || { state: 'idle' };
    children.push(h('details', { key: 'agc', className: 'mb-card', style: { marginTop: '10px' } },
      h('summary', { style: { cursor: 'pointer', userSelect: 'none' } }, t('agcTitle')),
      h('div', { className: 'mb-note', style: { marginTop: '6px', lineHeight: 1.6 } }, t('agcHint')),
      h('div', { className: 'mb-row', style: { marginTop: '8px' } },
        h('button', { className: 'mb-btn', onClick: agcStartLogin }, t('agcLogin')),
        h('button', { className: 'mb-btn', onClick: agcClearSession }, t('agcLogout')),
      ),
      agc.state === 'loading'
        ? h('div', { className: 'mb-note', style: { marginTop: '8px' } }, agc.message || '正在打开…')
        : null,
      agc.state === 'waiting'
        ? h('div', { style: { marginTop: '10px' } },
            h('div', { className: 'mb-note' },
              (agc.phase === 'scanned' ? '✅ 已扫码，请在手机上点「确认登录」'
                : agc.phase === 'expired' ? '二维码已过期，正在自动刷新…'
                : (agc.message || t('agcWaiting')))
              + (typeof agc.qrLeft === 'number' ? `（约 ${agc.qrLeft} 秒后自动刷新）` : '')),
            (agc.qr && agc.qr.length > 2000)
              ? h('img', {
                  src: 'data:image/png;base64,' + agc.qr,
                  style: { display: 'block', marginTop: '8px', width: '290px', height: '290px', borderRadius: '6px', background: '#fff' },
                })
              : h('div', { className: 'mb-note' }, t('agcNoQr')),
            h('button', { className: 'mb-btn', style: { marginTop: '8px' }, onClick: agcStartLogin }, t('agcRefresh')),
          )
        : null,
      agc.state === 'success'
        ? h('div', { className: 'mb-note', style: { marginTop: '8px', color: '#4ade80' } },
            t('agcSuccess') + (agc.cookieCount ? `（${agc.cookieCount} 条 Cookie）` : ''))
        : null,
      agc.state === 'failed'
        ? h('div', { className: 'mb-err', style: { marginTop: '8px' } },
            t('agcFailed') + (agc.message ? '：' + agc.message : ''))
        : null,
    ));

    children.push(h('div', { key: 'sh', className: 'mb-row' },
      h('input', {
        className: 'mb-input',
        value: cmd,
        spellCheck: false,
        onChange: (ev) => setCmd(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter' && !busy) { runShell(); } },
      }),
      h('button', { className: 'mb-btn', disabled: busy, onClick: runShell }, t('run')),
      h('button', { className: 'mb-btn', disabled: busy, onClick: screenshot }, t('screenshot')),
    ));

    if (out) {
      children.push(h('div', { key: 'oh', className: 'mb-row' },
        h('button', { className: 'mb-btn', onClick: copyOut }, copied ? t('copied') : t('copy')),
      ));
      children.push(h('pre', { key: 'o', className: 'mb-out' }, out));
    }
  }

  const diagText =
    '桥接 ' + DIAG.state +
    ' · connection=' + (DIAG.injected || '—') +
    ' · 轮询 ' + DIAG.polls + ' 次' +
    (DIAG.lastOk ? ' · 最近成功 ' + Math.max(0, Math.round((Date.now() - DIAG.lastOk) / 1000)) + 's 前' : '') +
    (DIAG.error ? ' · 错误: ' + DIAG.error : '');
  children.push(h('div', { key: 'diag', className: 'mb-note', style: { fontSize: '11.5px' } }, diagText));

  children.push(h('div', { key: 'n', className: 'mb-note' }, t(kind === 'hdc' ? 'hintHdc' : 'hintAdb')));

  return h('div', { className: 'mb-root' }, children);
}

export function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, {
    zh: {
      nav: '移动设备',
      connect: '连接设备',
      connecting: '连接中…',
      disconnect: '断开',
      run: '执行',
      screenshot: '截图',
      copy: '复制输出',
      copied: '已复制',
      copyFailed: '复制失败：浏览器拒绝了剪贴板写入，请手动选中输出复制。',
      os: '系统',
      diagnose: '诊断',
      hintAdb: '连接会跟着页面保留：关掉设置、切到别页再回来都不用重连；刷新页面则会断开，之后会自动尝试恢复。需要在手机上开启「USB 调试」，首次连接时手机会弹出授权提示。同一时刻只能有一个程序占用 USB，请先停掉本机的 adb server、Android Studio、scrcpy 等。',
      hintHdc: '连接会跟着页面保留：关掉设置、切到别页再回来都不用重连；刷新页面则会断开。需要在手机上开启「USB 调试」，并且本机不能有 hdc / DevEco Studio 正在占用设备（连接前先执行 hdc kill）。首次连接需要在手机上点「允许 / 始终信任」；之后同一把密钥不会再询问。连接建立后才可用命令与截图。',
      agcTitle: '华为账号登录（用于自动签名安装）',
      agcHint: '用手机「控制中心 → 扫一扫」扫码登录华为开发者账号。登录态只保存在本机，用于自动申请调试证书与 Profile；不需要你手工准备已签名的 HAP。',
      agcLogin: '开始登录（显示二维码）',
      agcRefresh: '刷新二维码',
      agcLogout: '清除登录态',
      agcWaiting: '等待扫码…二维码约 2 分钟有效',
      agcSuccess: '已登录，登录态已保存',
      agcFailed: '登录失败',
      agcNoQr: '点「开始登录」后在手机扫码',
      agcPwdTitle: '账号密码登录',
      agcAccount: '华为账号（手机号/邮箱）',
      agcPassword: '密码',
      agcPwdSubmit: '登录',
      agcCodeTitle: '短信验证码',
      agcCodeSubmit: '提交验证码',
      agcPwdHint: '账号密码只在本机转发给登录进程，不写日志、不保存。若弹出滑块验证，直接在下面的画面上拖动即可。',
      agcManual: '手动完成验证（在画面上拖动滑块 / 点击）',
      agcExtTitle: '方式一：用你本机的浏览器登录（推荐）',
      agcExtHint: '1) 点下面下载扩展 → 解压；2) 浏览器打开 chrome://extensions 或 edge://extensions，开启「开发者模式」，选择「加载已解压的扩展程序」，选中解压出来的文件夹；3) 在浏览器里正常登录 developer.huawei.com（密码/短信/扫码都行）；4) 点浏览器工具栏里的扩展图标 →「发送登录态给 DSH」。',
      agcExtDownload: '下载扩展（zip）',
      agcCheck: '检查登录态',
      agcManualBtn: '打开浏览器画面',
      agcViewHint: '画面来自宿主的浏览器。拖动滑块：在图上按住并往右拖；也可以直接点击。',
      hdcKeyTitle: '密钥设置（默认已自动保存，无需操作）',
      hdcKeyReset: '重置密钥',
      hdcKeyStored: '默认会保存一把密钥并复用，授权只需做一次；只有想换密钥时才需要点重置',
      hdcKeyHint: '如果你的电脑上 hdc 已经能连上这台手机，说明它的密钥已被设备信任。把这两个文件的内容一起粘贴进来（先私钥再公钥）：\nC:\\Users\\<你>\\.harmony\\hdckey  和  hdckey.pub\n提取方法（PowerShell）：Get-Content -Raw "$env:USERPROFILE\\.harmony\\hdckey"; Get-Content -Raw "$env:USERPROFILE\\.harmony\\hdckey.pub"',
      kindLabel: '设备类型',
      kindAdb: 'Android',
      kindHdc: 'HarmonyOS',
      hdcHint: 'HarmonyOS 走 HDC 协议（WebUSB 直连），首次连接会在设备上弹出授权，全部完成后才会显示「已连接」。',
      model: '机型',
      android: 'Android',
      serial: '序列号',
      usbId: 'USB ID',
      stateConnected: '已连接',
      stateIdle: '未连接',
      stateReconnecting: '正在恢复连接…',
      reconnectingHint: '检测到之前授权过的设备，正在用已保存的 RSA 密钥自动重连，不需要再点按钮。',
      noWebusb: '当前浏览器不支持 WebUSB。请使用 Chrome 或 Edge 打开本页面。',
      errBusy: '手机已被另一个程序占用（这一步是浏览器拿到了 USB 设备，但接口被抢占）。\n请在你自己电脑上依次做：\n1) 关掉 adb 服务：adb kill-server（Windows 任务管理器里结束 adb.exe）\n2) 退出 Android Studio、scrcpy、华为 HiSuite、各类手机助手\n3) 拔掉数据线再插回去，保持屏幕解锁\n4) 回到这里重新点「连接设备」',
      errExclusive: '这台电脑上的 hdc server 正独占着设备，Chrome 连 open 都做不到（真机实测：hdc server 在跑时 libusb_open 返回 -3 ACCESS，接口本身是正常的 WINUSB）。\n\n请按顺序做：\n1) 在 Windows 上执行（绝对路径）：\n   & "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe" kill\n2) 关闭 DevEco Studio（它开着会自动把 hdc 拉起来）\n3) 执行完之后【不要再运行任何 hdc 命令】，立刻回来点「连接设备」\n\n注意：任何一条 hdc 命令（包括 hdc list targets）都会让 server 重新抢占设备。',
      errHdcBusy: '浏览器无法接管 HDC 接口——几乎总是因为这台电脑上的 hdc server 正占着它（DevEco Studio 会自动拉起 hdc）。\n请在该电脑上依次做：\n1) 执行 hdc kill（或在任务管理器里结束 hdc.exe）\n2) 关闭 DevEco Studio / 手机助手 / HiSuite\n3) 拔掉数据线再插回去，保持屏幕解锁\n4) 回到这里重新点「连接设备」\n若 hdc kill 后仍失败，才是驱动问题（该 HDC 接口未绑定 WinUSB）。',
      errDriver: '浏览器无法接管该 USB 接口，通常是手机在 Windows 上绑的是 MTP/厂商驱动而不是 WinUSB。\n请在电脑上安装 Google Android USB Driver，或在设备管理器里把该设备的驱动改为 WinUSB，然后重新插拔。',
      errGesture: '浏览器要求由点击触发设备选择，请直接点「连接设备」按钮，不要通过脚本调用。',
      hint: '连接会跟着页面保留：关掉设置、切到别的页再回来都不用重连；刷新页面则会断开，之后会自动尝试恢复。需要在手机上开启「USB 调试」，首次连接时手机会弹出授权提示。同一时刻只能有一个程序占用 USB，请先停掉本机的 adb server、Android Studio、scrcpy 等。',
    },
    en: {
      nav: 'Mobile device',
      connect: 'Connect device',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      run: 'Run',
      screenshot: 'Screenshot',
      copy: 'Copy output',
      copied: 'Copied',
      copyFailed: 'Copy failed: the browser refused clipboard access. Select the output and copy manually.',
      os: 'OS',
      diagnose: 'Diagnose',
      hintAdb: 'The connection survives closing settings or switching pages; reloading the page drops it and it will try to reconnect. Enable USB debugging on the phone and confirm the authorization prompt on first connect. Only one program may hold the USB device, so stop the adb server, Android Studio and scrcpy first.',
      hintHdc: 'The connection survives closing settings or switching pages; reloading drops it. Enable USB debugging on the phone and make sure no hdc / DevEco Studio is holding the device (run hdc kill first). On first connect tap Allow / Always trust on the phone; the saved key is not asked for again. Commands and screenshots work once connected.',
      agcTitle: 'Huawei account sign-in (for automatic signing)',
      agcHint: 'Scan the QR with your phone (Control Center > Scan) to sign in. The session stays on this machine and is used to request a debug certificate and profile; you do not need to supply a pre-signed HAP.',
      agcLogin: 'Start sign-in (show QR)',
      agcRefresh: 'Refresh QR',
      agcLogout: 'Clear session',
      agcWaiting: 'Waiting for the scan - the QR expires after about two minutes',
      agcSuccess: 'Signed in, session saved',
      agcFailed: 'Sign-in failed',
      agcNoQr: 'Click Start sign-in, then scan with your phone',
      hdcKeyTitle: 'Key settings (a key is generated and saved automatically)',
      hdcKeyReset: 'Reset key',
      hdcKeyStored: 'The generated key is kept and reused, so authorization is needed once. Reset only if you want a new key.',
      hdcKeyHint: 'If hdc already connects to this phone from this PC, that key is trusted. Paste both files (private key first, then public key).',
      kindLabel: 'Device type',
      kindAdb: 'Android',
      kindHdc: 'HarmonyOS',
      hdcHint: 'HarmonyOS uses the HDC protocol over WebUSB. The device asks for authorization on first connect; the panel shows Connected only after it completes.',
      model: 'Model',
      android: 'Android',
      serial: 'Serial',
      usbId: 'USB ID',
      stateConnected: 'Connected',
      stateIdle: 'Not connected',
      stateReconnecting: 'Restoring connection…',
      reconnectingHint: 'A previously authorized device was found; reconnecting with the stored RSA key, no click needed.',
      noWebusb: 'This browser has no WebUSB support. Open this page in Chrome or Edge.',
      errBusy: 'The phone is held by another program: the browser reached the USB device but could not claim the interface.\nOn your own computer:\n1) stop the adb server: adb kill-server (or end adb.exe in Task Manager)\n2) quit Android Studio, scrcpy, HiSuite and phone-assistant tools\n3) unplug and replug the cable, keep the screen unlocked\n4) click "Connect device" again',
      errExclusive: 'The hdc server on this computer holds the device exclusively, so Chrome cannot even open it. (Measured on the real device: with the hdc server running, libusb_open returns -3 ACCESS, while the interface itself is a healthy WINUSB node.)\n\nDo this in order:\n1) On Windows run:\n   & "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe" kill\n2) Quit DevEco Studio (it restarts hdc automatically)\n3) After that do NOT run any hdc command; click "Connect device" right away\n\nAny hdc command (even hdc list targets) lets the server grab the device again.',
      errHdcBusy: 'The browser cannot claim the HDC interface. This is almost always because the hdc server on this computer is holding it (DevEco Studio starts hdc automatically).\nOn that computer:\n1) run hdc kill (or end hdc.exe in Task Manager)\n2) quit DevEco Studio / HiSuite / phone-assistant tools\n3) unplug and replug the cable, keep the screen unlocked\n4) click "Connect device" again\nIf it still fails after hdc kill, then it is a driver problem (HDC interface not bound to WinUSB).',
      errDriver: 'The browser cannot take over this USB interface. On Windows the phone is usually bound to the MTP/vendor driver instead of WinUSB.\nInstall the Google Android USB Driver, or switch the device driver to WinUSB in Device Manager, then replug.',
      errGesture: 'The browser requires a click to open the device chooser. Press the "Connect device" button directly.',
      hint: 'The connection survives closing settings or switching tabs; a page refresh drops it and triggers an automatic restore attempt. Enable USB debugging on the phone; the first connection asks for authorization on the device. Only one program can hold the USB interface, so stop the local adb server, Android Studio, and scrcpy first.',
    },
  }), 'mobile-bridge: locale');

  const t = ctx.locale.bind(NS);

  // 与宿主建立任务通道（不依赖 UI 是否挂载）
  // 不依赖 dsh.client.inject 的加载顺序：connection 服务可能在我之后才 provide，
  // 所以轮询等待它出现再启动桥（apply 期间拿不到就每 800ms 再试）。
  ctx.effect(() => {
    let cancelled = false;
    let timer = null;
    let stopBridge = null;

    const attempt = () => {
      if (cancelled || stopBridge) { return; }
      let conn = null;
      try { conn = ctx.get('connection'); } catch (e) {
        DIAG.injected = 'throw: ' + String(e && e.message ? e.message : e);
        DIAG.state = 'no-connection';
        timer = setTimeout(attempt, 800);
        return;
      }
      if (conn && conn.rpc && typeof conn.rpc.call === 'function') {
        DIAG.injected = 'ok';
        stopBridge = startBridge(conn);
        return;
      }
      DIAG.injected = conn ? 'no-rpc' : 'waiting';
      DIAG.state = 'waiting-connection';
      timer = setTimeout(attempt, 800);
    };

    attempt();
    return () => {
      cancelled = true;
      if (timer) { clearTimeout(timer); }
      if (stopBridge) { stopBridge(); }
    };
  }, 'mobile-bridge: host bridge');

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mobile-bridge',
    order: 32,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, MobileBridgeSection));
}