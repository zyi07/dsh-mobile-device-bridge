# HDC 文件传输 / HAP 安装 · 调研与实施方案（第 8 轮）

> 目标：在现有 WebUSB + HDC 通道上补齐 **文件 push/pull** 与 **HAP 安装**。
> 原则：**先说清事实来源，再动手**。凡是标 ⚠️ 的，都是尚未实证、必须在真机抓包确认的。

---

## 一、已核实的事实（可直接用于实现）

### 1.1 命令号（来源：`developtools_hdc/src/common/define_enum.h`，master）

```c
// File commands
CMD_FILE_INIT   = 3000
CMD_FILE_CHECK  = 3001
CMD_FILE_BEGIN  = 3002
CMD_FILE_DATA   = 3003
CMD_FILE_FINISH = 3004
CMD_APP_SIDELOAD= 3005
CMD_FILE_MODE   = 3006
CMD_DIR_MODE    = 3007

// App commands
CMD_APP_INIT    = 3500
CMD_APP_CHECK   = 3501
CMD_APP_BEGIN   = 3502
CMD_APP_DATA    = 3503
CMD_APP_FINISH  = 3504
CMD_APP_UNINSTALL = 3505
```

已确认的既有命令（我们已在用）：`HANDSHAKE=1`、`CHANNEL_CLOSE=2`、`UNITY_EXECUTE=1001`、
`SHELL_INIT=2000`、`SHELL_DATA=2001`、`HEARTBEAT=5000`。

### 1.2 结构体（来源：`src/common/transfer.h`）

```cpp
struct TransferPayload {   // 每个 FILE_DATA 包的前缀
    uint64_t index;            // 文件偏移
    uint8_t  compressType;     // 0=NONE,1=LZ4,2=LZ77,3=LZMA,4=BROTLI
    uint32_t compressSize;     // 本包压缩后长度
    uint32_t uncompressSize;   // 解压后长度
};

struct TransferConfig {    // CMD_FILE_INIT 的负载
    uint64_t fileSize;
    uint64_t atime;        // 纳秒
    uint64_t mtime;        // 纳秒
    string   options;
    string   path;          // 远端路径（pull 时是源路径）
    string   optionalName;
    bool     updateIfNew;
    uint8_t  compressType;
    bool     holdTimestamp;
    string   functionName;
    string   clientCwd;
    string   reserve1;
    string   reserve2;
};

struct FileMode {          // CMD_FILE_MODE / DIR_MODE 用
    uint64_t perm; uint64_t uId; uint64_t gId;
    string   context; string fullName;
};
```

关键常量：`payloadPrefixReserve = 64` —— 每个 DATA 包都会 **预留 64 字节** 放序列化后的
`TransferPayload`，**后面紧跟数据**；头部序列化后还会写一个 `'\0'` 结尾
（源码 `head.size() + 1` 一起 memcpy）。

### 1.3 序列化格式（来源：`src/common/serial_struct_define.h`）

**是 protobuf 兼容线格式**，不是定长二进制：

| C++ 类型 | wire type | 编码 |
|---|---|---|
| `uint32_t` / `uint64_t`（无 flags） | VARINT(0) | varint |
| `int32_t`（flags `s`） | VARINT(0) | zigzag varint |
| `bool` | VARINT(0) | 0/1 |
| `string` | LENGTH_DELIMITED(2) | len varint + 字节 |
| 嵌套 message | LENGTH_DELIMITED(2) | len + 内容 |

tag = `(字段号 << 3) | wireType`。

所以 `TransferPayload` 的字节布局是：
```
08 <index varint>         // field1 index
10 <compressType varint>  // field2 compressType
18 <compressSize varint>  // field3 compressSize
20 <uncompressSize varint>// field4 uncompressSize
```
不足 64 字节，其余补 0，末字节 `\0`，然后接数据。

> 推导依据：`transfer.cpp::SendIOPayload()` 把 `SerialStruct::SerializeToString(payloadHead)`
> 拷进 `sendBuf` 前 64 字节预留区；`payloadPrefixReserve = 64`。

### 1.4 我们在插件里已验证可用的部分（真机实测）

- 六步 AUTH（RSA-PSS/SHA-512/salt64）→ `SUCCESS`
- 命令通道：`flag=1001` + 随机非 0 `< 2^31` channelId，负载为纯文本；输出 `flag=10`；
  结束 `flag=2`（主机 `0x00` / 设备 `0x01`）
- 截图：`snapshot_display -f` + `base64` 读回（1316×2832 JPEG）
- 文件读写：`/data/local/tmp` 下写入/读回/删除均正常（shell 层）
- 设备信息：`PLA-AL10` / API 26 / `7.0.0.111(SP12C00E111R9P3)` / HongMeng Kernel 1.13.0
- 应用枚举：`bm dump -a` 返回 373 个包

### 1.5 HAP 安装的硬性要求（来源：华为开发者博客 / bm-tool 文档 / 社区实践）

| 事实 | 说明 |
|---|---|
| HAP 必须**签名** | 未签名包无法安装 |
| **调试签名绑定设备 UDID** | 调试 Profile（.p7b）里必须包含目标设备的 UDID，否则装不上 |
| 注册流程 | 取 UDID → 在 AppGallery Connect 把设备注册为调试设备 → 重新申请含该设备的调试 Profile → 用 `hap-sign-tool` 签名 |
| 命令 | `hdc install [-r] <hap>`；`-r` 覆盖安装保留数据；`-s` 用于 HSP 共享包（先装 HSP 再装入口 HAP） |
| 常见错误 | `9568322` 签名不匹配；`9568266` 需 debug 签名的企业应用；`9568337` 解析失败 |
| DevEco 自动签名 | Project Structure → Signing Configs → 登录华为账号 → Debug 自动生成（会把你当前连接的设备注册进去） |

**结论：插件不能自己"生成合法签名"**——签名依赖华为账号与开发者证书链。
所以安装能力的正确定位是：**调用 `hdc install` 等价流程，把用户已经签好的 HAP 推上去**，
并在签名/UDID 不匹配时把设备返回的错误码如实转达。

---

## 二、⚠️ 尚未实证、必须抓包确认的点

以下每一条都会影响字节级实现，**不确认就写代码等于猜**：

1. **CMD_FILE_INIT 之后 daemon 回什么**（回同样的 TransferConfig？还是状态字节？）
2. **CMD_FILE_BEGIN 的负载**（空？1 字节？还是 FileMode 序列化？）
3. **DATA 包的实际大小**（源码里有 `GetMaxBufSize()`/`GetUsbffsBulkSize()`，需要看真机一次发多少）
4. **DATA 包是否需要逐个 ACK**（transfer.cpp 有 `CMD_FILE_CHECK`，但触发条件不明）
5. **CMD_FILE_FINISH 的负载**（`uint8_t payload = 0` 见源码，成功/失败如何区分）
6. **pull（recv）方向**的发起方式：谁发 INIT、路径怎么给（`path` 字段写法、是否要 `-cwd`）
7. **`hdc install` 走的是 CMD_APP_***（3500+）还是 `CMD_UNITY_EXECUTE` 调 `bm install`**（两者都存在，需确认实际走哪条）
8. **DATA 包与 USB 512 字节分块的关系**（我们已验证 daemon 按 512 读 OUT）

---

## 三、抓包任务（交给本地 agent，用第 6 轮的 shim）

第 6 轮的 `usb_shim`（libusb 代理 DLL）已经能录真 hdc 的收发字节，直接复用：

```powershell
cd <shimrun 目录>
# 1) 小文件 push（观察 INIT/BEGIN/DATA/FINISH 全套）
hdc.exe file send C:\Users\ZY\Downloads\small.txt /data/local/tmp/small.txt
hdc.exe file send C:\Users\ZY\Downloads\mid.bin  /data/local/tmp/mid.bin      # 约 2~4 MB
# 2) pull
hdc.exe file recv /data/local/tmp/small.txt C:\Users\ZY\Downloads\small_back.txt
# 3) 安装（用一个已签名的 HAP；没有就跳过并说明）
hdc.exe install C:\Users\ZY\Downloads\app-signed.hap
# 4) 卸载
hdc.exe uninstall com.example.demo
# 5) 设备 UDID（安装相关）
hdc.exe shell "bm get --udid"
```

产出的 `usb_shim_*.log` 就是 O0 区（真 hdc 逐帧字节）。我要拿到：

| 需要的东西 | 用途 |
|---|---|
| `hdc file send` 全过程 OUT/IN 十六进制 | 确认 INIT/BEGIN/DATA/FINISH 的真实负载与顺序 |
| DATA 包长度序列 | 确认分包大小与是否 ACK |
| `hdc file recv` 的 OUT/IN | 确认 pull 的发起方向与路径写法 |
| `hdc install` 的帧 | 确认走 3500 还是 shell `bm install` |
| `bm get --udid` 输出 | 安装前置条件（Profile 是否包含该设备） |

**如果 `hdc install` 因为签名失败**，也请照抓——失败路径的帧同样有价值（错误码从哪来）。

---

## 四、实施方案（抓到包后按此落地，分三步）

### 步骤 1：文件 push/pull（核心）
- `hdc/transfer-codec.js`：protobuf 编码 `TransferConfig` / `TransferPayload`，含单测
  （用抓包字节逐字节回归，和当初做 `codec.js` 一样）
- `hdc/transfer.js`：`sendFile(path, bytes)` / `recvFile(path)`，按 `CMD_FILE_*` 状态机；
  每个 DATA 包 = 64B 前缀 + 数据；带进度回调
- 传输层补：**流式读**（大文件不能一次性进内存）、分包与背压

### 步骤 2：HAP 安装
- `hdc installHap(bytes|path, {replace})`：按抓包确认的路径实现；
  若确认走 shell，则用 `push → bm install -p` 组合
- 把设备返回的 `9568xxx` 错误码翻译成中文提示（签名/UDID/解析失败）

### 步骤 3：UI 与宿主桥
- 面板：文件拖拽/选择上传、下载输入路径、安装 HAP 按钮、进度条
- 宿主桥新增 `/mbridge/push`、`/mbridge/pull`、`/mbridge/install`，
  让我（或任何脚本）能直接调用

### 验证门槛（每步都要过）
1. 单元测试：编解码与抓包字节**逐字节一致**
2. 真机：小文件（<1KB）、中文件（2~4MB）、二进制文件的往返校验（sha256 比对）
3. 失败路径：路径不存在、无权限、空间不足，都要有明确错误

---

## 五、边界与风险（提前说明）

| 风险 | 说明 |
|---|---|
| 大文件内存 | 浏览器侧必须流式，否则 100MB 直接 OOM；实现里用分块 + 队列 |
| 压缩 | 源码默认 `COMPRESS_NONE`；LZ4 分支在 `HARMONY_PROJECT` 才编译，**不要假设可用** |
| 安装签名 | 签名合法性不由我们产生，安装失败多半是 UDID/Profile 问题，只能如实报错 |
| 版本差异 | 设备 daemon 是 `3.2.0f`，master 源码可能更新（AUTH 算法就已不同）。**以抓包为准，源码仅作结构参考** |
| 沙箱应用目录 | 往应用沙箱写文件需要 `-b bundleName` 与调试 HAP 权限，非 root 下大概率不可用 |

---

## 六、现在需要你做的

1. **把设备重连上**（面板点「连接设备」）——刚才掉了，`device: None`
2. 跑第三节的抓包任务（**这一步决定我写出来的代码一次对不对**）
3. 如果暂时没有已签名的 HAP，先只抓 `file send` / `file recv`，安装那步跳过并告诉我

拿到抓包我就按第四节落地，先做 `transfer-codec.js` 并用你的抓包字节做逐字节回归测试。
---

# 附录：2026-11-22 真机实测结论（已落地实现）

## A.1 文件传输（shell + base64 路线，**已实现并验证**）

| 项目 | 实测结果 |
|---|---|
| push（写入） | `echo -n '<b64>' \| base64 -d \| dd of=<path> bs=65536 seek=<n> conv=notrunc status=none` |
| pull（读回） | `base64 <path>`，设备按 ~512B 逐帧推流 |
| 校验 | `sha256sum`（**必须在命令后校验**） |
| 单条命令上限 | **≈128 KiB**；80KB 二进制成功、96KB 失败 → 分块 64KiB |
| 实测吞吐 | push ≈ 210 KB/s（1MB/4.9s）、pull ≈ 164 KB/s（1MB/6.4s） |
| 往返校验 | 512KB / 1MB 三次 sha256（本地·远端·拉回）全部一致 |

## A.2 必须避开的坑（都是真机踩出来的）

1. **`shell()` 不能把"空输出"当失败重试** —— `echo \| base64 -d` 正常无输出，
   重试会让命令执行两次；用 `>>` 追加时数据直接翻倍（实测 512KB 写成 983KB）。
   现改为：只有「没收到设备关闭帧」才重试。
2. **写命令失败走 stderr，我们只收 stdout** —— 往无权限目录写会"看起来成功"。
   现在 push 结束强制 `sha256sum` 校验，不一致即报错。
3. **HTTP 请求体上限 1 MiB** —— 1MB 文件 base64 后 1.4MB 会被拒（HTTP 100 后断开）。
   已放宽 push/install 至 128 MiB，并额外支持**分片提交**（`index`/`chunkSize`）。
4. **USB 句柄连续操作后可能失效** —— 需自动重连（已实现 `tryReconnectHdc`）。

## A.3 设备侧可用性（实测）

| 命令 | 结果 |
|---|---|
| `base64` / `sha256sum` / `dd` | ✅ 全部可用 |
| `bm install -p <hap>` / `bm uninstall -n <bundle>` | ✅ 存在 |
| shell 身份 | `uid=2000(shell) context=u:r:sh:s0` |
| 可写目录 | `/data/local/tmp` ✅；`/storage/media/100`、`/data/app/el1/bundle/public` ❌ |
| 设备 UDID | `<DEVICE_UDID>` |

## A.4 仍未做

- `CMD_FILE_*`（3000–3004）原生文件协议：**未抓包，未实现**。
  当前 shell 路线已够用；若要提速（目标 1MB/s 以上）需抓包后实现。
- HAP 安装：代码已就绪（推送 + `bm install -p` + 9568xxx 错误码翻译），
  但**尚未用真实已签名 HAP 验证**——需要 Profile 含上面 UDID 的调试签名包。
