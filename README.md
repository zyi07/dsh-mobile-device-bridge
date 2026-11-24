# dsh-mobile-device-bridge

DSH 插件：在「设置 → 移动设备」里通过 **WebUSB** 或**本机 adb/hdc 命令行**连接安卓 / 鸿蒙手机，
执行命令、截图、传文件、安装/卸载应用。

## 功能

- **安卓（ADB）**：WebUSB 直连，或本机 `adb` 命令行
- **鸿蒙（HDC）**：WebUSB 直连，或本机 `hdc` 命令行
- **双通道**：浏览器 WebUSB（Chrome/Edge 访问 DSH web）；本机 CLI（**DSH 桌面端首选**，绕开 WebUSB 权限与 WinUSB 驱动问题）
- **多设备**：安卓 + 鸿蒙可同时连接、切换操作
- **常用能力**：执行 shell、截图、推/拉文件、`pm/bm install`、卸载
- **鸿蒙 ID 自签（重点）**：华为账号扫码登录 → 向 AGC 自动申请调试证书/Profile（绑定本机 UDID）→ 本地 `hap-sign-tool` 签名 → 装到手机。包名从 HAP 的 `module.json` **自动读取**，无需手填
- **给 agent 用**：注册了原生工具 `mobile_bridge_devices / exec / screenshot / install / sign_install`，其他会话可直接调用（`sign_install` 会自己签名再装）

## 通道与接口

| 通道 | 端点 | 适用 |
|---|---|---|
| WebUSB | `/mbridge/exec · screenshot · push · pull · install · uninstall · activate` | 浏览器访问 DSH web（`navigator.usb` 可用） |
| 本地USB | `/mbridge/cli/status · exec · screenshot · push · pull · install · uninstall · activate` | DSH 桌面端 / 装了 adb·hdc 的机器 |
| 华为账号（ID自签） | `/mbridge/agc/login/* · /mbridge/agc/hap-info · /mbridge/agc/sign · /mbridge/agc/install-signed` | 给未签名 HAP 自动签名并安装 |

CLI 通道会自动探测 `adb` / `hdc`：先查 PATH，再查常见安装位（Android Platform-Tools、DevEco Studio toolchains 等）。

## 使用

1. 设置 → 移动设备
2. 顶部选通道：**WebUSB** 或 **本地USB**（另有一个「华为账号（ID自签）」页签）
   - 浏览器：点「连接设备」，在弹窗里选手机（首次会请求 USB 权限）
   - 本机命令行：点「刷新本机设备」，选中 adb/hdc 识别到的设备
3. 下方输入命令 → 执行；或点截图；设备日志区可切换「完整日志（开发者）」

## 限制

- **WebUSB 通道**：Windows 上设备需绑定 WinUSB 驱动（安卓通常自带；鸿蒙常见需要 Zadig 换驱动）；浏览器标签页须在前台（后台被节流会断轮询）
- **本机 CLI 通道**：需要本机可执行 `adb` / `hdc`；WebUSB 选择器里鸿蒙固件自报名为 `HDC Device`（固件决定，无法改），连接后插件显示真实型号
- 华为设备首次 `pm install` 可能弹「风险提示→继续安装→输密码」，需在系统设置关闭安装验证或在手机上手动完成
- 两台**同为鸿蒙（HDC）** 的设备未做真机验证；安卓+鸿蒙跨系统已验证

## 给未签名 HAP 自动签名（华为账号 ID 自签）

1. 「华为账号（ID自签）」→ 点「登录」→ 用手机「控制中心 → 扫一扫」扫面板上的二维码
2. 选一个未签名的 `.hap`：插件自动读包名 → 申请调试证书/Profile → 签名
3. 签完点 **「安装到设备」** 装到当前手机

首次要申请证书/Profile（约 20~40 秒），之后同一把密钥复用同一张证书，几秒出包。
签名材料在 `~/.dsh/agc-sign`（本机保存，不上传）。

也可命令行：

```bash
python3 tools/agc_sign.py --hap 你的.hap --out signed.hap      # 包名自动读
python3 tools/agc_sign.py --hap 你的.hap --bundle com.x --json  # 想显式指定
```

## 常见问题

- **多开 DSH 标签页**时偶发「浏览器端尚未连接设备」：任务可能被没有设备会话的那个标签页抢答，**重试 2~3 次**即可（建议只留一个标签页）。
- **拔掉数据线**：面板会在数秒内自动变为「未连接」，设备信息/命令/日志一并隐藏。
- 华为账号登录态存在 `~/.dsh/agc-session.json`（权限 600），点「退出登录（清除本机凭证）」才会删除。

## 开发

```bash
npm run build   # 构建 client.js
npm test        # 离线测试（HDC 协议 / ADB 常量 / 多设备 / CLI 通道）
```
