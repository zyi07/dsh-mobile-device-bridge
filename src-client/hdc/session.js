/**
 * HDC 会话层：握手（含 AUTH 六步）与命令通道
 *
 * 全部常量与结构来自**真机抓包逐字节核对**（2026-11-21，Mate 70 Pro+ /
 * OpenHarmony 7.0.0.111 / API 26 / hdc client+daemon `Ver: 3.2.0f73c487f8b34a2ba5`），
 * 原始帧见 ./fixtures.json。
 *
 * 与早期猜测的差异（已实证修正）：
 *   · 会话 id 由**主机**随机生成，同时写入 USBHead.sessionId 与握手 f3
 *   · 第一帧的 f5(buf) 不是空，而是一个 94 字节特征串
 *   · 公钥放在 **f5(buf)**，不在 connectKey(4)；格式为 PEM，前面接
 *     `<主机名>` + 一个 0x0C 分隔字节
 *   · token 是 **20 个 ASCII 字符**
 *   · 签名是 **512 字符 base64**（= 384 字节，RSA-3072 + SHA-512，PKCS#1 v1.5）
 */

import { encodeFrame, decodeFrame } from './codec.js';

/** 握手命令号：CMD_KERNEL_HANDSHAKE */
export const CMD_HANDSHAKE = 1;
/** 一次性命令：CMD_UNITY_EXECUTE（shell / param get 等） */
export const CMD_UNITY_EXECUTE = 1001;
/** 命令输出帧 */
export const CMD_OUTPUT = 10;
/** 通道关闭：CMD_KERNEL_CHANNEL_CLOSE */
export const CMD_CHANNEL_CLOSE = 2;
/** 心跳：CMD_HEARTBEAT_MSG */
export const CMD_HEARTBEAT = 5000;

export const AUTH_NONE = 0;
export const AUTH_TOKEN = 1;
export const AUTH_SIGNATURE = 2;
export const AUTH_PUBLICKEY = 3;
export const AUTH_OK = 4;
export const AUTH_FAIL = 5;

/** daemon 完整版本串（27 字节）；与本串不等会被断连 */
export const DAEMON_VERSION = 'Ver: 3.2.0f73c487f8b34a2ba5';

/** 第一帧 f5：94 字节特征串（真机原文，空格不能改） */
export const FEATURE_STRING =
  'authtype        1               1supportfeatures 29              Ver: 3.2.0f,USB,win,heartbeat';

/** daemon 索要公钥时回的 f5：33 字节 */
export const DAEMON_AUTH_ASK = 'authtype        1               1';

/** 签名算法：RSA-PSS + SHA-512，salt 长度 = 摘要长度 64。
 *  实证来源：真机抓包里 hdc 对 20 字节 token 的 384 字节签名，
 *  只有 PSS/SHA-512/salt=64 能验通（PKCS#1 v1.5 全部验不过）。 */
export const SIG_ALG = { name: 'RSA-PSS', saltLength: 64 };
export const SIG_IMPORT_ALG = { name: 'RSA-PSS', hash: 'SHA-512' };

/** 主机名与 PEM 之间的分隔字节（真机为 0x0C） */
export const HOSTNAME_SEP = 0x0c;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- 编解码

/** 握手帧：channelId 恒 0，commandFlag 恒 1 */
export function buildHandshakeFrame({ sessionId, authType, connectKey = '', buf = '', version = DAEMON_VERSION }) {
  const payload = encodeHandshakePayload({ authType, sessionId, connectKey, buf, version });
  return encodeFrame({ channelId: 0, commandFlag: CMD_HANDSHAKE, payload });
}

function fieldVarint(num, value) {
  const out = [];
  let v = value >>> 0;
  while (v >= 0x80) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v & 0x7f);
  return [num * 8, ...out];
}

function fieldBytes(num, bytes) {
  const out = [num * 8 + 2];
  let n = bytes.length;
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  out.push(n & 0x7f);
  return [...out, ...bytes];
}

/**
 * 握手负载。字段顺序以 session.h 的 struct SessionHandShake 为准：
 *   1=banner 2=authType 3=sessionId 4=connectKey 5=buf 6=version
 * `buf` 可以是字符串或 Uint8Array（公钥段含 0x0C 分隔字节，必须用 Uint8Array）。
 */
export function encodeHandshakePayload({ authType, sessionId = 0, connectKey = '', buf = '', version = DAEMON_VERSION, banner = 'OHOS HDC' }) {
  const toBytes = (v) => (v instanceof Uint8Array ? v : enc.encode(String(v)));
  return new Uint8Array([
    ...fieldBytes(1, enc.encode(banner)),
    ...fieldVarint(2, authType),
    ...fieldVarint(3, sessionId),
    ...fieldBytes(4, toBytes(connectKey)),
    ...fieldBytes(5, toBytes(buf)),
    ...fieldBytes(6, enc.encode(version)),
  ]);
}

export function parseHandshakeFrame(input) {
  const f = decodeFrame(input);
  const g = f.fields;
  return {
    commandFlag: f.commandFlag,
    channelId: f.channelId,
    authType: g[2] | 0,
    sessionId: g[3] | 0,
    connectKey: g[4] ? dec.decode(g[4]) : '',
    buf: g[5] instanceof Uint8Array ? g[5] : new Uint8Array(0),
    version: g[6] ? dec.decode(g[6]) : '',
  };
}

/**
 * 仅当这是握手帧（commandFlag=1）时才解析；心跳/输出/关闭等返回 null。
 * 传输层必须用它来过滤，否则心跳会被误当成 authType=0 的握手应答。
 */
export function tryParseHandshakeFrame(input) {
  const f = decodeFrame(input);
  if (f.commandFlag !== CMD_HANDSHAKE) { return null; }
  const g = f.fields || {};
  return {
    commandFlag: f.commandFlag,
    channelId: f.channelId,
    authType: g[2] | 0,
    sessionId: g[3] | 0,
    connectKey: g[4] ? dec.decode(g[4]) : '',
    buf: g[5] instanceof Uint8Array ? g[5] : new Uint8Array(0),
    version: g[6] ? dec.decode(g[6]) : '',
  };
}

// ---------------------------------------------------------------- 公钥 / 签名

/** 把 WebCrypto 的 SPKI 公钥导出成 hdc 需要的 PEM 文本 */
export function spkiToPem(spki) {
  const b64 = bytesToBase64(new Uint8Array(spki));
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) { lines.push(b64.slice(i, i + 64)); }
  return '-----BEGIN PUBLIC KEY-----\n' + lines.join('\n') + '\n-----END PUBLIC KEY-----\n';
}

/** 拼出 AUTH 阶段 f5：<主机名> + 0x0C + PEM */
export function buildPublicKeyBuf(hostname, pemText) {
  const h = enc.encode(hostname);
  const p = enc.encode(pemText);
  const out = new Uint8Array(h.length + 1 + p.length);
  out.set(h, 0);
  out[h.length] = HOSTNAME_SEP;
  out.set(p, h.length + 1);
  return out;
}

/** 拆分（用于测试与核对） */
export function splitPublicKeyBuf(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const idx = b.indexOf(HOSTNAME_SEP);
  if (idx < 0) { throw new Error('公钥 buf 缺少 0x0C 分隔字节'); }
  return { hostname: dec.decode(b.slice(0, idx)), pem: dec.decode(b.slice(idx + 1)) };
}

/** 生成 RSA-3072 密钥对（算法与 daemon 要求的 rsa_3072_sha512 一致） */
export async function generateKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: 'RSA-PSS',
      modulusLength: 3072,
      publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
      hash: 'SHA-512',
    },
    true,
    ['sign', 'verify'],
  );
}

/** 对 token 签名，返回 512 字符 base64（= 384 字节） */
export async function signToken(privateKey, token) {
  const tk = token instanceof Uint8Array ? token : enc.encode(String(token));
  const sig = await crypto.subtle.sign(SIG_ALG, privateKey, tk);
  return bytesToBase64(new Uint8Array(sig));
}

function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

// ---------------------------------------------------------------- 六步状态机

export const STATES = {
  IDLE: 'idle',
  AWAIT_PUBKEY_REQUEST: 'await-pubkey-request',
  AWAIT_TOKEN: 'await-token',
  AWAIT_AUTH_OK: 'await-auth-ok',
  AUTHORIZED: 'authorized',
  FAILED: 'failed',
};

/**
 * 握手状态机。只做"根据 daemon 的应答决定下一步"，不碰任何 I/O，
 * 便于离线用真机字节回放验证。
 *
 * 用法：
 *   const hs = new Handshake({ sessionId, serial, keyPair, hostname });
 *   const first = await hs.start();            // 第 1 帧
 *   // 收到 daemon 应答后：
 *   const next = await hs.accept(parsedReply); // 第 3 或第 5 帧；null 表示已结束
 */
export class Handshake {
  constructor({ sessionId, serial, hostname, keyPair, publicKeyPem, version = DAEMON_VERSION }) {
    if (!sessionId) { throw new Error('sessionId 必须由主机随机生成且非 0'); }
    this.sessionId = sessionId >>> 0;
    this.serial = serial;
    this.hostname = hostname;
    this.keyPair = keyPair || null;
    this.publicKeyPem = publicKeyPem || null;   // 复用已有密钥时直接给 PEM
    this.version = version;
    this.state = STATES.IDLE;
    this.token = null;
    this.pem = null;
    this.lastReply = null;
  }

  /** 第 1 帧：authType=NONE，connectKey=序列号，buf=特征串 */
  async start() {
    if (this.state !== STATES.IDLE) { throw new Error(`start() 状态不对: ${this.state}`); }
    if (this.publicKeyPem) { this.pem = this.publicKeyPem; }
    else if (this.keyPair) { this.pem = spkiToPem(await crypto.subtle.exportKey('spki', this.keyPair.publicKey)); }
    this.state = STATES.AWAIT_PUBKEY_REQUEST;
    return buildHandshakeFrame({
      sessionId: this.sessionId,
      authType: AUTH_NONE,
      connectKey: this.serial,
      buf: FEATURE_STRING,
      version: this.version,
    });
  }

  /**
   * 喂一个 daemon 应答；返回下一帧或 null。
   */
  async accept(reply) {
    this.lastReply = reply;
    const authType = reply.authType | 0;

    if (this.state === STATES.AWAIT_PUBKEY_REQUEST) {
      if (authType === AUTH_PUBLICKEY) {
        if (!this.pem) { throw new Error('daemon 索要公钥，但本机没有密钥对'); }
        this.state = STATES.AWAIT_TOKEN;
        return buildHandshakeFrame({
          sessionId: 0,
          authType: AUTH_PUBLICKEY,
          buf: buildPublicKeyBuf(this.hostname, this.pem),
          version: this.version,
        });
      }
      if (authType === AUTH_OK) { this.state = STATES.AUTHORIZED; return null; }   // 设备已授权过
      const bufText = reply.buf
        ? [...reply.buf].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')
        : '';
      if (authType === AUTH_FAIL) {
        this.state = STATES.FAILED;
        throw new Error(`daemon 拒绝了握手（AUTH_FAIL）${bufText ? '：' + bufText : ''}`);
      }
      throw new Error(`意外的 authType=${authType}（期望 3）${bufText ? ' buf=' + bufText.slice(0, 200) : ''}`);
    }

    if (this.state === STATES.AWAIT_TOKEN) {
      if (authType !== AUTH_SIGNATURE) {
        const t2 = reply.buf
          ? [...reply.buf].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('')
          : '';
        throw new Error(`意外的 authType=${authType}（期望 2）${t2 ? ' buf=' + t2.slice(0, 300) : ''}`);
      }
      const buf = reply.buf || new Uint8Array(0);
      if (buf.length !== 20) { throw new Error(`token 长度应为 20，实际 ${buf.length}`); }
      this.token = buf;
      this.state = STATES.AWAIT_AUTH_OK;
      const sig = await signToken(this.keyPair.privateKey, buf);
      return buildHandshakeFrame({
        sessionId: 0,
        authType: AUTH_SIGNATURE,
        buf: sig,
        version: this.version,
      });
    }

    if (this.state === STATES.AWAIT_AUTH_OK) {
      if (authType === AUTH_OK) {
        const text = dec.decode(reply.buf || new Uint8Array(0));
        if (!/SUCCESS/.test(text)) { throw new Error('AUTH_OK 但状态串不是 SUCCESS: ' + text); }
        this.state = STATES.AUTHORIZED;
        return null;
      }
      this.state = STATES.FAILED;
      throw new Error(`授权失败，authType=${authType}`);
    }

    throw new Error(`状态 ${this.state} 下不接受应答`);
  }
}

// ---------------------------------------------------------------- 命令通道

/** 命令帧：channelId 非 0 随机值，负载就是命令文本（**不带 \0**） */
export function buildCommandFrame({ channelId, text }) {
  if (!channelId) { throw new Error('命令帧 channelId 必须非 0'); }
  return encodeFrame({
    channelId: channelId >>> 0,
    commandFlag: CMD_UNITY_EXECUTE,
    payload: enc.encode(text),
  });
}

/** 关闭通道：(host 发 0x00，device 回 0x01) */
export function buildCloseFrame({ channelId, side = 'host' }) {
  return encodeFrame({
    channelId: channelId >>> 0,
    commandFlag: CMD_CHANNEL_CLOSE,
    payload: new Uint8Array([side === 'host' ? 0x00 : 0x01]),
  });
}

/** 心跳帧（双向，commandFlag=5000） */
export function buildHeartbeatFrame({ sessionId, count = 0 }) {
  return encodeFrame({
    channelId: 0,
    commandFlag: CMD_HEARTBEAT,
    payload: new Uint8Array([...fieldVarint(1, count), ...fieldBytes(2, [])]),
  });
}

/**
 * 解析命令应答。返回 { kind:'output'|'close'|'heartbeat'|'other', text? }
 */
export function parseCommandReply(input) {
  const f = decodeFrame(input);
  if (f.commandFlag === CMD_OUTPUT) {
    return { kind: 'output', text: dec.decode(f.payload) };
  }
  if (f.commandFlag === CMD_CHANNEL_CLOSE) {
    return { kind: 'close', side: f.payload[0] === 0x01 ? 'device' : 'host' };
  }
  if (f.commandFlag === CMD_HEARTBEAT) {
    return { kind: 'heartbeat' };
  }
  return { kind: 'other', commandFlag: f.commandFlag };
}
// ---------------------------------------------------------------- 复用已有 HDC 密钥

/** 从包含 PEM 的文本里取出指定类型的 base64 body */
function extractPemBlock(text, label) {
  const re = new RegExp('-----BEGIN ' + label + '-----([\\s\\S]*?)-----END ' + label + '-----');
  const m = String(text || '').match(re);
  return m ? m[1].replace(/[^A-Za-z0-9+/=]/g, '') : null;
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

function bytesToPem(bytes, label) {
  return spkiToPem(bytes).replace('PUBLIC KEY', label);
}

// ---- 极简 DER 解析：只够从 PKCS#8 的 RSAPrivateKey 里取出 n / e ----

function derReadTlv(buf, pos) {
  if (pos + 2 > buf.length) { throw new Error('DER 越界'); }
  const tag = buf[pos];
  let len = buf[pos + 1];
  let off = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) { len = (len << 8) | buf[off + i]; }
    off += n;
  }
  return { tag, start: off, end: off + len, next: off + len };
}

function derChildren(buf, tlv) {
  const out = [];
  let pos = tlv.start;
  while (pos < tlv.end) {
    const c = derReadTlv(buf, pos);
    out.push(c);
    pos = c.next;
  }
  return out;
}

function derEncode(tag, content) {
  const len = content.length;
  let header;
  if (len < 0x80) { header = [tag, len]; }
  else if (len < 0x100) { header = [tag, 0x81, len]; }
  else if (len < 0x10000) { header = [tag, 0x82, (len >> 8) & 0xff, len & 0xff]; }
  else { header = [tag, 0x83, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff]; }
  return new Uint8Array([...header, ...content]);
}

/** 从 PKCS#8 私钥 PEM 推导出 SPKI 公钥 PEM（WebCrypto 不支持直接从私钥导出公钥） */
export function derivePublicKeyPem(pkcs8Pem) {
  const b64 = extractPemBlock(pkcs8Pem, 'PRIVATE KEY');
  if (!b64) { throw new Error('没找到 -----BEGIN PRIVATE KEY----- 块'); }
  const der = b64ToBytes(b64);
  const root = derReadTlv(der, 0);                       // PrivateKeyInfo
  const top = derChildren(der, root);
  // PrivateKeyInfo ::= SEQUENCE { version, AlgorithmIdentifier, OCTET STRING(privateKey) }
  const octet = top.find((t) => t.tag === 0x04);
  if (!octet) { throw new Error('PKCS#8 结构异常：缺少 privateKey OCTET STRING'); }
  const inner = der.slice(octet.start, octet.end);
  const rsa = derReadTlv(inner, 0);                      // RSAPrivateKey
  const parts = derChildren(inner, rsa);
  // RSAPrivateKey ::= SEQUENCE { version, n, e, d, p, q, ... }
  if (parts.length < 3) { throw new Error('RSAPrivateKey 字段不足'); }
  const n = inner.slice(parts[1].start, parts[1].end);
  const e = inner.slice(parts[2].start, parts[2].end);
  const rsaPub = derEncode(0x30, [...derEncode(0x02, n), ...derEncode(0x02, e)]);   // RSAPublicKey
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86,
    0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);                                       // rsaEncryption
  const bitString = derEncode(0x03, [0x00, ...rsaPub]);
  const spki = derEncode(0x30, [...algId, ...bitString]);
  return spkiToPem(spki);
}

/**
 * 导入 hdc 自己的 PKCS#8 私钥（那把已被设备信任的密钥），
 * 返回 { privateKey, publicKeyPem }。公钥从私钥推导，或用文本里附带的 PUBLIC KEY 块。
 */
export async function importHdcKey(pemText) {
  const pkcs8 = extractPemBlock(pemText, 'PRIVATE KEY');
  if (!pkcs8) { throw new Error('未找到 PKCS#8 私钥（-----BEGIN PRIVATE KEY-----）'); }
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    b64ToBytes(pkcs8),
    SIG_IMPORT_ALG,
    false,
    ['sign'],
  );
  const pubBlock = extractPemBlock(pemText, 'PUBLIC KEY');
  const publicKeyPem = pubBlock
    ? bytesToPem(b64ToBytes(pubBlock), 'PUBLIC KEY')
    : derivePublicKeyPem(pemText);
  return { privateKey, publicKeyPem };
}
