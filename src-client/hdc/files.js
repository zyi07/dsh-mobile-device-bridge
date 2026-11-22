/**
 * 文件传输与 HAP 安装（HDC / HarmonyOS）
 *
 * 实现方式：走已验证可用的 shell 通道 + 设备自带的 `base64` / `sha256sum`。
 *
 * 全部参数都是**真机实测**得到的（Mate 70 Pro+ / API 26 / hdc daemon 3.2.0f）：
 *   · `echo -n '<b64>' | base64 -d > path`  写入，`>>` 追加     —— 可用
 *   · `base64 <path>` 读回，设备按 ~512B 分块推流              —— 可用（386KB 截图已验证）
 *   · `sha256sum <path>` 校验                                  —— 可用
 *   · **单条命令负载上限 ≈128KiB**：80KB 二进制（b64 109,228 字符）成功，
 *     96KB（b64 131,072）失败。故分块取 64KiB 二进制（b64 ~87KB）留足余量。
 *   · `bm install -p <hap>` / `bm uninstall` 设备侧可用
 *   · shell 身份 uid=2000(shell)，可写 `/data/local/tmp`；
 *     `/storage/media`、`/data/app` 等无权限
 *
 * 为什么不用 CMD_FILE_* 协议：那需要 INIT/BEGIN/DATA/FINISH 的完整字节序列，
 * 目前尚未用真机抓包确认（见 docs/HDC_FILE_INSTALL_RESEARCH.md 第二节）。
 * 这条 shell 路径已经实测可用，先交付能力，协议优化后续再做。
 */

/** 每次命令携带的二进制分块大小（base64 后约 87KB，低于 128KiB 上限） */
export const CHUNK_SIZE = 64 * 1024;

/** pull 时的最大回传字节数，防止误拉超大文件把内存打爆 */
export const PULL_MAX_BYTES = 64 * 1024 * 1024;

const B64_RE = /^[A-Za-z0-9+/=]+$/;

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
  return out;
}

/** 从命令输出里取出 sha256（跳过 `$ cmd` 回显行与错误行） */
export function parseSha256(text) {
  const m = String(text || '').match(/\b([0-9a-f]{64})\b/i);
  return m ? m[1].toLowerCase() : '';
}

/** 本地字节的 sha256（hex） */
export async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 校验远端文件内容与本地一致。
 * 这一步不能省：shell 命令的失败信息走 stderr，我们只收 stdout，
 * 所以"命令返回 ok"不等于"文件写成功"（实测往无权限目录写会静默失败）。
 */
export async function verifyRemote(session, remotePath, localBytes) {
  const [local, remoteRaw] = await Promise.all([
    sha256Bytes(localBytes),
    sha256Remote(session, remotePath),
  ]);
  if (!remoteRaw) {
    return { ok: false, local, remote: '', error: '远端文件不存在或不可读（写入很可能失败）' };
  }
  if (local !== remoteRaw) {
    return { ok: false, local, remote: remoteRaw, error: `校验不一致：本地 ${local.slice(0, 12)}… 远端 ${remoteRaw.slice(0, 12)}…` };
  }
  return { ok: true, local, remote: remoteRaw };
}

/** 把远端路径做 shell 转义（单引号包裹） */
export function shellQuote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

/**
 * 写入**单块**到指定偏移（幂等）。用于分片上传：每次 HTTP 请求只带一块，
 * 避免超大请求体，也便于断点重传。
 * @param chunkSize 块大小（必须与 offset 对齐方式一致）
 * @param index 块序号，offset = index * chunkSize
 */
export async function writeChunkAt(session, remotePath, chunkBytes, chunkSize, index, opts = {}) {
  const { log } = opts;
  const path = shellQuote(remotePath);
  const b64 = bytesToBase64(chunkBytes);
  const cmd = `echo -n '${b64}' | base64 -d | dd of=${path} bs=${chunkSize} seek=${index} conv=notrunc status=none`;
  if (cmd.length > 120 * 1024) {
    throw new Error(`内部错误：单块命令 ${cmd.length} 字符，超过实测上限 128KiB`);
  }
  // dd 写精确偏移，天然幂等；重试只会拖慢（等待设备关闭帧会被误判失败）
  await session.shell(cmd, { timeoutMs: 90000, attempts: 1 });
  if (log) { log(`写入第 ${index} 块（${chunkBytes.length} 字节 @ ${index * chunkSize}）`); }
  return { bytes: chunkBytes.length };
}

/**
 * 写入文件到设备。
 * @param session HdcSession
 * @param remotePath 远端绝对路径（需 shell 可写，实测 /data/local/tmp 可用）
 * @param bytes Uint8Array
 * @param opts { onProgress(done,total), log(msg) }
 */
export async function pushFile(session, remotePath, bytes, opts = {}) {
  const { onProgress, log } = opts;
  const total = bytes.length;
  const path = shellQuote(remotePath);

  // 先删旧文件，避免追加到上次残留内容后面
  await session.shell(`rm -f ${path}`, { timeoutMs: 15000, attempts: 1 });

  if (total === 0) {
    await session.shell(`: > ${path}`, { timeoutMs: 15000, attempts: 1 });
    const ls = await session.shell(`ls -l ${path}`, { timeoutMs: 15000, attempts: 1 });
    if (/No such file|Permission denied/i.test(String(ls.text || ''))) {
      throw new Error(`上传失败：${String(ls.text || '').trim().slice(0, 160)}`);
    }
    if (onProgress) { onProgress(0, 0); }
    return { bytes: 0, chunks: 0 };
  }

  let chunks = 0;
  for (let off = 0; off < total; off += CHUNK_SIZE) {
    const end = Math.min(off + CHUNK_SIZE, total);
    const slice = bytes.subarray(off, end);
    const b64 = bytesToBase64(slice);
    // 用 dd 写到**精确偏移**（bs=块大小, seek=块序号, conv=notrunc）：
    // 这样即使同一条命令因为重试被执行两次，也只是覆盖同一区域，不会数据翻倍。
    const idx = off / CHUNK_SIZE;
    const cmd = `echo -n '${b64}' | base64 -d | dd of=${path} bs=${CHUNK_SIZE} seek=${idx} conv=notrunc status=none`;
    // 安全阀：命令长度必须低于实测上限
    if (cmd.length > 120 * 1024) {
      throw new Error(`内部错误：单条命令 ${cmd.length} 字符，超过实测上限 128KiB`);
    }
    await session.shell(cmd, { timeoutMs: 90000, attempts: 1 });
    chunks += 1;
    if (onProgress) { onProgress(end, total); }
    if (log) { log(`上传 ${Math.round((end / total) * 100)}%（${end}/${total} 字节）`); }
  }
  // 强制校验：写不进去（无权限/空间不足）时命令可能"看起来成功"
  const check = await verifyRemote(session, remotePath, bytes);
  if (!check.ok) {
    throw new Error(`上传失败：${check.error}`);
  }
  if (log) { log(`校验通过 sha256=${check.local.slice(0, 16)}…`); }
  return { bytes: total, chunks, sha256: check.local };
}

/**
 * 从设备读取文件。
 * @returns { bytes, b64Length }
 */
export async function pullFile(session, remotePath, opts = {}) {
  const { onProgress, log } = opts;
  const path = shellQuote(remotePath);

  // 先确认文件存在与大小，避免大文件误拉
  const ls = await session.shell(`ls -l ${path}`, { timeoutMs: 15000, attempts: 1 });
  const lsText = String(ls.text || '');
  if (/No such file|Permission denied|not found/i.test(lsText)) {
    throw new Error(`远端文件不可读：${lsText.trim().slice(0, 160)}`);
  }
  const sizeMatch = lsText.match(/\s(\d+)\s+\d{4}-\d{2}-\d{2}/);
  if (sizeMatch) {
    const size = Number(sizeMatch[1]);
    if (size > PULL_MAX_BYTES) {
      throw new Error(`文件 ${size} 字节超过单次拉取上限 ${PULL_MAX_BYTES} 字节`);
    }
    if (log) { log(`远端文件 ${size} 字节，开始读取`); }
  }

  if (log) { log('读取中（设备按 ~512B 分块推流）'); }
  const r = await session.shell(`base64 ${path}`, { timeoutMs: 180000, attempts: 1 });
  const text = String(r.text || '').trim();

  // 输出可能被换行/回显污染：只保留 base64 字符
  const b64 = text.split('\n')
    .map((l) => l.trim())
    .filter((l) => l && B64_RE.test(l) && !l.startsWith('base64 '))
    .join('');

  if (!b64) {
    throw new Error(`读取为空：${text.slice(0, 160) || '(无输出)'}`);
  }
  if (b64.length > PULL_MAX_BYTES * 2) {
    throw new Error(`回传过大（${b64.length} 字符），已中止`);
  }
  const bytes = base64ToBytes(b64);
  if (onProgress) { onProgress(bytes.length, bytes.length); }
  if (log) { log(`读取完成 ${bytes.length} 字节`); }
  return { bytes, b64Length: b64.length };
}

/** 取远端文件 sha256（用于校验） */
export async function sha256Remote(session, remotePath) {
  const r = await session.shell(`sha256sum ${shellQuote(remotePath)}`, { timeoutMs: 30000, attempts: 2 });
  return parseSha256(r.text);
}

/**
 * 安装 HAP/HSP：先把包推到 /data/local/tmp，再执行 `bm install -p`。
 *
 * 注意：HAP 必须**已签名**，且调试签名的 Profile 必须包含本机 UDID，
 * 否则设备会返回 9568xxx 错误码。签名不由本插件生成，这里只负责传输与执行，
 * 并把设备返回的错误码翻成可读提示。
 */
export async function installHap(session, { bytes, filename, replace = false }, opts = {}) {
  const { onProgress, log } = opts;
  const safeName = String(filename || 'bundle.hap').replace(/[^\w.\-]/g, '_');
  const remote = `/data/local/tmp/${Date.now()}_${safeName}`;

  if (log) { log(`推送安装包到 ${remote}（${bytes.length} 字节）`); }
  await pushFile(session, remote, bytes, { onProgress, log });

  const shaLocalHint = '';
  const check = await verifyRemote(session, remote, bytes);
  if (!check.ok) {
    throw new Error(`安装包推送失败：${check.error}`);
  }
  if (log) { log(`安装包校验通过 sha256=${check.local.slice(0, 16)}…`); }
  if (log) { log('执行 bm install -p <包路径>'); }
  const args = replace ? `--replace` : '';
  const r = await session.shell(`bm install -p ${shellQuote(remote)} ${args}`.trim(),
    { timeoutMs: 240000, attempts: 1 });
  const out = String(r.text || '');

  // 清理临时包（保留在失败时便于排查？这里始终清理，避免占空间）
  session.shell(`rm -f ${shellQuote(remote)}`, { timeoutMs: 20000, attempts: 1 }).catch(() => {});

  const errMap = {
    '9568322': '签名不匹配：请确认 HAP 用调试证书签名，且调试 Profile 包含本机 UDID',
    '9568266': '需要 debug 签名的企业应用，或该包不是调试签名',
    '9568337': '安装包解析失败（文件损坏或不是合法 HAP）',
    '9568258': '已存在更高版本的同一应用',
    '9568305': '设备空间不足',
  };
  const codeMatch = out.match(/\b(9568\d{3})\b/);
  if (codeMatch) {
    const code = codeMatch[1];
    const hint = errMap[code] || '安装失败（未知错误码）';
    throw new Error(`安装失败 code:${code} —— ${hint}。设备原文：${out.trim().slice(0, 200)}`);
  }
  if (!/success/i.test(out) && out.trim()) {
    throw new Error(`安装未成功：${out.trim().slice(0, 200)}`);
  }
  return { output: out.trim(), remote };
}

/** 卸载 */
export async function uninstallBundle(session, bundleName) {
  const r = await session.shell(`bm uninstall -n ${shellQuote(bundleName)}`, { timeoutMs: 60000, attempts: 1 });
  return String(r.text || '').trim();
}