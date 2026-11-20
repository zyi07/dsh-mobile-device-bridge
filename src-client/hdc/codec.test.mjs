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
  payload: C.encodeHandshakePayload({ channelId: hs[2], version: dec.decode(hs[6]) }),
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
