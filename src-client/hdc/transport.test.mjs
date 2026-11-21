/**
 * 端到端（离线）测试：HdcTransport + HdcSession 跑在假 WebUSB 设备上，
 * 设备侧回放的是 2026-11-21 抓到的真机字节。
 *
 * 覆盖：
 *   1. 打开设备 → 找到 HDC 接口（class 0xFF/0x50/0x01）
 *   2. 先发 RESET（USBHead option=2, len=0）
 *   3. **UB 头与帧分两次写**（真机实证要求；合并写会被 daemon 当 softreset 丢弃）
 *   4. AUTH 六步走完（daemon 回 3 → 2 → 4）
 *   5. 命令通道：flag=1001 发命令 → 收到 flag=10 输出 → flag=2 关闭
 *   6. 心跳被正确忽略（不污染握手/命令流程）
 *   7. 读侧重组：IN 被切成 7 字节小块仍能还原完整包
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createFakeHdcDevice } from './fake-device.mjs';
import { HdcTransport, HdcSession, OPT_RESET } from './transport.js';
import { generateKeyPair } from './session.js';
import * as S from './session.js';

const F = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------- 1. 接口发现

{
  const dev = createFakeHdcDevice({ fixtures: F });
  const t = new HdcTransport(dev);
  const iface = await t.open();
  assert.equal(iface.interfaceNumber, 0);
  assert.equal(iface.endpointIn, 0x81);
  assert.equal(iface.endpointOut, 0x01);
  await t.close();
  console.log('1. 接口发现：class 0xFF/0x50/0x01 → IN 0x81 / OUT 0x01 ✓');
}

// ---------------------------------------------------------------- 2~6. 全流程

{
  const dev = createFakeHdcDevice({ fixtures: F, chunkSize: 7 });
  const t = new HdcTransport(dev);
  const keyPair = await generateKeyPair();
  const s = new HdcSession(t, {
    serial: F.serial,
    hostname: 'DESKTOP-J8MMDK0',
    version: F.version,
    keyPair,
    heartbeatMs: 0,          // 测试里关掉主动心跳，避免干扰写入断言
    sessionId: F.sessionId,  // 注入真机的 session id，以便逐字节比对 step1
  });

  const authText = await s.connect();
  assert.equal(s.authorized, true, 'AUTH 应完成');
  assert.match(authText, /SUCCESS/, 'AUTH_OK 状态串应含 SUCCESS');

  // 第一笔写入必须是 11 字节 RESET 头
  assert.equal(dev._log.outTransfers[0], 11, '第一笔应是 11 字节的 RESET 头');
  assert.equal(dev._log.resets, 1, '应发过一次 RESET');

  // 关键：头与帧必须是两次独立写。第二笔=11（头），第三笔=180（step1 帧）
  assert.equal(dev._log.outTransfers[1], 11, 'UB 头必须单独一次写');
  assert.equal(dev._log.outTransfers[2], 180, 'step1 帧必须单独一次写');
  assert.ok(
    !dev._log.outTransfers.includes(11 + 180),
    '不允许把 UB 头与帧合并成一次 191 字节写',
  );

  // 设备收到的第一帧必须与真机 step1 逐字节相同（key 不参与该段）
  assert.equal(dev._log.framesIn[0], F.step1_host_to_dev, 'step1 应与真机一致');

  // 后续三段握手（公钥/签名）也应各是"头 11 + 帧"
  const after = dev._log.outTransfers.slice(3);
  for (let i = 0; i < after.length; i += 2) {
    assert.equal(after[i], 11, `第 ${i / 2 + 2} 次握手的头必须单独写`);
  }

  // 命令通道
  const r = await s.shell(F.cmd_out_text);
  assert.equal(r.text, 'shim_probe3\n', '命令输出应与真机一致');

  await s.close();
  console.log(`2. RESET 先行：第一笔 ${dev._log.outTransfers[0]}B option=2 ✓`);
  console.log(`3. 分两次写：头 11B + 帧分开，未出现 ${11 + 180}B 的合并写 ✓`);
  console.log(`4. AUTH 六步：${dev._log.framesIn.length} 帧入站，状态串含 SUCCESS ✓`);
  console.log(`5. 命令通道：flag=1001 → 输出 ${JSON.stringify(r.text)} → 关闭 ✓`);
  console.log(`6. 读侧重组：IN 每次只给 7 字节，共 ${dev._log.reads} 次读仍还原 ✓`);
}

// ---------------------------------------------------------------- 7. 心跳过滤

{
  const dev = createFakeHdcDevice({ fixtures: F });
  const t = new HdcTransport(dev);
  const keyPair = await generateKeyPair();
  const s = new HdcSession(t, {
    serial: F.serial, hostname: 'h', version: F.version, keyPair, heartbeatMs: 0,
  });
  await s.connect();
  // 假设备在 RESET 后会先塞一个心跳包；若过滤失效，握手会因 authType=0 而报错
  assert.equal(s.authorized, true, '心跳不应打断握手');
  await s.close();
  console.log('7. 心跳过滤：RESET 后的心跳包被跳过，未误判为握手应答 ✓');
}

// ---------------------------------------------------------------- 8. 错误路径

{
  const dev = createFakeHdcDevice({ fixtures: F });
  const t = new HdcTransport(dev);
  const s = new HdcSession(t, { serial: F.serial, hostname: 'h', version: F.version, heartbeatMs: 0 });
  // 未完成 AUTH 就发命令 → 必须明确拒绝，而不是静默
  await assert.rejects(() => s.shell('echo x'), /尚未完成 AUTH/);
  console.log('8. 错误路径：未授权就发命令会被明确拒绝 ✓');
}


// ---------------------------------------------------------------- 9. 读取侧重同步

{
  const dev = createFakeHdcDevice({ fixtures: F });
  const t = new HdcTransport(dev);
  // 注意：先去掉空白，否则 /../g 会把空格也配对，字节全部错位
  // 只保留十六进制字符，避免空格/换行导致字节错位
  const hx = (x) => new Uint8Array(x.replace(/[^0-9a-fA-F]/g, '').match(/../g).map((c) => parseInt(c, 16)));

  // 真机上 hdc server 被杀后，IN 端点会残留上次会话的半帧：
  // 实测首次读到的是以 "10 01" 开头的垃圾，严格解析会直接抛 "UB magic 不对"。
  const garbage = hx('10 01 18 00 20 09 08 00 12 00');
  const head = hx('554201' + '25EF0DC9' + '00000063');
  const frame = hx(F.step2_dev_to_host);

  const all = new Uint8Array([...garbage, ...head, ...frame]);
  t.rx = all;

  const pkt = t.takeFromBuffer();
  assert.ok(pkt, '应能从垃圾后重同步出完整包');
  assert.equal(Buffer.from(pkt.frame).toString('hex').toUpperCase(), F.step2_dev_to_host);
  assert.equal(t.resyncs, 1, '应记录 1 次重同步');
  assert.equal(t.dropped, garbage.length, '应丢弃垃圾字节数');

  // 再验一个更刁钻的：垃圾里带 0x55（伪 magic）
  const tricky = hx('00 55 13 55 42 01 25EF0DC9 00000063' + F.step2_dev_to_host);
  t.rx = tricky;
  const pkt2 = t.takeFromBuffer();
  assert.ok(pkt2, '伪 magic 之后仍应找到真 magic');
  assert.equal(Buffer.from(pkt2.frame).toString('hex').toUpperCase(), F.step2_dev_to_host);

  console.log(`9. 读取侧重同步：跳过 ${garbage.length}B 残包后正确还原，伪 magic 也不误判 ✓`);
}


// ---------------------------------------------------------------- 10. AUTH 后关闭通道 0

{
  // 真机抓包 T+250：主机在 AUTH_OK 之后第一件事是关闭通道 0（flag=2, payload 0x00）
  const capturedClose = '4857000001000800000001080010021800200900';
  const mine = [...S.buildCloseFrame({ channelId: 0, side: 'host' })]
    .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  assert.equal(mine, capturedClose, '关闭通道 0 的帧必须与真机一致');
  console.log('10. AUTH 后关闭通道 0：帧与真机逐字节一致（flag=2 / payload 0x00）✓');
}

console.log('RESULT: 传输层 + 会话层（离线回放真机字节）全部通过');
