# Windows 连接桥（日志采集）方案

> 状态：**已归档，暂缓开发**（2026-11-25）。等现有插件问题清零后再启动。
> 关联：`dsh-mobile-device-bridge` 插件（手机通道：WebUSB / 本地USB / 华为账号 ID 自签）。

## 1. 目标与验收

**目标**：在不改变现有手机通道的前提下，加一条 `kind: "win"` 的通道，让 DSH 里的 agent 能：
`win_list`（有哪些日志源/进程）→ `win_logs`（取最近 N 行）→ `win_tail`（持续跟踪）→ `win_spawn/win_kill`（自己启停被观测的程序）。

**验收（可执行）**：
1. 用户在 Windows 上跑一条命令 → 面板「Windows 本机」页签 60 秒内显示在线；
2. agent 调 `win_logs(source="app")` 能拿到该程序最近日志（≤2s 延迟）；
3. 关掉 collector → 面板 10 秒内变未连接（不留残影，和手机通道一致）；
4. 未带 token 的请求一律 401，且不影响现有 `/mbridge/*` 行为。

## 2. 先纠正早期方案里站不住的假设（本机实测结论）

| 事实 | 依据 | 对方案的影响 |
|---|---|---|
| DSH 只监听 `127.0.0.1:3080`，对外靠 **frp TCP 隧道**（`frpc` → `168.110.29.85:7000`，`remotePort=3080`） | `ss -ltnp`、`/etc/frp/frpc.toml` 的 `type="tcp"` | 从 Windows 看，DSH 就是**一个 origin**；不依赖 HTTP 反代特性 |
| 隧道/代理进来的请求，源地址会被看成 **127.0.0.1** | 插件现有 `loopback` 判断 + frp tcp 转发模型 | 现有「只接受 127.0.0.1」的保护在隧道下**等于失效**；新通道必须自带 token |
| 插件路由**没有** DSH 鉴权：`GET /` 返回 401，但 `GET /mbridge/status` 返回 200 | 本机 curl 实测 | 不能指望 DSH 登录态保护新端点 → 自己校验 token |
| 无法假定 **WebSocket 升级**能穿过任意代理/隧道 | 方案不再依赖 WS | 改用「普通 HTTPS 请求」协议 |
| 服务器上没有 Go / .NET，只有 Node 24 | `go version` / `dotnet --version` 均缺失 | Windows 侧首选 **PowerShell 5.1 单文件**（Win10/11 自带，零构建零签名） |

## 3. 连接模型（核心决策）

**一条出站连接、捎带指令**——所有数据都由 Windows 主动 POST 出去，服务器在同一响应里下发指令：

```
[Windows collector]  ──POST {origin}{prefix}/mbridge/win/ingest──►  [DSH 插件]
   每 500ms~1s 一批（有日志立即发，空闲也发心跳）                      │
   body: {token, host, since, src:[{id,file,off}], lines:[{s,seq,t}]}
                                                                     ├─ 环形缓冲（每源 ≤2000 行）
   ◄── {ok, rev, commands:[{id,op:"tail"|"stop"|"spawn"|"kill"|"config"}], ackSeq}
```

为什么这样能应付「访问方式五花八门」：
- **不需要 WebSocket**：普通 HTTP 请求，任何 frp / nginx / Cloudflare / 反代 / TLS 终止都能过；
- **不需要 Windows 开放端口**：纯出站，无防火墙弹窗、无需管理员、NAT 后面也能用；
- **不依赖 DSH 登录态**：用插件自己发的配对 token；
- **URL 不写死**：UI 用 `window.location` 生成命令，用户实际用什么地址访问，就下发什么地址（含端口/路径前缀）；
- 断线自动重连（指数退避），服务器侧用 `lastSeen` 判在线（沿用手机通道的 6 秒粘性）。

**为什么不选浏览器中继**：页面是 HTTPS 时，页面连 `ws://127.0.0.1` 是否被 mixed-content 拦截取决于浏览器版本与地址写法（`127.0.0.1` 与 `localhost` 行为都不同），不可靠；「collector 直连同一个 origin」没有这个不确定性。浏览器中继只作为兜底（见 §8）。

## 4. 服务端改动（`index.js` + 客户端）

### 4.1 鉴权
- 首次加载生成 `~/.dsh/win-bridge.json`（600）：`{token, createdAt, lastSeen}`；UI 可「重新生成」（旧 token 立即失效）。
- 仅 `/mbridge/win/*` 走 token 校验（`Authorization: Bearer` 或 `?token=`），其余路径保持现有 loopback 规则。
- 失败统一 `401 {ok:false,error:"bad token"}`；连续 5 次失败同一 IP 记日志。

### 4.2 新路由
| 路由 | 方法 | 用途 |
|---|---|---|
| `/mbridge/win/ingest` | POST | collector 上报 + 捎带下发指令（主通道） |
| `/mbridge/win/status` | GET | 面板/agent 用：在线状态、源列表、最后心跳 |
| `/mbridge/win/logs` | GET | `?source=&n=200&since=` 取环形缓冲 |
| `/mbridge/win/sources` | POST | 增删日志源（文件 tail 配置、spawn 配置） |
| `/mbridge/win/token` | GET/POST | 取/轮换配对 token（仅 loopback） |

### 4.3 内存结构
- `winBridges: Map<bridgeId, {host, os, lastSeen, sources, cursor}>`（默认单实例，多台按 `host` 区分）
- `winLogs: Map<sourceId, RingBuffer<{seq, ts, text}>>`，每源上限 2000 行；命令队列 `Map<sourceId, Command[]>`
- 全部塞进现有 `diag` 便于排查

### 4.4 agent 工具（沿用现有 `ctx.inject(['tools'])` 模式）
| 工具 | 参数 | 说明 |
|---|---|---|
| `win_devices` | — | 列出在线 Windows 通道与日志源 |
| `win_logs` | `source`、`n?`、`since?` | 取最近日志文本 |
| `win_tail` | `source`、`seconds?` | 短时跟踪增量 |
| `win_sources` | `add?`/`remove?`/`reload?` | 增删/重载日志源 |
| `win_spawn` | `path`、`args?`、`cwd?`、`source?` | 让 collector 启动程序并接管 stdout/stderr |
| `win_kill` | `pid` 或 `source` | 结束被 collector 启动的进程 |

工具描述统一写 "CALL THIS FIRST for Windows app logs; do not try to read Windows files from the Linux host"。

### 4.5 客户端 UI
- 「移动设备」页签平级新增 **「Windows 本机」**
- 未连接：一键生成命令（`powershell -ExecutionPolicy Bypass -File win-bridge.ps1 -Url "<origin+prefix>" -Token "<token>"`）+ 复制 + 下载脚本
- 在线后：主机名/在线时长、日志源列表、实时 tail、拉取上限
- 未连接时整块隐藏设备详情（复用「拔线即隐藏」逻辑）

## 5. Windows collector（P1：PowerShell 单文件 `win-bridge.ps1`）

参数：`-Url`、`-Token`、`-Sources <json|file>`、`-Check`（只做连通性自检并打印诊断）。

P1 能力：
1. **文件 tail**：按字节偏移增量读，处理轮转（文件变短/ino 变化 → 从头读）、多编码（UTF-8 / GBK `[Text.Encoding]::GetEncoding(936)`）、可选正则 `filter`
2. **子进程接管**：`Start-Process -RedirectStandardOutput/Error` 到临时文件再 tail（PowerShell 读不了异步流，这是稳妥做法），退出时上报 exit code
3. **上报循环**：`Invoke-RestMethod -Method Post`，每 tick 收集增量，带 `ackSeq`；失败退避（1s→2s→5s→30s）；`-Check` 打印 TLS/证书/HTTP 码/耗时
4. **执行指令**：响应里的 `commands` 逐条执行并回 `{cid, ok, out}`
5. **体积控制**：单批 ≤64KB，超了截断并标 `truncated:true`

P2（同协议换实现）：Go 单 exe，补 **OutputDebugString 捕获**（DBWIN_BUFFER，等同 DebugView）、ETW 实时会话、事件日志订阅。

## 6. 日志来源支持矩阵

| 来源 | P1 | P2 | 备注 |
|---|---|---|---|
| 日志文件 tail | ✅ | ✅ | 最常见；轮转/编码/过滤已覆盖 |
| 子进程 stdout/stderr | ✅ | ✅ | collector 自己启动的程序 |
| `OutputDebugString`（DebugView 那套） | ❌ | ✅ | 不用改目标程序，需 Go + 共享内存 |
| ETW 实时 / 事件日志 | ❌ | ⚠️ 后续 | 开发量大 |
| 数据库/加密日志（Electron leveldb、SQLite WAL） | ❌ | ❌ | 需程序自己导出，明确不支持 |

## 7. 分阶段与工作量

| 阶段 | 内容 | 预计 |
|---|---|---|
| **P0 连通性 spike** | 加 `/mbridge/win/ping`（带 token），在用户机器上跑一条 `Invoke-RestMethod` 确认实际访问地址可达、证书/前缀没问题 | 0.5h |
| **P1 可用版** | ingest 协议 + 环形缓冲 + `win_*` 5 个工具 + PowerShell collector + UI 页签 | 1~1.5 天 |
| **P2 增强** | Go collector + OutputDebugString + 轮转细化 + `-Check` 完善 | 1~2 天 |
| **顺带修复（建议同期）** | 现有 `/mbridge/*` 在隧道下等同公开 → 给写操作（exec/install/uninstall/push）加 token 或限制方法 | 0.5h |

## 8. 风险与未决

| 风险 | 处置 |
|---|---|
| Windows 只能「浏览器能开」，collector 连不上 origin（边缘有 mTLS/SSO/一次性签名 URL） | P0 暴露。兜底：a) 页面中继（需实测能否连 `http://127.0.0.1`，0.5h spike）；b) frp 再加一条 `remotePort` 专供 collector；c) 走局域网地址 |
| 边缘反代只放行指定路径 | `-Check` 打印返回码定位；必要时 ingest 改走 `/api` 前缀子路径 |
| 日志量太大（>1MB/s） | 环形缓冲 + 批大小上限 + 丢旧保新；必要时只在 `win_tail` 激活时上报 |
| PowerShell 执行策略/杀软拦截 | 提供 `-ExecutionPolicy Bypass` 一键命令；P2 换 Go exe |
| token 泄漏 | 轮换按钮 + 本机 600 + 可选绑定首次上报 host |

## 9. 开工前需确认

1. **Windows 浏览器访问 DSH 的完整地址形态**（域名/IP、端口、路径前缀、证书是否公网可信）→ 决定 `-Check` 默认参数与是否需要 `-SkipTlsCheck`。
2. **要抓的第一个程序**：自己写日志文件（路径？）还是只往 stdout/调试输出打？
3. 是否接受「在 Windows 上跑一个 PowerShell 脚本、纯出站、不装服务、不开端口」。
