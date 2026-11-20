# dsh-mobile-bridge 开发日志

## 2026-11-20 16:17 — 按 DSH 规范重建，Host 行已激活

**背景：** 上一版 `dsh-plugin-mobile-bridge` 从未被 DSH 加载过：
`dsh --dump-config` 报 `patch: entry "mobile-bridge-server" not found`，
`list_bundles` 里该 bundle `rows: []`。

**根因（三条）：**
1. `cordis.patch.yml` 缺 `- insert:` 包裹，被当成"覆盖不存在的行"→ 整个跳过。
2. 依赖 `@deepseek-ai/dsh-tools@0.0.1-rc.1`（宿主为 0.2.2-rc.3），import 直接崩在
   `Cannot find package '@deepseek-ai/dsh-scope'`。DSH 插件不应自带 core 包。
3. 客户端产物是 Vite ESM 包，不是 DSH 的
   `window.__ModuleLoader__.load({ id, factory })` 格式；且无 `./client` 导出、
   无 locale/icon/detail。

**本次做法：**
- 新建 bundle `/root/dsh-mobile-bridge`，按 `dsh-doc` 的 decoration 模板组织。
- `cordis.patch.yml` 改为 `- insert: [{ id: mobile-bridge, name: dsh-mobile-bridge }]`。
- Host 半 `index.js` 只留空 `apply()`；删除全部假工具（旧版 `mobile_shell` 等只返回"请用 UI"）。
- 客户端源码 `src-client/main.js`（纯 JS，无 JSX）→ rollup 打包 cjs，
  包进 `__ModuleLoader__` 外壳生成 `client.js`（191 KB，Tango 内联）。
- Tango 升级到 2.x 并对齐：adb 2.6.4 / adb-daemon-webusb 2.3.2 / adb-credential-web 2.1.0
  （旧版是 adb 0.0.24 + credential 2.1.0 的错配）。
- 运行时依赖清零，Tango 全部移入 devDependencies（client.js 已预构建）。
- 补 `locale/en.json`、`locale/zh.json`、`icon.svg`、`docs/DETAIL.md`。
- 撤销 P5 残留：`remove_bundle` 移除旧包，并删除我手工写进
  `~/.dsh/profiles/web/cordis.patch.yml` 的坏行（已备份 `.bak-before-cleanup-*`）。
- 用 `plugin_manager install_bundle` 正规安装。

**已验证：**
- `dump-config` 无 patch 警告，组合中出现行 `- id: mobile-bridge / name: dsh-mobile-bridge`。
- `list_bundles`: `rows: [{rowId: mobile-bridge}]`，`overrides: []`。
- `list_plugins`: `include:mobile-bridge` `enabled: true` `fiberPhase: active`。
- 离线执行 `client.js`（stub 宿主）：exports=apply,inject；注册到 `settings.section`，id/order/label/props 正确。

**未验证：**
- 浏览器内真实渲染（需要刷新页面后用真机确认）。
- WebUSB 连接真机流程、截图字节流。
- curl 取 `/plugins/...` 返回 401，CLI 无法验证客户端资源下发。

**已知限制：** 仅 Android/ADB；HarmonyOS 的 HDC 未实现；无服务端工具（USB 只能在浏览器侧）。

## 2026-11-20 16:26 — 翻译 WebUSB 占用类报错

用户实测已能看到「移动设备」栏，点连接后报
`The device is already in used by another program`。
核对来源：Tango `error.js` 的 `DeviceBusyError`，抛于 `claimInterface`（device.js:196），
即浏览器已枚举并打开设备，仅接口被本机其他程序占用。

改动：新增 `friendly()` 把三类英文异常映射为中文可执行步骤
（busy / 驱动不匹配 / 缺用户手势），未识别的原样透出便于排查。
离线验证：4 条样例映射正确，slot 注册仍为 1 条。
