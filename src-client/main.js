import React from 'react';
import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
import AdbWebCredentialStore from '@yume-chan/adb-credential-web';

export const inject = ['slots', 'locale'];

const NS = 'mobile-bridge';
const h = React.createElement;

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
.mb-err { color: var(--dsw-alias-label-error, #d9534f); white-space: pre-wrap; }
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
  const [phase, setPhase] = React.useState('idle');
  const [error, setError] = React.useState('');
  const [info, setInfo] = React.useState(null);
  const [cmd, setCmd] = React.useState('getprop ro.product.model');
  const [out, setOut] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const adbRef = React.useRef(null);
  const [usbSupported, setUsbSupported] = React.useState(
    typeof navigator !== 'undefined' && !!navigator.usb,
  );

  React.useEffect(() => () => {
    const adb = adbRef.current;
    adbRef.current = null;
    if (adb) { adb.close().catch(() => {}); }
  }, []);

  async function connect() {
    setError('');
    setPhase('connecting');
    try {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) { throw new Error(t('noWebusb')); }
      const device = await manager.requestDevice();
      if (!device) { setPhase('idle'); return; }

      const connection = await device.connect();
      const credentialStore = new AdbWebCredentialStore('dsh-mobile-bridge');
      const transport = await AdbDaemonTransport.authenticate({
        serial: device.serial,
        connection,
        credentialStore,
      });
      const adb = new Adb(transport);
      adbRef.current = adb;

      let model = '';
      let android = '';
      try { model = await adb.getProp('ro.product.model'); } catch { /* ignore */ }
      try { android = await adb.getProp('ro.build.version.release'); } catch { /* ignore */ }

      setInfo({
        serial: device.serial,
        vendorId: device.raw.vendorId,
        productId: device.raw.productId,
        model,
        android,
      });
      setPhase('connected');
    } catch (e) {
      adbRef.current = null;
      setError(String(e && e.message ? e.message : e));
      setPhase('idle');
    }
  }

  async function runShell() {
    const adb = adbRef.current;
    if (!adb) { return; }
    setBusy(true);
    setError('');
    try {
      const sp = adb.subprocess.shellProtocol;
      if (sp) {
        const r = await sp.spawnWaitText(cmd);
        setOut(
          '$ ' + cmd + '\n' +
          (r.stdout || '') +
          (r.stderr ? '\n[stderr] ' + r.stderr : '') +
          '\n[exit ' + r.exitCode + ']',
        );
      } else {
        const text = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
        setOut('$ ' + cmd + '\n' + text);
      }
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function screenshot() {
    const adb = adbRef.current;
    if (!adb) { return; }
    setBusy(true);
    setError('');
    try {
      const bytes = await adb.subprocess.noneProtocol.spawnWait('screencap -p');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
      window.open(url, '_blank');
    } catch (e) {
      setError(String(e && e.message ? e.message : e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    const adb = adbRef.current;
    adbRef.current = null;
    if (adb) { try { await adb.close(); } catch { /* ignore */ } }
    setInfo(null);
    setOut('');
    setPhase('idle');
  }

  const children = [
    h('style', { key: 's' }, CSS),
    h('div', { key: 'row', className: 'mb-row' },
      h('button', {
        key: 'c',
        className: 'mb-btn mb-btn--primary',
        disabled: phase === 'connecting' || !usbSupported,
        onClick: connect,
      }, phase === 'connecting' ? t('connecting') : t('connect')),
      phase === 'connected'
        ? h('button', { key: 'd', className: 'mb-btn', onClick: disconnect }, t('disconnect'))
        : null,
      h('span', { key: 'b', className: 'mb-badge' }, phase === 'connected' ? t('stateConnected') : t('stateIdle')),
    ),
  ];

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
        h('span', { className: 'mb-k' }, t('android')),
        h('span', { className: 'mb-v' }, info.android || '—'),
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
      children.push(h('pre', { key: 'o', className: 'mb-out' }, out));
    }
  }

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
      model: '机型',
      android: 'Android',
      serial: '序列号',
      usbId: 'USB ID',
      stateConnected: '已连接',
      stateIdle: '未连接',
      noWebusb: '当前浏览器不支持 WebUSB。请使用 Chrome 或 Edge 打开本页面。',
      hint: '需要在手机上开启「USB 调试」，首次连接时手机会弹出授权提示。同一时刻只能有一个程序占用 USB，请先停掉本机的 adb server、Android Studio、scrcpy 等。',
    },
    en: {
      nav: 'Mobile device',
      connect: 'Connect device',
      connecting: 'Connecting…',
      disconnect: 'Disconnect',
      run: 'Run',
      screenshot: 'Screenshot',
      model: 'Model',
      android: 'Android',
      serial: 'Serial',
      usbId: 'USB ID',
      stateConnected: 'Connected',
      stateIdle: 'Not connected',
      noWebusb: 'This browser has no WebUSB support. Open this page in Chrome or Edge.',
      hint: 'Enable USB debugging on the phone; the first connection asks for authorization on the device. Only one program can hold the USB interface, so stop the local adb server, Android Studio, and scrcpy first.',
    },
  }), 'mobile-bridge: locale');

  const t = ctx.locale.bind(NS);

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'mobile-bridge',
    order: 32,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t }),
  }, MobileBridgeSection));
}