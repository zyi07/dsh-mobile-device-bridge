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
 * 关键：华为/Android 会弹「风险提示 → 继续安装」确认框，`pm install` 会一直阻塞等它。
 * 如果在前台执行，会把 shell 通道和任务队列整个堵死。
 * 所以：**后台执行 pm install**，宿主侧轮询——有确认框就自动点掉，读日志判断结果。
 */
export async function installApkAdb(adb, { bytes, filename, replace = false }, opts = {}) {
  const { log } = opts;
  const safe = String(filename || 'app.apk').replace(/[^\w.\-]/g, '_');
  const remote = `/data/local/tmp/${Date.now()}_${safe}`;
  const logFile = '/data/local/tmp/dsh_install.log';

  if (log) { log(`推送 APK（${bytes.length} 字节）→ ${remote}`); }
  await pushFileAdb(adb, remote, bytes, opts);

  const flag = replace ? '-r' : '';
  // 后台安装（nohup），立即返回，绝不阻塞通道
  await runShell(adb, `rm -f ${logFile}; nohup pm install ${flag} ${remote} > ${logFile} 2>&1 & echo started`);
  if (log) { log('已发起安装（后台），等待系统安装界面…'); }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const deadline = Date.now() + 180000;
  let tapped = 0;
  let out = '';

  while (Date.now() < deadline) {
    await sleepMs(1500);
    // 一条短命令：有「继续安装」就点掉；顺带回读安装日志
    const probe = await runShell(adb,
      'uiautomator dump /data/local/tmp/dsh_ui.xml >/dev/null 2>&1; '
      + 'B=$(grep -o \'bounds="[^"]*"\' /data/local/tmp/dsh_ui.xml 2>/dev/null | head -1); '
      + 'if grep -q "继续安装" /data/local/tmp/dsh_ui.xml 2>/dev/null; then '
      + 'N=$(echo "$B" | tr -dc "0-9," | tr "," "\n"); '
      + 'X=$(echo "$N" | sed -n "1p;3p" | awk "{s+=\$1}END{print int(s/2)}"); '
      + 'Y=$(echo "$N" | sed -n "2p;4p" | awk "{s+=\$1}END{print int(s/2)}"); '
      + 'input tap ${X:-780} ${Y:-2207}; echo TAPPED; fi; '
      + `echo ---; cat ${logFile} 2>/dev/null`);
    const so = String(probe.stdout || '');
    if (/TAPPED/.test(so)) { tapped += 1; if (log) { log(`已自动点「继续安装」（第 ${tapped} 次）`); } }
    out = so.split('---').pop().trim();
    if (/Success/i.test(out) || /Failure/i.test(out)) { break; }
  }

  adb.subprocess.noneProtocol.spawnWaitText(`rm -f ${shellQuote(remote)}`).catch(() => {});

  const errMap = {
    INSTALL_FAILED_ALREADY_EXISTS: '已存在同包名应用，请用「覆盖安装」',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: '已安装版本签名不同，需先卸载',
    INSTALL_FAILED_VERSION_DOWNGRADE: '版本号低于已安装版本，不能降级安装',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: '设备空间不足',
    INSTALL_PARSE_FAILED_NOT_APK: '不是有效的 APK',
    INSTALL_FAILED_INVALID_APK: '安装包无效或被系统策略禁止更新',
    INSTALL_FAILED_USER_RESTRICTED: '设备策略禁止安装（可能开了纯净模式）',
    INSTALL_FAILED_VERIFICATION_FAILURE: '系统安装校验失败',
  };
  for (const [code, hint] of Object.entries(errMap)) {
    if (out.includes(code)) { throw new Error(`安装失败 ${code} —— ${hint}。设备原文：${out.slice(0, 200)}`); }
  }
  if (!/Success/i.test(out)) {
    throw new Error(`安装未成功（等待 ${tapped} 次确认）：${out.slice(0, 200) || '(无输出，可能超时)'}`);
  }
  return { output: out, remote, tapped };
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
