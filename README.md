# dsh-mobile-bridge

DSH 插件：在「设置 → 移动设备」里通过 **WebUSB** 或**本机 adb/hdc 命令行**连接安卓 / 鸿蒙手机，
执行命令、截图、传文件、安装/卸载应用。

## 功能

- **安卓（ADB）**：WebUSB 直连，或本机 `adb` 命令行
- **鸿蒙（HDC）**：WebUSB 直连，或本机 `hdc` 命令行
- **双通道**：浏览器 WebUSB（Chrome/Edge 访问 DSH web）；本机 CLI（**DSH 桌面端首选**，绕开 WebUSB 权限与 WinUSB 驱动问题）
- **多设备**：安卓 + 鸿蒙可同时连接、切换操作
- **常用能力**：执行 shell、截图、推/拉文件、`pm/bm install`、卸载
- **鸿蒙侧载**：华为账号扫码登录 → 自动申请调试证书/Profile → 签名 HAP → `bm install`

## 两条通道

| 通道 | 端点 | 适用 |
|---|---|---|
| WebUSB | `/mbridge/exec · screenshot · push · pull · install · uninstall · activate` | 浏览器访问 DSH web（`navigator.usb` 可用） |
| 本机 CLI | `/mbridge/cli/status · exec · screenshot · push · pull · install · uninstall · activate` | DSH 桌面端 / 装了 adb·hdc 的机器 |

CLI 通道会自动探测 `adb` / `hdc`：先查 PATH，再查常见安装位（Android Platform-Tools、DevEco Studio toolchains 等）。

## 使用

1. 设置 → 移动设备
2. 顶部选通道：**浏览器** 或 **本机命令行**
   - 浏览器：点「连接设备」，在弹窗里选手机（首次会请求 USB 权限）
   - 本机命令行：点「刷新本机设备」，选中 adb/hdc 识别到的设备
3. 下方输入命令 → 执行；或点截图；设备日志区可切换「完整日志（开发者）」

## 限制

- **WebUSB 通道**：Windows 上设备需绑定 WinUSB 驱动（安卓通常自带；鸿蒙常见需要 Zadig 换驱动）；浏览器标签页须在前台（后台被节流会断轮询）
- **本机 CLI 通道**：需要本机可执行 `adb` / `hdc`；WebUSB 选择器里鸿蒙固件自报名为 `HDC Device`（固件决定，无法改），连接后插件显示真实型号
- 华为设备首次 `pm install` 可能弹「风险提示→继续安装→输密码」，需在系统设置关闭安装验证或在手机上手动完成
- 两台**同为鸿蒙（HDC）** 的设备未做真机验证；安卓+鸿蒙跨系统已验证

## 开发

```bash
npm run build   # 构建 client.js
npm test        # 离线测试（HDC 协议 / ADB 常量 / 多设备 / CLI 通道）
```
