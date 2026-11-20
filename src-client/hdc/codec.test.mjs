import assert from 'node:assert';
import * as C from './codec.js';

const hex = (s) => new Uint8Array(s.replace(/\s+/g, '').match(/../g).map((h) => parseInt(h, 16)));

// 实测抓包向量：一次 53 字节的 session handshake
const VECTOR =
  '48 57 00 00 01 00 0c 00 00 00 1e ' +
  '08 c4 e6 88 89 01 10 01 18 00 20 09 ' +
  '0a 08 4f 48 4f 53 20 48 44 43 ' +
  '10 00 18 01 22 00 2a 00 ' +
  '32 0a 33 2e 32 2e 30 63 54 45 53 54';

const raw = hex(VECTOR);
assert.equal(raw.length, 53, `向量长度应为 53，实际 ${raw.length}`);

const f = C.decodeFrame(raw);
assert.equal(f.headSize, 12);
assert.equal(f.dataSize, 30);
assert.equal(f.totalSize, 53);
assert.equal(f.protocolVer, 1);
assert.equal(f.vCode, 9, 'vCode 魔数应为 9');
assert.equal(f.commandFlag, 1);
assert.equal(f.checkSum, 0);

const hs = C.decodeFields(f.payload);
const dec = new TextDecoder();
assert.equal(dec.decode(hs[1]), 'OHOS HDC');
assert.equal(hs[2], 0);
assert.equal(hs[3], 1);
assert.equal(hs[4].length, 0);
assert.equal(hs[5].length, 0);
assert.equal(dec.decode(hs[6]), '3.2.0cTEST');

// 重新编码必须逐字节一致
const rebuilt = C.encodeFrame({
  channelId: f.channelId,
  commandFlag: f.commandFlag,
  checkSum: f.checkSum,
  // 注意顺序：f2=authType, f3=sessionId（以 session.h 的结构体为准）
  payload: C.encodeHandshakePayload({
    authType: hs[2],
    sessionId: hs[3],
    connectKey: dec.decode(hs[4]),
    buf: dec.decode(hs[5]),
    version: dec.decode(hs[6]),
  }),
});
assert.deepEqual([...rebuilt], [...raw], '重编码结果与抓包不一致');

// 108 字节握手往返
const h108 = C.encodeHandshake108({ channelId: 287449388, version: '3.2.0c', hugeBuffer: true });
assert.equal(h108.length, 108);
const back = C.decodeHandshake108(h108);
assert.equal(back.banner, 'OHOS HDC');
assert.equal(back.channelId, 287449388);
assert.equal(back.version, '3.2.0c');
assert.equal(back.hugeBuffer, true);

// 粘包切分：两帧连着一次读入
const two = new Uint8Array([...raw, ...raw]);
const split = C.splitFrames(two);
assert.equal(split.frames.length, 2);
assert.equal(split.rest.length, 0);

// 半包：只给前半段，应切不出帧
const half = C.splitFrames(raw.slice(0, 40));
assert.equal(half.frames.length, 0);
assert.equal(half.rest.length, 40);

// 非 HDC 数据必须报错，而不是静默当成帧
assert.throws(() => C.decodeFrame(new Uint8Array([0, 0, 0, 0, 1, 0, 12, 0, 0, 0, 30])), /HW/);

// protobuf varint 边界
for (const n of [0, 1, 127, 128, 300, 287449388, 2 ** 32 - 1]) {
  const enc = C.encodeVarint(n);
  const d = C.decodeVarint(enc, 0);
  assert.equal(d.value, n, `varint ${n} 往返失败`);
  assert.equal(d.next, enc.length);
}

console.log('全部断言通过：帧解码 / 重编码逐字节一致 / 108 握手 / 粘包切分 / 半包 / 魔数校验 / varint');

// ================= 真机字节（libusb 直读，HUAWEI Mate 70 Pro+） =================
{
  // 设备发来的 USB 包：11 字节 UB 包头 + 24 字节 HW 帧
  const ub = hex('55 42 01 09 EB AE F9 00 00 00 18');
  const hw = hex('48 57 00 00 01 00 09 00 00 00 04 08 00 10 88 27 18 00 20 09 08 1E 12 00');

  const head = C.decodeUsbHead(ub);
  assert.equal(head.version, 1);
  assert.equal(head.sessionId, 0x09ebaef9);
  assert.equal(head.payloadLength, 24, 'UB 包头长度字段必须等于后续帧长度');
  assert.equal(head.payloadLength, hw.length);

  const f = C.decodeFrame(hw);
  assert.equal(f.totalSize, hw.length, '11 + headSize + dataSize 必须等于实际帧长');
  assert.equal(f.headSize, 9);
  assert.equal(f.dataSize, 4);
  assert.equal(f.vCode, 9);
  assert.equal(f.channelId, 0);
  assert.equal(f.commandFlag, 5000, '真机心跳命令号');
  assert.equal(f.checkSum, 0);
  assert.equal(C.decodeFields(f.payload)[1], 30);

  // UB 头也要能重编码成同样的字节
  assert.deepEqual([...C.encodeUsbHead({ sessionId: 0x09ebaef9, length: 24 })], [...ub]);

  // 三次会话的 sessionId 都要往返一致
  for (const sid of [0x82245e70, 0xa791a61c, 0x09ebaef9]) {
    const enc = C.encodeUsbHead({ sessionId: sid, length: 24 });
    assert.equal(C.decodeUsbHead(enc).sessionId, sid);
  }

  // 粘连：两个 USB 包一次到达
  const two = new Uint8Array([...ub, ...hw, ...ub, ...hw]);
  const split = C.splitUsbPackets(two);
  assert.equal(split.packets.length, 2);
  assert.equal(split.rest.length, 0);
  assert.equal(split.packets[0].frame.length, 24);

  // 半包：只有 UB 头 + 10 字节帧，应切不出来
  const partial = C.splitUsbPackets(new Uint8Array([...ub, ...hw.slice(0, 10)]));
  assert.equal(partial.packets.length, 0);
  assert.equal(partial.rest.length, 21);

  // 心跳计数递增：同会话下 payload 字段1 逐次 +1
  for (let seq = 0; seq < 3; seq++) {
    const h = new Uint8Array([...hw]);
    h[21] = 0x1e + seq;
    assert.equal(C.decodeFields(C.decodeFrame(h).payload)[1], 30 + seq);
  }

  console.log('真机字节断言通过：UB 包头 / 层长度自洽 / 三次会话 sessionId / 粘连 / 半包 / 心跳递增');
}
