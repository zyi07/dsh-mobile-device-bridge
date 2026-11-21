/**
 * 假 WebUSB 设备：回放 2026-11-21 抓到的真机字节。
 *
 * 用途：在没有真机的情况下验证 HdcTransport / HdcSession 的接线是否正确
 * （分两次写、读侧重组、心跳过滤、命令通道、AUTH 六步）。
 *
 * 故意把 IN 方向切成很小的块（默认 7 字节），用来压读取侧的重组逻辑。
 */

import { decodeFrame } from './codec.js';
import { parseUsbHead, buildUsbHead, USB_HEAD_SIZE, OPT_HEADER } from './transport.js';

const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

export function createFakeHdcDevice({ fixtures, chunkSize = 7 }) {
  const log = {
    outTransfers: [],   // 每次 transferOut 的字节数
    framesIn: [],       // 设备收到的完整帧（hex）
    resets: 0,
    reads: 0,
  };

  let outBuf = new Uint8Array(0);
  let rx = [];                       // 待发给主机的字节块队列
  let sid = 0;                       // 最近一次头里的 sessionId
  let opened = false;
  let claimed = false;

  const alt = {
    interfaceClass: 0xff,
    interfaceSubclass: 0x50,
    interfaceProtocol: 0x01,
    endpoints: [
      { type: 'bulk', direction: 'in', endpointNumber: 0x81, packetSize: 512 },
      { type: 'bulk', direction: 'out', endpointNumber: 0x01, packetSize: 512 },
    ],
  };
  const iface = { interfaceNumber: 0, alternate: alt, alternates: [alt] };

  function enqueueFrame(hexFrame) {
    const frame = fromHex(hexFrame);
    const head = buildUsbHead({ sessionId: sid, dataSize: frame.length, option: OPT_HEADER });
    rx.push(head, frame);
  }

  function enqueueRawHex(hexAll) {
    // 用于回放"UB 头 + 帧"已拼好的整块（心跳等）
    rx.push(fromHex(hexAll));
  }

  function enqueueHeartbeat() {
    enqueueFrame(fixtures.heartbeat_out_frame);
  }

  function onOut(data) {
    log.outTransfers.push(data.length);
    const next = new Uint8Array(outBuf.length + data.length);
    next.set(outBuf, 0);
    next.set(data, outBuf.length);
    outBuf = next;

    for (;;) {
      if (outBuf.length < USB_HEAD_SIZE) { return; }
      const head = parseUsbHead(outBuf.subarray(0, USB_HEAD_SIZE));
      if (head.option === 2) {                    // RESET：只有头
        log.resets += 1;
        outBuf = outBuf.slice(USB_HEAD_SIZE);
        enqueueHeartbeat();                       // 真机上 RESET 后设备继续发心跳
        continue;
      }
      const need = USB_HEAD_SIZE + head.dataSize;
      if (outBuf.length < need) { return; }
      const frame = outBuf.slice(USB_HEAD_SIZE, need);
      outBuf = outBuf.slice(need);
      sid = head.sessionId;
      handleFrame(frame);
    }
  }

  function handleFrame(frame) {
    log.framesIn.push(Buffer.from(frame).toString('hex').toUpperCase());
    let f;
    try { f = decodeFrame(frame); } catch { return; }
    const g = f.fields || {};
    if (f.commandFlag === 1) {                      // 握手
      const auth = g[2] | 0;
      if (auth === 0) { enqueueFrame(fixtures.step2_dev_to_host); return; }
      if (auth === 3) { enqueueFrame(fixtures.step4_dev_to_host); return; }
      if (auth === 2) { enqueueFrame(fixtures.step6_dev_to_host); return; }
      return;
    }
    if (f.commandFlag === 1001) {                   // 命令
      enqueueFrame(fixtures.cmd_reply_frame);       // 输出
      enqueueFrame(fixtures.close_device_frame);    // 设备侧关闭
      return;
    }
    if (f.commandFlag === 2) { return; }            // 主机侧关闭
    if (f.commandFlag === 5000) { enqueueHeartbeat(); return; }
  }

  const device = {
    get opened() { return opened; },
    configuration: null,
    // 描述符树：真实 WebUSB 中 device.configurations[i].interfaces 随时可读
    configurations: [{ configurationValue: 1, interfaces: [iface] }],

    async open() { opened = true; },
    async close() { opened = false; },
    async selectConfiguration() { device.configuration = { interfaces: [iface] }; },
    async claimInterface() { claimed = true; },
    async releaseInterface() { claimed = false; },
    async clearHalt() { /* no-op */ },

    async transferOut(ep, data) {
      if (!claimed) { throw new Error('未 claim 接口'); }
      if (ep !== 0x01) { throw new Error(`OUT 端点错: 0x${ep.toString(16)}`); }
      onOut(new Uint8Array(data));
      return { status: 'ok', bytesWritten: data.length };
    },

    async transferIn(ep, len) {
      if (!claimed) { throw new Error('未 claim 接口'); }
      if (ep !== 0x81) { throw new Error(`IN 端点错: 0x${ep.toString(16)}`); }
      log.reads += 1;
      if (rx.length === 0) { return { status: 'timeout', data: new DataView(new ArrayBuffer(0)) }; }
      // 故意切成小块返回，压重组逻辑
      const take = Math.min(len, chunkSize);
      let out = new Uint8Array(0);
      while (out.length < take && rx.length) {
        const head = rx[0];
        const room = take - out.length;
        const piece = head.subarray(0, Math.min(room, head.length));
        out = new Uint8Array([...out, ...piece]);
        if (piece.length === head.length) { rx.shift(); }
        else { rx[0] = head.slice(piece.length); }
      }
      return { status: 'ok', data: new DataView(out.buffer, out.byteOffset, out.byteLength) };
    },

    _log: log,
  };

  return device;
}