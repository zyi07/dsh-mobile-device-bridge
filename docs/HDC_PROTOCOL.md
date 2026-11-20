# HDC 协议笔记（据 OpenHarmony 开源实现，非黑盒逆向）

> 状态：**帧层已验证（离线字节比对），传输层与鉴权未实现/未验证。**

## 出处

| 结构 | 源码位置 |
|---|---|
| `ChannelHandShake` | `developtools_hdc` `src/common/channel.h:36` |
| `PayloadHead` | `src/common/session.h:160` |
| 会话/通道读写 | `src/common/channel.cpp`（ReadStream）、`src/common/session.cpp` |
| 设备侧命令分发 | `src/daemon/daemon_app.cpp` |
| 文件/安装任务协议 | `src/common/file.cpp`、`src/common/transfer.cpp` |
| 结构体与常量 | `src/common/define.h`、`src/common/serial_struct_define.h` |

仓库：`github.com/openharmony/developtools_hdc`（体积约 0.6 MB，直接 grep 比猜二进制高效得多）。

## 帧格式（本仓库已实现并通过字节级验证）

```
[11 字节 PayloadHead][headSize 字节 会话头][dataSize 字节 负载]
总长 = 11 + headSize + dataSize
```

`PayloadHead`（packed，全大端）：

| 偏移 | 内容 |
|---|---|
| 0..1 | `48 57`（"HW"） |
| 2..3 | 保留 0 |
| 4 | protocolVer = `0x01` |
| 5..6 | headSize（u16 BE）= 会话头字节数 |
| 7..10 | dataSize（u32 BE）= 负载字节数 |

会话头是 protobuf，字段固定为 4 个：

| 号 | 含义 |
|---|---|
| 1 | channelId（varint） |
| 2 | commandFlag（varint） |
| 3 | checkSum（varint） |
| 4 | **vCode = 0x09**（魔数） |

⚠️ `vCode` 对不上时对端**静默丢包**，不报错。这是最容易"看起来连上了但没反应"的坑。

## 握手

`ChannelHandShake` 有两种长度：**44** 与 **108**（108 = 44 + 64 字节版本串）。实测抓包是 108。

```
banner[12]   "OHOS HDC" + NUL
  banner[10] = 'K' → kill-server 能力位
  banner[11] = 'H' → huge-buffer 能力位
[12..43]     union { channelId (u32 BE, 服务端) | connectKey[32] (客户端, 如 usb sn) }
[44..107]    version 字符串，如 "3.2.0c" + 哈希
```

- **服务端先开口**：`accept()` 后立刻发 108 字节；客户端校验 banner、认领 channelId 再回一份。第一次搭 mock 时"等客户端先说话"会白等。
- 校验强度：有实现只校验 8 字节 banner 与 connectKey 长度，**不校验 version**，因此回 44 字节也能与两种服务端互通。

## 已用真实抓包验证的向量（53 字节）

```
48 57 00 00 01 00 0c 00 00 00 1e          ← PayloadHead: head=12, data=30
08 c4 e6 88 89 01 10 01 18 00 20 09       ← 会话头: chId=287449388, flag=1, sum=0, vCode=9
0a 08 "OHOS HDC" 10 00 18 01 22 00 2a 00  ← 负载: banner / chId=0 / 1 / 空 / 空
32 0a "3.2.0cTEST"                        ← 负载: version
```

`11 + 12 + 30 = 53`，与抓包 `RECV len=53` 吻合。`src-client/hdc/codec.test.mjs` 断言：
解码取值正确、**重编码逐字节一致**、粘包切分、半包等待、非 HW 数据抛错、varint 边界。

## 命令与响应

- 客户端首帧负载 = 命令文本 + `\0`（如 `shell ls /`）
- 设备侧命令结束会发 `CMD_KERNEL_CHANNEL_CLOSE`，随后连接关闭；**EOF 即完成**
- 本地命令（list targets 等）连接不关，只能靠空闲判定完成
- 交互式 shell（无参数 `shell`）进入 interactiveShellMode，每帧即 stdin，`exit` 结束
- 长输出按 4 KiB 分片，需要多帧重组

## 文件 / 安装任务协议（纯 socket 可实现）

- 官方 CLI 会在 `file send/recv`、`install` 命令文本后追加 ` remote -cwd "<cwd>"`
- `file send`：`CMD_FILE_CHECK`(TransferConfig) → `CMD_FILE_BEGIN`(8 标志字节) → `CMD_FILE_DATA`(64 字节 TransferPayload 前缀 + 数据) → `CMD_FILE_FINISH(1)` → 等 `CMD_FILE_FINISH(0)`
- `install`：`CMD_APP_CHECK`(随机 optionalName) → 设备落到 `/data/local/tmp/<random>.hap` → 执行 `bm install <options> -p <path>` → `CMD_APP_FINISH: [mode u8][ok u8][msg]`

## 三个未决问题（决定 WebUSB 路线可行性）

1. **版本漂移**：帧格式在 hdc 6.x（HarmonyOS NEXT）上被观察到变化——另一种说法是握手后变成 `[4 字节大端长度][payload]`。本仓库实现的是 `PayloadHead` 那一版。**必须先抓包确定目标设备用的是哪版。**
2. **USB 传输层**：`src/host/usb*.cpp` 决定了接口类/子类、端点分配、以及一次 bulk 写是否等于一帧。尚未通读。
3. **鉴权（最大未知）**：真机首连需要 RSA 签名。源码里常量清楚（`RSA_TOKEN_SIZE=20`、`RSA_KEY_BITS=3072`、`AuthVerify(token,sig,siglen)`、`PostUIConfirm`），但"token 与签名分别放在 `buf` 还是 `connectKey`、是否 base64、首连是否先发 `AUTH_PUBLICKEY`"这些**只能靠真机抓包确定**。

> 已知教训：另一份实现明确把 RSA 闭环标为"未实现、停止盲推"。盲推出来的"能跑"会被下一个人当成"已完成"，比写明未实现更危险。

## 真机实测（2026-11-20，HUAWEI Mate 70 Pro+ / OpenHarmony 7.0.0.111 / API 26）

数据来源：另一台机器上的执行 Agent 在**无管理员权限、无法安装 USBPcap** 的条件下，
改用 DevEco 自带 `libusb_shared.dll` 直接 claim 设备读取，以及 `hdc.exe` 静态字符串 + server 日志。
原始记录见 `report.md`（第 1/3/5 节）。

### 已确认（硬件级）

| 项 | 实测值 |
|---|---|
| 设备 | `PLA-AL10`（Mate 70 Pro+），VID:PID = **`12D1:1101`** |
| 系统 | `OpenHarmony-7.0.0.111`，API **26** |
| hdc | client `Ver: 3.2.0f`，daemon `Ver: 3.2.0f73c487f8b34a2ba5` |
| HDC 接口 | interface **#0**，`class=0xFF / subclass=0x50 / protocol=0x01`（vendor-specific） |
| 端点 | bulk **IN `0x81`**、bulk **OUT `0x01`**，`wMaxPacketSize=512`，`bInterval=0` |
| 设备驱动 | 绑定 **WINUSB**（`winusb.inf`） |
| 另一接口 | #1 = MTP/PTP（`0x82` interrupt、`0x83`/`0x02` bulk），与 HDC 无关 |

### 帧公式已在真机字节上验证

设备实际发出（bulk IN 24 字节）：

```
48 57 00 00 01 00 09 00 00 00 04  08 00 10 88 27 18 00 20 09  08 1E 12 00
└─ "HW" ·· ver  head=9   data=4 ┘ └──── 会话头 9 字节 ─────┘ └─ 负载 4 ─┘
```

解码结果：`headSize=9`、`dataSize=4`、`channelId=0`、`commandFlag=**5000**`、`checkSum=0`、`vCode=9`、
负载 `{1: 30, 2: 空}`。`11 + 9 + 4 = 24`，与实到字节数一致。

- `commandFlag=5000` + 递增计数 → 判定为**心跳**（hdc 日志里 `enablesupportfeatures: heartbeat,...` 佐证）
- 负载字段 1 在会话内单调 +1（`0x1E → 0x1F → 0x20`），跨会话重置 → 心跳序号

### 新发现：USB 传输层还有一层 `UB` 包头（手册未涵盖）

每个 HDC 帧前面还有 11 字节：

```
55 42 | 01 | sessionId(4, BE) | payloadLength(4, BE)
"UB"    ver   每会话变化/会话内恒定    恒等于紧随帧的字节数
```

三次独立会话的 `sessionId` 分别为 `82245E70` / `A791A61C` / `09EBAEF9`；
`payloadLength` 三次都精确等于随后 24 字节帧，`0x18 = 24`。

> `UB` 的语义名未在源码核实（可能是 USB 缩写）；但"它是长度前缀"有强证据。
> 因此 USB 上的读取流程是：**读 11 字节 → 取长度 → 读该长度的帧 → 解 `HW` 帧**。

### 鉴权（重要修正）

日志原文：

```
WorkThreadStartSession ... auth 0 send handshake hs: OHOS HDC
daemon auth type is rsa_3072_sha512 for ... session
load pubkey from file(...pub) success / Get pubkey info success / send pubkey over
Session handshake successful connType:0
load prikey success / sign success / response auth signture success
```

- **算法 = RSA-3072 + SHA-512**（`rsa_3072_sha512`）→ 签名应为 384 字节
- **已授权（`auth 0`）状态下，公钥下发与签名仍然发生**。
  即"撤销授权"只影响"设备侧挑战 → 弹窗确认"那条分支，**AUTH 主体流量不依赖撤销授权也能采到**。
  这一条推翻了本手册原先的假设，复抓时不必撤销授权。
- 握手字段名（日志级）：`banner / sessionId / authType / connectKey / version`，
  附加 `buf` 内：`emgmsg / devname / daemonauthstatus / 1200 / enablesupportfeatures`

### 仍然缺的三项（只能靠主动探测或抓包）

1. `SessionHandShake` 与 AUTH 交换的**实际字节**（公钥长度/开头、签名长度、字段编号与名字的对应）
2. 大块传输（如截图）是否被拆成 512 字节整倍数
3. 44 / 108 两种握手长度在本机属于哪种（USB 上可能根本不用 `ChannelHandShake`，那是 TCP 载体用的）

补这三项的工具：`tools/hdc_probe.py` —— 用 libusb 直接当客户端去握手并记录双向字节，
**不需要管理员权限与抓包驱动**（因为 `hdc kill` 后 `claim_interface(0)` 普通权限即成功，已实测）。

---

## 与 ADB 路线的关系

两条路互不干扰：`DeviceClient` 接口相同（connect / shell / screenshot / close），按 USB VID+PID 与探测结果选择实现。华为设备可能跑 Android（走 ADB，已实机验证 TNY-AL00）也可能跑 HarmonyOS（走 HDC），**不能只按 VID 判断**——按 VID 判断会把用户这台机器错误地挡掉。
