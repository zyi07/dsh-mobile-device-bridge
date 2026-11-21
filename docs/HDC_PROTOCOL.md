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

## 源码核对结果（第三轮，已定位前两轮失败根因）

从 `openharmony/developtools_hdc` 拉到并核对了 `define.h` / `define_plus.h` / `define_enum.h` / `session.h`。

### USB 传输层结构体（`define_plus.h`，此前只能靠字节反推）

```c
struct USBHead {          // packed，实测 11 字节，与抓包完全吻合
    uint8_t  flag[2];     // "UB"
    uint8_t  option;      // enum UsbProtocolOption: HEADER=1, RESET=2
    uint32_t sessionId;
    uint32_t dataSize;    // 大端，等于紧随其后帧的字节数
};
```

### 会话头结构体（`session.h`，vCode 常量也在此）

```c
struct PayloadProtect {
    uint32_t channelId;
    uint32_t commandFlag;
    uint8_t  checkSum;
    uint8_t  vCode;       // payloadProtectStaticVcode = 0x09
};
```

### ★ 握手结构体与失败根因

```c
struct SessionHandShake {
    string  banner;       // f1  "OHOS HDC"
    uint8_t authType;     // f2  ← 第二个字段
    uint32_t sessionId;   // f3  ← 第三个字段
    string  connectKey;   // f4
    string  buf;          // f5
    string  version;      // f6
};
enum AuthType { AUTH_NONE=0, AUTH_TOKEN=1, AUTH_SIGNATURE=2, AUTH_PUBLICKEY=3, AUTH_OK=4, AUTH_FAIL=5 };
```

**第一轮探针把 f2/f3 写反了**（把随机 sessionId 塞进 f2，authType=4 塞进 f3）。
设备按 `authType` 解析 f2 得到随机大数 → 非法 auth type → **静默丢弃**。
这正是"`write rc=0` 但设备零回应、4 种外壳变体全失败"的原因。

修正后，用 `banner/authType=0/sessionId/connectKey/buf/version` 顺序重建的帧，
与已知真实抓包（53 字节）**逐字节一致**。

### 命令号（`define_enum.h: enum HdcCommand`，需要的几个）

| 值 | 名称 | 用途 |
|---|---|---|
| 1 | `CMD_KERNEL_HANDSHAKE` | 握手帧 |
| 2 | `CMD_KERNEL_CHANNEL_CLOSE` | 通道关闭（命令结束标志） |
| 4/5 | `CMD_KERNEL_TARGET_DISCOVER` / `_LIST` | 发现/列出设备 |
| 1001 | `CMD_UNITY_EXECUTE` | 一次性命令（shell 等） |
| 1200 | `CMD_UNITY_EXECUTE_EX` | 需 shell 特性位 |
| 2000/2001 | `CMD_SHELL_INIT` / `_DATA` | 交互式 shell |
| **5000** | `CMD_HEARTBEAT_MSG` | **心跳，即之前一直看到的那些帧** ✅ |

### 心跳报文（`session.h`）

```c
struct HeartbeatMsg { uint64_t heartbeatCount; string reserved; };
```

对照实测 `08 86 01 12 00` → f1=134（varint）、f2="" —— 完全吻合。
之前被误读为"小端计数器"的现象，本质是 **protobuf varint 的低字节在前**。

### 另外两条能解释现象的常量（`define.h`）

- `HEARTBEAT_INTERVAL = 5000`（5 秒心跳，与观察到的周期性一致）
- `NEW_SESSION_DROP_USB_DATA_TIME_MAX_MS = 1000`
  → 新会话开始时设备会丢弃 1 秒内的 USB 数据。这解释了"`UB.sid=0` 变体当时一个包都收不到"。

---

## 与 ADB 路线的关系

两条路互不干扰：`DeviceClient` 接口相同（connect / shell / screenshot / close），按 USB VID+PID 与探测结果选择实现。华为设备可能跑 Android（走 ADB，已实机验证 TNY-AL00）也可能跑 HarmonyOS（走 HDC），**不能只按 VID 判断**——按 VID 判断会把用户这台机器错误地挡掉。

## 第四轮前的事实修正（2026-11-20 夜）

上一轮结论「daemon 根本没在读 EP 0x01」**被其自身实验反证**：

> 发 `USBHead(option=USB_OPTION_RESET=2, dataSize=0)` 后设备心跳立即停止。

daemon 若不在读 OUT，不可能响应 RESET。因此：

- daemon **在读** EP `0x01`，且**正确解析** `USBHead`；
- 卡点在 `USBHead` 之后的处理，或"RESET 后如何建立新会话"；
- 已验证 `RESET` 不重启设备，仅清会话；之后 `hdc list targets` 会短暂 `[Empty]`，
  重新 `list targets` 即恢复。

下一轮两件事：① RESET 优先的会话重建序列（`tools/hdc_probe3.py`）；
② 读**设备侧 hilog** 里 hdcd 的日志——让设备自己说出拒绝原因，胜过继续猜帧。

## 第四轮结果（2026-11-20 夜 → 21 日凌晨）

### 已由 daemon 日志证实的两个根因

**R1｜UB 头与帧必须分两次 bulk 写**
合并成一次 61 字节写，daemon 会整包当软复位丢弃：

```
[SendToHdcStream:189] SendToHdcStream softreset dataSize:61 payloadSize:0 childRet:0
```

`payloadSize:0` 说明帧体 31 字节的握手负载被解析成 0，帧根本没被识别。

**R2｜`version` 必须与 daemon 完整版本串逐字节相等**

```
[DaemonSessionHandshake:1032] DaemonSessionHandshake failed!
    version not match [Ver: 3.2.0f] vs [Ver: 3.2.0f73c487f8b34a2ba5]
```

即客户端要声称 `Ver: 3.2.0f73c487f8b34a2ba5`（28 字符），不能用短版本。

对比真 hdc 成功时的路径（同一份日志）：

```
[DispatchToWorkThread:564] New session coming, restart old sessionId:225******822
[DispatchMainThreadCommand:1393] START_SESSION sessionId:273******239 instance:daemon
[RsaSignVerify:678] sign verify success for session 273******239
[HandDaemonAuthSignature:830] auth success for session 273******239
```

我们的帧（合并写时）只触发一条 `softreset ... payloadSize:0`，连 `START_SESSION` 都没进。

### RESET 语义（`USBHead.option = 2`）已确认

```
[ResetOldSession:233] Hostside softreset to restart daemon, old sessionId:0*0 isSoftReset:1
[DispatchMainThreadCommand:1399] STOP_SESSION sessionId:0*0
```

RESET 会停掉会话、心跳随之停止；之后需要**重新发起**会话，daemon 不会自己重建。
副作用：`hdc list targets` 会短暂 `[Empty]`，重新 list 即恢复；不重启设备。

### daemon 侧还有一个间歇性发送失败

```
[SendUSBBlock:91] SendUSBRaw index failed      ← daemon 想回包但发不出去
```

配合 `NEW_SESSION_DROP_USB_DATA_TIME_MAX_MS = 1000`，写完后需等待约 1 秒再读，
并对 STALL（`rc=-9 PIPE`）做 `clear_halt` 重试。

### 疑似 daemon 握手应答（待核实）

执行 Agent 报告拿到了如下应答，但**未把对应那次运行的 jsonl/hilog 一起提供**，
且其 `version` 字段是短串 `Ver: 3.2.0f`，与同一份日志里"短版本必然失败"的结论相冲突，
故暂列**待核实**：

```
UB : 55 42 01 00000000 00000032
HW : 48 57 00 00 01 00 08 00 00 00 1F
会话头: 08 00 10 01 18 00 20 09        (flag=1 = CMD_KERNEL_HANDSHAKE)
负载  : f1 banner "OHOS HDC" / f2 authType=3 (AUTH_PUBLICKEY) / f3 sid=0
        f4 connectKey="" / f5 buf="" / f6 version "Ver: 3.2.0f"
```

若成立，则 auth 流程为：
`AUTH_NONE(0) → daemon 回 AUTH_PUBLICKEY(3) → 客户端送公钥 → daemon 回 token → 客户端送签名 → AUTH_OK(4)`。
`tools/hdc_probe4.py` 即按此流程推进，并把收到的每个包原样记录以待核对。

## 第五轮结果（2026-11-21 凌晨）

### 第三个根因 R3：`USBHead.sessionId` 必须等于 daemon 当前会话 id

```
[CheckPacketOption:165] CheckPacketOption softreset
    header->sessionId:0*0  sessionId:154******913(L:10)
[SendToHdcStream:189] SendToHdcStream softreset dataSize:66 payloadSize:0 childRet:0
```

daemon 把 `header->sessionId` 与自身会话 id 比较，不一致就**当作主机发来的 softreset**
并丢弃负载（`payloadSize:0`）。`hdc_probe4.py` 的 Step 0 已学到 `dev_sid` 却硬编码发 0，
这是失败原因。改用它学到的 sid 后，`CheckPacketOption softreset` 消失。

### 新增硬事实：daemon 按 512 字节分块读 OUT

```
[SendToHdcStream:189] ... dataSize:512 payloadSize:0
[SendToHdcStream:189] ... dataSize:179 payloadSize:0
```

691 字节的 S2 帧被读成 512 + 179（合计 691 ✅）。发送侧不必自己切，但读取侧要能容忍分块。

### 当前唯一剩余阻塞

`[SendUSBBlock:91] SendUSBRaw index failed` —— daemon 想回包但**发送失败**，
因此拿不到 token。两个待验证假设：

- **H1 主机侧读饥饿**：daemon 回包时主机没有 pending 的 IN URB。
  对策：常驻读线程，让 IN 端点始终有未完成传输。
- **H2 会话生命周期**：daemon 仍持有上一次真 hdc 留下的旧会话，状态陈旧。
  对策：先发 `OPT_RESET` 再握手；或等旧会话自然超时后再握手。

`tools/hdc_probe5.py` 即按 H1/H2 做对照（P1 对照 / P2 RESET 先行 / P4 正确 sid + 常驻读 / P3 等超时）。
其 `classify()` 会把入站包判成 `heartbeat` / `handshake?`，避免再把心跳误报成 token。

## 第六轮：AUTH 全链已用真 hdc 的字节验证（2026-11-21）

执行 Agent 在**无管理员权限**下改用 **libusb 代理 DLL**（自写 `usb_shim.c` 导出 hdc.exe
import 的 24 个 libusb 函数、替换 `bulk_transfer`/`submit_transfer` 等 4 个、其余转发），
让**真 `hdc.exe`** 在一次完整会话里把收发字节全录下来。等价于 USBPcap 的应用层视图。

### 六步实证（每一帧都用本仓库 codec 独立解过，长度全部自洽）

| 步 | 方向 | 帧长 | `f2 authType` | `f3` | `f4 connectKey` | `f5 buf` |
|---|---|---|---|---|---|---|
| 0 | H→D | 11 | — | — | — | `USBHead(option=2/RESET, len=0)` |
| 1 | H→D | 180 | 0 `NONE` | **636423625** | `DSHDEVICE0000001` | 94B 特征串 |
| 2 | D→H | 99 | 3 `PUBLICKEY` | 0 | 空 | 33B `authtype        1               1` |
| 3 | H→D | 708 | 3 | 0 | 空 | **641B = 主机名 + `0x0C` + PEM** |
| 4 | D→H | 86 | 2 `SIGNATURE` | 0 | 空 | **20B token（纯 ASCII）** |
| 5 | H→D | 579 | 2 | 0 | 空 | **512 字符 base64 签名（=384 字节）** |
| 6 | D→H | 270 | 4 `AUTH_OK` | 0 | 空 | 203B，含 `SUCCESS` |

关键：**会话 id 由主机随机生成**，同一个值同时写进 `USBHead.sessionId` 与握手 `f3`
（实测 `0x25EF0DC9 = 636423625`）。这一点与早期"用 daemon 广播的 sid"完全相反。

### 修正前几轮的错误假设

| 早期假设 | 实证结果 |
|---|---|
| 公钥放 `connectKey(f4)`、格式 `ssh-rsa AAAA…` | ❌ 公钥在 **`f5(buf)`**，且是 **PEM**（`-----BEGIN PUBLIC KEY-----`） |
| 第一帧 `f5` 是空 | ❌ 是 94 字节特征串：`authtype 1 1supportfeatures 29 Ver: 3.2.0f,USB,win,heartbeat` |
| `connectKey` 每步都填序列号 | ❌ 只有第 1 帧填；AUTH 阶段为空 |
| token 是二进制 | ❌ 是 **20 个 ASCII 字符** |
| 只有设备发心跳 | ❌ **双向**，主机每 ~5s 也发 `commandFlag=5000` |

### 命令通道（同一次抓包内实证）

| 项 | 实测 |
|---|---|
| 命令帧 | `commandFlag=1001`（`CMD_UNITY_EXECUTE`），`channelId` **非 0 随机**（如 1309532605） |
| 命令负载 | 纯文本，**不带 `\0`**：`echo shim_probe3` |
| 输出帧 | `commandFlag=10`，负载带 `\n`：`7368696d5f70726f6265330a` |
| 结束 | `commandFlag=2` + 1 字节：主机发 `00`，设备回 `01` |

### 由此修掉的一个 codec bug

`decodeFrame` 原先**无条件把负载当 protobuf 解**。但负载并非总是 protobuf：
握手帧是，命令帧是纯文本，关闭帧是 1 字节裸值。现在改为容错解析
（解不出置 `null`，由 `commandFlag` 决定怎么读）。

### 已落地的代码与验证

- `src-client/hdc/session.js`：握手六步状态机 + 命令帧 + 心跳 + PEM/签名
- `src-client/hdc/fixtures.json`：真机六帧 + 命令帧 + 心跳帧（原始 hex）
- `src-client/hdc/session.test.mjs`：**用真机帧逐字节复现** step1/step3/step5/命令帧/心跳帧，
  并解析 daemon 三个应答，再让状态机沿真实应答走完全程（WebCrypto 生成的签名恰为 384 字节）
- `node session.test.mjs` → 全绿

### 传输层与插件接线（已完成，2026-11-21 凌晨）

- `src-client/hdc/transport.js`
  - `HdcTransport`：WebUSB 打开/claim、按 class `0xFF/0x50/0x01` 找接口、
    **11B 头与帧分两次 `transferOut`**、`RESET(option=2)`、读侧按 UB 头重组、
    STALL 时 `clearHalt`
  - `HdcSession`：`connect()` 走 RESET → 六步 AUTH → 心跳；`shell(text)` 走
    `flag=1001` 命令 + 收集 `flag=10` 输出 + `flag=2` 关闭
- 插件 UI 增加「Android / HarmonyOS」类型开关；HDC 分支用现场生成的 RSA-3072 密钥
  应答 AUTH，连上后用 `param get` 取机型与 API 版本展示
- 宿主桥（`/mbridge/exec`）自动适配两种通道

### 离线验证（无真机）

- `hdc/fake-device.mjs`：假 WebUSB 设备，回放真机字节，**故意把 IN 切成 7 字节小包**
  以压读取侧重组
- `hdc/transport.test.mjs`：8 项全绿，含
  「第一笔必须是 11B RESET 头」「头与帧不得合并成 191B 一次写」
  「经完整路径发出的 step1 与真机逐字节一致」「命令输出 `shim_probe3\n`」

### 仍未做

1. **真机端到端**：在真机上点「HarmonyOS → 连接设备」，验证 AUTH 与 `shell`
2. **HDC 截图**：需 `snapshot_display` + 文件传输（`file recv`），未实现
3. **假设待验**：daemon 是否只校验"当场送的公钥 vs 当场送的签名"。
   若它还要求公钥在已授权列表里，则需复用 hdc 的私钥（导入 PKCS#8）

## 第 7 轮：WebUSB 连不上的根因（实测，2026-11-21）

### 现象

Chrome 能枚举设备、能选中、能在授权后报错：

```
NetworkError: Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface.
```

### 三条实测证据

| 检查 | 结果 | 出处 |
|---|---|---|
| interface 0（`HDC Interface`）的驱动 | `Service = WINUSB`，`winusb.inf`，`USB\MS_COMP_WINUSB` | `driver_info.txt` |
| hdc server 在跑时 `libusb_open` | **-3 ACCESS**（连 open 都失败，走不到 claim） | `e1_claim.txt` |
| `hdc kill` 之后 | open **0 SUCCESS**、`claim(0)` **0 SUCCESS** | `c1_claim_after_hdc_kill.txt` |

对照组 `claim(1) = -12 NOT_SUPPORTED` 是正常的：MI_01 是 MTP（`WUDFWpdMtp`），不是 WinUSB。

### 结论

**根因是 `hdc server`（`hdc.exe`）常驻并独占打开 WinUSB 设备。**
Chrome 权限与驱动都没问题（设备甚至是 `MS_COMP_WINUSB`，WebUSB 的理想形态），
是 `open()` 拿不到独占句柄，Chrome 把它报成 `Unable to claim interface`。

**不是**驱动类型问题（排除 libusbK/usbdk 假设）、**不是**权限问题。

### 正确操作顺序

```
1) & "C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe" kill
2) 关闭 DevEco Studio（开着会自动拉起 hdc）
3) 之后不要再运行任何 hdc 命令
4) 立刻在浏览器里点「连接设备」
```

⚠️ 任何一条 hdc 命令（含 `hdc list targets`）都会让 server 重新抢占设备。

### 插件侧已做的适配

- `HdcTransport.open()` 记录失败发生在 `open` / `selectConfiguration` / `claim` 哪一步
- **`open` 阶段失败** → 判定为「被独占」，给出上述可复制的命令，
  而不是误导性的"去装 Android USB Driver"
- 退避重试 4 次 + 换新鲜句柄重试一次（应对授权瞬间的重新枚举）

## 第 8 轮：AUTH 全链路在浏览器里跑通（2026-11-21 深夜）

### 关键结论

1. **WebUSB 侧绝不能调用 `selectConfiguration`。** 一调用就会重置接口/端点，
   daemon 之后的发送全部失败（历史日志里的 `SendUSBRaw index failed`），表现为
   "设备一个字节都不发"。正确做法：直接从 `device.configurations[i].interfaces`
   描述符树找接口，**先 claim，失败才回退选配置**。
2. **签名算法是 RSA-PSS（SHA-512，saltLength=64），不是 PKCS#1 v1.5。**
   用真机抓包的 token + 签名 + 公钥离线验证：v1.5 对所有摘要都不通过，
   PSS/salt64 一次通过。源码里的 `rsa_3072_sha512` 指摘要，填充是 PSS。
3. **新密钥需要上机确认。** 提交公钥后若设备回
   `[E000002] The device unauthorized … DAEMON_UNAUTH`，说明它在等用户在手机上点允许；
   它**随即关闭会话**，所以不能原地等 token，必须重新握手。实测第 3 轮（用户点允许后）
   就拿到了 token 并 `authType=4 … SUCCESS`。
4. **channelId 必须 < 2^31。** 超过时 daemon 按 int32 处理成负数，
   每条命令都被**立即关闭通道且无输出**。

### 实测通过的顺序（r50 日志）

```
claim（未选配置）→ RESET → 握手(authType=0, buf=特征串)
← authType=3 PUBLICKEY（buf 33B "authtype 1 1"）
→ 送公钥（f5 = 主机名 + 0x0C + PEM）
← （第1、2轮）authType=4 + E000002 DAEMON_UNAUTH   ← 等用户上机确认
← （第3轮）authType=2 SIGNATURE，token 20B
→ 签名（RSA-PSS/SHA-512/salt64，512 字符 base64）
← authType=4 + "daemonauthstatus7 SUCCESS"         ← AUTH 完成
```
