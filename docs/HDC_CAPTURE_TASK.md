# HDC USB 抓包任务手册（交给执行 Agent）

> 目标：在一台**插着 HarmonyOS NEXT 真机**的电脑上，抓到 hdc 首次连接（含授权）的 USB 流量，
> 并按第 5 节模板产出结构化记录。
>
> 使用者：另一个 AI Agent 或人。这份手册里每一步都是可执行的，不需要理解 HDC 协议。
> 时间盒：**45 分钟**。超时就交付已拿到的部分，不要空手回。

---

## 0. 任务边界（先读，避免踩线）

**要做**
- 采集 USB 流量、版本信息、设备信息
- 把结果整理成 `report.md`
- 保留原始 `.pcapng`

**不要做**
- 不要刷机、不要 root、不要装/卸任何应用
- 不要 `hdc target boot`（会重启设备）、不要 `hdc file send/recv` 到系统目录
- 不要动与目标手机无关的 USB 设备
- 不要为了"抓得更全"而反复插拔超过 3 次

**如果卡住**：按第 7 节降级，仍然交付。**明确写出"哪一步失败、报错原文"比勉强凑数据更有价值。**

---

## 1. 环境自检（每项都要记录「命令」+「原始输出」）

按顺序执行并把输出原样贴进 `report.md` 的「1. 环境」小节。

### 1.1 操作系统与抓包工具
```powershell
# Windows
[System.Environment]::OSVersion.VersionString
& "C:\Program Files\Wireshark\tshark.exe" -v
& "C:\Program Files\USBPcap\USBPcapCMD.exe" --help
```
```bash
# Linux
uname -a
tshark -v
```

### 1.2 hdc 工具链
```powershell
where.exe hdc
hdc -v
hdc checkserver
```
> 若 `where hdc` 找不到，去 DevEco Studio 安装目录找：
> `...\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`
> 记录**完整路径**，后续命令都用绝对路径。

### 1.3 设备信息
```powershell
hdc list targets -v
hdc shell param get const.product.model
hdc shell param get const.product.brand
hdc shell param get const.ohos.apiversion
hdc shell param get const.ohos.fullname
hdc shell param get const.build.characteristics
```

### 1.4 USB 层信息（协议实现要用）
Windows（PowerShell）：
```powershell
Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -like "*USB*" } |
  Select-Object Status,Class,FriendlyName,InstanceId | Format-Table -AutoSize
```
记录手机的 **VID / PID**（后面抓包过滤器要用）。

Linux：
```bash
lsusb
lsusb -v -d <VID>:<PID> 2>/dev/null | grep -A3 -E "bInterfaceClass|bEndpointAddress|wMaxPacketSize"
```

### 1.5 确认没有别的程序抢设备
```powershell
Get-Process adb,studio64,devecostudio,HiSuite,scrcpy -ErrorAction SilentlyContinue |
  Select-Object Id,ProcessName
```
有输出就**结束它们**（`Stop-Process -Id <id> -Force`），并记录"结束了哪些"。

---

## 2. 制造"全新授权"场景（关键，别跳过）

AUTH 握手只在**设备尚未信任这台电脑**时发生。如果之前授权过，抓包根本看不到鉴权段。

1. 手机上进入开发者选项：
   - HarmonyOS NEXT：`设置 → 系统 → 开发者选项`
   - 旧版：`设置 → 系统和更新 → 开发人员选项`
2. 确认已开启：**USB 调试**（NEXT 上叫「允许 HDB 调试」/「USB 调试」）
3. 点击 **「撤销 USB 调试授权」** → 确认
4. 记录：撤销前后的界面状态（截图或文字描述）

> 如果这个选项不存在，退而求其次：在**另一台从未连过该手机的电脑**上抓包。若两者都做不到，
> 记录实际情况，继续抓"普通命令"段（段 B），并在 report 里写明「未捕获 AUTH」。

---

## 3. 抓包（**分两段，不要一次录到底**）

分成两段是因为：一次会话几百个 URB 混在一起，握手和 AUTH 会被淹没。

### 3.1 选对 USBPcap 接口

Wireshark 里 `接口列表` 会出现 `USBPcap1` / `USBPcap2` / `USBPcap3`……，对应不同 USB 根集线器。

**判断方法**：手机**先别插**，逐个开始捕获，然后插上手机；哪个接口能看到
`USB device attached`（或 `GET_DESCRIPTOR`）事件，就选它。

> 常见坑：手机插在 USB3 口时，某些 USBPcap 版本抓不到。**优先插 USB2 口**（黑色/白色口，不是蓝色）。

命令行等价做法（无 GUI，更可控）：
```powershell
& "C:\Program Files\USBPcap\USBPcapCMD.exe" -d \\.\USBPcap2 -o auth.pcap
```

### 3.2 段 A：授权握手（**最高优先级**）

```
① 开始捕获 → 输出到 auth.pcapng
② 插上手机，保持屏幕解锁
③ hdc kill
④ hdc list targets          ← 手机会弹「是否允许调试」→ 点「允许」（建议勾选"始终允许"）
⑤ 等 5 秒，让握手收尾
⑥ 停止捕获 → 保存为 auth.pcapng
```

若 ④ 之前手机关联已存在授权，就不会弹窗——这时记录「未弹出授权框」，并把 ③ 改成
在手机上先执行第 2 节的撤销授权。

### 3.3 段 B：普通命令（**必须做**，用来定位端点与帧边界）

```
① 开始捕获 → cmd.pcapng
② hdc list targets
③ hdc shell echo hello
④ hdc shell param get const.product.model
⑤ hdc shell snapshot_display -f /data/local/tmp/agent_probe.jpeg
⑥ hdc shell rm /data/local/tmp/agent_probe.jpeg
⑦ 停止捕获 → cmd.pcapng
```

> ⑤ 是为了让抓包里出现一次**大块数据传输**（截图），方便判断一帧是否等于一次 bulk 传输。
> ⑥ 把探针文件删掉，不要留在设备上。

---

## 4. 必录信息（按项抄，缺哪项就写"未获得"）

### 4.1 握手包（判断 44 还是 108 字节、version 串）

用 tshark 精确抽取（比截图可靠）。**用 `-x` 打 hex+ASCII，不要用 `-e usb.capdata`**——
那个字段在 bulk 传输上经常为空（它主要对应 control 传输），照它取会得到一堆空白：

```powershell
# 列出前 40 个 bulk 传输的元信息
tshark -r auth.pcapng -Y "usb.transfer_type==0x03" -T fields -e frame.number -e usb.endpoint_address -e usb.data_len | Select-Object -First 40

# 打前 12 个 bulk 传输的完整字节（hex + ASCII），这个一定有内容
tshark -r auth.pcapng -Y "usb.transfer_type==0x03" -x -c 12
```
> 若 `-x` 出来的仍是空块，改用 `-Y "usb.data_len > 0"` 再试；再不行就用 GUI 里
> 右键包 → Follow → 或 Copy → as Hex Dump。

**要记录**：
- 第一个 bulk **IN** 包的完整 hex（应为 44 或 108 字节）
- 同包的 ASCII 视图（能直接看到 `OHOS HDC` 和版本串）
- 客户端回的那个包（同长度）的完整 hex

> 已知：设备侧 daemon 是"先发话"的一方，但 USB 是**主机驱动**的总线，
> 所以你会先看到主机发出 bulk IN 请求（URB），响应数据才带握手内容。
> **判断依据是"有数据的那个 bulk IN"，不是"第一个 IN 包"**——前面可能有 0 长度的占位 URB。

### 4.2 AUTH 段（本任务的核心产出）

在 `auth.pcapng` 里找 AUTH 相关包。特征：
- 握手完成后、`hdc list targets` 返回设备号之前的若干个小包
- 方向交替（OUT 挑战 / IN 回应）

用这个过滤看"握手之后的头 20 个 bulk 包"：
```powershell
tshark -r auth.pcapng -Y "usb.transfer_type==0x03" -T fields `
  -e frame.number -e usb.endpoint_address -e usb.data_len -e usb.capdata | Select-Object -Skip 2 -First 20
```

**要记录（每个包一条，逐条填表）**：

| 序号 | 方向(IN/OUT) | 长度 | 完整 hex（≤512 字节全贴，超过则贴前 128 + 后 32） |
|---|---|---|---|
| 1 | | | |
| 2 | | | |

**特别标注以下三件事**（有就写有，没有明确写"未见"）：
1. 有没有**设备先发的挑战 token**？长度是否为 20 字节？
2. 有没有**客户端回的公钥**？长度多少？是否以 `ssh-rsa` / `AAAA` 之类开头？
3. 有没有**客户端发的签名**？长度是否为 384 字节（RSA-3072）？

### 4.3 USB 端点与接口（WebUSB 实现要用）

从 `cmd.pcapng` 里取：
```powershell
tshark -r cmd.pcapng -Y "usb.transfer_type==0x03" -T fields `
  -e usb.bus_id -e usb.device_address -e usb.endpoint_address -e usb.data_len |
  Sort-Object | Get-Unique | Select-Object -First 20
```

**要记录**：
- 设备 bus / device address
- 用到的 **bulk IN 端点号** 与 **bulk OUT 端点号**（十六进制，如 `0x81` / `0x02`）
- 接口描述符里的 `bInterfaceClass` / `bInterfaceSubClass` / `bInterfaceProtocol`
- `wMaxPacketSize`（通常 512）

取接口描述符：
```powershell
tshark -r cmd.pcapng -Y "usb.bDescriptorType==4" -T fields `
  -e usb.bInterfaceClass -e usb.bInterfaceSubClass -e usb.bInterfaceProtocol
```

### 4.4 帧边界（解决"版本漂移"）

**要记录**：`cmd.pcapng` 里前 20 个 **bulk OUT** 传输的长度列表，以及截图那次的长度序列。

```powershell
# direction==0 是 OUT（主机→设备），1 是 IN
tshark -r cmd.pcapng -Y "usb.transfer_type==0x03 && usb.endpoint_address.direction==0" -T fields -e frame.number -e usb.data_len | Select-Object -First 20
```

判断并写明结论（三选一）：
- **(a) 一次 bulk 写 = 一帧**（长度分布离散，且能对上 `11+head+data`）
- **(b) 帧前有 4 字节大端长度前缀**
- **(c) 一帧被拆成多次 bulk 传输**（出现大量 512 字节整倍数）

**结论直接写进 report 的「4.4 结论」**，这是我最需要的一条。

---

## 5. 交付物与 report.md 模板

### 5.1 必须交付的三个文件
1. `auth.pcapng` —— 授权段原始抓包
2. `cmd.pcapng` —— 命令段原始抓包
3. `report.md` —— 按下面模板填写

### 5.2 report.md 模板（照抄结构，填内容）

```markdown
# HDC 抓包记录

## 1. 环境
- 操作系统：
- hdc 路径：
- hdc -v：
- hdc checkserver：
- tshark 版本：
- USBPcap 版本 / 使用的接口名：
- 手机型号：
- HarmonyOS 版本 / API version：
- 设备 VID:PID：
- 抓包前结束了哪些进程：

## 2. 授权场景
- 是否执行了「撤销 USB 调试授权」：是/否
- 连接时手机是否弹出授权框：是/否
- 是否点击了「允许」：是/否（勾选"始终允许"：是/否）

## 3. 握手
- 第一个 bulk IN 包长度：      __ 字节（44 还是 108？）
- 完整 hex：
  ```
  （粘贴）
  ```
- ASCII 视图（看到 OHOS HDC / 版本串）：
  ```
  （粘贴）
  ```
- 客户端回应包长度：__ 字节，完整 hex：
  ```
  （粘贴）
  ```

## 4. AUTH 段
- 是否捕获到 AUTH：是/否
- 包清单表（序号/方向/长度/hex）：

| 序号 | 方向 | 长度 | hex |
|---|---|---|---|
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |
| 4 |  |  |  |

- 设备挑战 token 长度：__ 字节（是否 20？）
- 客户端公钥长度：__ 字节，开头 16 字节：
- 客户端签名长度：__ 字节（是否 384？）
- 未捕获 AUTH 时，说明原因：

## 5. USB 端点
- bus / device address：
- bulk IN 端点：
- bulk OUT 端点：
- bInterfaceClass / SubClass / Protocol：
- wMaxPacketSize：

## 6. 帧边界结论
- bulk OUT 长度列表（前 20）：
- 截图那次传输的长度序列：
- 结论：(a) 一次 bulk = 一帧 / (b) 有 4 字节长度前缀 / (c) 一帧被拆分
- 依据（能对上 11+head+data 的实例）：

## 7. 失败与降级
- 哪一步失败：
- 报错原文（完整，不要概括）：
- 已尝试的替代方案：
- 结论：哪几项仍未获得

## 8. 附加说明
- 任何异常现象（设备重连、hdc 自动重启、驱动提示等）
```

---

## 6. 字段速查（万一只能手抄）

从 hex 里可以直接认出来的东西：

| 特征 | 含义 |
|---|---|
| `4f 48 4f 53 20 48 44 43` | ASCII `OHOS HDC` —— 握手 banner 起点 |
| `48 57` 开头 | `"HW"` —— HDC 帧头 magic（PayloadHead 版本） |
| `... 20 09` | 会话头末尾 `vCode = 0x09` 魔数 |
| `00 0c` / `00 1e` | headSize=12 / dataSize=30 的典型值（大端） |
| `73 73 68 2d 72 73 61` | ASCII `ssh-rsa` —— 公钥文本格式 |
| `41 41 41 41` + 后接 `42 33 4e 7a` | `AAAA` + `B3Nz` —— SSH 公钥 base64 开头 |

**只要能看到 `OHOS HDC` 那一段加上紧随其后 2～6 个 bulk 包，我就能开工。**

---

## 7. 降级方案（按顺序尝试）

| 情况 | 处理 |
|---|---|
| 没有 USBPcap | 装 Wireshark 时勾选 USBPcap 组件；或单独下载 USBPcap 1.5+ |
| USBPcap 抓不到手机（USB3 口） | 换 USB2 口；换根集线器；换一根数据线 |
| hdc 连不上设备 | 回到第 2 节确认 USB 调试已开；换线；换口；`hdc kill` 后重试 |
| 完全抓不到包 | 交付 `report.md` 里第 1、2、7 节 + `hdc` 的所有输出；**明确写"未捕获"** |
| Linux 环境 | `sudo modprobe usbmon` → `lsusb` 找 bus → `sudo tshark -i usbmon<N> -w auth.pcapng`；注意 udev 权限 |

---

## 8. 自查清单（交付前逐项打勾）

- [ ] `hdc -v` 输出已记录
- [ ] 手机型号 + HarmonyOS 版本已记录
- [ ] `auth.pcapng` 存在且 > 10 KB
- [ ] `cmd.pcapng` 存在且 > 10 KB
- [ ] 第一个 bulk IN 包的**完整 hex** 已贴（长度写明 44/108）
- [ ] AUTH 段包清单已填；若无，写明原因
- [ ] bulk IN / OUT 端点号已记录
- [ ] 帧边界结论已给出 (a)/(b)/(c) 之一
- [ ] 失败步骤的**报错原文**已贴（不是概括）
- [ ] 设备上没有遗留探针文件（`/data/local/tmp/agent_probe.jpeg` 已删）

---

## 9. 提醒（给执行 agent）

- 这个任务的产出**不是"看起来成功了"，而是可核对的字节**。宁可贴长 hex，不要写"握手正常"。
- 任何"我推测/应该/大概是"的表述都要标注 `[推测]`，与实测区分开。
- 完成或卡住都请立即交付 `report.md`，不要为了完美而超时。
