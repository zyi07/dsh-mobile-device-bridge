import React from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { HdcTransport, HdcSession, diagnoseUsb } from './hdc/transport.js';
import { generateKeyPair as hdcGenerateKeyPair, DAEMON_VERSION, importHdcKey } from './hdc/session.js';
import { pushFile, pullFile, installHap, uninstallBundle, sha256Remote, writeChunkAt } from './hdc/files.js';
import { pushFileAdb, pullFileAdb, installApkAdb, uninstallPackageAdb } from './adb/files.js';

/** 客户端构建标记：显示在面板并随 poll 上报，用来确认浏览器加载的是哪一版 */
const BUILD_TAG = 'r110';

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
// 日志行形如 "HH:MM:SS.mmm LEVEL msg"；RX/TX/DBG 是协议原始帧，默认不展示给普通用户
export function isReadableLogLine(line) {
  const m = String(line).match(/^\d\d:\d\d:\d\d\.\d+\s+([A-Z]+)\s/);
  if (!m) { return true; }
  return !['RX', 'TX', 'DBG'].includes(m[1]);
}

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
  lastConnectError: null,   // 最近一次连接失败原因（上报给宿主诊断）
  hdcKeyText: '',     // 保留字段（已不再暴露 UI）
  connectToken: 0,    // 每次连接自增；旧任务发现令牌变化即放弃
  connectInFlight: null,  // 串行化：同一时刻只允许一个连接流程
  hdcPending: null,   // 进行中的 HDC 会话（自动重连/手动连接都可能留下）
  keepAlive: null,    // 后台保活句柄
  agc: { state: 'idle', qr: '', message: '' },   // 华为账号登录状态
  agcView: null,   // 遥控浏览器截图 { image, width, height }
  connection: null,   // 宿主 RPC 连接（用于把 HDC 日志送到宿主落盘）
  sessions: [],       // 多设备：每项 { id, kind, adb, hdc, device, info }
  activeId: null,     // 当前活跃设备 id
};

/** 设备唯一键：类型 + 序列号 */
function sessionKey(kind, info, device) {
  const serial = (info && info.serial)
    || (device && (device.serialNumber || device.serial)) || '';
  return kind + ':' + (serial || 'unknown');
}

/** 把当前 STATE 的活跃会话回写到 sessions（保证引用最新） */
function syncActiveToSessions() {
  if (!STATE.activeId) { return; }
  const s = STATE.sessions.find((x) => x.id === STATE.activeId);
  if (s) {
    s.kind = STATE.kind; s.adb = STATE.adb; s.hdc = STATE.hdc;
    s.device = STATE.device; s.info = STATE.info; s.log = STATE.log;
  }
}

/** 把当前 STATE 里的设备登记为会话（并设为活跃） */
function registerCurrentSession() {
  if (!STATE.kind || (!STATE.adb && !STATE.hdc)) { return; }
  const id = sessionKey(STATE.kind, STATE.info, STATE.device);
  const prev = STATE.sessions.find((s) => s.id === id);
  if (prev && (prev.adb !== STATE.adb || prev.hdc !== STATE.hdc)) {
    // 同 id 但不同实例：关闭旧实例，避免 claim 泄漏
    if (prev.hdc && prev.hdc !== STATE.hdc) { try { prev.hdc.close(); } catch { /* ignore */ } }
    if (prev.adb && prev.adb !== STATE.adb) { try { prev.adb.close(); } catch { /* ignore */ } }
  }
  STATE.sessions = STATE.sessions.filter((s) => s.id !== id);
  STATE.sessions.push({
    id, kind: STATE.kind, adb: STATE.adb, hdc: STATE.hdc,
    device: STATE.device, info: STATE.info, log: STATE.log,
  });
  STATE.activeId = id;
}

/** 切换活跃设备（STATE.adb/hdc/... 变成该设备的投影） */
function setActive(id) {
  syncActiveToSessions();
  const s = STATE.sessions.find((x) => x.id === id);
  if (!s) { return false; }
  STATE.activeId = s.id;
  STATE.kind = s.kind; STATE.adb = s.adb; STATE.hdc = s.hdc;
  STATE.device = s.device; STATE.info = s.info;
  STATE.log = s.log || [];     // 切到该设备的日志
  STATE.connectToken += 1;     // 让旧任务作废
  return true;
}

/** 移除一个设备会话并释放其资源 */
async function removeSession(id) {
  const s = STATE.sessions.find((x) => x.id === id);
  if (s) {
    if (s.hdc) { try { s.hdc.abort('断开设备'); } catch { /* ignore */ } }
    if (s.adb) { try { await s.adb.close(); } catch { /* ignore */ } }
    if (s.hdc) { try { await s.hdc.close(); } catch { /* ignore */ } }
  }
  STATE.sessions = STATE.sessions.filter((x) => x.id !== id);
  if (STATE.activeId === id) {
    const next = STATE.sessions[STATE.sessions.length - 1];
    if (next) { setActive(next.id); }
    else {
      STATE.activeId = null; STATE.kind = null; STATE.adb = null;
      STATE.hdc = null; STATE.device = null; STATE.info = null;
    }
  }
}

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
 * 释放残留的设备句柄。
 *
 * WebUSB 的 device 句柄挂在浏览器进程里。上一次连接（尤其是大文件传输超时）
 * 如果没走到 device.close()，页面销毁也不会自动关，句柄就一直 open，
 * 之后每次 open() 都报 Access denied —— 这就是反复连不上的真正原因。
 *
 * 所以连接前，把所有 getDevices() 里 opened=true 的设备强制 close 一遍。
 */
/** 把当前 WebUSB 的真实状态写进宿主日志，便于在不依赖用户复制的情况下定位问题 */
async function dumpUsbState(tag) {
  if (typeof navigator === 'undefined' || !navigator.usb) { return; }
  const report = { tag, at: new Date().toISOString(), devices: [], error: null };
  try {
    const list = await navigator.usb.getDevices();
    report.count = list.length;
    for (const d of list) {
      report.devices.push({
        vid: '0x' + d.vendorId.toString(16),
        pid: '0x' + d.productId.toString(16),
        serial: d.serialNumber || '',
        opened: !!d.opened,
        productName: d.productName || '',
        configuration: d.configuration ? d.configuration.configurationValue : null,
        interfaces: d.configuration
          ? d.configuration.interfaces.map((i) => ({
              n: i.interfaceNumber,
              cls: '0x' + i.alternate.interfaceClass.toString(16),
              claimed: !!i.claimed,
            }))
          : null,
      });
    }
  } catch (e) { report.error = String((e && e.message) || e); }
  // 直接 POST 到宿主（同源），宿主机写 ~/.dsh/usbstate.log
  try {
    await fetch('/mbridge/agc/usbstate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch { /* ignore */ }

  // 分析：是否有 HDC 的 vendor 接口(0xff)
  const classes = [];
  for (const d of report.devices) {
    for (const i of (d.interfaces || [])) { classes.push(i.cls); }
  }
  report.classes = classes;
  report.hasHdcIface = classes.indexOf('0xff') >= 0;
  return report;
}

async function releaseStaleUsbHandles() {
  if (typeof navigator === 'undefined' || !navigator.usb) { return 0; }
  let n = 0;
  try {
    const list = await navigator.usb.getDevices();
    // 跳过已连接（sessions 里）的设备，多设备时不能把它们关掉
    const inUse = new Set();
    for (const s of STATE.sessions) {
      const sn = s.device && (s.device.serialNumber || s.device.serial);
      if (sn) { inUse.add(sn); }
    }
    if (STATE.device) { inUse.add(STATE.device.serialNumber || STATE.device.serial); }
    for (const d of list) {
      if (d.opened && !inUse.has(d.serialNumber || d.serial)) {
        try {
          await d.close();
          n += 1;
          pushHdcLog('INFO', `已释放残留的设备句柄 ${d.serialNumber || ''}`);
        } catch (e) {
          pushHdcLog('INFO', `释放残留句柄失败：${(e && e.message) || e}`);
        }
      }
    }
  } catch { /* ignore */ }
  return n;
}

/**
 * USB 掉线自愈：WebUSB 的 transfer 抛错后句柄即失效，此时用 getDevices() 取已授权设备
 * 重新走一遍连接（密钥已保存，通常无需上机确认）。
 */
/** Android 断线自愈：用 getDevices() 取已授权设备重新 attach（不需要用户手势） */
async function tryReconnectAdb() {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) { return false; }
  try {
    const list = await manager.getDevices();
    const want = STATE.info && STATE.info.serial;
    const dev = (want && list.find((d) => d.serial === want)) || list[0];
    if (!dev) { return false; }
    pushHdcLog('ADB', 'USB 句柄失效，尝试自动重连');
    const next = await attach(dev);
    STATE.kind = 'adb';
    STATE.info = next;
    registerCurrentSession();   // ★ 更新 sessions
    pushHdcLog('ADB', '自动重连成功');
    return true;
  } catch (e) {
    pushHdcLog('ADB', `自动重连失败：${(e && e.message) || e}`);
    return false;
  }
}

/** 按当前平台重连 */
async function tryReconnectAny() {
  if (STATE.kind === 'hdc') { return tryReconnectHdc(); }
  if (STATE.kind === 'adb') { return tryReconnectAdb(); }
  return false;
}

async function tryReconnectHdc() {
  if (typeof navigator === 'undefined' || !navigator.usb) { return false; }
  try {
    const list = await navigator.usb.getDevices();
    // 多设备：必须按当前活跃设备的 serial 找，不能取第一个（否则会重连到另一台）
    const wantSerial = STATE.device && (STATE.device.serialNumber || STATE.device.serial);
    const dev = (wantSerial && list.find((d) => d.vendorId === 0x12d1 && (d.serialNumber || d.serial) === wantSerial))
      || list.find((d) => d.vendorId === 0x12d1);
    if (!dev) { return false; }
    pushHdcLog('INFO', 'USB 句柄失效，尝试自动重连');
    const next = await withConnectLock(async () => {
      const token = ++STATE.connectToken;
      if (STATE.hdc) { try { STATE.hdc.abort('掉线重连'); } catch { /* ignore */ } STATE.hdc = null; }
      return connectHarmony(dev, token);
    });
    STATE.info = next;
    STATE.kind = 'hdc';
    registerCurrentSession();   // ★ 更新 sessions 里的会话引用，否则切设备会用到失效的旧会话
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

/** 从宿主读取已保存的登录态（插件重载/切页后自动恢复，不需要重新登录） */
async function agcRestoreSession() {
  try {
    const r = await fetch(AGC_API + '/session');
    const d = await r.json();
    if (d.present) {
      STATE.agc = {
        state: 'success', qr: '', message: '',
        savedAt: d.savedAt, cookieCount: d.cookieCount,
      };
    } else if (!STATE.agc || STATE.agc.state === 'idle') {
      STATE.agc = { state: 'idle', qr: '', message: '' };
    }
  } catch { /* 宿主不可达时保持原状 */ }
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
    const r = await fetch(AGC_API + '/login/close', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    STATE.agc = {
      state: 'idle', qr: '', mode: 'qr',
      message: d && d.removed
        ? '已清除登录态（本机凭证已删除），下次登录需要重新扫码'
        : '已关闭登录会话（本机没有凭证文件）',
    };
  } catch (e) {
    STATE.agc = { state: 'failed', qr: '', message: '清除失败：' + String(e && e.message ? e.message : e) };
    return;
  }
  agcPollTimer && clearInterval(agcPollTimer);
  agcPollTimer = null;
}

/** 给未签名 HAP 走「AGC 申请证书/Profile + 本地签名」，签完自动装到当前设备 */
async function agcSignInstall(file) {
  STATE.sign = { ...(STATE.sign || {}), busy: true, ok: true, msg: `读取 ${file.name} 的包信息…` };
  if (STATE.notify) { STATE.notify(); }
  // 读文件 + 自动识别包名（包名从 HAP 的 module.json 读，不用人肉输入）
  let b64 = '';
  try {
    const u8 = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) { bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); }
    b64 = btoa(bin);
  } catch (e) {
    STATE.sign = { ...STATE.sign, busy: false, ok: false, msg: '读文件失败：' + String(e && e.message ? e.message : e) };
    if (STATE.notify) { STATE.notify(); }
    return;
  }
  let bundle = String((STATE.sign && STATE.sign.bundle) || '').trim();
  if (!bundle) {
    try {
      const ri = await fetch(AGC_API + '/hap-info', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, base64: b64 }),
      });
      const di = await ri.json();
      if (di && di.bundleName) {
        bundle = di.bundleName;
        STATE.sign = { ...(STATE.sign || {}), bundle };
      }
    } catch { /* 读不到就让用户手填 */ }
  }
  if (!bundle) {
    STATE.sign = { ...(STATE.sign || {}), busy: false, ok: false, msg: '读不到包名，请在输入框填 bundleName 后再选一次文件' };
    if (STATE.notify) { STATE.notify(); }
    return;
  }
  STATE.sign = { ...(STATE.sign || {}), busy: true, ok: true, msg: `包名 ${bundle}，正在签名并安装（首次要申请证书/Profile，约 20~40 秒）…` };
  if (STATE.notify) { STATE.notify(); }
  try {
    const r = await fetch(AGC_API + '/sign', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: file.name, base64: b64, bundle, autoInstall: true }),
    });
    const d = await r.json();
    const info = d.sign || {};
    if (!d.ok) { throw new Error(info.error || d.error || '签名失败'); }
    let msg = '✅ 签名成功\n包名：' + (info.bundle || bundle) + '\n输出：' + (info.signedPath || '') + '\n证书：' + (info.certName || '-');
    if (d.installed) {
      msg += '\n安装：' + (d.installed.ok ? (d.installed.output || 'ok') : ('失败 ' + (d.installed.error || '')));
    }
    STATE.sign = { ...STATE.sign, busy: false, ok: true, msg };
  } catch (e) {
    STATE.sign = { ...STATE.sign, busy: false, ok: false, msg: '签名失败：' + String(e && e.message ? e.message : e) };
  } finally {
    if (STATE.notify) { STATE.notify(); }
  }
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
  if (!info.model) { info.model = device.productName || ''; }
  if (!info.serial) { info.serial = device.serialNumber || device.serial || ''; }
  info.sysVersion = info.android ? ('Android ' + info.android) : 'Android';
  pushAdbLog(`机型=${info.model || '?'} Android=${info.android || '?'}`);
  STATE.adb = adb;
  STATE.device = device;
  STATE.info = info;
  STATE.kind = 'adb';        // 关键：registerCurrentSession 依赖 kind
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
      return await connectHarmonyInner(t, dev, token);
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

  // 失败自愈：换一个全新的 USBDevice 引用重试（旧引用在 close 后可能失效）
  const RETRYABLE = /claim|Unable|NetworkError|disconnect|in use|busy|open|Access denied|SecurityError|not allowed/i;
  let lastErr = null;
  let dev = device;
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt(dev);
    } catch (e) {
      lastErr = e;
      const raw = String(e && e.message ? e.message : e);
      if (!RETRYABLE.test(raw)) { throw e; }
      if (i === 2) { break; }
      pushHdcLog('INFO', `连接失败，${800 * (i + 1)}ms 后换新的设备引用重试（第 ${i + 2}/3 次）`);
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
      const list = await navigator.usb.getDevices().catch(() => []);
      const fresh = list.find((d) => d.vendorId === 0x12d1
        && (!device.serialNumber || d.serialNumber === device.serialNumber));
      if (fresh) { dev = fresh; }
    }
  }
  throw lastErr;
}

async function connectHarmonyInner(t, device, token) {
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
    t.emit('ERROR', `握手/连接异常：${(e && e.message) || e}`);
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
  let osRelease = '';     // 系统主版本号，例如 7.0.0.111
  let online = '';
  try {
    for (let round = 1; round <= 5; round++) {
      if (STATE.connectToken !== token) { break; }
      model = await probe(['const.product.model', 'const.product.name', 'const.product.brand']);
      if (model) {
        api = await probe(['const.ohos.apiversion']);
        // 系统版本号：const.ohos.fullname 形如 OpenHarmony-7.0.0.111 → 取 7.0.0.111
        const fullname = await probe(['const.ohos.fullname']);
        const mv = String(fullname || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
        osRelease = mv ? mv[1] : '';
        if (!osRelease) {
          // 兜底：const.product.software.version 形如 "PLA-AL10 7.0.0.111(SP12C00E111R9P3)"
          const soft = await probe(['const.product.software.version']);
          const m2 = String(soft || '').match(/(\d+\.\d+\.\d+(?:\.\d+)?)/);
          osRelease = m2 ? m2[1] : '';
        }
        online = await probe(['const.product.devicetype']);
        break;
      }
      t.emit('INFO', `机型探测第 ${round}/5 轮未取到，1.5 秒后重试`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    t.emit('INFO', `设备信息探测失败（不影响连接）：${(e && e.message) || e}`);
  }
  t.emit('INFO', `探测结果 机型=${model || '?'} 版本=${osRelease || '?'} API=${api || '?'} 类型=${online || '?'}`);

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
    sysVersion: osRelease ? `HarmonyOS ${osRelease}` : (api ? `HarmonyOS (API ${api})` : 'HarmonyOS'),
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
/**
 * 执行一个桥接任务。push/pull/install/uninstall 按当前平台分派到 HDC 或 ADB 实现。
 */
async function doTransferJob(job) {
  const log = (m) => pushHdcLog('INFO', m);
  const kind = job.kind;
  const d = job.data;
  const bytes = (d && d.base64) ? fromBase64(d.base64) : null;

  if (kind === 'push') {
    if (STATE.hdc) {
      // 分片模式：只写这一块（幂等，精确偏移）
      if (typeof d.index === 'number' && d.chunkSize) {
        const r = await writeChunkAt(STATE.hdc, d.path, bytes, d.chunkSize, d.index, { log });
        return { ok: true, bytes: r.bytes, chunk: d.index };
      }
      log(`开始上传 ${bytes.length} 字节 → ${d.path}`);
      const r = await pushFile(STATE.hdc, d.path, bytes, { log });
      return { ok: true, bytes: r.bytes, chunks: r.chunks };
    }
    if (STATE.adb) {
      log(`开始上传 ${bytes.length} 字节 → ${d.path}`);
      const r = await pushFileAdb(STATE.adb, d.path, bytes, { log });
      return { ok: true, bytes: r.bytes };
    }
    return { ok: false, error: '未连接设备' };
  }

  if (kind === 'pull') {
    if (STATE.hdc) {
      log(`开始下载 ${d.path}`);
      const r = await pullFile(STATE.hdc, d.path, { log });
      return { ok: true, bytes: r.bytes.length, base64: toBase64(r.bytes) };
    }
    if (STATE.adb) {
      log(`开始下载 ${d.path}`);
      const r = await pullFileAdb(STATE.adb, d.path, { log });
      return { ok: true, bytes: r.bytes.length, base64: toBase64(r.bytes) };
    }
    return { ok: false, error: '未连接设备' };
  }

  if (kind === 'install') {
    if (STATE.hdc) {
      log(`开始安装 ${d.filename}（${bytes.length} 字节）`);
      const r = await installHap(STATE.hdc, { bytes, filename: d.filename, replace: !!d.replace }, { log });
      return { ok: true, output: r.output };
    }
    if (STATE.adb) {
      log(`开始安装 APK ${d.filename}（${bytes.length} 字节）`);
      const r = await installApkAdb(STATE.adb, { bytes, filename: d.filename, replace: !!d.replace }, { log });
      return { ok: true, output: r.output };
    }
    return { ok: false, error: '未连接设备' };
  }

  if (kind === 'uninstall') {
    if (STATE.hdc) { return { ok: true, output: await uninstallBundle(STATE.hdc, d.bundle) }; }
    if (STATE.adb) { return { ok: true, output: await uninstallPackageAdb(STATE.adb, d.bundle) }; }
    return { ok: false, error: '未连接设备' };
  }

  return { ok: false, error: '未知任务类型 ' + kind };
}

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
    if (job.kind === 'activate') {
      const id = String(job.data && job.data.id || '');
      const ok = setActive(id);
      if (!ok) { return { ok: false, error: '没有这个设备：' + id }; }
      return { ok: true, output: '已切换到 ' + id, activeId: id };
    }
    if (job.kind === 'push' || job.kind === 'pull' || job.kind === 'install' || job.kind === 'uninstall') {
      const r = await doTransferJob(job);
      if (stale() && r.ok) { return { ok: false, error: '连接已切换，任务作废' }; }
      return r;
    }
    return { ok: false, error: '未知任务类型 ' + job.kind };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // USB 掉线：按平台自动重连，然后重试同一任务一次
    if (/transferIn|transferOut|USBDevice|disconnect|lost|No device|socket|closed/i.test(msg) && !stale()) {
      const ok = await tryReconnectAny();
      if (ok) {
        try {
          if (job.kind === 'shell') { return { ok: true, output: await execShell(job.data.cmd) }; }
          if (job.kind === 'screenshot') {
            const shot = await captureScreen();
            return { ok: true, base64: toBase64(shot.bytes), mime: shot.mime };
          }
          return await doTransferJob(job);
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

  // 任务队列：轮询只负责"取任务入队"，执行交给独立 runner 串行跑。
  // 关键：绝不能在轮询循环里 await 长任务（pm install 等待弹窗、大文件传输等），
  // 否则整条轮询会停摆，宿主会判定"浏览器没有在轮询"，连心跳都没了。
  const queue = [];
  let running = false;

  async function runner() {
    if (running) { return; }
    running = true;
    while (queue.length && !stopped) {
      const job = queue.shift();
      let outcome;
      try {
        // 任务级超时兜底：任何单个任务最多 6 分钟，超时后放弃，绝不无限堵队列
        outcome = await Promise.race([
          runJob(job),
          new Promise((_, rej) => setTimeout(
            () => rej(new Error('任务超时（6 分钟），已放弃')), 360000)),
        ]);
      } catch (e) {
        outcome = { ok: false, error: String(e && e.message ? e.message : e) };
      }
      try {
        await connection.rpc.call(BRIDGE, EP + '/result', Object.assign({ id: job.id }, outcome));
      } catch { /* 宿主可能已超时，忽略 */ }
    }
    running = false;
  }

  (async () => {
    while (!stopped) {
      const started = Date.now();
      try {
        const res = await connection.rpc.call(BRIDGE, EP + '/poll', {
          device: STATE.info
            ? { model: STATE.info.model, android: STATE.info.android, os: STATE.info.os, kind: STATE.kind, serial: STATE.info.serial }
            : null,
          devices: (STATE.sessions || []).map((x) => ({
            id: x.id, kind: x.kind,
            model: x.info && x.info.model || '',
            serial: x.info && x.info.serial || '',
            active: x.id === STATE.activeId,
          })),
          activeId: STATE.activeId,
          log: STATE.log && STATE.log.length ? STATE.log.slice(-80) : undefined,
          state: STATE.info ? 'connected' : (STATE.lastConnectError ? 'failed' : ((STATE.hdcPending || STATE.connectInFlight) ? 'connecting' : 'idle')),
          lastError: STATE.lastConnectError || null,
          build: BUILD_TAG,
        });
        DIAG.polls += 1;
        DIAG.lastOk = Date.now();
        DIAG.error = null;
        if (res && res.ok && res.value && res.value.job) {
          // 只入队，不等待执行
          if (queue.length < 32) { queue.push(res.value.job); }
          runner();
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
/* 用 !important 压掉宿主全局 button 样式：否则 disabled 时会被改成白底白字 */
.mb-root .mb-btn {
  padding: 7px 14px !important; border-radius: 8px !important;
  border: 1px solid rgba(127,127,127,.45) !important;
  background: rgba(127,127,127,.18) !important;
  color: inherit !important;
  font-size: 13px !important; cursor: pointer !important; font-family: inherit !important;
  line-height: 1.5 !important;
}
.mb-root .mb-btn:hover:not(:disabled) { border-color: #3b82f6 !important; }
.mb-root .mb-btn:disabled {
  opacity: 1 !important; cursor: not-allowed !important;
  background: rgba(127,127,127,.10) !important;
  color: rgba(127,127,127,.95) !important;
}
.mb-root .mb-btn--primary {
  background: #3b82f6 !important; color: #fff !important;
  border-color: transparent !important;
}
.mb-root .mb-btn--primary:disabled {
  background: rgba(59,130,246,.55) !important;
  color: #fff !important;
}
.mb-card {
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius: 10px;
  padding: 12px 14px; background: var(--dsw-alias-fill-l1, rgba(127,127,127,.08));
}
.mb-kv { display: grid; grid-template-columns: 92px 1fr; row-gap: 4px; }
.mb-k { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.95)); }
.mb-v { color: var(--dsw-alias-label-primary, inherit); word-break: break-all; }
.mb-note { color: var(--dsw-alias-label-tertiary, rgba(127,127,127,.95)); line-height: 1.6; }
.mb-err { color: var(--dsw-alias-label-error, #d9534f); white-space: pre-wrap; line-height: 1.6; }
.mb-input {
  flex: 1; min-width: 220px; padding: 7px 10px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45));
  background: var(--dsw-alias-bg-l1, transparent); color: var(--dsw-alias-label-primary, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
}
.mb-out {
  margin: 0; padding: 10px; border-radius: 8px; max-height: 260px; overflow: auto;
  background: var(--dsw-alias-fill-l2, rgba(127,127,127,.16)); color: var(--dsw-alias-label-primary, inherit);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; white-space: pre-wrap; word-break: break-all;
}
.mb-badge {
  display: inline-block; padding: 1px 8px; border-radius: 9px; font-size: 11px; line-height: 18px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45)); color: var(--dsw-alias-label-secondary, rgba(127,127,127,.95));
}
`;

/**
 * 华为账号登录（独立设置页）
 *
 * 登录态由宿主持久化在 ~/.dsh/agc-session.json，页面挂载时自动恢复，
 * 所以插件重载、切页、重连手机都不需要重新登录。
 */
/** 构建「华为账号」面板（内嵌在移动设备页，与 Android / HarmonyOS 平级切换） */
function buildHuaweiAccountPanel(t) {
  const agc = STATE.agc || { state: 'idle' };
  const savedAtText = agc.savedAt ? new Date(agc.savedAt * 1000).toLocaleString() : '';
  const out = [];

  out.push(h('div', { key: 'acc-h', className: 'mb-card' },
    h('div', { className: 'mb-note', style: { lineHeight: 1.7 } }, t('accountHint')),

    h('div', { style: { marginTop: '10px' } },
      agc.state === 'success'
        ? h('div', { style: { color: '#22c55e', fontWeight: 600 } },
            '✅ ' + t('accountStatusOk')
            + (agc.cookieCount ? `（${agc.cookieCount} 条 Cookie）` : '')
            + (savedAtText ? `，登录于 ${savedAtText}` : ''))
        : h('div', { className: 'mb-note' }, t('accountStatusNone'))),

    h('div', { className: 'mb-row', style: { marginTop: '10px' } },
      h('button', { className: 'mb-btn mb-btn--primary', onClick: agcStartLogin },
        agc.state === 'success' ? t('accountRelogin') : t('agcLogin')),
      h('button', { className: 'mb-btn', onClick: agcClearSession }, t('agcLogout')),
    ),

    agc.state === 'loading'
      ? h('div', { className: 'mb-note', style: { marginTop: '10px' } }, agc.message || '正在打开…')
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

    agc.state === 'failed'
      ? h('div', { className: 'mb-err', style: { marginTop: '10px' } },
          t('agcFailed') + (agc.message ? '：' + agc.message : ''))
      : null,
  ));

  if (agc.state === 'success') {
    const sg = STATE.sign || {};
    out.push(h('div', { key: 'acc-sign', className: 'mb-card', style: { marginTop: '10px' } },
      h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '给 HAP 自动签名并安装'),
      h('div', { className: 'mb-note', style: { lineHeight: 1.7 } },
        '选一个未签名的 .hap：自动读取包名 → 申请调试证书/Profile → 签名 → 装到当前设备。包名不用手输。'),
      h('div', { className: 'mb-row', style: { marginTop: '8px', gap: '8px', flexWrap: 'wrap' } },
        h('input', {
          className: 'mb-input', placeholder: '包名（选文件后自动识别，可改）',
          value: sg.bundle || '', spellCheck: false,
          onChange: (ev) => { STATE.sign = { ...(STATE.sign || {}), bundle: ev.target.value }; },
          style: { flex: '1 1 220px' },
        }),
        h('input', {
          type: 'file', accept: '.hap', disabled: !!sg.busy,
          onChange: (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) { agcSignInstall(f); } },
        }),
      ),
      sg.busy ? h('div', { className: 'mb-note', style: { marginTop: '8px' } }, sg.msg || '签名中…') : null,
      (!sg.busy && sg.msg) ? h('div', {
        className: sg.ok ? 'mb-note' : 'mb-err',
        style: { marginTop: '8px', whiteSpace: 'pre-wrap' },
      }, sg.msg) : null,
    ));
  }

  out.push(h('div', { key: 'acc-p', className: 'mb-card' },
    h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, t('accountPersistTitle')),
    h('div', { className: 'mb-note', style: { lineHeight: 1.7 } }, t('accountPersistHint')),
  ));

  return out;
}

function MobileBridgeSection(props) {
  const t = props.t;
  const [view, setView] = React.useState('device');   // device | account（与 Android/HarmonyOS 平级）
  const [phase, setPhase] = React.useState((STATE.adb || STATE.hdc) ? 'connected' : 'idle');
  const [kind, setKind] = React.useState(STATE.kind || 'adb');
  const [showFullLog, setShowFullLog] = React.useState(false);
  const [channel, setChannel] = React.useState('web');   // web | cli
  const [cliTools, setCliTools] = React.useState(null);
  const [cliDevices, setCliDevices] = React.useState([]);
  const [cliActive, setCliActive] = React.useState(null);
  const [cliLog, setCliLog] = React.useState([]);
  const [cliBusy, setCliBusy] = React.useState(false);
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
  // 把一段文本追加到当前设备日志（STATE.log 即当前活跃设备的日志数组引用）
  function appendToLog(text) {
    try {
      if (!STATE.log) { STATE.log = []; }
      STATE.log.push(String(text));
      setTick((n) => n + 1);
    } catch { /* ignore */ }
  }
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    STATE.notify = () => setTick((n) => n + 1);
    agcRestoreSession();      // 打开设置页就把已保存的华为登录态读回来
    return () => { clearInterval(id); if (STATE.notify) { STATE.notify = null; } };
  }, []);

  // 页面卸载时尽力关闭 USB 设备，避免句柄悬挂在浏览器进程里（下次连接会 Access denied）
  React.useEffect(() => {
    const onUnload = () => {
      try { if (STATE.hdc) STATE.hdc.close(); } catch { /* 同步尽力而为 */ }
      try {
        navigator.usb.getDevices().then((list) => {
          for (const d of list) { if (d.opened) { try { d.close(); } catch { /* ignore */ } } }
        }).catch(() => {});
      } catch { /* ignore */ }
    };
    window.addEventListener('beforeunload', onUnload);
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      window.removeEventListener('pagehide', onUnload);
    };
  }, []);

  // 挂载时不做任何自动重连：曾经的后台自动重连会和用户点击抢锁、
  // 让 requestDevice 失去用户手势，是 Access denied / gesture 报错的根源之一。

  // ★★ 关键：requestDevice 必须在用户点击的同一个调用栈里**立刻**调用。
  //     绝不能先 await（包括等连接锁），否则浏览器判定"没有用户手势"，
  //     报 Must be handling a user gesture。这就是之前一直连不上的真正原因。
  // 统一的「连接设备」：不预设安卓/鸿蒙，选完设备后自动识别类型。
  async function connect() {
    setError('');
    if (typeof navigator === 'undefined' || !navigator.usb) { setError(t('noWebusb')); return; }
    const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
    let raw = null;
    try {
      // 华为设备的 ADB 与 HDC 都是 vendorId 0x12d1，用同一个选择器让用户直接选设备
      raw = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x12d1 }] });
    } catch (e) {
      if (!e || e.name !== 'NotFoundError') {
        setError('选择设备失败：' + (e && e.message ? e.message : e));
      }
      return;
    }
    if (!raw) { setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle'); return; }

    // 自动识别：该设备出现在 ADB 设备列表里 → 安卓；否则 → 鸿蒙（HDC 接口不是 ADB 标准接口）
    const serial = raw.serialNumber || raw.serial || '';
    let adbDev = null;
    if (manager) {
      try {
        const list = await manager.getDevices();
        adbDev = list.find((d) => d.serial === serial) || null;
      } catch { /* ignore */ }
    }
    const detected = adbDev ? 'adb' : 'hdc';
    setPhase('connecting');
    startKeepAlive();
    return withConnectLock(() => runConnect(detected === 'adb' ? adbDev : raw, detected));
  }

  async function runConnect(device, connKind) {
    // 多设备：先把当前活跃设备存进 sessions（不清空、不断开），再连接新设备
    syncActiveToSessions();
    // ★ 同一台设备（同 serial）重复连接时，必须先关闭旧会话释放它的 WebUSB claim，
    //   否则旧 HdcSession 还 claim 着接口，新连接必然 claim 失败，且要重启浏览器才恢复。
    try {
      const devSerial = device && (device.serialNumber || device.serial);
      if (devSerial) {
        const dup = STATE.sessions.filter((s) =>
          (s.info && s.info.serial === devSerial)
          || (s.device && (s.device.serialNumber || s.device.serial) === devSerial));
        for (const old of dup) {
          try { await removeSession(old.id); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    const token = ++STATE.connectToken;
    STATE.info = null;
    try {
      if (connKind === 'hdc') {
        // 清掉浏览器里残留的句柄（releaseStaleUsbHandles 会跳过 sessions 里在用的设备）
        await releaseStaleUsbHandles();
        const next = await connectHarmony(device, token);
        await flushHdcLog();
        setInfo(next);
        registerCurrentSession();
        setCmd('param get const.product.model');
        STATE.lastConnectError = null;
        setPhase('connected');
        return;
      }
      if (STATE.connectToken !== token) { return; }        // 期间已发起新连接
      const next = await attach(device);
      if (STATE.connectToken !== token) { return; }   // 连接被取代
      setInfo(next);
      registerCurrentSession();
      setCmd('getprop ro.product.model');
      STATE.lastConnectError = null;
      setPhase('connected');
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      STATE.lastConnectError = raw;
      // 失败时把 USB 真实状态写进日志（我在宿主侧直接读，无需用户复制）
      let usbState = null;
      try { usbState = await dumpUsbState('连接失败后'); } catch { /* ignore */ }
      let hint = friendly(raw, t, connKind);
      // 精准诊断：设备在，但暴露的是 HID/其它接口，没有 HDC 的 0xff 接口
      if (usbState && usbState.count > 0 && usbState.hasHdcIface === false) {
        hint = '手机当前的 USB 接口不是 HDC 调试接口（现在暴露的是 class='
          + (usbState.classes.join('/') || '?')
          + '，HDC 需要 0xff）。\n\n解决办法（在手机上操作）：\n'
          + '1) 解锁手机，下拉通知栏 → 点「USB 连接方式」→ 选「传输文件」\n'
          + '   （或拔掉数据线重插，在手机弹出的选项里选「传输文件」）\n'
          + '2) 确认「设置 → 系统 → 开发者选项 → USB 调试」是打开的\n'
          + '3) 回到这里点「连接设备」\n\n'
          + '如果下拉通知栏没有 USB 选项：换一根数据线（有些线只能充电）。';
      }
      // 日志与原始错误在下面统一设置（并把日志复制到剪贴板）
      const logText = (STATE.log && STATE.log.length)
        ? STATE.log.join('\n')
        : '（本次未产生收发日志：说明失败发生在创建传输层之前）';
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
    if (STATE.activeId) {
      await removeSession(STATE.activeId);   // 只断当前这台，其他设备保留
    } else {
      await detach();
    }
    setInfo(STATE.info || null);
    if (!STATE.activeId) { setOut(''); setPhase('idle'); }
  }

  // ---- 本机 CLI 通道操作（走宿主 /mbridge/cli/*）----
  async function cliRefresh() {
    try {
      const r = await fetch('/mbridge/cli/status');
      const d = await r.json();
      setCliTools({ adb: d.adb, hdc: d.hdc, available: !!d.available });
      setCliDevices(d.devices || []);
      setCliActive(d.activeId || (d.devices && d.devices[0] && d.devices[0].id) || null);
    } catch (e) { setError('CLI 探测失败：' + (e && e.message ? e.message : e)); }
  }
  async function cliActivate(id) {
    try {
      await fetch('/mbridge/cli/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
      setCliActive(id);
    } catch { /* ignore */ }
  }
  async function cliExec() {
    if (!cmd || cliBusy) { return; }
    setCliBusy(true);
    try {
      const r = await fetch('/mbridge/cli/exec', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd, deviceId: cliActive, timeoutMs: 60000 }) });
      const d = await r.json();
      setCliLog((prev) => prev.concat([d.ok ? d.output : ('✗ 错误：' + (d.error || ''))]));
    } catch (e) {
      setCliLog((prev) => prev.concat(['✗ 错误：' + (e && e.message ? e.message : e)]));
    } finally { setCliBusy(false); }
  }
  async function cliShot() {
    if (cliBusy) { return; }
    setCliBusy(true);
    try {
      const r = await fetch('/mbridge/cli/screenshot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: cliActive }) });
      const d = await r.json();
      if (d.ok && d.base64) {
        const bin = atob(d.base64); const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
        window.open(URL.createObjectURL(new Blob([arr], { type: d.mime || 'image/png' })), '_blank');
        setCliLog((prev) => prev.concat([`截图完成：${d.bytes} 字节`]));
      } else {
        setCliLog((prev) => prev.concat(['✗ 截图失败：' + (d.error || '')]));
      }
    } catch (e) {
      setCliLog((prev) => prev.concat(['✗ 截图失败：' + (e && e.message ? e.message : e)]));
    } finally { setCliBusy(false); }
  }

  async function runShell() {
    if (!STATE.adb && !STATE.hdc) { setPhase('idle'); return; }
    setBusy(true);
    setError('');
    const token = STATE.connectToken;
    try {
      const text = await execShell(cmd);
      if (STATE.connectToken !== token) { return; }   // 连接已切换，丢弃旧结果
      appendToLog(text);
    } catch (e) {
      const raw = String(e && e.message ? e.message : e);
      // 失败时把 USB 真实状态写进日志（我在宿主侧直接读，无需用户复制）
      let usbState = null;
      try { usbState = await dumpUsbState('连接失败后'); } catch { /* ignore */ }
      let hint = friendly(raw, t, kind);
      // 精准诊断：设备在，但暴露的是 HID/其它接口，没有 HDC 的 0xff 接口
      if (usbState && usbState.count > 0 && usbState.hasHdcIface === false) {
        hint = '手机当前的 USB 接口不是 HDC 调试接口（现在暴露的是 class='
          + (usbState.classes.join('/') || '?')
          + '，HDC 需要 0xff）。\n\n解决办法（在手机上操作）：\n'
          + '1) 解锁手机，下拉通知栏 → 点「USB 连接方式」→ 选「传输文件」\n'
          + '   （或拔掉数据线重插，在手机弹出的选项里选「传输文件」）\n'
          + '2) 确认「设置 → 系统 → 开发者选项 → USB 调试」是打开的\n'
          + '3) 回到这里点「连接设备」\n\n'
          + '如果下拉通知栏没有 USB 选项：换一根数据线（有些线只能充电）。';
      }
      // 日志与原始错误在下面统一设置（并把日志复制到剪贴板）
      const logText = (STATE.log && STATE.log.length)
        ? STATE.log.join('\n')
        : '（本次未产生收发日志：说明失败发生在创建传输层之前）';
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
      h('button', {
        key: 'chweb',
        className: 'mb-btn' + (channel === 'web' ? ' mb-btn--primary' : ''),
        onClick: () => setChannel('web'),
      }, t('chWeb')),
      h('button', {
        key: 'chcli',
        className: 'mb-btn' + (channel === 'cli' ? ' mb-btn--primary' : ''),
        onClick: () => { setChannel('cli'); if (!cliDevices.length) { cliRefresh(); } },
      }, t('chCli')),
      h('button', {
        key: 'kacc',
        className: 'mb-btn' + (view === 'account' ? ' mb-btn--primary' : ''),
        onClick: () => setView('account'),
      }, t('navAccount') + (STATE.agc && STATE.agc.state === 'success' ? ' ✓' : '')),

      view === 'account' ? null : h('button', {
        key: 'diag',
        className: 'mb-btn',
        onClick: async () => {
          setError('');
          try {
            await dumpUsbState('诊断按钮');
            const d = await diagnoseUsb();
            appendToLog('USB 诊断：\n' + JSON.stringify(d, null, 2));
          } catch (e) {
            setError(String(e && e.message ? e.message : e));
          }
        },
      }, t('diagnose')),
      view === 'account' ? null : h('button', {
        key: 'c',
        className: 'mb-btn mb-btn--primary',
        disabled: phase === 'connecting' || !usbSupported,
        onClick: connect,
      }, phase === 'connecting' ? t('connecting') : t('connect')),
      view === 'account' ? null : (phase === 'connected'
        ? h('button', { key: 'd', className: 'mb-btn', onClick: disconnect }, t('disconnect'))
        : null),
      view === 'account' ? null : h('span', { key: 'b', className: 'mb-badge' }, phaseLabel),
      h('span', { key: 'build', className: 'mb-badge' }, BUILD_TAG),
    ),
  ];

  // 华为账号视图：只渲染账号面板（与设备视图平级切换）
  if (view === 'account') {
    for (const el of buildHuaweiAccountPanel(t)) { children.push(el); }
    children.push(h('div', { key: 'n2', className: 'mb-note' }, t('accountHintShort')));
    return h('div', { className: 'mb-root' }, children);
  }

  // ===== 本机 CLI 通道视图 =====
  if (channel === 'cli') {
    children.push(h('div', { key: 'cli', className: 'mb-card' },
      h('div', { className: 'mb-row' },
        h('button', { className: 'mb-btn mb-btn--primary', onClick: cliRefresh }, t('cliRefresh')),
        h('span', { className: 'mb-note' }, cliTools
          ? (cliTools.available
            ? ('adb ' + (cliTools.adb ? '✓' : '✗') + '  hdc ' + (cliTools.hdc ? '✓' : '✗'))
            : t('cliNotFound'))
          : ''),
      ),
      h('div', { style: { marginTop: '10px' } }, cliDevices.length
        ? cliDevices.map((d) => h('button', {
            key: d.id,
            className: 'mb-btn' + (d.id === cliActive ? ' mb-btn--primary' : ''),
            style: { marginRight: '8px', marginBottom: '6px' },
            onClick: () => cliActivate(d.id),
          }, (d.kind === 'hdc' ? '鸿蒙 ' : '安卓 ') + (d.model || d.serial)))
        : h('div', { className: 'mb-note' }, cliTools ? t('cliNoDev') : t('cliHint'))),
      h('div', { className: 'mb-row', style: { marginTop: '10px' } },
        h('input', {
          className: 'mb-input', value: cmd, spellCheck: false,
          onChange: (e) => setCmd(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && !cliBusy) { cliExec(); } },
        }),
        h('button', { className: 'mb-btn', disabled: cliBusy || !cliActive, onClick: cliExec }, t('run')),
        h('button', { className: 'mb-btn', disabled: cliBusy || !cliActive, onClick: cliShot }, t('screenshot')),
      ),
      h('pre', { className: 'mb-out', style: { maxHeight: '320px', marginTop: '10px' } },
        cliLog.length ? cliLog.join('\n') : t('noLog')),
    ));
    return h('div', { className: 'mb-root' }, children);
  }

  // 多设备：已连接设备列表（点 chip 切换活跃设备，● 为当前；断开在标题栏）
  if (STATE.sessions && STATE.sessions.length > 0) {
    const chips = STATE.sessions.map((sess) => {
      const isActive = sess.id === STATE.activeId;
      const model = (sess.info && sess.info.model) || (sess.device && sess.device.productName) || '';
      const serial = (sess.info && sess.info.serial) || (sess.device && (sess.device.serialNumber || sess.device.serial)) || '';
      const label = (model || serial || '设备') + (serial && model ? ' · ' + serial : '');
      const typeTag = sess.kind === 'hdc' ? '鸿蒙' : '安卓';
      return h('button', {
        key: 'dev-' + sess.id,
        className: 'mb-btn' + (isActive ? ' mb-btn--primary' : ''),
        style: { marginRight: '8px', marginBottom: '6px' },
        title: sess.id,
        onClick: () => {
          if (isActive) { return; }
          setActive(sess.id);
          setInfo(STATE.info || null);
          setPhase('connected');
          setError('');
        },
      }, (isActive ? '● ' : '') + typeTag + ' ' + label);
    });
    children.push(h('div', { key: 'devlist', className: 'mb-card' },
      h('div', {
        key: 'hdr',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' },
      },
        h('div', { style: { fontWeight: 600 } }, t('devicesTitle') + '（' + STATE.sessions.length + '）'),
        h('button', { className: 'mb-btn', style: { padding: '4px 12px' }, onClick: disconnect }, t('disconnect')),
      ),
      h('div', {}, chips),
    ));
  }

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
        h('span', { className: 'mb-k' }, t('sysVersion')),
        h('span', { className: 'mb-v' }, info.sysVersion || info.os || info.android || '—'),
        h('span', { className: 'mb-k' }, t('serial')),
        h('span', { className: 'mb-v' }, info.serial || '—'),
        h('span', { className: 'mb-k' }, t('usbId')),
        h('span', { className: 'mb-v' },
          '0x' + info.vendorId.toString(16) + ' / 0x' + info.productId.toString(16)),
      ),
    ));

    // ---- 本地安装（绕开 WebUSB，用本机 hdc.exe）---- 仅鸿蒙：包是 HAP
    if (info.kind === 'hdc') children.push(h('details', { key: 'locinstall', className: 'mb-card', style: { marginTop: '10px' } },
      h('summary', { style: { cursor: 'pointer', userSelect: 'none' } }, '本地安装（推荐：用电脑上的 hdc.exe）'),
      h('div', { className: 'mb-note', style: { marginTop: '6px', lineHeight: 1.7 } },
        '如果 WebUSB 一直报「设备被独占」，可以先验证 hdc 安装链路：下载下面的'
        + '示例包，用你电脑上 DevEco 自带的 hdc.exe 安装。hdc 自己占用设备，不经过浏览器。'),
      h('div', { className: 'mb-row', style: { marginTop: '8px' } },
        h('a', {
          className: 'mb-btn',
          href: '/mbridge/agc/hap',
          download: 'dsh_demo_signed.hap',
          style: { textDecoration: 'none', display: 'inline-block' },
        }, '下载示例包（9.9 MB）'),
      ),
      h('div', { className: 'mb-note', style: { marginTop: '10px' } }, '下载完成后，在 PowerShell 里运行这一条：'),
      h('pre', { className: 'mb-out', style: { whiteSpace: 'pre-wrap', userSelect: 'all' } },
        '& "C:\\Program Files\\Huawei\\DevEco Studio\\sdk\\default\\openharmony\\toolchains\\hdc.exe" install -r "$env:USERPROFILE\\Downloads\\dsh_demo_signed.hap"'),
      h('div', { className: 'mb-note', style: { marginTop: '6px' } },
        '说明：这是打包时固定生成的示例包，包名 com.dsh.bridgeapp，签名材料绑定的是开发机那台设备。'
        + '它只能用来验证 hdc 安装链路通不通，不能安装你自己的应用。'
        + '「针对任意应用自动申请证书 / Profile 并签名」的能力还没做完，别把它当成能用。'),
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

    // 设备日志：显示当前活跃设备的日志，默认「用户可读」，可勾选「完整日志」供开发者排查
    {
      const activeSess = STATE.sessions.find((x) => x.id === STATE.activeId);
      const logArr = STATE.log || [];
      const shown = showFullLog ? logArr : logArr.filter(isReadableLogLine);
      const sessName = activeSess
        ? ((activeSess.info && (activeSess.info.model || activeSess.info.serial)) || '设备')
        : '—';
      children.push(h('div', { key: 'devlog', className: 'mb-card', style: { marginTop: '10px' } },
        h('div', {
          key: 'h',
          style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
        },
          h('div', { style: { fontWeight: 600 } }, t('deviceLog') + '（' + sessName + '）'),
          h('label', { style: { fontSize: '12px', cursor: 'pointer', userSelect: 'none' } },
            h('input', {
              type: 'checkbox', checked: showFullLog,
              onChange: (e) => setShowFullLog(e.target.checked),
              style: { marginRight: '5px', verticalAlign: 'middle' },
            }),
            t('fullLog'),
          ),
        ),
        h('pre', { className: 'mb-out', style: { maxHeight: '240px' } },
          shown.length ? shown.join('\n') : t('noLog')),
      ));
    }
  }

  const diagText =
    '桥接 ' + DIAG.state +
    ' · connection=' + (DIAG.injected || '—') +
    ' · 轮询 ' + DIAG.polls + ' 次' +
    (DIAG.lastOk ? ' · 最近成功 ' + Math.max(0, Math.round((Date.now() - DIAG.lastOk) / 1000)) + 's 前' : '') +
    (DIAG.error ? ' · 错误: ' + DIAG.error : '');
  children.push(h('div', { key: 'diag', className: 'mb-note', style: { fontSize: '11.5px' } }, diagText));

  children.push(h('div', { key: 'n', className: 'mb-note' }, t(STATE.kind === 'hdc' ? 'hintHdc' : 'hintAdb')));

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
      navAccount: '华为账号',
      devicesTitle: '已连接设备',
      sysVersion: '系统版本',
      deviceLog: '设备日志',
      fullLog: '完整日志（开发者）',
      chWeb: '浏览器',
      chCli: '本机命令行',
      cliRefresh: '刷新本机设备',
      cliNotFound: '未找到 adb/hdc（装 DevEco / Platform-Tools，或确认在 PATH）',
      cliNoDev: '（没有可用设备：插好手机、开启 USB 调试，确认命令行能看到）',
      cliHint: '点「刷新本机设备」自动探测 adb/hdc',
      noLog: '（暂无日志）',
      accountTitle: '华为账号登录',
      accountHintShort: '登录态保存在本机，插件重载、切页、重连手机都不需要重新登录。',
      accountHint: '用手机「控制中心 → 扫一扫」扫码登录华为开发者账号，登录态只保存在本机。当前版本只做到「登录 + 保存凭证」；自动申请调试证书 / Profile 还没做完，不能替你给任意应用签名。',
      accountStatusOk: '已登录',
      accountStatusNone: '未登录',
      accountRelogin: '重新登录',
      accountPersistTitle: '登录态如何保存',
      accountPersistHint: '登录态保存在本机（~/.dsh/agc-session.json，权限 600），不会上传到任何地方。\n插件重载、切换页面、重连手机都不需要重新登录；只有你点「退出登录」或华为侧会话失效时才需要再扫一次。',
      agcTitle: '华为账号登录（管理登录态）',
      agcHint: '用手机「控制中心 → 扫一扫」扫码登录华为开发者账号，登录态只保存在本机、不上传。自动申请调试证书与 Profile 的功能仍在开发中，当前版本还不能替你签名任意应用。',
      agcLogin: '开始登录（显示二维码）',
      agcRefresh: '刷新二维码',
      agcLogout: '退出登录（清除本机凭证）',
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
      errExclusive: '设备在 open 阶段被拒绝（Access denied），说明有程序正独占它。注意：错误发生在 open 而不是 claim，通常**不是驱动问题**，而是有进程/页面握着这个设备。\n\n按可能性从高到低排查：\n\n【最常见】Chrome 自己还占着（上一次连接没释放，比如大文件传输超时后）\n  → 完全退出 Chrome（关掉所有窗口；任务管理器确认 chrome.exe 全部结束），再重新打开本页面\n\n【其次】DevEco Studio（内置 hdc，会不停重启 server）\n  → 完全退出 DevEco Studio（不是关窗口，是在任务管理器结束 devecostudio64.exe / idea64.exe / hdc.exe）\n\n【兜底】物理重置\n  → 拔掉 USB 线，等 3 秒再插回去，保持手机解锁\n\n查占用（Windows PowerShell）：\n  Get-Process chrome,devecostudio64,idea64,hdc,hdc_std,HiSuite -ErrorAction SilentlyContinue | Select Name,Id\n\n做完【不要运行任何 hdc 命令】，立刻点「连接设备」。',
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
      navAccount: 'Huawei account',
      devicesTitle: 'Connected devices',
      sysVersion: 'OS version',
      deviceLog: 'Device log',
      fullLog: 'Full log (developer)',
      chWeb: 'Browser',
      chCli: 'Local CLI',
      cliRefresh: 'Refresh local devices',
      cliNotFound: 'adb/hdc not found (install DevEco / Platform-Tools or ensure on PATH)',
      cliNoDev: '(no device: plug in phone, enable USB debugging, ensure the CLI sees it)',
      cliHint: 'Click "Refresh local devices" to detect adb/hdc',
      noLog: '(no log yet)',
      accountTitle: 'Huawei account sign-in',
      accountHintShort: 'The session is stored on this machine; reloading, switching pages or reconnecting the phone needs no new sign-in.',
      accountHint: 'Scan the QR with your phone (Control Center > Scan) to sign in. Once signed in, the plugin requests a debug certificate, mints a debug profile and signs HAPs for you - no signing material needed on your side.',
      accountStatusOk: 'Signed in',
      accountStatusNone: 'Not signed in',
      accountRelogin: 'Sign in again',
      accountPersistTitle: 'How the session is kept',
      accountPersistHint: 'The session is stored on this machine (~/.dsh/agc-session.json, mode 600) and is never uploaded.\nReloading the plugin, switching pages or reconnecting the phone does not require another sign-in; only signing out or an expiry on the Huawei side does.',
      agcTitle: 'Huawei account sign-in (for automatic signing)',
      agcHint: 'Scan the QR with your phone (Control Center > Scan) to sign in. The session stays on this machine and is used to request a debug certificate and profile; you do not need to supply a pre-signed HAP.',
      agcLogin: 'Start sign-in (show QR)',
      agcRefresh: 'Refresh QR',
      agcLogout: 'Log out (clear local credential)',
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
      errExclusive: 'The device was refused at open (Access denied), so some program holds it exclusively. The failure is at open rather than claim, which usually means a process or page still owns it, not a driver problem.\n\nCheck in this order:\n\n[most likely] Chrome itself still holds it (a previous connection was never released, e.g. after a large transfer timed out)\n  -> Quit Chrome completely (close every window; confirm no chrome.exe remains in Task Manager), then reopen this page\n\n[next] DevEco Studio (bundles hdc and keeps restarting the server)\n  -> Quit it fully (end devecostudio64.exe / idea64.exe / hdc.exe in Task Manager, not just close the window)\n\n[last resort] Physical reset\n  -> Unplug the USB cable, wait 3 seconds, plug it back in, keep the phone unlocked\n\nFind the holder (Windows PowerShell):\n  Get-Process chrome,devecostudio64,idea64,hdc,hdc_std,HiSuite -ErrorAction SilentlyContinue | Select Name,Id\n\nAfter that do NOT run any hdc command; click "Connect device" immediately.',
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