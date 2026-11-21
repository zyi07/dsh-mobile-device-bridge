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


## 2026-11-21 12:40 - HDC claim 加固：退避重试 + 枚举变化后换新鲜句柄

**做了什么：**
- 现象：手机清除授信→重新插→点连接→手机弹「始终信任」→点信任后报
  `Unable to claim interface`
- 推断：授权瞬间手机会重新枚举 USB，claim 撞在枚举空窗期；且旧 `USBDevice`
  句柄在重新枚举后失效
- `HdcTransport.open()` 改为**退避重试 4 次**（每次失败先 `close()` 再等 400ms×n）
- `connectHarmony()` 在 claim/NetworkError 类错误上**用 `getDevices()` 取新鲜句柄重试一次**
- 提交 hash: 待填

**待做什么：**
- 仍需用户点「诊断」提供 `claimTest` / `claimed` 实测结果
- 若 claim 恒失败且 `claimed=false`：查 Windows 服务（Huawei PC Manager 之类）与 WinUSB 绑定
---


## 2026-11-21 13:50 - 定位 WebUSB 连不上根因：hdc server 独占 WinUSB

**做了什么：**
- 第 7 轮实测证据（本地 agent 提供）：
  · interface 0 的 `Service = WINUSB`、`winusb.inf`、`MS_COMP_WINUSB`
  · hdc server 在跑时 `libusb_open` → -3 ACCESS（open 阶段就失败）
  · `hdc kill` 后 open/claim(0) 均 0 SUCCESS
- 结论写进 `docs/HDC_PROTOCOL.md`：根因是 hdc server 独占，非驱动/权限问题
- `HdcTransport.open()` 区分 open / selectConfiguration / claim 三个阶段
- `main.js` 新增 `errExclusive` 文案：直接给出可复制的 `hdc kill` 绝对路径命令，
  并强调"之后不要再运行任何 hdc 命令"

**待做什么：**
- 用户按顺序执行后做真机 AUTH 验证（首次连接需现场生成 RSA-3072 密钥）
- HDC 截图（snapshot_display + file recv）仍未实现
---


## 2026-11-21 14:00 - 修读取侧重同步：IN 端点残留半帧导致 "UB magic 不对"

**做了什么：**
- 真机首次进入协议层，报 `UB magic 不对: 10 1`。原因：hdc server 被杀时 IN 端点
  残留上次会话的半帧（以 `10 01` 开头，是旧会话头 `…10 01 18 00 20 09…` 的残片），
  严格解析直接抛错
- `HdcTransport.takeFromBuffer()` 改为**可重同步**：跳过垃圾、扫描 `55 42` 对齐，
  并校验 `option∈{1,2}`、`dataSize≤1MB`，伪 magic 也只跳 2 字节继续找
- 新增 `drainIdle()`：claim 之后与 RESET 之后各清一次端点残留
- 新增 `resyncs` / `dropped` 计数便于诊断
- `transport.test.mjs` 加第 9 节：用真机的 `10 01 …` 残包与伪 magic 两种情形做回归

**待做什么：**
- 真机验证 AUTH（首次连接需现场生成 RSA-3072）
---


## 2026-11-21 14:15 - 真机握手无应答：加收发日志 + 首帧自动重发

**做了什么：**
- 现状：claim 成功、RESET 已发、第 1 帧已发，但设备 8 秒内零回包
  （报 `握手超时（第 1 次等待应答）`）
- 给 `HdcTransport` 加 `logger`：TX/RX 每一条都记 USBHead(opt/sid/len)、帧长、
  帧头 24 字节 hex、重同步跳过字节数、超时事件
- `main.js`：日志进 `STATE.log`，连接失败时直接显示在输出区（带复制按钮）；
  环境信息（vid/pid/serial/daemon 版本）也记一条
- 握手等待 5s → 8s；**首帧无应答自动重发一次**（应对 daemon 旧会话未清理）
- 测试仍全绿（9 项传输层 + 会话层）

**待做什么：**
- 等用户把新日志发来，判断是"设备完全不发"还是"发了我们没收到"
---


## 2026-11-21 21:40 - HDC 日志自动落盘 + 握手变体自动重试

**做了什么：**
- 宿主 `index.js` 新增 `/api/mobile-bridge/log` 路由：把浏览器上报的 HDC 收发日志
  追加写入 `~/.dsh/mbridge-hdc.log`（可用 `MOBILE_BRIDGE_HDC_LOG` 覆盖路径）
- 客户端 `STATE.connection` 保存宿主 RPC 连接；连接失败/成功都 `flushHdcLog()` 上报
  → **不再需要截屏传日志**
- `HdcSession` 拆出 `handshake()`；首轮超时后自动换变体（**不发 RESET 直接握手**）再试一次，
  两种变体在日志里可区分
- 用插件管理器重载宿主半区（`include:mobile-bridge` disable→enable），
  实测 `/mbridge/status` 返回 `fetchRoutes: 3`，确认 `/api/mobile-bridge/log` 已注册

**待做什么：**
- 等真机重试，读 `~/.dsh/mbridge-hdc.log` 判断"设备完全不发"还是"发了我们没收到"
---


## 2026-11-21 22:00 - 诊断链路修正 + 协议级重放探针

**做了什么：**
- 承认并修正自己的错误：`r40` 徽章那次 `str.replace` 静默没匹配上（锚点是 `key: 'b'` 不是 `key: 'badge'`），
  导致"客户端是旧版"的判断建立在错误前提上；本次改用已确认存在的锚点插入并 `grep` 验证产物
- 宿主 `pollRoute` 增加落盘：每次 poll 的 payload 写入 `~/.dsh/mbridge-poll.json`，
  可据此判断浏览器跑的客户端版本（旧版只发 `device`）
- 客户端 poll 携带 `build` 标记与最近 80 条日志 → 即使连不上也能把日志带出来
- 新增 `/root/hdc_probe8.py`：**把真机抓包的第 1 帧原样重放**（libusb 直连，不走浏览器），
  跑两个变量（抓包 sid / 随机 sid），用于把「协议对不对」与「WebUSB 实现差异」分开
  - 自检：内嵌帧与 fixtures 逐字节一致；解析器能正确还原抓包里的 authType=3 应答

**待做什么：**
- 本地 agent 跑 probe8；浏览器侧硬刷新后看是否有 `r41` 徽章
---


## 2026-11-21 22:05 - 日志改用剪贴板交付（宿主路由重载不可靠）

**做了什么：**
- 确认客户端已是新版（面板出现 `r41` 标记），但 `~/.dsh/mbridge-hdc.log` 与
  `mbridge-poll.json` 均未生成 → 判定：**插件 disable/enable 没有真正替换宿主侧
  fetch 路由处理器**（旧 handler 仍在服务），宿主侧改动不可靠
- 改走不依赖宿主重载的通道：连接失败时把完整收发日志
  `navigator.clipboard.writeText()` 复制到剪贴板，并必定显示在输出区；
  错误文案提示用户直接 Ctrl+V 粘贴
- 构建标记 → r42，便于确认浏览器加载版本

**待做什么：**
- 拿到用户粘贴的日志，判断"设备完全不发"还是"发了没收到"
- 本地 agent 跑 `tools/hdc_probe8.py`（协议级重放，不经浏览器）
---


## 2026-11-21 22:20 - 关键发现：设备对我们零发送（含自发心跳）

**证据（用户粘贴的 r42 完整日志）：**
```
21:58:04.431 INFO serial="…" 版本=Ver: 3.2.0f73c487f8b34a2ba5
21:58:05.261 RX timeout（本轮无数据）   ← 在任何 TX 之前
21:58:05.261 TX ub-head opt=2 sid=0x0 len=0
...
全程只有 RX timeout，零个 RX pkt
```
真机抓包里 hdc 打开设备后 47ms 内设备就自发心跳 → **本机 daemon 一个字节都不发**，
连它本该自发的心跳都没有。所以问题不在握手内容。

**做了什么：**
- 修 `tools/hdc_probe8.py` 的 `NameError: c_uint`（导入缺失，我的 bug）
- `HdcTransport.readPacket()` 改为**始终复用同一个在途 transferIn**：
  WebUSB 无超时，原先每次 race 超时就丢弃 promise，会在端点上堆积多个永远
  不完成的传输
- 连接开始时先**纯被动监听 3 秒**（不发任何字节），并记录收到几个包

**待做什么：**
- 让用户先跑 `hdc list targets -v` 证明 daemon 是否在发数据，再 `hdc kill` 后跑 probe8
---


## 2026-11-21 22:30 - 协议被 libusb 探针证实；WebUSB 侧改用「不选配置直接 claim」

**证据（probe8 第一次运行，设备刚 kill 完 hdc）：**
```
[pre] IN 11B UB sid=0x307ABD85 len=24          ← 设备自发心跳，计数器递增
[V1]  IN 11B UB sid=0x25EF0DC9 len=0x63
[V1]  IN 99B flag=1 authType=3 buf_len=33 "authtype        1               1"
→ 收到 2 个包（有回音！）
```
→ **真机第 1 帧原样重放即可拿到 daemon 的 AUTH_PUBLICKEY 应答**，协议/字段/时序全部正确。
V2 随机 sid 无回音属正常（会话已绑定 0x25EF0DC9，换 sid 被判 softreset）。
第二次运行时写操作 rc=-9/-1，属端点被上一次异常收尾挂住，需 clearHalt 或重插。

**关键对照：** libusb 能收到心跳，WebUSB 一个字节都收不到。两者最大差异是
**libusb 从不调用 SET_CONFIGURATION**，而 WebUSB 里我们总是先 `selectConfiguration`。
SET_CONFIGURATION 会重置所有接口/端点，正好能解释 daemon 侧 `SendUSBRaw index failed`。

**做了什么：**
- `HdcTransport.open()`：**先尝试不选配置直接 `claimInterface`**，失败才回退到
  `selectConfiguration` + 重新 claim；两条路径都记日志
- 新增 `findHdcInterfaceFromConfigurations()`：从 `device.configurations[i].interfaces`
  描述符树找接口（不需要先选配置）
- `writeOut()`：写失败时 `clearHalt(in/out)` 后重试一次
- 假设备同步建模 `configurations[i].interfaces`，9 项离线测试仍全绿
- 构建标记 r44

**待做什么：**
- 真机验证：F5 → hdc kill → 连接；看是否收到心跳与 authType=3
---


## 2026-11-21 22:35 - SET_CONFIGURATION 假设被证实：daemon 开始回话

**真机日志（r44）：**
```
INFO claim 成功（未调用 selectConfiguration）iface=0
INFO 被动监听 3 秒（不发任何数据）
RX timeout → INFO 被动监听结束，收到 0 个包
TX reset(无帧)
TX ub-head sid=0x99D75AA8 len=180 → TX frame 180B
RX pkt opt=1 sid=0x99D75AA8 len=99     ← ★ daemon 回了 AUTH_PUBLICKEY 请求
TX ub-head len=710 → TX frame 710B     ← 我们发了公钥
RX pkt opt=1 sid=0x99D75AA8 len=451    ← 设备回了 451B（抓包里 token 应答只有 86B）
```

**结论：** 不再调用 `SET_CONFIGURATION` 后，daemon 立刻正常应答 → 之前"设备零发送"
的根因就是 `selectConfiguration` 重置了接口/端点，使 daemon 的回包发送失败
（对应历史日志 `SendUSBRaw index failed`）。

**新问题：** 公钥发出后 daemon 回复 451 字节，与抓包中 86 字节的 token 应答不符，
需要看清内容才能判断是"拒绝并说明原因"还是别的。

**做了什么：**
- 握手应答改为**结构化日志**：authType（含名称）、sid、connectKey 长度、buf 长度、
  buf 文本（前 160 字符）、以及前 512 字节完整 hex
- `session.js` 的异常信息带上 buf 文本，AUTH_FAIL 与意外 authType 都能直接看到原因
- 构建标记 r45

**待做什么：**
- 根据 451B 应答内容决定：若是"拒绝"→ 走上机授权/复用 hdc 密钥；
  若是分片或其他 → 修读取与状态机
---


## 2026-11-21 22:40 - 破译 451 字节应答：DAEMON_UNAUTH，需要上机确认

**真机 r45 日志（关键行）：**
```
RX pkt len=99  → INFO ← 握手应答 authType=3(PUBLICKEY) buf=33B "authtype        1               1"
TX frame 710B（送公钥）
RX pkt len=451 → INFO ← 握手应答 authType=4(OK) buf=384B
  buf 文本: "emgmsg 175 [E000002]:The device unauthorized.
             This server's public key is not set.
             Please check for a confirmation dialog on your device. …
             daemonauthstatus13  DAEMON_UNAUTH
             1200 6 enablesupportfeatures 21 heartbeat,encrypt_tcp"
```

**结论：设备接受了我们的公钥，但该密钥尚未授权，需要用户在手机上点确认。**
抓包里之所以直接返回 token，是因为那把密钥当时已被信任。

另一发现：被动监听这次收到 4 个包（含 86B 握手帧），是**上一次会话残留在设备侧的应答**；
需要按 UB 头的 sid 过滤掉不属于当前会话的包。

**做了什么：**
- `authType=4` 且 buf 含 `UNAUTH` → **不判失败**，改为进入"等待上机确认"：
  面板提示「请在手机上点允许/始终信任」，最多等 90 秒
- 等待期间每 12 秒**重发一次公钥帧**催 token
- 按 `UB sid` 过滤其它会话的残留包
- 日志**实时上屏**（`STATE.notify`），用户能看到提示而不用等失败
- 构建标记 r46

**待做什么：**
- 用户在手机上点允许，观察 daemon 是否回 token（authType=2）
---


## 2026-11-21 22:50 - 面板看不到日志的原因 + 缩短确认等待

**现象：** 用户点连接后面板一直「连接中」，94 轮轮询（约 140 秒）既无报错也无提示。

**原因（两个，都是我的问题）：**
1. 日志靠 `STATE.notify` 回调推到面板，但该回调在组件重挂载时被清成 null，
   导致连接中完全看不到日志与"请点允许"的提示
2. 等待链过长：确认等待 90s + 变体重试再 120s，用户面对近 4 分钟的"连接中"

**做了什么：**
- 面板改为**直接从模块级 `STATE.log` 渲染**连接中的日志尾巴（40 行）与
  「📱 请在手机上点允许」提示——面板本就每 2 秒重渲染，不再依赖回调
- 确认等待 90s → **60s**；总握手硬上限 120s → **75s**
- 确认超时抛 `code='NEED_CONFIRM'` 的错误，**不再做无意义的变体重试**
- 构建标记 r47

**待做什么：**
- 用户在手机上点允许，观察是否收到 token
---


## 2026-11-21 23:00 - 设备回完 UNAUTH 就关会话 → 改成「提示 + 重新握手」

**真机 r47 日志（面板实时输出）：**
```
22:38:54.194 RX pkt len=20  flag=2  payload 01        ← 设备发「通道关闭」
22:38:54.195 RX pkt len=202 flag=9  00 5b 45 30 30 …   ← 长度前缀字符串 "[E000002]:The device unauthorized…"
22:38:58.896 RX pkt len=24  flag=5000 heartbeat count=0
22:39:03.965 … count=1  （每 5 秒递增）
```
**关键判断：** daemon 回完未授权消息后**立即关闭了会话**，随后心跳恢复
（心跳开启本身就表示"当前无会话"）。因此"原地等 token"是错的——正确做法是
让用户去机上确认，然后**重新握手**。

**做了什么：**
- `handshake()` 收到 `DAEMON_UNAUTH` → 立即抛 `code='NEED_CONFIRM'`
- `connect()` 改为**重试循环**：最多 7 轮，每轮提示「请在手机上点允许」并等 9 秒后重新握手
  （每轮都会重置会话并发 USER_CONFIRM 提示，给设备多次弹窗机会）
- 移除"确认期间重发公钥帧"的无效催应答逻辑
- 构建标记 r48

**待做什么：**
- 用户盯着手机看是否弹窗；7 轮都无弹窗则改走「复用 hdc 已授权私钥」路线
---


## 2026-11-21 23:15 - 增加「复用 hdc 已授权私钥」路线（免除上机确认）

**动机：** r47 那种运行里 daemon 直接不回握手（疑似记住了一次未授权提交、
在用户确认前不再理会新握手），而手机又没弹窗 → 死锁。
既然本机 hdc 能连上手机，说明**它的密钥已被设备信任**，复用它即可免确认。

**做了什么：**
- `session.js` 新增：
  - `extractPemBlock()` / `b64ToBytes()` / `bytesToPem()`
  - 极简 DER 解析（`derReadTlv` / `derChildren` / `derEncode`）
  - `derivePublicKeyPem(pkcs8Pem)`：从 PKCS#8 私钥推导 SPKI 公钥 PEM
    （WebCrypto 不支持从私钥导出公钥，只能自己算）
  - `importHdcKey(pemText)`：导入 PKCS#8 私钥 + 得到公钥 PEM
- `Handshake` 支持直接给 `publicKeyPem`（跳过现场生成）
- 面板新增「已有 HDC 私钥（可选）」折叠区，粘贴即用；`STATE.hdcKeyText` 保存
- 离线验证：生成 RSA-3072 → 导出 PKCS#8 → 用我们的推导函数还原公钥，
  与 WebCrypto 的 SPKI 导出**逐字节一致**；导入后签名 384 字节且可验证
- 构建标记 r49

**待做什么：**
- 用户粘贴 hdckey + hdckey.pub 后连接，应直接走 token → 签名 → AUTH_OK
---


## 2026-11-21 23:30 - ★ 找到根因：hdc 用 RSA-PSS，不是 PKCS#1 v1.5

**真机日志（r49，复用 hdckey）：**
```
RX authType=3(PUBLICKEY) buf=33B
TX 公钥 710B
RX authType=2(SIGNATURE) buf=20B token "7b90f1ce…"
TX 签名 579B
RX authType=4(OK) buf=255B
   "[E000010]:Auth failed, cannt login the device. … DAEMON_UNAUTH"
```
token 拿到了、签名也发出去了，但**验签失败** → 问题在签名算法本身。

**离线验签（用真机抓包的 token + 384B 签名 + 公钥）：**
| 算法 | 结果 |
|---|---|
| PKCS#1 v1.5 + SHA-512 / SHA-256 / SHA-1 | ❌ 全不通过 |
| RSA-PSS + SHA-512 + **saltLength=64** | ✅ **通过** |
| PSS 其他 salt / SHA-256 | ❌ |
| 换被签内容（hex 字符串 / 10 字节 / 加 \0） | ❌ |

→ **hdc 使用 RSASSA-PSS（MGF1-SHA512，salt=64）**，所谓 `rsa_3072_sha512` 指摘要，
   填充是 PSS。我们此前用 PKCS#1 v1.5，必然被判 Auth failed。

**做了什么：**
- `session.js`：`SIG_ALG = {name:'RSA-PSS', saltLength:64}`、`SIG_IMPORT_ALG = {name:'RSA-PSS', hash:'SHA-512'}`
- `generateKeyPair()` / `signToken()` / `importHdcKey()` 全部改用 PSS
- `session.test.mjs` 新增 D 段回归：
  · 真机签名必须能被 PSS/SHA-512/salt64 验通
  · **反向断言**：PKCS#1 v1.5 必须验不通（防止算法被改回去）
  · 自签自验通过、签名恒为 384 字节
- 额外验证：生成 PSS 私钥 → 导出 PKCS#8 → `importHdcKey` 导入 → 签名 → 原公钥验通；
  推导出的公钥与 WebCrypto 导出的 SPKI 逐字节一致
- 构建标记 r50

**待做什么：**
- 真机连接验证 AUTH_OK + SUCCESS
---


## 2026-11-21 23:45 - 密钥持久化（授权只需一次）+ 修正对用户的误判

**修正：** 之前说"用户没点允许"是错的。用户每轮都点了「始终允许」，
且日志证明三轮用的是**同一把密钥**（"使用现场生成的 RSA-3072 密钥"只出现一次），
所以是**设备侧授权写入生效滞后**，不是操作问题。

**真正的问题：** 每次连接都**现场生成新密钥** → 每次都要重新授权一遍。

**做了什么：**
- 生成密钥后立即导出 PKCS#8 并包成 PEM，存入 `localStorage['mobile-bridge.hdc.pkcs8']`
- 后续连接优先复用：粘贴的私钥 > 已保存的密钥 > 新生成
- 面板加「重置密钥」按钮，并说明默认行为
- 授权等待 9s → **12s**（给设备写入信任列表留时间）
- 与 r51 的 channelId(<2^31) 修复合并后，构建标记 r52

**待做什么：**
- 验证命令通道能拿到输出（`param get const.product.model`）
---


## 2026-11-22 00:10 - 鸿蒙首轮连接成功；UI 分平台文案、去密钥设置、修机型、加截图

**里程碑：** AUTH 打通后，用户实测 **第一轮就连上**（密钥已在设备 `hdc_keys` 中）。

**做了什么：**
- **移除密钥设置 UI**（折叠区、粘贴框、重置按钮全部不显示）；逻辑保留为
  「复用浏览器已保存的密钥 → 否则新生成并保存」
- **文案按平台分开**：`hintAdb` / `hintHdc`，不再用同一段文案（安卓讲 adb server/scrcpy，
  鸿蒙讲 hdc kill / 上机授权）
- **Android 侧补日志**：`pushAdbLog()` 复用同一面板日志，记录连接开始、USB 连接、
  ADB 认证完成、机型/版本、命令与错误 —— 与 HDC 的日志体验一致
- **修鸿蒙机型识别**：原来只读 `const.product.model`；现在按
  `const.product.model → name → brand`、`const.ohos.apiversion → product.software.version`
  依次尝试，并过滤 `param get` 回显与 `[E...]` 报错行；最终兜底用 WebUSB productName
- **补 HDC 截图**：`snapshot_display -f /data/local/tmp/…jpeg` → `base64 <file>` 经 shell 回传
  → 浏览器解码成 Blob 打开；失败时给出可诊断信息（含 snapshot 输出）
- 构建标记 r54

**待做什么：**
- 真机验证截图链路（尤其设备上是否有 `base64` 命令）
- 后续可补：文件 push/pull、HAP 安装（复用同一 shell 通道）
---


## 2026-11-22 00:25 - 命令通道仍无输出；抓包对比指向"时序"

**抓包对比（同一条命令）：**
```
真 hdc: AUTH_OK T+250 → 关通道0 T+250 → **T+4359** 才发 param get → 收到 PLA-AL10 \n
我们 : AUTH_OK → 关通道0 → 60ms 后立刻发 → 零输出
```
真 hdc 在 AUTH 之后隔了 **4.1 秒**才发第一条命令，推测是在等设备侧 shell 服务就绪。

**做了什么：**
- AUTH 后关闭通道 0 的等待 60ms → **400ms**
- `shell()` 改为最多 **3 次尝试**，空输出时等 1200ms 换新 channelId 重试
- 命令应答逐帧记日志（`← 命令输出 flag=10 N字符` / `← 通道关闭 side=device`）
- 截图加入 `ls -l` 诊断（区分"截图没生成"与"无 base64 命令"），并尝试
  `base64` / `base64 -w0` / `cat | base64` 三种写法
- 构建标记 r56

## 2026-11-22 00:35 - 会话作废机制（HDC）+ 安卓同类问题一并对齐

**真机现象：** 重新连接时握手拿不到应答。日志显示本次会话 sid=0x113298C5，
但端点里出现 sid=0x43CA5424 的帧（**上一次会话**），daemon 视为 softreset 丢弃，
连本次的握手应答一起被吞。根因：上一次 `param get` 的重试循环仍在跑
（3 次 × 20s），继续往端点写旧 sid 的帧。

**HDC 侧：**
- `HdcSession.abort()` / `ensureAlive()`：作废后所有写入与重试立即抛错
- `connect()` 每轮、`handshake()` 写入前、`shell()` 每次尝试前都 `ensureAlive()`
- UI 每次连接自增 `STATE.connectToken`，并先 `abort()` 旧会话
- 连接探测参数改为**单次尝试 + 6s 超时**，避免长时间占用

**安卓侧（同类隐患，一并对齐）：**
- `detach()` 先 `hdc.abort()` 再关闭，保证旧会话不再写
- 安卓连接分支在 `requestDevice` / `attach` 之后校验令牌，过期则 `detach()`
- 挂载静默重连尊重令牌，与手动连接互斥，避免两次 `device.connect()` 抢同一设备
- `runShell` / `runJob` / 截图：结果回来时校验令牌，连接切换则丢弃旧结果
- 截图统一为 `captureScreen()`（ADB: screencap / HDC: snapshot_display+base64），
  UI 与宿主任务共用；`runJob` 的截图不再误报"HDC 不支持"
- 构建标记 r58

## 2026-11-22 00:50 - 命令通道：按 channelId 匹配应答（修真 bug）

**真机日志暴露的问题：**
```
TX 命令 chId=d39fbe8b02
RX 关闭 chId=e8d8cf9905     ← 设备关的是【上一个】通道
INFO ← 通道关闭 side=device  ← 我把它当成了本次命令的结束 → 立即返回空
```
即：**任意关闭帧都被当成"本命令完成"**，而设备对上一个通道的关闭回执恰好落在
新命令刚发出的时刻，于是每次都立刻返回空输出。

**做了什么：**
- `parseCommandReply()` 返回 `channelId`
- `shellOnce()` 只认**自己通道**的输出/关闭；别人的关闭帧记日志后忽略
- 只在收到设备侧关闭后才回发 host close（避免我们主动关掉设备还没执行的通道）
- 假设备改为**回显客户端通道号**（真实设备就是回显），使离线测试能覆盖该路径
- 机型兜底不再取 `device.productName`（它是 "HDC Device"）
- 构建标记 r60
