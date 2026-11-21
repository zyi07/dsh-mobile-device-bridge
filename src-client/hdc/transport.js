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
import { Handshake, buildCommandFrame, buildCloseFrame, buildHeartbeatFrame, parseCommandReply, tryParseHandshakeFrame, AUTH_OK } from './session.js';

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

/**
 * 不选配置也能找接口：直接用 getConfiguration 拿到的描述符树。
 * WebUSB 里 device.configuration 只有在 selectConfiguration 之后才有值，
 * 而 device.configurations 是描述符本身，随时可读。
 */
export function findHdcInterfaceFromConfigurations(device) {
  if (device.configuration) { return findHdcInterface(device); }
  const cfgs = device.configurations || [];
  for (const cfg of cfgs) {
    for (const iface of cfg.interfaces || []) {
      for (const alt of [iface.alternate, ...(iface.alternates || [])]) {
        if (!alt) { continue; }
        if (alt.interfaceClass === IFACE_CLASS
          && alt.interfaceSubclass === IFACE_SUBCLASS
          && alt.interfaceProtocol === IFACE_PROTOCOL) {
          const eps = findBulkEndpoints(alt);
          if (eps) { return { interfaceNumber: iface.interfaceNumber, ...eps }; }
        }
      }
    }
  }
  throw new Error('描述符里找不到 HDC 接口（class 0xFF/0x50/0x01）');
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
    this.pendingRead = null;   // 唯一的在途 IN 传输
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
  async open({ attempts = 3, delayMs = 400 } = {}) {
    const d = this.device;
    let lastErr = null;
    let lastStep = 'open';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let step = 'open';
      try {
        if (!d.opened) { step = 'open'; await d.open(); }

        // ★ 关键差异：libusb 从不调用 SET_CONFIGURATION（它直接用现有配置），
        // 而 WebUSB 里我们过去总是先 selectConfiguration 才能枚举接口。
        // SET_CONFIGURATION 会重置所有接口/端点，很可能让 daemon 的回包发送失败
        // （真机日志里的 SendUSBRaw index failed）。
        // 所以：**先尝试不选配置直接 claim**，失败再退回选配置。
        step = 'claim';
        this.iface = findHdcInterfaceFromConfigurations(d);
        this.selectedConfig = false;
        try {
          await d.claimInterface(this.iface.interfaceNumber);
          this.emit('INFO', `claim 成功（未调用 selectConfiguration）iface=${this.iface.interfaceNumber}`);
        } catch (eClaimNoSel) {
          if (!d.configuration) {
            const cfg = d.configurations && d.configurations[0];
            if (!cfg) { throw eClaimNoSel; }
            await d.selectConfiguration(cfg.configurationValue);
            this.selectedConfig = true;
            this.emit('INFO', `回退：已 selectConfiguration(${cfg.configurationValue})，重新 claim`);
            await d.claimInterface(this.iface.interfaceNumber);
          } else {
            throw eClaimNoSel;
          }
        }
        this.opened = true;
        return this.iface;
      } catch (e) {
        lastErr = e;
        lastStep = step;
        this.opened = false;
        try { await d.close(); } catch { /* ignore */ }
        if (attempt < attempts) { await sleep(delayMs * attempt); }
      }
    }
    const where = lastStep === 'open'
      ? 'open 失败（设备被独占）'
      : (lastStep === 'claim' ? `claimInterface 失败（重试 ${attempts} 次）` : `${lastStep} 失败`);
    const desc = where
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
    await this.writeOut(head, 'UB 头');
    if (option === OPT_RESET) { this.emit('TX', 'reset(无帧)'); return; }   // RESET 只有头，没有帧
    this.emit('TX', `frame ${frame.length}B ${bytesToHexPreview(frame)}`);
    await this.writeOut(frame, '帧');
  }

  /** 写 OUT；遇 STALL 先 clearHalt 再重试一次（设备被上次异常会话挂住时常见） */
  async writeOut(data, label) {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.device.transferOut(this.iface.endpointOut, data);
        if (r && r.status === 'ok' && r.bytesWritten === data.length) { return; }
        throw new Error(`${r && r.status} ${r && r.bytesWritten}/${data.length}`);
      } catch (e) {
        if (i === 1) { throw new Error(`写${label}失败: ${(e && e.message) || e}`); }
        this.emit('INFO', `写${label}失败(${(e && e.message) || e})，clearHalt 后重试`);
        try { await this.device.clearHalt('out', this.iface.endpointOut); } catch { /* ignore */ }
        try { await this.device.clearHalt('in', this.iface.endpointIn); } catch { /* ignore */ }
        await sleep(120);
      }
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

      // WebUSB 的 transferIn 没有超时参数，只能自己 race。
      // 但**不能每次 race 超时就丢下 promise 再新起一个**，否则端点上会堆积
      // 多个永远不会完成的传输。这里始终复用同一个在途传输。
      if (!this.pendingRead) {
        this.pendingRead = this.device.transferIn(this.iface.endpointIn, this.readChunk)
          .then((r) => { this.pendingRead = null; return r; },
                (e) => { this.pendingRead = null; throw e; });
      }
      const res = await Promise.race([
        this.pendingRead,
        sleep(remain).then(() => ({ status: 'timeout' })),
      ]);

      if (!res) { this.emit('RX', 'timeout（本轮无数据）'); return null; }
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
  constructor(transport, { serial, hostname, version, keyPair, publicKeyPem, heartbeatMs = 5000, sessionId } = {}) {
    this.t = transport;
    this.serial = serial;
    this.hostname = hostname || 'dsh-web';
    this.version = version;
    this.keyPair = keyPair || null;
    this.publicKeyPem = publicKeyPem || null;
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
  async connect({ resetFirst = true, resetSettleMs = 150, confirmRounds = 7, confirmWaitMs = 9000 } = {}) {
    await this.t.open();
    // 先纯被动监听：真机上 hdc 打开设备后 47ms 内设备就自发心跳。
    // 若这里一个包都收不到，说明是设备侧不发数据，而不是我们的握手有问题。
    this.t.emit('INFO', '被动监听 3 秒（不发任何数据）');
    const passive = await this.t.drainIdle({ timeoutMs: 3000, rounds: 4 });
    this.t.emit('INFO', `被动监听结束，收到 ${passive} 个包`);

    let needConfirm = false;
    for (let round = 1; round <= confirmRounds; round++) {
      try {
        return await this.handshake({ resetFirst: resetFirst || round > 1, resetSettleMs });
      } catch (e) {
        const code = e && e.code;
        if (code === 'NEED_CONFIRM') {
          needConfirm = true;
          this.t.emit('INFO', `[第 ${round}/${confirmRounds} 轮] 设备未授权本机密钥 → `
            + '★ 请在手机上点「允许 / 始终信任」，本机将在 ' + Math.round(confirmWaitMs / 1000)
            + ' 秒后自动重新握手');
          await sleep(confirmWaitMs);
          continue;
        }
        // 首次超时：换"不发 RESET"的变体再试一次
        const msg = String(e && e.message ? e.message : e);
        if (round === 1 && /等待应答|超时/.test(msg)) {
          this.t.emit('INFO', '变体：本次不发 RESET，直接重新握手');
          await this.t.drainIdle({ timeoutMs: 120, rounds: 10 });
          try {
            return await this.handshake({ resetFirst: false, resetSettleMs: 0 });
          } catch (e2) {
            if (e2 && e2.code === 'NEED_CONFIRM') {
              needConfirm = true;
              this.t.emit('INFO', '★ 请在手机上点「允许 / 始终信任」');
              await sleep(confirmWaitMs);
              continue;
            }
            throw e2;
          }
        }
        throw e;
      }
    }
    const err = new Error(needConfirm
      ? '设备始终未授权本机密钥：手机上可能没有出现授权弹窗，或没有点「允许」'
      : '握手未完成');
    err.code = needConfirm ? 'NEED_CONFIRM' : 'HANDSHAKE';
    throw err;
  }

  async handshake({ resetFirst = true, resetSettleMs = 150 } = {}) {
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
      publicKeyPem: this.publicKeyPem,
      ...(this.version ? { version: this.version } : {}),
    });

    let frame = await hs.start();
    await this.t.writeFrame({ sessionId: this.sessionId, frame });

    const AUTH_NAMES = { 0: 'NONE', 1: 'TOKEN', 2: 'SIGNATURE', 3: 'PUBLICKEY', 4: 'OK', 5: 'FAIL' };
    let resendDone = false;
    let lastFrame = frame;         // 最后发出的握手帧（确认期间用于催应答）
    let lastNudge = 0;
    const HARD_DEADLINE = Date.now() + 75000;

    for (let guard = 0; guard < 60; guard++) {
      if (Date.now() > HARD_DEADLINE) { throw new Error('握手总超时（120 秒）'); }

      const timeoutMs = 8000;
      const pkt = await this.t.readPacket({ timeoutMs });

      if (!pkt) {
        if (confirmDeadline && Date.now() < confirmDeadline) {
          // 用户可能已经点了允许，但 daemon 没主动发 token：定期重发公钥帧催一次
          if (Date.now() - lastNudge > 12000) {
            lastNudge = Date.now();
            this.t.emit('INFO', '等待确认中…重发公钥帧以获取 token');
            await this.t.writeFrame({ sessionId: this.sessionId, frame: lastFrame });
          }
          continue;
        }
        if (!resendDone) {
          resendDone = true;
          this.t.emit('INFO', '首帧无应答，重发第 1 帧一次');
          await this.t.drainIdle({ timeoutMs: 100, rounds: 5 });
          await this.t.writeFrame({ sessionId: this.sessionId, frame });
          continue;
        }
        {
          const err = new Error(confirmDeadline
            ? '等待设备确认超时：手机上没有出现授权弹窗，或没有点「允许」'
            : '握手超时（等待应答失败）');
          err.code = confirmDeadline ? 'NEED_CONFIRM' : 'TIMEOUT';
          throw err;
        }
      }
      if (pkt.head.option !== OPT_HEADER) { continue; }

      // 过滤其它会话残留的包（设备侧会缓存上一次会话的应答）
      if (pkt.head.sessionId !== (this.sessionId >>> 0)) {
        this.t.emit('INFO', `忽略其它会话的包 sid=0x${(pkt.head.sessionId >>> 0).toString(16).toUpperCase()}`);
        continue;
      }

      let reply;
      try { reply = tryParseHandshakeFrame(pkt.frame); } catch { continue; }
      if (!reply) { continue; }

      const bufText = [...reply.buf].filter((c) => c >= 32 && c < 127).length >= 4
        ? decodeText(reply.buf.slice(0, 200)) : '';
      this.t.emit('INFO', `← 握手应答 authType=${reply.authType}(${AUTH_NAMES[reply.authType] || '?'}) `
        + `sid=${reply.sessionId} connectKey=${reply.connectKey.length}B buf=${reply.buf.length}B`);
      if (bufText) { this.t.emit('INFO', `   buf 文本: ${JSON.stringify(bufText)}`); }
      this.t.emit('HEX', `reply-frame ${pkt.frame.length}B: ${hexOf(pkt.frame, 512)}`);

      // ★ daemon 说"未授权，请在上机确认"。
      // 实测：它回完这条消息就**关闭会话**（紧跟一个 flag=2 关闭帧，随后心跳恢复），
      // 所以不能原地等 token —— 必须让用户去手机上点允许，然后**重新握手**。
      if (reply.authType === AUTH_OK && /UNAUTH|unauthorized|not set/i.test(bufText)) {
        const err = new Error('设备未授权本机密钥，需要在手机上确认');
        err.code = 'NEED_CONFIRM';
        throw err;
      }

      const next = await hs.accept(reply);
      this.info = reply;
      if (next === null) {
        this.authorized = true;
        break;
      }
      lastFrame = next;
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


function hexOf(bytes, limit = 256) {
  const n = Math.min(limit, bytes.length);
  return [...bytes.subarray(0, n)].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    + (bytes.length > n ? ` ...(+${bytes.length - n}B)` : '');
}
