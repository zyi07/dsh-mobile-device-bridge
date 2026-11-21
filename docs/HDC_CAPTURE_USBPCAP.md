# HDC 抓包任务手册 · 第 6 轮（USBPcap 版，需管理员）

> **这一轮的性质变了**：前五轮抓的是"我们自己构造的包"，本轮要抓的是
> **真 `hdc.exe` 与设备 daemon 之间的一次完整会话**。
>
> 它能一次性回答前五轮剩下的全部问题：
> ①②③ 真实握手 / 公钥 / 签名三段字节 ④20 字节 token ⑤每次写是分块还是一次
> ⑥daemon 回包时主机侧在做什么（对应 `SendUSBRaw index failed`）
>
> 执行者需要**管理员权限**（USBPcap 要装内核过滤驱动）。
> 时间盒：**45 分钟**。超时就交付已拿到的部分。

---

## 0. 边界（先读）

**要做**：装抓包组件、抓 USB 流量、用 tshark 导出字节、填报告。

**不要做**
- 不刷机、不 root、不装卸应用、不改开发者选项以外的系统设置
- 不 `hdc target boot`（会重启设备）
- 不动与目标手机无关的 USB 设备（本机有个 `OrayUSBVHCI` 虚拟设备，别碰）
- 抓包期间不要开 Android Studio / DevEco Studio / 手机助手 / scrcpy（会干扰设备状态）

**关键前提**：本轮**必须**用管理员身份运行抓包工具。上一轮之所以失败，就是进程无提权令牌
（`IsAdmin: False`、`Mandatory Label\Medium`、`BUILTIN\Administrators ... deny only`）。

---

## 1. 安装抓包组件（管理员）

### 1.1 装 Wireshark + USBPcap

1. 下载 Wireshark 官方安装包（3.6 或 4.x 均可）。
2. 安装时**必须勾选** `Install USBPcap`（在组件列表里，默认是未选）。
3. 装完**重启一次**（USBPcap 驱动要生效）。
4. 验证（管理员 PowerShell）：

```powershell
where.exe tshark
& "C:\Program Files\Wireshark\tshark.exe" -v
Get-Service | Where-Object { $_.Name -match "USBPcap|npcap|npf" } | Select-Object Name,Status
Test-Path "C:\Program Files\USBPcap\USBPcapCMD.exe"
```

> 若公司策略禁止安装驱动，走第 8 节的替代方案（Linux + usbmon），不要硬装。

### 1.2 记录环境（贴进报告）

```powershell
[System.Environment]::OSVersion.VersionString
whoami /groups | Select-String "Administrators|Mandatory"
& "C:\Program Files\Wireshark\tshark.exe" -v
hdc -v
hdc checkserver
where.exe hdc
```

`hdc` 若不在 PATH，用绝对路径（上一轮实测位置）：
`C:\Program Files\Huawei\DevEco Studio\sdk\default\openharmony\toolchains\hdc.exe`

---

## 2. 准备设备（为了抓到完整 AUTH）

**必须让设备重新走一次完整授权**，否则抓不到 token/签名那段。

1. 手机：`设置 → 系统 → 开发者选项`
2. 确认 **USB 调试** 已开启
3. 点 **「撤销 USB 调试授权」** → 确认
4. 记录：撤销前后的界面（截图或文字）

> 如果这个菜单项不在，退而求其次：**换一台从未连过该手机的电脑**。
> 两者都做不到，就照常抓（能拿到握手与 daemon 应答，只是可能缺 token 段），并在报告里写明。

---

## 3. 关键一步：找对 USBPcap 接口

手机先用**USB2 口**（黑/白口，不要蓝色 USB3 口）——上一轮设备挂在 USB3 根集线器上，
USBPcap 在部分版本上对 xHCI 抓取不稳。

```powershell
# 列出所有可抓接口，找 \\.\USBPcapN
& "C:\Program Files\Wireshark\tshark.exe" -D
```

输出里会有 `\\.\USBPcap1`、`\\.\USBPcap2`……每个对应一个 USB 根集线器。

**确定哪一个**：先用别的方法让手机产生流量（插上再拔），逐个试抓 3 秒，哪个能看到
`USB device attached` 或 `GET_DESCRIPTOR` 就是对的。也可以直接用设备管理器对照：

```powershell
Get-PnpDevice -PresentOnly |
  Where-Object { $_.InstanceId -like "*USB*" -and $_.FriendlyName -match "HDC|HUAWEI|PLA" } |
  Select-Object Status,Class,FriendlyName,InstanceId | Format-Table -AutoSize
```

记录：你最终用的是 `\\.\USBPcapX` 里的哪个。

---

## 4. 抓包 · 段 A：完整授权会话（**最重要**）

**目标**：拿到"首次授权"全过程——握手 → daemon 要公钥 → 客户端送公钥 → daemon 发 token
→ 客户端送签名 → AUTH OK。

### 4.1 顺序（严格按这个来）

```
① 确保手机未插、hdc 没在跑
   hdc kill
   记录：当前时间（精确到秒）

② 开始抓包（管理员）
   tshark -i \\.\USBPcapX -w hdc_auth.pcapng -q
   （或 GUI：Wireshark 选该接口 → 开始捕获）

③ 插上手机（保持屏幕解锁）

④ 记录时间，然后执行：
   hdc list targets
   —— 手机会弹「是否允许 USB 调试」→ 点「允许」（建议勾"始终允许"）
   —— 若 10 秒内没弹窗，说明撤销授权没生效，记录实际情况继续

⑤ 再执行：
   hdc shell echo hdc_capture_marker
   hdc shell param get const.product.model

⑥ 停抓（tshark 按 Ctrl+C；GUI 点停止）

⑦ 立刻再跑一条大块传输的（可选，用于看分片）：
   重新开抓 → hdc shell snapshot_display -f /data/local/tmp/cap_probe.jpeg
   → 停抓 → 存 hdc_big.pcapng
   → hdc shell rm /data/local/tmp/cap_probe.jpeg    ← 删掉探针文件
```

### 4.2 每条命令都要记时间

在报告里按这种格式记（**这是后续对齐 pcap 时间戳的唯一依据**）：

| 序号 | 墙上时间 | 执行的命令 | 结果 |
|---|---|---|---|
| 1 | 00:15:30 | hdc kill | Kill server finish |
| 2 | 00:15:35 | 开始抓包 | — |
| 3 | 00:15:40 | 插上手机 | 设备管理器出现 HDC Interface |
| 4 | 00:15:42 | hdc list targets | 手机弹窗→允许 |
| 5 | 00:15:50 | hdc shell echo ... | hdc_capture_marker |

---

## 5. 抓包 · 段 B：已授权常规会话（对照用，可选但建议）

撤销授权后再抓一次，用于区分「授权分支」与「已授权分支」的差异：

```
① hdc kill
② 开抓 → hdc list targets → hdc shell echo second_run → 停抓
③ 存 hdc_normal.pcapng
```

---

## 6. 用 tshark 导出（**不要靠截图**）

### 6.1 先看宏观：抓到了多少个 bulk 传输

```powershell
tshark -r hdc_auth.pcapng -Y "usb.transfer_type==0x03" -T fields `
  -e frame.number -e usb.endpoint_address -e usb.data_len | Measure-Object -Line
```

> 期望：几十到几百个。如果只有几条，说明抓错接口或没抓到设备流量。

### 6.2 按方向分离（**这是本轮核心产出**）

```powershell
# 主机 → 设备（OUT，端点 0x01）：真实 hdc 发出的每一段字节
tshark -r hdc_auth.pcapng -Y "usb.transfer_type==0x03 && usb.endpoint_address==0x01" -x > out_host_to_device.txt

# 设备 → 主机（IN，端点 0x81）：daemon 的应答（含 token）
tshark -r hdc_auth.pcapng -Y "usb.transfer_type==0x03 && usb.endpoint_address==0x81" -x > in_device_to_host.txt
```

⚠️ **必须用 `-x`**。上一轮已经踩过：`usb.capdata` 字段在 bulk 传输上经常为空，
按它取会得到一堆空白。`-x` 打印 hex+ASCII，一定有内容。

若 `usb.endpoint_address==0x01` 语法报错，改用：
`-Y "usb.transfer_type==0x03 && usb.endpoint_address.direction==0"`（0=OUT，1=IN）。

### 6.3 只要长度序列（看分块）

```powershell
tshark -r hdc_auth.pcapng -Y "usb.transfer_type==0x03 && usb.endpoint_address.direction==0" `
  -T fields -e frame.number -e usb.data_len | Select-Object -First 60
```

### 6.4 时间线（对齐我给的命令时间）

```powershell
tshark -r hdc_auth.pcapng -Y "usb.transfer_type==0x03" `
  -T fields -e frame.time_relative -e usb.endpoint_address -e usb.data_len | Select-Object -First 80
```

---

## 7. 我要从抓包里取什么（你按这个自检）

在 `out_host_to_device.txt` 里，按出现顺序找下面五段。**找到了就在报告里标出行号**。

| # | 目标 | 识别特征 |
|---|---|---|
| ① | 第一段：会话握手 | ASCII 里有 `OHOS HDC`；hex 里有 `48 57`（"HW"）和结尾 `20 09`（vCode） |
| ② | 公钥段 | ASCII 里有 `ssh-rsa` 或 `AAAA`（hdc 用的是 SSH 文本公钥） |
| ③ | token 段（设备侧） | 在 `in_device_to_host.txt` 里，长度很小（约 20 字节 payload） |
| ④ | 签名段 | 长度很大（**RSA-3072 签名 = 384 字节**，加帧头后约 400+） |
| ⑤ | 分块规律 | `usb.data_len` 序列：是 11 一次、还是 11+大包、有没有 512 整除 |

**同时回答这三个对照问题**（这是解 `SendUSBRaw index failed` 的关键）：

1. 真实 hdc 的**第一段**是 `USBHead(option=?)`，`sessionId` 填的是什么？（0 / 设备的 / 别的）
2. 它的 `UB 头` 与 `帧` 是**两次独立 bulk 传输**还是**一次**？
3. 每一步之间有没有明显时间间隔（`frame.time_relative` 差值）？特别是握手→公钥→签名之间。

---

## 8. 降级方案

| 情况 | 处理 |
|---|---|
| 装不上 USBPcap（策略/无权限） | 用 Linux 机器：`sudo modprobe usbmon` → `lsusb` 找总线号 → `sudo tshark -i usbmon<N> -w hdc_auth.pcapng`；或 `tcpdump -i usbmon<N>` |
| `tshark -D` 看不到 USBPcapN | 驱动没生效 → 重启；确认装的是"完整"版 Wireshark 且勾了 USBPcap |
| 抓到了但全是 MTP 流量 | 用 `-Y "usb.endpoint_address==0x01 or usb.endpoint_address==0x81"` 过滤出 HDC 接口 |
| pcap 太大（>200MB） | 只保留 30 秒窗口；或用 `-s 65535` 设 snaplen、`-a duration:30` 限时 |
| 手机不弹授权窗 | 说明撤销没生效；照常抓"已授权"分支，并在报告写清 |
| 完全抓不到 | 交付报告第 1、2、8 节 + 命令输出，明确写"未捕获" |

---

## 9. 交付物

| 文件 | 必须 | 说明 |
|---|---|---|
| `hdc_auth.pcapng` | ✅ | 段 A 原始抓包（授权会话） |
| `out_host_to_device.txt` | ✅ | `tshark -x` 导出的 OUT 字节 |
| `in_device_to_host.txt` | ✅ | `tshark -x` 导出的 IN 字节 |
| `hdc_big.pcapng` | 建议 | 截图大块传输，用于看 512 分块 |
| `hdc_normal.pcapng` | 建议 | 已授权会话对照 |
| `report6.md` | ✅ | 按下面模板 |

> pcapng 若太大，可直接上传原始文件；我会自己解析（不需要你装解析工具）。

### report6.md 模板

```markdown
# HDC USBPcap 抓包记录（第 6 轮）

## 1. 环境
- 是否以**管理员**运行：是/否（贴 whoami /groups 里 Administrators 与 Mandatory 两行）
- Wireshark 版本：
- USBPcap 版本 / 使用的接口：\\.\USBPcap__
- hdc 路径与版本：
- 手机型号 / HarmonyOS 版本 / API：
- 设备 VID:PID：
- 手机插在：USB2 口 / USB3 口

## 2. 设备准备
- 是否执行「撤销 USB 调试授权」：是/否
- 抓包时手机是否弹出授权框：是/否，是否点了允许：是/否

## 3. 命令时间线
| 序号 | 墙上时间 | 命令 | 结果 |
|---|---|---|---|
| 1 |  |  |  |
| 2 |  |  |  |
| 3 |  |  |  |

## 4. 抓包规模
- bulk 传输条数：
- OUT 条数 / IN 条数：
- 抓包总时长（秒）：

## 5. 五段字节（在导出文件里的行号）
| # | 内容 | 找到？ | 在 out_*.txt 的行号 | 备注 |
|---|---|---|---|---|
| ① | 会话握手（含 OHOS HDC） |  |  |  |
| ② | 公钥（ssh-rsa ...） |  |  |  |
| ③ | token（IN 方向，约 20B） |  |  |  |
| ④ | 签名（约 384B） |  |  |  |
| ⑤ | 分块规律 |  |  |  |

## 6. 三个对照问题的答案
1. 第一段的 USBHead(option/sessionId) 是：
2. UB 头与帧是两次传输还是一次：
3. 握手→公钥→签名之间的时间间隔：

## 7. 原始 hex（关键段直接贴，不要概括）
① 第一段 OUT 全文：
```
（贴 hex + ASCII）
```
② 公钥段 OUT 全文（若太长，贴前 128 字节 + 说明总长）：
```
（贴）
```
③ IN 方向在"②之后"收到的第一个包：
```
（贴）
```

## 8. 失败与降级
- 哪一步失败：
- 报错原文（完整）：
- 已尝试的替代：
- 哪些项仍未获得：

## 9. 设备最终状态
```
hdc list targets -v
hdc shell echo final_ok
```
```

---

## 10. 交付前自查

- [ ] 抓包时确实是**管理员**（贴出 whoami 证据）
- [ ] `out_host_to_device.txt` 里能看到 `OHOS HDC`
- [ ] `out_host_to_device.txt` 里能看到 `ssh-rsa`
- [ ] `in_device_to_host.txt` 里有非心跳的短包（候选 token）
- [ ] `usb.data_len` 序列已贴（判断分块用）
- [ ] 报告第 6 节三个问题都答了
- [ ] 设备上没有遗留探针文件（`/data/local/tmp/cap_probe.jpeg` 已删）
- [ ] 设备最终 `hdc list targets -v` 正常

---

## 11. 我会怎么用它

1. 用 `out_host_to_device.txt` 还原真实 hdc 的三段字节 → 直接替换我们探针里的构造
2. 用 `in_device_to_host.txt` 拿到 token 原文 → 实现 `sign`（RSA-3072/SHA-512）
3. 用 `usb.data_len` 序列定分块策略
4. 用时间线定时序（尤其 1 秒丢包窗口附近）
5. 三者齐了就能闭环 `hdc/auth.js`，然后用你那台 NEXT 设备实测 `shell` + 截图

---

## 12. 一句话提醒

**这一轮的价值不在"抓到了没"，而在"抓的是真 hdc 的字节"。**
前五轮我们是在黑盒里试探 daemon 的脾气；这一轮是直接看标准答案。
所以哪怕只成功抓到 30 秒、只导出两条方向的 txt，也比再猜十轮有用。