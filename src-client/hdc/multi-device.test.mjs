/**
 * 多设备（同系统 HDC）协议层测试。
 *
 * 用两个独立的假 WebUSB 设备（各自独立回放状态、独立 claim），验证：
 *   1. 两台 HDC 会话能各自完成 AUTH（互不干扰）
 *   2. 各自执行命令返回正确
 *   3. 交替执行多轮无串扰
 *   4. 关闭其中一台，另一台仍正常（资源独立）
 *
 * 注意：这是协议层验证（HdcTransport/HdcSession 每设备独立）。
 * main.js 的 sessions[] 状态管理另见代码审查；真机双同系统设备仍需现场验证。
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createFakeHdcDevice } from './fake-device.mjs';
import { HdcTransport, HdcSession } from './transport.js';
import { generateKeyPair } from './session.js';

const F = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8'));
const EXPECT = 'shim_probe3\n';
const keyPair = await generateKeyPair();

function mk(serial) {
  const dev = createFakeHdcDevice({ fixtures: F });   // 每个设备独立回放状态
  const t = new HdcTransport(dev);
  const s = new HdcSession(t, { serial, hostname: 'h', version: F.version, keyPair, heartbeatMs: 0 });
  return { dev, t, s };
}

const A = mk('SERIAL-A');
const B = mk('SERIAL-B');

await A.s.connect();
await B.s.connect();
assert.equal(A.s.authorized, true, 'A 应完成 AUTH');
assert.equal(B.s.authorized, true, 'B 应完成 AUTH');
console.log('1. 两台独立设备各自完成 AUTH ✓');

const ra = await A.s.shell(F.cmd_out_text);
const rb = await B.s.shell(F.cmd_out_text);
assert.equal(ra.text, EXPECT, 'A 命令输出');
assert.equal(rb.text, EXPECT, 'B 命令输出');
console.log('2. 两台各自执行命令，输出正确 ✓');

for (let i = 0; i < 3; i++) {
  const x = await A.s.shell(F.cmd_out_text);
  const y = await B.s.shell(F.cmd_out_text);
  assert.equal(x.text, EXPECT, `第 ${i + 1} 轮 A`);
  assert.equal(y.text, EXPECT, `第 ${i + 1} 轮 B`);
}
console.log('3. 交替执行 3 轮无串扰 ✓');

await A.s.close();
assert.equal(A.dev.opened, false, 'A 关闭后 device 应关闭');
const rb2 = await B.s.shell(F.cmd_out_text);
assert.equal(rb2.text, EXPECT, 'A 关闭后 B 仍工作');
assert.equal(B.dev.opened, true, 'B 仍 open');
console.log('4. 关闭 A 后 B 仍正常（资源独立，claim 未串）✓');

await B.s.close();
assert.equal(B.dev.opened, false);
console.log('5. 两台全部关闭 ✓');
console.log('\n多设备（同系统 HDC）协议层：两台会话独立共存、互不干扰 ✓');
