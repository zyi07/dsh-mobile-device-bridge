/**
 * HDC over WebUSB —— 传输层与会话客户端
 *
 * 设计依据全部来自 2026-11-21 对**真 hdc.exe** 的抓包（见 ../docs/HDC_PROTOCOL.md
 * 与 ./fixtures.json），要点：
 *
 *   · 接口：class 0xFF / subclass 0x50 / protocol 0x01；bulk IN 0x81、OUT 0x01
 *   · 每个包前有 11 字节 USBHead{magic "UB", option, sessionId, dataSize}
 *   · **UB 头与帧必须分两次 bulk 写**（合并写会被 daemon 当 softreset 丢弃）
 *   · 连接建立先发 USBHead(option=2/RESET, size=0)，再发握手
 *   · 握手六步见 session.js；会话 id 由主机随机生成且非 0
 *   · 命令：commandFlag=1001，channelId 随机非 0，负载为纯文本（无 \0）
 *   · 输出：commandFlag=10；结束：commandFlag=2（主机发 0x00，设备回 0x01）
 *   · 心跳：双向，commandFlag=5000
 *
 * 本模块不直接依赖 navigator.usb，而是接受任意符合 WebUSB 形状的对象，
 * 因此可以用假设备离线回放真机字节做测试（见 transport.test.mjs）。
 */

import { decodeFrame, splitFrames } from './codec.js';
import { Handshake, buildCommandFrame, buildCloseFrame, buildHeartbeatFrame, parseCommandReply, tryParseHandshakeFrame } from './session.js';

export const OPT_HEADER = 1;
export const OPT_RESET = 2;
export const USB_HEAD_SIZE = 11;
export const MAGIC = [0x55, 0x42];
/** HDC 接口标识（真机实测） */
export const IFACE_CLASS = 0xff;
export const IFACE_SUBCLASS = 0x50;
export const IFACE_PROTOCOL = 0x01;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 生成一个非 0 的 32 位随机 id */
export function randomId() {
  let v = 0;
  while (v === 0) {
    const b = new Uint8Array(4);
    crypto.getRandomValues(b);
    v = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
    v = v >>> 0;
  }
  return v;
}

export function buildUsbHead({ sessionId, dataSize, option = OPT_HEADER }) {
  const out = new Uint8Array(USB_HEAD_SIZE);
  out[0] = MAGIC[0];
  out[1] = MAGIC[1];
  out[2] = option & 0xff;
  new DataView(out.buffer).setUint32(3, sessionId >>> 0, false);
  new DataView(out.buffer).setUint32(7, dataSize >>> 0, false);
  return out;
}

export function parseUsbHead(bytes) {
  if (bytes.length < USB_HEAD_SIZE) { throw new RangeError('UB 头不足 11 字节'); }
  if (bytes[0] !== MAGIC[0] || bytes[1] !== MAGIC[1]) {
    throw new Error(`UB magic 不对: ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    option: bytes[2],
    sessionId: dv.getUint32(3, false),
    dataSize: dv.getUint32(7, false),
  };
}

/** 在 WebUSB 设备里找 HDC 接口与该接口的两个 bulk 端点 */
export function findHdcInterface(device) {
  const config = device.configuration;
  if (!config) { throw new Error('设备未选择配置'); }
  for (const iface of config.interfaces) {
    for (const alt of [iface.alternate, ...(iface.alternates || [])]) {
      if (
        alt.interfaceClass === IFACE_CLASS &&
        alt.interfaceSubclass === IFACE_SUBCLASS &&
        alt.interfaceProtocol === IFACE_PROTOCOL
      ) {
        const eps = findBulkEndpoints(alt);
        if (eps) { return { interfaceNumber: iface.interfaceNumber, ...eps }; }
      }
    }
  }
  // 退路：任何同时含 bulk IN/OUT 的 vendor-specific 接口
  for (const iface of config.interfaces) {
    const alt = iface.alternate;
    if (alt.interfaceClass === IFACE_CLASS) {
      const eps = findBulkEndpoints(alt);
      if (eps) { return { interfaceNumber: iface.interfaceNumber, ...eps }; }
    }
  }
  throw new Error('未找到 HDC 接口（class 0xFF/0x50/0x01）');
}

function findBulkEndpoints(alt) {
  let epIn = 0;
  let epOut = 0;
  for (const ep of alt.endpoints || []) {
    if (ep.type !== 'bulk') { continue; }
    if (ep.direction === 'in') { epIn = ep.endpointNumber; }
    if (ep.direction === 'out') { epOut = ep.endpointNumber; }
  }
  return epIn && epOut ? { endpointIn: epIn, endpointOut: epOut, packetSize: alt.endpoints[0]?.packetSize } : null;
}

/**
 * 纯传输层：负责 open/claim、11 字节头与帧的分两次写、以及读侧重组。
 * 不做任何协议语义。
 */
export class HdcTransport {
  constructor(device, { readChunk = 512, logger = null } = {}) {
    this.device = device;
    this.readChunk = readChunk;
    this.logger = logger;          // (dir, text) => void，用于把收发过程显示出来
    this.iface = null;
    this.rx = new Uint8Array(0);
    this.opened = false;
    // 诊断计数：hdc server 被杀时 IN 端点里会残留半帧，需要重同步
    this.resyncs = 0;
    this.dropped = 0;
  }

  static async requestDevice(usb, { vendorIds = [0x12d1] } = {}) {
    const filters = vendorIds.map((vendorId) => ({ vendorId }));
    const device = await usb.requestDevice({ filters });
    return device;
  }

  /**
   * 打开并 claim。带重试：手机在"始终信任"授权瞬间会重新枚举 USB，
   * 第一次 claim 常常正好撞在枚举空窗期，所以失败要退避重试几次。
   */
  async open({ attempts = 4, delayMs = 400 } = {}) {
    const d = this.device;
    let lastErr = null;
    let lastStep = 'open';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let step = 'open';
      try {
        if (!d.opened) { step = 'open'; await d.open(); }
        step = 'selectConfiguration';
        if (!d.configuration) {
          const cfg = d.configurations && d.configurations[0];
          if (!cfg) { throw new Error('设备没有配置'); }
          await d.selectConfiguration(cfg.configurationValue);
        }
        step = 'claim';
        this.iface = findHdcInterface(d);
        await d.claimInterface(this.iface.interfaceNumber);
        this.opened = true;
        return this.iface;
      } catch (e) {
        lastErr = e;
        lastStep = step;
        this.opened = false;
        // 释放句柄，否则下一次一定失败（WebUSB 的 open 会独占设备）
        try { await d.close(); } catch { /* ignore */ }
        if (attempt < attempts) { await sleep(delayMs * attempt); }
      }
    }
    // 第 7 轮实测：hdc server 常驻时 libusb_open 返回 -3 ACCESS，
    // Chrome 表现为 open 这一步就失败。open 失败 = 被别的程序独占，
    // 而不是"驱动不对"（真机 interface 0 的 Service 已确认是 WINUSB）。
    const where = lastStep === 'open'
      ? 'open 失败（设备被独占）'
      : (lastStep === 'claim'
        ? `claimInterface 失败（重试 ${attempts} 次）`
        : `${lastStep} 失败`);
    const desc =
      where
      + ` [class=0x${IFACE_CLASS.toString(16)} sub=0x${IFACE_SUBCLASS.toString(16)}`
      + ` proto=0x${IFACE_PROTOCOL.toString(16)}]`;
    const err = new Error(
      `${desc} → ${(lastErr && lastErr.name) || 'Error'}: ${(lastErr && lastErr.message) || lastErr}`,
    );
    err.cause = lastErr;
    err.step = lastStep;
    err.diagnostic = await diagnoseUsb().catch(() => null);
    throw err;
  }

  /**
   * 关键：**先写 11 字节 UB 头，再单独写帧**。
   * 合并成一次写会被 daemon 当 softreset 把负载丢掉（真机日志实证）。
   */
  async writeFrame({ sessionId, frame, option = OPT_HEADER }) {
    const head = buildUsbHead({ sessionId, dataSize: frame.length, option });
    this.emit('TX', `ub-head opt=${option} sid=0x${(sessionId >>> 0).toString(16).toUpperCase()} len=${frame.length}`);
    const r1 = await this.device.transferOut(this.iface.endpointOut, head);
    if (r1.status !== 'ok' || r1.bytesWritten !== head.length) {
      throw new Error(`写 UB 头失败: ${r1.status} ${r1.bytesWritten}/${head.length}`);
    }
    if (option === OPT_RESET) { this.emit('TX', 'reset(无帧)'); return; }   // RESET 只有头，没有帧
    this.emit('TX', `frame ${frame.length}B ${bytesToHexPreview(frame)}`);
    const r2 = await this.device.transferOut(this.iface.endpointOut, frame);
    if (r2.status !== 'ok' || r2.bytesWritten !== frame.length) {
      throw new Error(`写帧失败: ${r2.status} ${r2.bytesWritten}/${frame.length}`);
    }
  }

  async reset() {
    await this.writeFrame({ sessionId: 0, frame: new Uint8Array(0), option: OPT_RESET });
  }

  /** 读一个完整包（UB 头 + 其声明的帧）。超时返回 null。 */
  async readPacket({ timeoutMs = 3000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = this.takeFromBuffer();
      if (parsed) { return parsed; }

      const remain = deadline - Date.now();
      if (remain <= 0) { return null; }

      const res = await Promise.race([
        this.device.transferIn(this.iface.endpointIn, this.readChunk),
        sleep(remain).then(() => ({ status: 'timeout' })),
      ]);

      if (res.status === 'timeout') { this.emit('RX', 'timeout（本轮无数据）'); return null; }
      if (res.status !== 'ok') {
        if (res.status === 'stall') {
          try { await this.device.clearHalt('in', this.iface.endpointIn); } catch { /* ignore */ }
          continue;
        }
        throw new Error(`读失败: ${res.status}`);
      }
      if (res.data && res.data.byteLength > 0) {
        this.append(new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength));
      }
    }
  }

  /** 记一条收发日志（没有 logger 时静默） */
  emit(dir, text) {
    if (this.logger) { this.logger(dir, text); }
  }

  append(chunk) {
    const next = new Uint8Array(this.rx.length + chunk.length);
    next.set(this.rx, 0);
    next.set(chunk, this.rx.length);
    this.rx = next;
  }

  /**
   * 从缓冲里取一个完整包。
   *
   * 必须具备**重同步**能力：设备 IN 端点里常残留上一次会话的半帧
   * （实测：hdc server 被杀后第一次读会拿到以 `10 01` 开头的残片），
   * 严格解析会直接抛错。这里的策略是跳过垃圾、对齐到 "UB"(0x55 0x42)。
   */
  takeFromBuffer() {
    for (;;) {
      // —— 对齐到 UB magic ——
      if (this.rx.length >= 2 && (this.rx[0] !== MAGIC[0] || this.rx[1] !== MAGIC[1])) {
        let idx = -1;
        for (let i = 1; i + 1 < this.rx.length; i++) {
          if (this.rx[i] === MAGIC[0] && this.rx[i + 1] === MAGIC[1]) { idx = i; break; }
        }
        if (idx < 0) {
          // 整段都找不到 magic：只保留末尾可能残缺的 0x55
          const keep = this.rx[this.rx.length - 1] === MAGIC[0] ? 1 : 0;
          this.dropped += this.rx.length - keep;
          this.rx = this.rx.slice(this.rx.length - keep);
          return null;                    // 需要更多数据才能重新对齐
        }
        this.emit('SYNC', `跳过 ${idx} 字节垃圾（对齐到 UB）`);
        this.dropped += idx;
        this.resyncs += 1;
        this.rx = this.rx.slice(idx);
      }

      if (this.rx.length < USB_HEAD_SIZE) { return null; }

      let head;
      try {
        head = parseUsbHead(this.rx.subarray(0, USB_HEAD_SIZE));
      } catch {
        this.dropped += 2;
        this.rx = this.rx.slice(2);
        continue;
      }

      // 头部字段合法性校验：option 只能是 1/2，长度不超过 1MB
      const optionOk = head.option === OPT_HEADER || head.option === OPT_RESET;
      if (!optionOk || head.dataSize > (1 << 20)) {
        this.dropped += 2;
        this.rx = this.rx.slice(2);
        continue;
      }

      const need = USB_HEAD_SIZE + head.dataSize;
      if (this.rx.length < need) { return null; }

      const frame = this.rx.slice(USB_HEAD_SIZE, need);
      this.rx = this.rx.slice(need);
      this.emit('RX', `pkt opt=${head.option} sid=0x${(head.sessionId >>> 0).toString(16).toUpperCase()} len=${head.dataSize} ${bytesToHexPreview(frame)}`);
      return { head, frame };
    }
  }

  /**
   * 丢弃端点里的残留数据：claim 之后、RESET 之后都该调一次。
   * 返回丢弃的包数。
   */
  async drainIdle({ timeoutMs = 150, rounds = 20 } = {}) {
    let got = 0;
    for (let i = 0; i < rounds; i++) {
      const p = await this.readPacket({ timeoutMs });
      if (!p) { break; }
      got += 1;
    }
    this.rx = new Uint8Array(0);       // 清掉不完整的尾巴
    return got;
  }

  async close() {
    if (!this.opened) { return; }
    try { await this.device.releaseInterface(this.iface.interfaceNumber); } catch { /* ignore */ }
    try { await this.device.close(); } catch { /* ignore */ }
    this.opened = false;
  }
}

/**
 * 协议客户端：连接（RESET → 六步握手）→ 执行命令。
 */
export class HdcSession {
  constructor(transport, { serial, hostname, version, keyPair, heartbeatMs = 5000, sessionId } = {}) {
    this.t = transport;
    this.serial = serial;
    this.hostname = hostname || 'dsh-web';
    this.version = version;
    this.keyPair = keyPair || null;
    this.heartbeatMs = heartbeatMs;
    /** 允许外部指定（测试用；生产应留空由 randomId() 生成） */
    this.fixedSessionId = (sessionId || 0) >>> 0;
    this.sessionId = 0;
    this.authorized = false;
    this.hbTimer = null;
    this.hbCount = 0;
    this.info = null;
  }

  /** 建立连接并完成 AUTH。返回 daemon 的 AUTH_OK 状态文本。 */
  async connect({ resetFirst = true, resetSettleMs = 150 } = {}) {
    await this.t.open();
    // 上一次会话（如被 kill 的 hdc server）可能在 IN 端点留下半帧，先清干净
    await this.t.drainIdle({ timeoutMs: 120, rounds: 20 });
    if (resetFirst) {
      await this.t.reset();
      await sleep(resetSettleMs);
      await this.t.drainIdle({ timeoutMs: 120, rounds: 20 });
    }
    this.sessionId = this.fixedSessionId || randomId();
    const hs = new Handshake({
      sessionId: this.sessionId,
      serial: this.serial,
      hostname: this.hostname,
      keyPair: this.keyPair,
      ...(this.version ? { version: this.version } : {}),
    });

    let frame = await hs.start();
    await this.t.writeFrame({ sessionId: this.sessionId, frame });

    for (let step = 0; step < 6; step++) {
      let pkt = await this.t.readPacket({ timeoutMs: 8000 });
      // 首帧没回音时重发一次：设备可能仍处在"上一个会话未完全清理"的状态，
      // 重发能让 daemon 走 "New session coming" 分支。
      if (!pkt && step === 0) {
        this.t.emit('INFO', '首帧无应答，重发第 1 帧一次');
        await this.t.drainIdle({ timeoutMs: 100, rounds: 5 });
        await this.t.writeFrame({ sessionId: this.sessionId, frame });
        pkt = await this.t.readPacket({ timeoutMs: 8000 });
      }
      if (!pkt) { throw new Error(`握手超时（第 ${step + 1} 次等待应答）`); }
      if (pkt.head.option !== OPT_HEADER) { continue; }
      let reply;
      try { reply = tryParseHandshakeFrame(pkt.frame); } catch { continue; }
      if (!reply) { continue; }        // 心跳等非握手帧，跳过继续等
      const next = await hs.accept(reply);
      this.info = reply;
      if (next === null) {
        this.authorized = true;
        break;
      }
      await this.t.writeFrame({ sessionId: hs.sessionId, frame: next });
    }
    if (!this.authorized) { throw new Error('握手未完成'); }
    this.startHeartbeat();
    return hs.lastReply ? decodeText(hs.lastReply.buf) : '';
  }

  startHeartbeat() {
    if (!this.heartbeatMs || this.hbTimer) { return; }
    this.hbTimer = setInterval(() => {
      const frame = buildHeartbeatFrame({ sessionId: this.sessionId, count: this.hbCount++ });
      this.t.writeFrame({ sessionId: this.sessionId, frame }).catch(() => { /* 心跳失败不致命 */ });
    }, this.heartbeatMs);
    if (this.hbTimer.unref) { this.hbTimer.unref(); }
  }

  stopHeartbeat() {
    if (this.hbTimer) { clearInterval(this.hbTimer); this.hbTimer = null; }
  }

  /**
   * 执行一条命令。返回 { text, codes }。
   * 依据抓包：一条命令 = 1 个输出帧 + 1 个关闭帧。
   */
  async shell(text, { timeoutMs = 20000 } = {}) {
    if (!this.authorized) { throw new Error('尚未完成 AUTH'); }
    const channelId = randomId();
    await this.t.writeFrame({
      sessionId: this.sessionId,
      frame: buildCommandFrame({ channelId, text }),
    });

    const deadline = Date.now() + timeoutMs;
    let out = '';
    try {
      for (;;) {
        const remain = deadline - Date.now();
        if (remain <= 0) { throw new Error(`命令超时 ${timeoutMs}ms：${text}`); }
        const pkt = await this.t.readPacket({ timeoutMs: Math.min(remain, 3000) });
        if (!pkt) { throw new Error(`命令等待应答超时：${text}`); }
        if (pkt.head.option !== OPT_HEADER) { continue; }
        let f;
        try { f = decodeFrame(pkt.frame); } catch { continue; }
        if (f.commandFlag === 5000) { continue; }            // 心跳：忽略
        const kind = parseCommandReply(pkt.frame);
        if (kind.kind === 'output') { out += kind.text; continue; }
        if (kind.kind === 'close') {
          if (kind.side === 'device') { break; }
          continue;
        }
        // 其他帧不认识的，忽略继续等
      }
    } finally {
      // 主机侧也要发关闭（抓包里是 0x00）
      try {
        await this.t.writeFrame({
          sessionId: this.sessionId,
          frame: buildCloseFrame({ channelId, side: 'host' }),
        });
      } catch { /* ignore */ }
    }
    return { text: out };
  }

  async close() {
    this.stopHeartbeat();
    await this.t.close();
  }
}

function decodeText(bytes) {
  try { return new TextDecoder().decode(bytes); } catch { return ''; }
}
/**
 * 诊断：把 Chrome 眼里的设备/接口状态打出来。
 * `claimed` 特别关键——它由本页或别的页持有，能直接回答"接口是不是被占着"。
 */
export async function diagnoseUsb() {
  if (typeof navigator === 'undefined' || !navigator.usb) {
    return { ok: false, error: '当前浏览器没有 WebUSB' };
  }
  let devices;
  try { devices = await navigator.usb.getDevices(); } catch (e) {
    return { ok: false, error: 'getDevices 失败: ' + (e && e.message) };
  }
  const out = [];
  for (const d of devices) {
    const entry = {
      vid: '0x' + d.vendorId.toString(16),
      pid: '0x' + d.productId.toString(16),
      serial: d.serialNumber || '',
      opened: !!d.opened,
      productName: d.productName || '',
      interfaces: d.configuration
        ? d.configuration.interfaces.map((i) => {
            const a = i.alternate;
            return {
              interfaceNumber: i.interfaceNumber,
              claimed: !!i.claimed,
              class: '0x' + a.interfaceClass.toString(16),
              subclass: '0x' + a.interfaceSubclass.toString(16),
              protocol: '0x' + a.interfaceProtocol.toString(16),
              endpoints: a.endpoints.map(
                (e) => `${e.direction}:${e.endpointNumber}:${e.type}:pk${e.packetSize}`,
              ),
            };
          })
        : null,
    };
    // 现场试一次 claim：这是判断"环境问题 vs 我们代码问题"的决定性证据
    entry.claimTest = await probeClaim(d);
    out.push(entry);
  }
  return { ok: true, count: devices.length, devices: out };
}

/** 打开→选配置→尝试 claim→释放→关闭；只报告结论，不改设备状态。 */
async function probeClaim(device) {
  let openedHere = false;
  let claimed = false;
  let target = null;
  try {
    if (!device.opened) { await device.open(); openedHere = true; }
    if (!device.configuration) {
      const cfg = device.configurations && device.configurations[0];
      if (cfg) { await device.selectConfiguration(cfg.configurationValue); }
    }
    target = findHdcInterface(device);
    await device.claimInterface(target.interfaceNumber);
    claimed = true;
    return 'ok';
  } catch (e) {
    return `${(e && e.name) || 'Error'}: ${(e && e.message) || e}`;
  } finally {
    if (claimed) { try { await device.releaseInterface(target.interfaceNumber); } catch { /* ignore */ } }
    if (openedHere) { try { await device.close(); } catch { /* ignore */ } }
  }
}


function bytesToHexPreview(bytes, n = 24) {
  const arr = bytes.subarray(0, Math.min(n, bytes.length));
  const hex = [...arr].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return hex + (bytes.length > n ? ' ...' : '');
}
