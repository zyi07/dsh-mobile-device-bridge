/**
 * 用**真机抓到的帧**验证会话层实现。
 *
 * fixtures.json 里的六帧来自 2026-11-21 对真 hdc.exe 的 libusb 代理抓取
 * （Mate 70 Pro+ / OpenHarmony 7.0.0.111 / API 26）。
 *
 * 断言分三类：
 *   A. 逐字节复现真实帧（step1 / step3 / step5 / 命令帧 / 心跳帧）
 *   B. 正确解析 daemon 的三个应答（got pubkey request / token / auth ok）
 *   C. 状态机能沿真实应答走完全程，并用 WebCrypto 生成 384 字节签名
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as S from './session.js';
import { decodeFrame } from './codec.js';

const F = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const hex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const toHex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const dec = new TextDecoder();

// ---------------------------------------------------------------- A. 逐字节复现

// step1：会话 id / 序列号 / 特征串 / 版本 → 必须与真机帧完全一致
const step1 = S.buildHandshakeFrame({
  sessionId: F.sessionId,
  authType: S.AUTH_NONE,
  connectKey: F.serial,
  buf: S.FEATURE_STRING,
  version: F.version,
});
assert.equal(toHex(step1), F.step1_host_to_dev, 'step1 与真机帧不一致');
assert.equal(step1.length, 180);

// 会话 id 必须同时等于握手 f3 与 USBHead.sessionId（这是 R3 的教训）
const p1 = S.parseHandshakeFrame(hex(F.step1_host_to_dev));
assert.equal(p1.sessionId, F.sessionId);
assert.equal(p1.authType, S.AUTH_NONE);
assert.equal(p1.connectKey, F.serial);
assert.equal(dec.decode(p1.buf), S.FEATURE_STRING);
assert.equal(p1.version, F.version);

// step3：公钥段（主机名 + 0x0C + PEM）→ 必须逐字节一致
const realBuf = new Uint8Array(Buffer.from(F.publickey_buf_b64, 'base64'));
const parts = S.splitPublicKeyBuf(realBuf);
assert.equal(parts.hostname, 'DESKTOP-J8MMDK0');
assert.ok(parts.pem.startsWith('-----BEGIN PUBLIC KEY-----\n'), 'PEM 头不对');
assert.ok(parts.pem.endsWith('-----END PUBLIC KEY-----\n'), 'PEM 尾不对');
assert.equal(realBuf[parts.hostname.length], 0x0c, '分隔字节应为 0x0C');

const step3 = S.buildHandshakeFrame({
  sessionId: 0,
  authType: S.AUTH_PUBLICKEY,
  buf: S.buildPublicKeyBuf(parts.hostname, parts.pem),
  version: F.version,
});
assert.equal(toHex(step3), F.step3_host_to_dev, 'step3 与真机帧不一致');

// step5：签名段 → 必须逐字节一致
const p5real = S.parseHandshakeFrame(hex(F.step5_host_to_dev));
const sigB64 = dec.decode(p5real.buf);
assert.equal(sigB64.length, 512, '真机签名应为 512 字符 base64');
assert.equal(Buffer.from(sigB64, 'base64').length, 384, '签名应为 384 字节');
const step5 = S.buildHandshakeFrame({
  sessionId: 0,
  authType: S.AUTH_SIGNATURE,
  buf: sigB64,
  version: F.version,
});
assert.equal(toHex(step5), F.step5_host_to_dev, 'step5 与真机帧不一致');

// 命令帧：channelId 非 0，负载是纯命令文本（不带 \0）
const cmd = S.buildCommandFrame({ channelId: F.cmd_channel_id, text: F.cmd_out_text });
assert.equal(toHex(cmd), F.cmd_out_frame, '命令帧与真机不一致');
assert.equal(cmd.length, 40);

// 心跳帧
// 夹具里取的是最后一次心跳，计数为 10（负载 08 0A 12 00）
const hb = S.buildHeartbeatFrame({ sessionId: F.sessionId, count: 10 });
assert.equal(toHex(hb), F.heartbeat_out_frame, '心跳帧与真机不一致');

// ---------------------------------------------------------------- B. 解析 daemon 应答

const p2 = S.parseHandshakeFrame(hex(F.step2_dev_to_host));
assert.equal(p2.authType, S.AUTH_PUBLICKEY);
assert.equal(p2.sessionId, 0);
assert.equal(dec.decode(p2.buf), S.DAEMON_AUTH_ASK, 'daemon 索要公钥的 buf 应为 33 字节特征串');

const p4 = S.parseHandshakeFrame(hex(F.step4_dev_to_host));
assert.equal(p4.authType, S.AUTH_SIGNATURE);
assert.equal(p4.buf.length, 20, 'token 应为 20 字节');
const token = dec.decode(p4.buf);
assert.match(token, /^[\x20-\x7e]{20}$/, 'token 应为 20 个可打印 ASCII');

const p6 = S.parseHandshakeFrame(hex(F.step6_dev_to_host));
assert.equal(p6.authType, S.AUTH_OK);
assert.match(dec.decode(p6.buf), /SUCCESS/);

// 命令输出与关闭
const outReply = S.parseCommandReply(hex(F.cmd_reply_frame));
assert.equal(outReply.kind, 'output');
assert.equal(outReply.text, 'shim_probe3\n');

const closeReply = S.parseCommandReply(hex(F.close_device_frame));
assert.equal(closeReply.kind, 'close');
assert.equal(closeReply.side, 'device');

// ---------------------------------------------------------------- C. 状态机全程

const keyPair = await S.generateKeyPair();
const hs = new S.Handshake({
  sessionId: F.sessionId,
  serial: F.serial,
  hostname: parts.hostname,
  keyPair,
  version: F.version,
});
assert.equal(hs.state, S.STATES.IDLE);

// 第 1 帧必须与真机逐字节相同（key 不参与这一段）
assert.equal(toHex(await hs.start()), F.step1_host_to_dev);
assert.equal(hs.state, S.STATES.AWAIT_PUBKEY_REQUEST);

// 喂 daemon 的"要公钥"→ 应产出 authType=3 的公钥帧
const s3 = await hs.accept(p2);
assert.ok(s3, '应当产出公钥帧');
const parsed3 = S.parseHandshakeFrame(s3);
assert.equal(parsed3.authType, S.AUTH_PUBLICKEY);
const pk = S.splitPublicKeyBuf(parsed3.buf);
assert.equal(pk.hostname, parts.hostname);
assert.ok(pk.pem.startsWith('-----BEGIN PUBLIC KEY-----\n'), '我们生成的公钥应是 PEM');
assert.equal(hs.state, S.STATES.AWAIT_TOKEN);

// 喂 token → 应产出 authType=2 的签名帧，512 字符 base64 / 384 字节
const s5 = await hs.accept(p4);
assert.ok(s5, '应当产出签名帧');
const parsed5 = S.parseHandshakeFrame(s5);
assert.equal(parsed5.authType, S.AUTH_SIGNATURE);
assert.equal(dec.decode(parsed5.buf).length, 512, '签名的 base64 应为 512 字符');
assert.equal(Buffer.from(dec.decode(parsed5.buf), 'base64').length, 384, '签名应为 384 字节');
assert.equal(toHex(hs.token), F.step4_dev_to_host.slice(0, 0) + toHex(p4.buf), 'token 应被原样保存');
assert.equal(hs.state, S.STATES.AWAIT_AUTH_OK);

// 喂 AUTH_OK → 结束
assert.equal(await hs.accept(p6), null);
assert.equal(hs.state, S.STATES.AUTHORIZED);

// 状态机拒绝乱序应答
const bad = new S.Handshake({ sessionId: 1, serial: 'x', hostname: 'h', keyPair });
await bad.start();
await assert.rejects(() => bad.accept(p4), /意外的 authType/);

console.log('A. 逐字节复现：step1 / step3 / step5 / 命令帧 / 心跳帧 全部与真机一致');
console.log(`B. 应答解析：daemon 要公钥(33B) / token(${token.length}B) / AUTH_OK(含 SUCCESS) / 输出 / 关闭`);
console.log('C. 状态机：idle → 等公钥 → 等 token → 等 OK → 已授权，签名 384 字节验证通过');

// ---------------------------------------------------------------- D. 签名算法：必须是 RSA-PSS

{
  // 用真机抓包里的 token 与签名，验证我们主张的算法参数是正确的
  const p4 = S.parseHandshakeFrame(hex(F.step4_dev_to_host));
  const p5 = S.parseHandshakeFrame(hex(F.step5_host_to_dev));
  const token = p4.buf;
  const sig = new Uint8Array(Buffer.from(dec.decode(p5.buf), 'base64'));
  const pubBuf = new Uint8Array(Buffer.from(F.publickey_buf_b64, 'base64'));
  const { pem } = S.splitPublicKeyBuf(pubBuf);
  const spki = new Uint8Array(Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64'));

  const pssKey = await crypto.subtle.importKey('spki', spki, S.SIG_IMPORT_ALG, false, ['verify']);
  assert.equal(
    await crypto.subtle.verify(S.SIG_ALG, pssKey, sig, token),
    true,
    '真机签名必须能用 RSA-PSS/SHA-512/salt64 验证通过',
  );

  // 反向断言：PKCS#1 v1.5 必须验不过（防止有人又把算法改回去）
  const v15Key = await crypto.subtle.importKey(
    'spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-512' }, false, ['verify'],
  );
  assert.equal(
    await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, v15Key, sig, token),
    false,
    'PKCS#1 v1.5 不应验通（若通过说明夹具或算法判断有误）',
  );

  // 我们自己生成的签名也必须能被同一组参数验证
  const kp = await S.generateKeyPair();
  const mySig = await S.signToken(kp.privateKey, token);
  assert.equal(Buffer.from(mySig, 'base64').length, 384, '签名应为 384 字节');
  const mySpki = await crypto.subtle.exportKey('spki', kp.publicKey);
  const myKey = await crypto.subtle.importKey('spki', mySpki, S.SIG_IMPORT_ALG, false, ['verify']);
  assert.equal(
    await crypto.subtle.verify(S.SIG_ALG, myKey, new Uint8Array(Buffer.from(mySig, 'base64')), token),
    true,
    '自签自验应通过（RSA-PSS/SHA-512/salt64）',
  );

  console.log('D. 签名算法：真机签名 = RSA-PSS/SHA-512/salt64 ✓（v1.5 验不过，自签自验通过）');
}

console.log('RESULT: HDC 会话层 OK');