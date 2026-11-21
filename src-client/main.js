import React from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';
import { HdcTransport, HdcSession, diagnoseUsb } from './hdc/transport.js';
import { generateKeyPair as hdcGenerateKeyPair, DAEMON_VERSION } from './hdc/session.js';

/** 客户端构建标记：显示在面板并随 poll 上报，用来确认浏览器加载的是哪一版 */
const BUILD_TAG = 'r44';

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
  connection: null,   // 宿主 RPC 连接（用于把 HDC 日志送到宿主落盘）
};

/** 把 HDC 日志送到宿主写文件，便于直接读取而不必截屏。 */
async function flushHdcLog() {
  const conn = STATE.connection;
  if (!conn || !STATE.log || !STATE.log.length) { return; }
  try {
    await conn.rpc.call(BRIDGE, EP + '/log', { lines: STATE.log });
  } catch { /* 日志上报失败不影响主流程 */ }
}

function pushHdcLog(dir, text) {
  const d = new Date();
  const ts = String(d.getHours()).padStart(2, '0') + ':' +
    String(d.getMinutes()).padStart(2, '0') + ':' +
    String(d.getSeconds()).padStart(2, '0') + '.' +
    String(d.getMilliseconds()).padStart(3, '0');
  STATE.log.push(`${ts} ${dir} ${text}`);
  if (STATE.log.length > 400) { STATE.log.shift(); }
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
  const connection = await device.connect();
  const credentialStore = new AdbWebCredentialStore('dsh-mobile-bridge');
  const transport = await AdbDaemonTransport.authenticate({
    serial: device.serial,
    connection,
    credentialStore,
  });
  const adb = new Adb(transport);
  const info = await readInfo(adb, device);
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
async function connectHarmony(device) {
  const attempt = async (dev) => {
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
  const keyPair = await hdcGenerateKeyPair();
  const hostname = (typeof location !== 'undefined' && location.hostname) ? location.hostname : 'dsh-web';
  const session = new HdcSession(t, {
    serial: device.serialNumber || '',
    hostname,
    keyPair,
  });
  const authText = await session.connect();

  let model = '';
  let ohos = '';
  try {
    const r1 = await session.shell('param get const.product.model');
    model = (r1.text || '').trim();
  } catch { /* 拿不到不影响连接 */ }
  try {
    const r2 = await session.shell('param get const.ohos.apiversion');
    ohos = (r2.text || '').trim();
  } catch { /* ignore */ }

  STATE.hdc = session;
  STATE.device = device;
  STATE.kind = 'hdc';
  STATE.info = {
    kind: 'hdc',
    serial: device.serialNumber || '',
    vendorId: device.vendorId,
    productId: device.productId,
    model,
    os: ohos ? 'HarmonyOS (API ' + ohos + ')' : 'HarmonyOS',
    auth: authText.split('\n').filter(Boolean).slice(-1)[0] || '',
  };
  return STATE.info;
}

/** 统一执行一条 shell 命令（ADB 或 HDC）。 */
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
  const adb = STATE.adb;
  if (!STATE.adb && !STATE.hdc) { return { ok: false, error: '浏览器端尚未连接设备（请在设置页点「连接设备」）' }; }
  try {
    if (job.kind === 'shell') {
      return { ok: true, output: await execShell(job.data.cmd) };
    }
    if (job.kind === 'screenshot') {
      if (STATE.kind === 'hdc') {
        return { ok: false, error: 'HDC 通道暂不支持截图（需要文件传输，尚未实现）' };
      }
      const bytes = await adb.subprocess.noneProtocol.spawnWait('screencap -p');
      if (bytes.length > 12 * 1024 * 1024) {
        return { ok: false, error: `截图过大（${bytes.length} 字节），未回传` };
      }
      return { ok: true, base64: toBase64(bytes) };
    }
    return { ok: false, error: '未知任务类型 ' + job.kind };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * 轮询宿主取任务 → 在本地 adb 上执行 → 回传结果。
 * 这条链路与 UI 是否可见无关：只要标签页还活着就会跑；
 * 但标签页被浏览器挂起（后台节流）时会变慢。
 */
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
  const [usbSupported] = React.useState(
    typeof navigator !== 'undefined' && !!navigator.usb,
  );
  // 诊断心跳：DIAG 是模块级对象，没有它面板不会重渲染
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 2000);
    return () => clearInterval(id);
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
        const devices = await manager.getDevices();
        if (devices.length > 0 && !STATE.pending) {
          STATE.pending = attach(devices[0]).finally(() => { STATE.pending = null; });
          const next = await STATE.pending;
          if (alive) { setInfo(next); setPhase('connected'); return; }
        }
      } catch { /* 静默失败：交回手动连接 */ }
      if (alive) { setPhase('idle'); }
    })();
    return () => { alive = false; };  // 注意：这里不再断开连接
  }, []);

  async function connect() {
    setError('');
    setPhase('connecting');
    try {
      if (kind === 'hdc') {
        // HarmonyOS：直接用 WebUSB 选设备（华为 VID），再走 HDC 协议
        if (typeof navigator === 'undefined' || !navigator.usb) { throw new Error(t('noWebusb')); }
        const device = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x12d1 }] });
        if (!device) { setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle'); return; }
        if (STATE.adb || STATE.hdc) { await detach(); }
        const next = await connectHarmony(device);
        await flushHdcLog();
        setInfo(next);
        setCmd('param get const.product.model');
        setPhase('connected');
        return;
      }
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) { throw new Error(t('noWebusb')); }
      const device = await manager.requestDevice();
      if (!device) { setPhase((STATE.adb || STATE.hdc) ? 'connected' : 'idle'); return; }
      if (STATE.adb || STATE.hdc) { await detach(); }
      const next = await attach(device);
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
    try {
      setOut(await execShell(cmd));
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
    if (STATE.kind === 'hdc') {
      setError('HDC 通道暂不支持截图：鸿蒙截图需要 snapshot_display + 文件传输（file recv），尚未实现。可先用 hdc shell 执行命令。');
      return;
    }
    const adb = STATE.adb;
    if (!adb) { setPhase('idle'); return; }
    setBusy(true);
    setError('');
    try {
      const bytes = await adb.subprocess.noneProtocol.spawnWait('screencap -p');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      window.open(url, '_blank');
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

  children.push(h('div', { key: 'n', className: 'mb-note' }, t('hint')));

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