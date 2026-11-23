# Android / HarmonyOS 能力对比自查

> 依据：逐行核对 `src-client/main.js`、`src-client/hdc/*` 的实际实现（2026-11-23）。
> 结论：**两条通道不一致，HarmonyOS 侧能力明显更完整。**

## 一、总览

| 能力 | Android（ADB） | HarmonyOS（HDC） | 是否一致 |
|---|---|---|---|
| 连接设备 | ✅ `@yume-chan/adb` + WebUSB | ✅ 自研 HDC 协议 + WebUSB | ✅ |
| 命令执行 | ✅ | ✅ | ⚠️ 输出内容不同（见下） |
| 截图 | ✅ `screencap -p` → **PNG** | ✅ `snapshot_display`+base64 → **JPEG** | ✅（格式不同） |
| 设备信息 | ✅ 4 项 | ✅ 6 项 | ⚠️ HDC 更全 |
| 文件上传 push | ❌ **未实现** | ✅ 分片 + 断点续传 + sha256 | ❌ |
| 文件下载 pull | ❌ **未实现** | ✅ | ❌ |
| 应用安装 | ❌ **未实现** | ✅ `bm install` | ❌ |
| 应用卸载 | ❌ **未实现** | ✅ `bm uninstall` | ❌ |
| 华为账号 ID 签名 | ❌ 未实现 | ✅ 全自动 | ❌ |
| 断线自动重连 | ❌ 无 | ✅ `tryReconnectHdc` | ❌ |
| 命令失败重试 | ❌ 无（库默认） | ✅ 3 次 + 换通道 | ❌ |
| 连接诊断 | ✅ 通用 USB 诊断 | ✅ 更细（接口 class 分析） | ⚠️ |
| 运行日志 | ✅ 粗粒度（连接/命令） | ✅ 逐帧 TX/RX | ⚠️ HDC 更详细 |
| 后台保活 | ✅ | ✅ | ✅ |
| 多设备并存 | ❌ | ❌ | ✅（都不支持） |

## 二、逐项细节差异

### 1. 命令执行（差异：输出信息量）

**Android**（`runShellText`）：
```
$ <命令>
<stdout>
[stderr] <stderr>     ← 有
[exit N]              ← 有退出码
```

**HarmonyOS**（`execShell` → `hdc.shell`）：
```
$ <命令>
<纯文本输出>          ← 没有 stderr 分离，没有退出码
```

👉 **Android 侧能拿到退出码和 stderr，HDC 拿不到。**
HDC 协议本身只有数据帧，判断成败只能靠输出文本（这也是之前"写文件假成功"的根因，后来改用 sha256 校验才解决）。

### 2. 超时与重试

| | Android | HarmonyOS |
|---|---|---|
| 超时 | 库默认 | 20s 可配 |
| 重试 | 无 | 3 次，间隔递增，换 channelId |
| 空输出处理 | — | 专用逻辑（不再误判失败） |

👉 **HDC 侧更可控**；Android 完全依赖 `@yume-chan/adb` 的默认行为。

### 3. 设备信息字段

| 字段 | Android | HarmonyOS |
|---|---|---|
| 机型 model | ✅ `ro.product.model` | ✅ `const.product.model`（多候选回退） |
| 系统版本 | ✅ `ro.build.version.release`（Android 10） | ✅ `const.ohos.apiversion`（API 26） |
| 设备类型 devtype | ❌ | ✅ `phone` |
| 序列号 | ✅ | ✅ |
| USB VID/PID | ✅ | ✅ |

### 4. 截图

| | Android | HarmonyOS |
|---|---|---|
| 命令 | `screencap -p` | `snapshot_display -f` + `base64` 读回 |
| 格式 | PNG | JPEG |
| 速度 | 快（一次调用） | 慢（生成文件 + base64 回传 + 清理） |
| 尺寸处理 | 原图 | 原图 |

👉 都能用，**HDC 侧链路更长、更容易受大文件/断线影响**。

### 5. 文件与应用（最大缺口）

Android 侧调用会直接返回：

```
文件传输/安装目前只支持 HarmonyOS 通道（Android 侧待接入 Tango sync）
```

**这意味着 Android 通道现在只能：连接、跑命令、截图。**
不能传文件、不能装 APK、不能卸载。

> 备注：`@yume-chan/adb` 库本身有 `adb.sync()`（push/pull）和 `adb.subprocess`，
> 接入 Android 的 push/pull/APK 安装在技术上完全可行，只是**没做**。

### 6. 断线自愈

- **HarmonyOS**：USB 级错误 → `tryReconnectHdc()` 用 `getDevices()` 重连 → 重试原任务
- **Android**：无。USB 断了只能手动重连

### 7. 认证机制（都不需要用户干预，但原理不同）

| | Android | HarmonyOS |
|---|---|---|
| 机制 | ADB RSA 公钥（`@yume-chan` 的 credentialStore） | 自研六步握手，RSA-PSS 3072 |
| 密钥存储 | 浏览器（IndexedDB） | 浏览器 `localStorage` + 设备 `hdc_keys` |
| 首次授权 | 手机弹「允许 USB 调试」 | 手机弹「允许 / 始终信任」 |
| 之后 | 免确认 | 免确认 |

### 8. 华为账号（只对鸿蒙有意义）

「华为账号 ✓」这个 Tab 对 Android 通道**没有实际用途**——它只用于申请鸿蒙调试证书、签 HAP。Android 的 APK 签名体系完全不同（jarsigner/apksigner + keystore），目前**没实现**。

### 9. 一个 UI 小问题（已记录）

「本地安装（推荐：用电脑上的 hdc.exe）」区块**没有按平台隐藏**——Android 用户连上后也会看到它，下载的是鸿蒙 HAP，装了没用。应改为仅在鸿蒙通道显示。

## 三、差距清单（按优先级）

| # | 缺口 | 影响 | 技术难度 |
|---|---|---|---|
| 1 | Android push / pull | 传文件、传日志、拉截图原文件 | 低（`adb.sync()` 现成） |
| 2 | Android APK 安装 / 卸载 | 侧载 App | 低（`adb install` / `pm uninstall`） |
| 3 | Android 断线自愈 | 稳定性 | 低（照抄 HDC 的做法） |
| 4 | HDC 取退出码 / stderr | 判断命令成败更准 | 中（协议只回数据帧，需约定退出码上报） |
| 5 | 「本地安装」区块按平台隐藏 | UI 干净 | 极低 |
| 6 | 多设备并存 | 同时调试多台 | 中 |

## 四、结论

**不一致。HarmonyOS 是"完整调试通道"，Android 目前只是"命令 + 截图"通道。**

原因很直接：鸿蒙侧是这次从零实现的（含文件传输、签名、安装），
Android 侧沿用早期接入 `@yume-chan/adb` 的最小实现，之后没再补。

如果需要两边对齐，按第三节 1→2→3 补，Android 侧工作量不大（库都现成）。
