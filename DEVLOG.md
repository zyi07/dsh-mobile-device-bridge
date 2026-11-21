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

## 2026-11-20 16:33 — 修复「关掉设置页就断开」

**用户实测**：连接成功（TNY-AL00 / Android 10 / RPGGK20914000028 / USB 0x12d1:0x107e），
但关掉设置再打开就回到未连接，必须重新点。

**根因**：连接挂在组件 state + 卸载 `useEffect` 清理里 `adb.close()`，
设置页 section 卸载 = 主动断开。

**改动**：
- 连接状态移到模块作用域 `STATE`，组件卸载不再断开。
- 仅在 `window.pagehide`（离页/刷新）时关闭。
- 挂载时若 STATE 为空，用 `manager.getDevices()` + 已存 RSA 密钥做**静默重连**
  （不需要用户手势），覆盖刷新页面场景。
- 新增「复制输出」按钮（此前答应过）。
- 提示文案同步更新为「关设置/切页不重连，刷新才断开」。

**已验证（离线执行 client.js）**：
- slot 注册 1 条（settings.section / id mobile-bridge / order 32）、label 走 locale、inject 提供 t。
- `pagehide` 监听 1 个；`adb.close()` 仅 2 处（pagehide 与 detach），组件卸载路径已无关闭。
- `friendly()` 三条样例映射正确。

**未验证**：关设置再打开 / 刷新后的真实重连行为，需用户在浏览器确认。

**顺带发现**：TNY-AL00 是华为机型（VID 0x12d1）但跑 Android 10。
旧版「华为 VID ⇒ HarmonyOS ⇒ 拒绝连接」的分支正好会挡住这台机器，重建版已无该判断。

## 2026-11-20 16:52 — 打通「智能体远程驱动手机」的桥

**目标**：让智能体/本机脚本能间接在手机执行 ADB，而不是只能手点 UI。

**约束**：WebUSB 只在浏览器进程可用；宿主拿不到用户电脑的 USB。
`connection` 的 RPC 只有 client→host 单向（`HostConnectionRpc.handle` /
`ClientConnectionRpc.call`），没有反向调用。

**方案（两个方向都不 import 任何 @deepseek-ai 包）**：
- 浏览器→宿主：已认证 RPC 通道 `/mobile-bridge`
  - `poll`：取任务（payload 顺带带 device 信息）
  - `result`：回传 {id, ok, output|base64}
- 宿主→本机：`ctx.webServer` 上 prefix 路由 `/mobile-bridge`
  - `GET /status`、`POST /exec`、`POST /screenshot`（截图写 /tmp 并返回路径）
  - 仅接受 127.0.0.1 / ::1，非 loopback 一律 403
- 客户端 `apply()` 里起轮询循环，与 UI 是否挂载无关；标签页活着就能被调。

**踩到的坑**：
`export const inject = ['webServer','connection']` 不生效，patch 行级 inject 也不生效，
启用时报 `cannot get property "webServer" without inject`。
改成 cordis 的 `ctx.inject(['webServer'], cb)` / `ctx.inject(['connection'], cb)`
子上下文后 `application: applied`，无警告。

**已验证**：
- `curl 127.0.0.1:3080/mobile-bridge/status` → `{"ok":true,"browserAlive":false,...}` 200
- `exec` 在浏览器未轮询时返回明确中文错误
- 离线执行 client.js：轮询循环发出 `poll`→执行→回传 `result`（id/ok/error 均正确）

**待验证**：浏览器刷新后 `browserAlive` 变 true、真机命令返回。
**限制**：标签页被浏览器后台节流时轮询会变慢；只支持 Android/ADB。

## 2026-11-20 17:02 — 桥接第二版：修通道 + 去顺序依赖 + 加诊断

**实测否掉的假设**：自定义 `rpc.handle('/mobile-bridge')` 不产生浏览器可达的 HTTP 路由。
证据：`POST /mobile-bridge/poll` 与 `POST /zzz/poll` 同为 **405**（落在 SPA fallback），
而 `POST /api/goals/create` 为 **401**（存在、需鉴权）。→ 改用
`connection.rpc.intercept('/api', ...)`，端点 `mobile-bridge/{poll,result}`。

**另一处自我造成的故障**：本地 CLI 路由原本也挂在 `/mobile-bridge` 前缀，
会先命中并因「仅 loopback」返回 403，把浏览器的 RPC 请求挡掉且被 catch 吞掉。
→ CLI 路由迁到 `/mbridge`。

**去掉顺序依赖**：`dsh.client.inject` 只影响加载次序；若本插件先 apply，
`ctx.get('connection')` 当刻为 undefined 且之后不再重试。
→ 改为每 800ms 等 connection 服务出现再启动桥。

**加诊断**：模块级 `DIAG`（state/polls/lastOk/error/injected），
面板底部显示一行「桥接 … · connection=… · 轮询 N 次 · 错误 …」，
console 每 20 次失败打一次 warn。避免再次静默失败。

## 2026-11-21 12:30 - 修 WebUSB 设备句柄泄漏 + 诊断按钮实测 claim

**做了什么：**
- 真机首次连接报 `NetworkError: Unable to claim interface`，排查中发现真 bug：
  `connectHarmony()` 失败时没有关闭已 `open()` 的设备句柄，泄漏后每次 claim 都失败
  （`src-client/main.js`、`src-client/hdc/transport.js`）
- claim 失败时保留原始 `DOMException` 的 name/message 与接口信息，UI 同时显示
  「友好建议 + 原始错误」
- 新增 `diagnoseUsb()`：列出 Chrome 眼里的设备/接口/`claimed` 状态，并**现场实测一次
  claim**（打开→claim→释放→关闭），据此区分「环境占用/驱动」与「我们代码」问题
- 面板新增「诊断」按钮
- 剔除误导文案：HDC 的 claim 失败不再提示 Android 的 WinUSB/Google 驱动方案

**待做什么：**
- 等用户在真机点「诊断」，据 `claimTest` 结果决定：关占用进程 / Zadig 绑 WinUSB / 修代码
---

