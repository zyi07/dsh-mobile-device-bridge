/**
 * CLI 通道离线测试：用假的 adb/hdc 可执行脚本模拟真机输出，
 * 验证探测、列设备、exec、push/pull、install/uninstall 的封装与解析。
 *
 * 不依赖真机/真 adb，可在任意 Linux/macOS 上跑（Windows 上用 .cmd 同理）。
 */

import assert from 'node:assert';
import { writeFileSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectTools, listDevices, execShell, push, pull, install, uninstall } from './cli-channel.js';

const dir = mkdtempSync(path.join(tmpdir(), 'fakebin-'));
const fakeAdb = path.join(dir, 'adb');
const fakeHdc = path.join(dir, 'hdc');

writeFileSync(fakeAdb, `#!/bin/sh
if [ "$1" = "devices" ]; then
  echo "List of devices attached"
  printf "FAKEADB1\\tdevice product:x model:FAKE-ADB device:y transport_id:1\\n"
  printf "UNAUTH1\\tunauthorized\\n"
  exit 0
fi
if [ "$1" = "-s" ]; then
  shift 2
  case "$1" in
    shell) shift; echo "OUT:$*";;
    install) echo "Success";;
    uninstall) echo "Success";;
    push) echo "1 file pushed";;
    pull) printf "PULLED" > "$3";;
  esac
  exit 0
fi
exit 1
`);
writeFileSync(fakeHdc, `#!/bin/sh
if [ "$1" = "list" ]; then echo "FAKEHDC1"; exit 0; fi
if [ "$1" = "-t" ]; then
  shift 2
  case "$1" in
    shell) shift; echo "HDCOUT:$*";;
    install) echo "install bundle successfully.";;
    uninstall) echo "uninstall successfully.";;
    file) shift; case "$1" in recv) printf "HDCPULL" > "$3";; send) echo sent;; esac;;
  esac
  exit 0
fi
exit 1
`);
chmodSync(fakeAdb, 0o755);
chmodSync(fakeHdc, 0o755);

const tools = { adb: fakeAdb, hdc: fakeHdc };

// 1 列设备（adb 解析 + unauthorized 跳过 + hdc）
{
  const devs = await listDevices(tools);
  assert.ok(devs.find((d) => d.id === 'cli:adb:FAKEADB1' && d.kind === 'adb' && d.model === 'FAKE-ADB'), 'adb 设备');
  assert.ok(devs.find((d) => d.id === 'cli:hdc:FAKEHDC1' && d.kind === 'hdc'), 'hdc 设备');
  assert.ok(!devs.find((d) => d.serial === 'UNAUTH1'), 'unauthorized 应跳过');
  console.log('1. 列设备（adb/hdc，跳过 unauthorized） ✓');
}

// 2 adb exec
{
  const r = await execShell(tools, { kind: 'adb', serial: 'FAKEADB1' }, 'echo hi');
  assert.match(r.text, /OUT:echo hi/);
  console.log('2. adb exec ✓');
}

// 3 hdc exec
{
  const r = await execShell(tools, { kind: 'hdc', serial: 'FAKEHDC1' }, 'param get x');
  assert.match(r.text, /HDCOUT:param get x/);
  console.log('3. hdc exec ✓');
}

// 4 push / pull（adb）
{
  const p = await push(tools, { kind: 'adb', serial: 'FAKEADB1' }, Buffer.from('abc'), '/data/local/tmp/x');
  assert.equal(p.bytes, 3);
  const b = await pull(tools, { kind: 'adb', serial: 'FAKEADB1' }, '/data/local/tmp/x');
  assert.equal(b.toString(), 'PULLED');
  console.log('4. push / pull ✓');
}

// 5 pull（hdc）
{
  const b = await pull(tools, { kind: 'hdc', serial: 'FAKEHDC1' }, '/data/local/tmp/x');
  assert.equal(b.toString(), 'HDCPULL');
  console.log('5. hdc file recv ✓');
}

// 6 install / uninstall
{
  const o = await install(tools, { kind: 'adb', serial: 'FAKEADB1' }, Buffer.from('x'), 'a.apk', true);
  assert.match(o, /Success/);
  const u = await uninstall(tools, { kind: 'hdc', serial: 'FAKEHDC1' }, 'com.x');
  assert.match(u, /success/i);
  console.log('6. install / uninstall ✓');
}

// 7 错误路径：安装失败应抛出
{
  writeFileSync(fakeAdb, '#!/bin/sh\nif [ "$1" = "-s" ]; then exit 0; fi\nexit 1\n');
  await assert.rejects(
    () => install(tools, { kind: 'adb', serial: 'X' }, Buffer.from('x'), 'a.apk', false),
    /安装失败/,
  );
  console.log('7. 安装失败正确抛出 ✓');
}

// 8 detectTools（通过 PATH 找到）
{
  process.env.PATH = dir + path.delimiter + process.env.PATH;
  const dt = await detectTools();
  assert.equal(dt.adb, fakeAdb, 'detect adb');
  assert.equal(dt.hdc, fakeHdc, 'detect hdc');
  console.log('8. detectTools（PATH 探测） ✓');
}

rmSync(dir, { recursive: true, force: true });
console.log('\nCLI 通道全部通过 ✓');
