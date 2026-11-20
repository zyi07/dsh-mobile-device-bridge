/**
 * HDC 协议编解码（HarmonyOS Debug Connector）
 *
 * 依据 OpenHarmony 开源实现 developtools_hdc，不是猜测：
 *   - 帧头 PayloadHead   src/common/session.h:160   （packed，11 字节）
 *   - 握手 ChannelHandShake src/common/channel.h:36 （packed，108 = 44 + 64）
 *
 * 帧布局（实测字节数吻合）：
 *   [11 字节 PayloadHead][headSize 字节 会话头 protobuf][dataSize 字节 会话负载]
 *   总长 = 11 + headSize + dataSize
 *
 * 会话头是 protobuf：1=channelId 2=commandFlag 3=checkSum 4=vCode(=0x09)
 * vCode 是魔数，对不上时对端静默丢包（不报错），所以必须精确。
 *
 * ⚠️ 版本差异：帧格式在 hdc 6.x（HarmonyOS NEXT）上有变化，另一份针对
 * API 12+ 的实现观察到握手后是 [4 字节大端长度][payload]。本文件实现的是
 * 源码里 PayloadHead 那一版；两种都留了入口，等真机抓包定版本。
 */

/** 会话头魔数，必须等于 0x09 */
export const VCODE = 0x09;
/** PayloadHead 起头两个字节 "HW" */
export const FLAG_HW = [0x48, 0x57];
export const PROTOCOL_VER = 0x01;
export const HEAD_SIZE = 11;
/** ChannelHandShake 固定长度 */
export const HANDSHAKE_SIZE = 108;
export const BANNER = 'OHOS HDC';

// ---------------------------------------------------------------- protobuf

export function encodeVarint(value) {
  const out = [];
  let v = value >>> 0;
  if (value < 0) throw new RangeError('varint 不支持负数');
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

export function decodeVarint(bytes, pos) {
  let result = 0;
  let shift = 1;
  let i = pos;
  for (;;) {
    if (i >= bytes.length) throw new RangeError('varint 越界');
    const b = bytes[i++];
    result += (b & 0x7f) * shift;
    if ((b & 0x80) === 0) break;
    shift *= 128;
    if (shift > 2 ** 53) throw new RangeError('varint 过长');
  }
  return { value: result, next: i };
}

const utf8 = new TextEncoder();
const utf8d = new TextDecoder();

function fieldVarint(num, value) {
  return [...encodeVarint(num * 8), ...encodeVarint(value)];
}

function fieldBytes(num, bytes) {
  return [...encodeVarint(num * 8 + 2), ...encodeVarint(bytes.length), ...bytes];
}

/** 极简 protobuf 解析：只处理 varint 与 length-delimited，够 hdc 用。 */
export function decodeFields(bytes) {
  const fields = {};
  let pos = 0;
  while (pos < bytes.length) {
    const key = decodeVarint(bytes, pos);
    pos = key.next;
    const num = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (wire === 0) {
      const v = decodeVarint(bytes, pos);
      pos = v.next;
      fields[num] = v.value;
    } else if (wire === 2) {
      const len = decodeVarint(bytes, pos);
      pos = len.next;
      fields[num] = bytes.slice(pos, pos + len.value);
      pos += len.value;
    } else {
      throw new Error(`不支持的 protobuf wire type ${wire} (字段 ${num})`);
    }
  }
  return fields;
}

// ------------------------------------------------------------ 会话头

/** 会话头 protobuf：1=channelId 2=commandFlag 3=checkSum 4=vCode */
export function encodeSessionHead({ channelId, commandFlag, checkSum = 0, vCode = VCODE }) {
  return [
    ...fieldVarint(1, channelId),
    ...fieldVarint(2, commandFlag),
    ...fieldVarint(3, checkSum),
    ...fieldVarint(4, vCode),
  ];
}

// ------------------------------------------------------------ 握手负载

/**
 * 握手负载 protobuf。字段号来自实测抓包（见 docs/HDC_PROTOCOL.md）：
 *   1 = banner("OHOS HDC")  2 = channelId  3 = 1  4 = 空  5 = 空  6 = version
 * 源码里这几个字段的语义名没有一一对应公开，故按序号保留，勿臆造名字。
 */
export function encodeHandshakePayload({ banner = BANNER, channelId = 0, version = '' }) {
  return [
    ...fieldBytes(1, [...utf8.encode(banner)]),
    ...fieldVarint(2, channelId),
    ...fieldVarint(3, 1),
    ...fieldBytes(4, []),
    ...fieldBytes(5, []),
    ...fieldBytes(6, [...utf8.encode(version)]),
  ];
}

// ------------------------------------------------------------ 帧

export function encodeFrame({ channelId, commandFlag, payload = [], checkSum = 0 }) {
  const head = encodeSessionHead({ channelId, commandFlag, checkSum });
  const data = [...payload];
  const frame = [
    ...FLAG_HW,
    0x00, 0x00,
    PROTOCOL_VER,
    (head.length >> 8) & 0xff, head.length & 0xff,
    (data.length >>> 24) & 0xff,
    (data.length >>> 16) & 0xff,
    (data.length >>> 8) & 0xff,
    data.length & 0xff,
    ...head,
    ...data,
  ];
  return new Uint8Array(frame);
}

export function decodeFrame(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < HEAD_SIZE) throw new RangeError(`帧太短: ${bytes.length}`);
  if (bytes[0] !== FLAG_HW[0] || bytes[1] !== FLAG_HW[1]) {
    throw new Error(`帧标志不是 "HW": ${bytes[0].toString(16)} ${bytes[1].toString(16)}`);
  }
  const protocolVer = bytes[4];
  const headSize = (bytes[5] << 8) | bytes[6];
  const dataSize = ((bytes[7] << 24) >>> 0) + (bytes[8] << 16) + (bytes[9] << 8) + bytes[10];
  const need = HEAD_SIZE + headSize + dataSize;
  if (bytes.length < need) throw new RangeError(`帧不完整: 需要 ${need}，只有 ${bytes.length}`);

  const headBytes = bytes.slice(HEAD_SIZE, HEAD_SIZE + headSize);
  const payload = bytes.slice(HEAD_SIZE + headSize, need);
  const head = decodeFields(headBytes);

  return {
    protocolVer,
    headSize,
    dataSize,
    totalSize: need,
    channelId: head[1],
    commandFlag: head[2],
    checkSum: head[3],
    vCode: head[4],
    payload,
    fields: decodeFields(payload),
  };
}

/** 从字节流里切出完整帧（用于 USB/stream 分段读取）。 */
export function splitFrames(buffer) {
  const out = [];
  let pos = 0;
  while (buffer.length - pos >= HEAD_SIZE) {
    const headSize = (buffer[pos + 5] << 8) | buffer[pos + 6];
    const dataSize =
      ((buffer[pos + 7] << 24) >>> 0) + (buffer[pos + 8] << 16) + (buffer[pos + 9] << 8) + buffer[pos + 10];
    const need = HEAD_SIZE + headSize + dataSize;
    if (buffer.length - pos < need) break;
    out.push(buffer.slice(pos, pos + need));
    pos += need;
  }
  return { frames: out, rest: buffer.slice(pos) };
}

// ------------------------------------------------------------ 握手包

/**
 * ChannelHandShake（108 字节）。服务端先发，客户端回同一结构：
 *   banner[12] ("OHOS HDC" + NUL)，union{channelId u32 BE | connectKey[32]}，version[64]
 * banner[10]='K' 是 kill-server 能力位，banner[11]='H' 是 huge-buffer 能力位。
 */
export function encodeHandshake108({ channelId = 0, connectKey = '', version = '', hugeBuffer = false, killServer = false }) {
  const out = new Uint8Array(HANDSHAKE_SIZE);
  const name = utf8.encode(BANNER);
  out.set(name.slice(0, 11), 0);
  out[10] = killServer ? 0x4b : 0x00;
  out[11] = hugeBuffer ? 0x48 : 0x00;
  if (connectKey) {
    const key = utf8.encode(connectKey).slice(0, 32);
    out.set(key, 12);
  } else {
    new DataView(out.buffer).setUint32(12, channelId >>> 0, false); // 大端
  }
  const v = utf8.encode(version).slice(0, 64);
  out.set(v, 44);
  return out;
}

export function decodeHandshake108(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < HANDSHAKE_SIZE) throw new RangeError(`握手包太短: ${bytes.length}`);
  const bannerEnd = bytes.indexOf(0, 0);
  const banner = utf8d.decode(bytes.slice(0, bannerEnd === -1 ? 12 : Math.min(bannerEnd, 12)));
  const channelId = new DataView(bytes.buffer, bytes.byteOffset + 12, 4).getUint32(0, false);
  const keyEnd = bytes.indexOf(0, 12);
  const connectKey = keyEnd > 12 ? utf8d.decode(bytes.slice(12, Math.min(keyEnd, 44))) : '';
  const verEnd = bytes.indexOf(0, 44);
  const version = verEnd > 44 ? utf8d.decode(bytes.slice(44, verEnd)) : '';
  return {
    banner,
    killServer: bytes[10] === 0x4b,
    hugeBuffer: bytes[11] === 0x48,
    channelId,
    connectKey,
    version,
  };
}

/** 44 字节变体（不带 version 段）；部分实现只校验 banner 与 connectKey 长度。 */
export function encodeHandshake44({ connectKey = '' }) {
  const out = new Uint8Array(44);
  out.set(utf8.encode(BANNER).slice(0, 11), 0);
  out.set(utf8.encode(connectKey).slice(0, 32), 12);
  return out;
}