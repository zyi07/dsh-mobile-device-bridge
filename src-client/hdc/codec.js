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
/** USBHead.option 取值（define_enum.h: enum UsbProtocolOption） */
export const USB_OPTION_HEADER = 1;
export const USB_OPTION_RESET = 2;
/** HdcCommand（define_enum.h），实测/源码确认 */
export const CMD = {
  HELP: 0,
  HANDSHAKE: 1,
  CHANNEL_CLOSE: 2,
  TARGET_DISCOVER: 4,
  TARGET_LIST: 5,
  TARGET_ANY: 6,
  TARGET_CONNECT: 7,
  ECHO: 9,
  CHECK_SERVER: 13,
  CHECK_DEVICE: 14,
  UNITY_EXECUTE: 1001,
  UNITY_EXECUTE_EX: 1200,
  SHELL_INIT: 2000,
  SHELL_DATA: 2001,
  HEARTBEAT_MSG: 5000,
};
/** AuthType（session.h: enum AuthType） */
export const AUTH = {
  NONE: 0,
  TOKEN: 1,
  SIGNATURE: 2,
  PUBLICKEY: 3,
  OK: 4,
  FAIL: 5,
  SSL_TLS_PSK: 6,
};

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
 * 握手负载 protobuf。
 *
 * 字段顺序**以 session.h 的 struct SessionHandShake 为准**（这不是推测）：
 *   struct SessionHandShake { string banner; uint8_t authType; uint32_t sessionId;
 *                             string connectKey; string buf; string version; };
 * 因此：f1=banner  f2=authType  f3=sessionId  f4=connectKey  f5=buf  f6=version
 *
 * ⚠️ 早期版本把 f2/f3 写反（sessionId 放 f2），设备按 authType 解析随机数后
 * 判为 invalid auth type 并静默丢弃——这是"发了但设备无任何回应"的真因。
 */
export function encodeHandshakePayload({
  banner = BANNER,
  authType = 0,          // AuthType: AUTH_NONE=0, AUTH_TOKEN=1, AUTH_SIGNATURE=2, AUTH_PUBLICKEY=3, AUTH_OK=4
  sessionId = 0,
  connectKey = '',
  buf = '',
  version = '',
}) {
  return [
    ...fieldBytes(1, [...utf8.encode(banner)]),
    ...fieldVarint(2, authType),
    ...fieldVarint(3, sessionId),
    ...fieldBytes(4, [...utf8.encode(connectKey)]),
    ...fieldBytes(5, [...utf8.encode(buf)]),
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

  // ⚠️ 负载**不一定是 protobuf**：
  //   · 握手帧的负载是 protobuf（需要 fields）
  //   · 命令帧的负载是纯文本（无 framing）
  //   · 通道关闭帧的负载是 1 字节裸值 0x00/0x01
  // 所以这里做容错解析，解不出就置 null，由调用方按 commandFlag 决定怎么读。
  let payloadFields = null;
  try {
    payloadFields = decodeFields(payload);
  } catch {
    payloadFields = null;
  }

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
    fields: payloadFields,
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
// ------------------------------------------------------- USB 传输层包头

/**
 * USB 层包头（11 字节），实测存在于设备→主机的 bulk IN 流上：
 *   55 42 | 01 | sessionId(4) | payloadLength(4, BE)
 * 即每个 HDC 帧前面还有一层 "UB" 包头，长度字段等于紧随其后的帧字节数。
 *
 * 依据（真机 libusb 直读，3/3 会话一致）：
 *   55 42 01 09 EB AE F9 00 00 00 18  后紧跟正好 24 字节的 "HW" 帧。
 * sessionId 每会话变化、会话内恒定；payloadLength 与下一包长度精确相等。
 *
 * ⚠️ magic 语义未在源码中核实（"UB" 可能是 USB 的缩写），但长度字段的
 * 自洽性使"它是长度前缀"这一解释有强证据；字段命名待抓包/源码确认。
 */
export const USB_HEAD_SIZE = 11;
export const USB_MAGIC = [0x55, 0x42];

export function encodeUsbHead({ sessionId = 0, length, version = 0x01 }) {
  const out = new Uint8Array(USB_HEAD_SIZE);
  out[0] = USB_MAGIC[0];
  out[1] = USB_MAGIC[1];
  out[2] = version & 0xff;
  new DataView(out.buffer).setUint32(3, sessionId >>> 0, false);
  new DataView(out.buffer).setUint32(7, length >>> 0, false);
  return out;
}

export function decodeUsbHead(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < USB_HEAD_SIZE) throw new RangeError(`USB 包头太短: ${b.length}`);
  if (b[0] !== USB_MAGIC[0] || b[1] !== USB_MAGIC[1]) {
    throw new Error(`USB 包头 magic 不是 "UB": ${b[0].toString(16)} ${b[1].toString(16)}`);
  }
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    version: b[2],
    sessionId: view.getUint32(3, false),
    payloadLength: view.getUint32(7, false),
  };
}

/**
 * 把 USB 字节流切成 [UB 包头][帧] 对。用于 bulk 读取时判断"够不够一整个包"。
 * 返回 rest 为尚未到齐的尾巴。
 */
export function splitUsbPackets(buffer) {
  const b = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const packets = [];
  let pos = 0;
  while (b.length - pos >= USB_HEAD_SIZE) {
    const head = decodeUsbHead(b.slice(pos, pos + USB_HEAD_SIZE));
    const need = USB_HEAD_SIZE + head.payloadLength;
    if (b.length - pos < need) break;
    packets.push({
      head,
      frame: b.slice(pos + USB_HEAD_SIZE, pos + need),
    });
    pos += need;
  }
  return { packets, rest: b.slice(pos) };
}
