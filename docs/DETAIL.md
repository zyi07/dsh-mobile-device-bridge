# 移动设备

在 **设置 → 移动设备** 里通过 WebUSB 直接连上插在这台电脑上的安卓手机，用 ADB 协议执行命令、截图。不需要安装 Android SDK，也不需要跑 adb server。

## 用法

1. 手机上开启「开发者选项」和「USB 调试」，用数据线连到电脑。
2. 打开设置页的「移动设备」一栏，点「连接设备」，在浏览器的设备选择框里选中手机。
3. 首次连接时手机会弹出授权提示，勾选「一律允许」并确定。
4. 连上后可以填写任意 ADB shell 命令执行，或点「截图」。

## 前提与限制

- 只有 Chromium 内核浏览器支持 WebUSB（Chrome、Edge、Opera）。Firefox 和 Safari 无法使用。
- 页面必须是 HTTPS 或 localhost。DSH 本机默认的 `http://127.0.0.1:3080` 满足要求。
- 同一时刻只能有一个程序占用该 USB 接口：请先关掉本机的 adb server、Android Studio、scrcpy 等。
- 命令以混合输出返回；设备支持 shell 协议时额外显示退出码。
- 截图走 `screencap -p`，个别机型可能因图像格式差异需要重试。
- 当前只支持 Android（ADB）。HarmonyOS 设备的 HDC 协议尚未实现。
- 设备管理发生在浏览器里，所以没有可供智能体调用的服务端工具；本插件不注册任何工具。
