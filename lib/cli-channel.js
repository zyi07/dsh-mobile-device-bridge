/**
 * 本机命令行通道（CLI）：自动探测 adb / hdc，并封装成与 WebUSB 通道等价的操作。
 *
 * 适用：DSH 桌面端（Electron 有完整 Node）、或任何装了 adb/hdc 的机器。
 * 绕开浏览器的 WebUSB（不需要 select-usb-device 权限、不需要 WinUSB 驱动替换）。
 *
 * 设备 id 形如：`cli:adb:<serial>` / `cli:hdc:<connectKey>`。
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const isWin = process.platform === 'win32';

/** 某工具名的候选路径（PATH 之外的常见安装位） */
function candidatePaths(name) {
  const exe = isWin ? `${name}.exe` : name;
  const list = [];
  if (isWin) {
    const L = process.env.LOCALAPPDATA || '';
    const PF = process.env.ProgramFiles || 'C:\\Program Files';
    const U = process.env.USERPROFILE || '';
    if (name === 'adb') {
      list.push(path.join(L, 'Android', 'Sdk', 'platform-tools', exe));
      list.push(path.join(U, 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', exe));
      list.push(path.join(PF, 'Android', 'platform-tools', exe));
    }
    if (name === 'hdc') {
      list.push(path.join(L, 'Huawei', 'DevEco Studio', 'sdk', 'default', 'openharmony', 'toolchains', exe));
      list.push(path.join(PF, 'Huawei', 'DevEco Studio', 'sdk', 'default', 'openharmony', 'toolchains', exe));
      list.push(path.join(U, 'AppData', 'Local', 'Huawei', 'Sdk', 'default', 'openharmony', 'toolchains', exe));
      list.push(path.join(U, 'AppData', 'Local', 'Huawei', 'Sdk', 'HarmonyOS-NEXT', 'toolchains', exe));
    }
  } else {
    list.push(`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/opt/homebrew/bin/${name}`);
    if (name === 'adb') { list.push(path.join(process.env.HOME || '', 'Android/Sdk/platform-tools/adb')); }
    if (name === 'hdc') {
      const H = process.env.HOME || '';
      list.push('/opt/harmony26/command-line-tools/sdk/default/openharmony/toolchains/hdc');
      list.push('/opt/harmony/command-line-tools/sdk/default/openharmony/toolchains/hdc');
      list.push(path.join(H, 'command-line-tools/sdk/default/openharmony/toolchains/hdc'));
      list.push(path.join(H, 'Huawei/Sdk/default/openharmony/toolchains/hdc'));
      list.push(path.join(H, 'Library/OpenHarmony/Sdk/toolchains/hdc'));
    }
  }
  return list;
}

/** 用 where/which 在 PATH 里找 */
function whichSync(name) {
  return new Promise((resolve) => {
    const cmd = isWin ? 'where' : 'which';
    let p;
    try { p = spawn(cmd, [name], { windowsHide: true }); } catch { resolve(null); return; }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(null));
    p.on('close', (code) => {
      const first = out.trim().split(/\r?\n/)[0].trim();
      resolve(code === 0 && first ? first : null);
    });
  });
}

/** 探测 adb / hdc 的绝对路径；找不到为 null */
export async function detectTools() {
  const result = { adb: null, hdc: null };
  const envHint = {
    adb: process.env.ADB_PATH ? String(process.env.ADB_PATH) : null,
    hdc: process.env.HDC_PATH ? String(process.env.HDC_PATH) : null,
  };
  for (const name of ['adb', 'hdc']) {
    let found = null;
    const hint = envHint[name];
    if (hint && existsSync(hint)) { found = hint; }
    if (!found) { found = await whichSync(name); }
    if (!found) {
      for (const cand of candidatePaths(name)) {
        if (cand && existsSync(cand)) { found = cand; break; }
      }
    }
    result[name] = found;
  }
  return result;
}

/** hdc 在部分 Linux 环境缺 libatomic，补一个库搜索路径 */
function spawnEnv(bin) {
  if (process.platform !== 'linux') { return undefined; }
  if (!/hdc$/i.test(String(bin))) { return undefined; }
  const env = { ...process.env };
  const lib = '/usr/x86_64-linux-gnu/lib';
  const cur = env.LD_LIBRARY_PATH || '';
  if (!cur.split(':').includes(lib)) { env.LD_LIBRARY_PATH = cur ? cur + ':' + lib : lib; }
  return env;
}

/** 跑一个命令，收集 stdout/stderr 文本 */
export function run(bin, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(bin, args, { windowsHide: true, env: spawnEnv(bin) }); } catch (e) { reject(e); return; }
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error(`命令超时(${timeoutMs}ms): ${bin} ${args.join(' ')}`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

/** 跑一个命令，收集二进制 stdout（截图用） */
export function runBytes(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(bin, args, { windowsHide: true, env: spawnEnv(bin) }); } catch (e) { reject(e); return; }
    const chunks = []; let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error(`命令超时: ${bin} ${args.join(' ')}`)); }, timeoutMs);
    p.stdout.on('data', (d) => { chunks.push(Buffer.from(d)); });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, bytes: Buffer.concat(chunks), stderr: err }); });
  });
}

function parseAdbDevices(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) { continue; }
    const serial = m[1];
    const state = m[2];
    const rest = m[3] || '';
    if (/^list/i.test(serial) || !state) { continue; }
    if (state !== 'device') { continue; }        // unauthorized/offline 跳过
    const model = (rest.match(/model:(\S+)/) || [])[1] || '';
    out.push({ id: `cli:adb:${serial}`, kind: 'adb', serial, model, state });
  }
  return out;
}

function parseHdcTargets(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) { continue; }
    if (/\[Empty\]/i.test(t) || /^list/i.test(t) || /^waiting/i.test(t)) { continue; }
    // hdc list targets 每行一个 connectKey（常见为序列号）
    out.push({ id: `cli:hdc:${t}`, kind: 'hdc', serial: t, model: '', state: 'device' });
  }
  return out;
}

/** 列出 CLI 通道可见的设备（adb + hdc） */
export async function listDevices(tools) {
  const out = [];
  if (tools && tools.adb) {
    try {
      const r = await run(tools.adb, ['devices', '-l'], { timeoutMs: 15000 });
      out.push(...parseAdbDevices(r.stdout));
    } catch { /* ignore */ }
  }
  if (tools && tools.hdc) {
    try {
      const r = await run(tools.hdc, ['list', 'targets'], { timeoutMs: 15000 });
      out.push(...parseHdcTargets(r.stdout));
    } catch { /* ignore */ }
  }
  return out;
}

function pickTools(tools, dev) {
  if (dev.kind === 'adb') {
    if (!tools.adb) { throw new Error('未找到 adb，可执行文件'); }
    return tools.adb;
  }
  if (!tools.hdc) { throw new Error('未找到 hdc，可执行文件'); }
  return tools.hdc;
}

/** 执行一条 shell 命令 */
export async function execShell(tools, dev, cmd, { timeoutMs = 30000 } = {}) {
  const bin = pickTools(tools, dev);
  const args = dev.kind === 'adb'
    ? ['-s', dev.serial, 'shell', cmd]
    : ['-t', dev.serial, 'shell', cmd];
  const r = await run(bin, args, { timeoutMs });
  const text = r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : '');
  return { text, code: r.code };
}

/** 截图，返回 { bytes, mime } */
export async function screenshot(tools, dev, { timeoutMs = 60000 } = {}) {
  const bin = pickTools(tools, dev);
  if (dev.kind === 'adb') {
    const r = await runBytes(bin, ['-s', dev.serial, 'exec-out', 'screencap', '-p'], { timeoutMs });
    if (!r.bytes || r.bytes.length < 8) { throw new Error('screencap 未返回数据: ' + r.stderr.slice(0, 120)); }
    return { bytes: r.bytes, mime: 'image/png' };
  }
  // hdc：设备上生成图片再 file recv 回来
  const remote = `/data/local/tmp/dsh_shot_${Date.now()}.jpeg`;
  await run(bin, ['-t', dev.serial, 'shell', `snapshot_display -f ${remote}`], { timeoutMs });
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cli-'));
  const local = path.join(dir, 'shot.jpeg');
  try {
    const r = await run(bin, ['-t', dev.serial, 'file', 'recv', remote, local], { timeoutMs });
    if (!existsSync(local)) { throw new Error('hdc file recv 未拿到截图: ' + r.stderr.slice(0, 120)); }
    const bytes = readFileSync(local);
    return { bytes, mime: 'image/jpeg' };
  } finally {
    try { unlinkSync(local); } catch { /* ignore */ }
    run(bin, ['-t', dev.serial, 'shell', `rm -f ${remote}`], { timeoutMs: 10000 }).catch(() => {});
  }
}

/** 推文件（dataBuf 为内容） */
export async function push(tools, dev, dataBuf, remotePath, { timeoutMs = 300000 } = {}) {
  const bin = pickTools(tools, dev);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cli-'));
  const local = path.join(dir, path.basename(remotePath) || 'f.bin');
  writeFileSync(local, dataBuf);
  try {
    const args = dev.kind === 'adb'
      ? ['-s', dev.serial, 'push', local, remotePath]
      : ['-t', dev.serial, 'file', 'send', local, remotePath];
    const r = await run(bin, args, { timeoutMs });
    if (r.code !== 0) { throw new Error(`${dev.kind} 推文件失败: ${(r.stderr || r.stdout).slice(0, 200)}`); }
  } finally {
    try { unlinkSync(local); } catch { /* ignore */ }
  }
  return { bytes: dataBuf.length };
}

/** 拉文件，返回 Buffer */
export async function pull(tools, dev, remotePath, { timeoutMs = 300000 } = {}) {
  const bin = pickTools(tools, dev);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cli-'));
  const local = path.join(dir, 'f.bin');
  try {
    const args = dev.kind === 'adb'
      ? ['-s', dev.serial, 'pull', remotePath, local]
      : ['-t', dev.serial, 'file', 'recv', remotePath, local];
    const r = await run(bin, args, { timeoutMs });
    if (!existsSync(local)) { throw new Error(`${dev.kind} 拉文件失败: ${(r.stderr || r.stdout).slice(0, 200)}`); }
    return readFileSync(local);
  } finally {
    try { unlinkSync(local); } catch { /* ignore */ }
  }
}

/** 安装应用（dataBuf 为包内容） */
export async function install(tools, dev, dataBuf, filename, replace = false, { timeoutMs = 300000 } = {}) {
  const bin = pickTools(tools, dev);
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-cli-'));
  const local = path.join(dir, filename || (dev.kind === 'adb' ? 'app.apk' : 'app.hap'));
  writeFileSync(local, dataBuf);
  try {
    const args = dev.kind === 'adb'
      ? ['-s', dev.serial, 'install', ...(replace ? ['-r'] : []), local]
      : ['-t', dev.serial, 'install', ...(replace ? ['-r'] : []), local];
    const r = await run(bin, args, { timeoutMs });
    const out = (r.stdout + r.stderr).trim();
    if (!/success/i.test(out)) { throw new Error(`安装失败: ${out.slice(0, 200)}`); }
    return out;
  } finally {
    try { unlinkSync(local); } catch { /* ignore */ }
  }
}

/** 卸载应用 */
export async function uninstall(tools, dev, pkg, { timeoutMs = 60000 } = {}) {
  const bin = pickTools(tools, dev);
  const args = dev.kind === 'adb'
    ? ['-s', dev.serial, 'uninstall', pkg]
    : ['-t', dev.serial, 'uninstall', pkg];
  const r = await run(bin, args, { timeoutMs });
  const out = (r.stdout + r.stderr).trim();
  if (!/success/i.test(out)) { throw new Error(`卸载失败: ${out.slice(0, 200)}`); }
  return out;
}
