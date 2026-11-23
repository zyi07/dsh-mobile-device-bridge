/**
 * Android 侧文件传输与应用管理
 *
 * 依据 `@yume-chan/adb@2.6.4` 的真实类型定义实现：
 *   const sync = await adb.sync();                 // AdbSync
 *   await sync.write({ filename, file: ReadableStream<Uint8Array> });  // 推文件
 *   const stream = sync.read(filename);            // 拉文件，返回 ReadableStream
 *   await sync.dispose();                          // 必须释放，否则 socket 泄漏
 *
 * ADB sync 是二进制流式协议，速度远高于鸿蒙那边的 shell+base64，
 * 但仍保留 sha256 校验（写失败不报错是 shell 系的通病）。
 */

function bytesToReadableStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readableStreamToBytes(stream) {
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) { break; }
    if (value) { parts.push(value); total += value.length; }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** 用 shell 执行并返回 { stdout, stderr, exitCode } */
async function runShell(adb, cmd) {
  const sp = adb.subprocess.shellProtocol;
  if (sp) {
    const r = await sp.spawnWaitText(cmd);
    return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode };
  }
  const text = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
  return { stdout: text || '', stderr: '', exitCode: 0 };
}

function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/** 推文件到设备 */
export async function pushFileAdb(adb, remotePath, bytes, opts = {}) {
  const { log } = opts;
  const dir = String(remotePath).replace(/\/[^/]*$/, '');
  const sync = await adb.sync();
  try {
    if (dir) {
      // 目录不存在时 sync.write 会失败，先建目录
      await adb.subprocess.noneProtocol.spawnWaitText(`mkdir -p ${shellQuote(dir)}`);
    }
    await sync.write({ filename: remotePath, file: bytesToReadableStream(bytes) });
    if (log) { log(`已写入 ${bytes.length} 字节 → ${remotePath}`); }
  } finally {
    try { await sync.dispose(); } catch { /* ignore */ }
  }
  return { bytes: bytes.length };
}

/** 从设备读文件 */
export async function pullFileAdb(adb, remotePath, opts = {}) {
  const { log } = opts;
  const sync = await adb.sync();
  try {
    const stream = sync.read(remotePath);
    const bytes = await readableStreamToBytes(stream);
    if (log) { log(`已读取 ${bytes.length} 字节 ← ${remotePath}`); }
    return { bytes };
  } finally {
    try { await sync.dispose(); } catch { /* ignore */ }
  }
}

/** 远端文件 sha256（用于校验） */
export async function sha256Adb(adb, remotePath) {
  const r = await runShell(adb, `sha256sum ${shellQuote(remotePath)}`);
  const m = String(r.stdout || '').match(/\b([0-9a-f]{64})\b/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 安装 APK：推到 /data/local/tmp 后 `pm install`。
 *
 * 用户已在设备上关闭华为安装验证后，pm install 直接返回 Success，不弹窗/不要密码。
 * 用 spawn（不等待）+ 收集输出流，避免前台 await 阻塞；超时则 kill 并提示人工确认。
 */
export async function installApkAdb(adb, { bytes, filename, replace = false }, opts = {}) {
  const { log } = opts;
  const safe = String(filename || 'app.apk').replace(/[^\w.\-]/g, '_');
  const remote = `/data/local/tmp/${Date.now()}_${safe}`;
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  if (log) { log(`推送 APK（${bytes.length} 字节）→ ${remote}`); }
  await pushFileAdb(adb, remote, bytes, opts);

  const argv = ['pm', 'install'];
  if (replace) { argv.push('-r'); }
  argv.push(remote);
  if (log) { log(`执行 ${argv.join(' ')}`); }

  const proc = await adb.subprocess.noneProtocol.spawn(argv);

  let output = '';
  const decoder = new TextDecoder();
  const pump = (async () => {
    const reader = proc.output.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        if (value) { output += decoder.decode(value, { stream: true }); }
      }
    } catch { /* ignore */ }
  })();

  let exited = false;
  proc.exited.then(() => { exited = true; }).catch(() => { exited = true; });
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && !exited) { await sleepMs(400); }

  let timedOut = false;
  if (!exited) { timedOut = true; try { await proc.kill(); } catch { /* ignore */ } }
  await Promise.race([pump, sleepMs(3000)]);
  adb.subprocess.noneProtocol.spawnWaitText(`rm -f ${shellQuote(remote)}`).catch(() => {});

  const out = output.trim();
  const errMap = {
    INSTALL_FAILED_ALREADY_EXISTS: '已存在同包名应用，请用「覆盖安装」',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: '已安装版本签名不同，需先卸载',
    INSTALL_FAILED_VERSION_DOWNGRADE: '版本号低于已安装版本，不能降级安装',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: '设备空间不足',
    INSTALL_PARSE_FAILED_NOT_APK: '不是有效的 APK',
    INSTALL_FAILED_INVALID_APK: '安装包无效或被系统策略禁止更新',
    INSTALL_FAILED_USER_RESTRICTED: '设备策略禁止安装（可能开了纯净模式或安装验证）',
    INSTALL_FAILED_VERIFICATION_FAILURE: '系统安装校验失败',
  };
  for (const [code, hint] of Object.entries(errMap)) {
    if (out.includes(code)) { throw new Error(`安装失败 ${code} —— ${hint}。设备原文：${out.slice(0, 200)}`); }
  }
  if (timedOut) {
    throw new Error('安装超时：设备可能弹出了「安装确认 / 密码」框，请在手机上完成后重试（可在系统设置里关闭安装验证）');
  }
  if (!/Success/i.test(out)) {
    throw new Error(`安装未成功：${out.slice(0, 200) || '(无输出)'}`);
  }
  return { output: out, remote };
}

/** 卸载应用 */
export async function uninstallPackageAdb(adb, pkg) {
  const r = await runShell(adb, `pm uninstall ${shellQuote(pkg)}`);
  const out = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
  if (!/Success/i.test(out)) {
    throw new Error(`卸载失败：${out.slice(0, 200) || '(无输出)'}`);
  }
  return out;
}
