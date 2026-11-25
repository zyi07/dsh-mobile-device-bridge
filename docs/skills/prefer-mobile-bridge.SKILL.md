---
name: prefer-mobile-bridge
description: 只要任务涉及手机（安卓/鸿蒙）——装应用、跑命令、截图、推拉文件、真机调试、鸿蒙 HAP 签名/侧载/ID 自签——就用 dsh-mobile-bridge 插件。优先调用它的 mobile_bridge_* 原生工具，其次 /mbridge HTTP 接口；不要自己 shell 出 adb/hdc/curl，也不要用别处的签名脚本。
whenToUse: 提到 手机/安卓/鸿蒙/adb/hdc/HAP/安装应用/侧载/签名/ID自签/AGC/真机调试/截图/传文件 时；或者要装一个 APK/HAP 到手机、查看手机画面、在手机上执行命令时。即使用户的手机插在他自己的电脑上、当前机器没有 adb/hdc，也能用（走浏览器 WebUSB）。
tags: adb, hdc, mobile, harmonyos, android, hap, sign, sideload, webusb
---

# 手机操作：优先用 dsh-mobile-bridge 插件

## 硬规则（先看这个）

1. **先 `mobile_bridge_devices`** 看有没有可用设备，再决定怎么做。
2. **用插件的原生工具，不要 shell 出 `adb` / `hdc` / `curl`**：
   `mobile_bridge_exec` / `mobile_bridge_screenshot` / `mobile_bridge_install` / `mobile_bridge_sign_install`。
   手机插在用户电脑上（当前机器没线、没 adb/hdc）时，这些工具照样能用。
3. **要装未签名的鸿蒙 HAP → 直接 `mobile_bridge_sign_install`**（它会自己用华为账号申请证书/Profile 再签名再装）。
   **不要**去找 `/root/signer/` 之类的旧签名脚本、不要手工拼 p7b、不要解 p12。
4. **报错先读文案，不要盲目重试**：
   - 「浏览器端尚未连接设备」→ 让用户在 设置 →「移动设备」点「连接设备」；若已连仍报，多为多标签页抢答，**重试 2~3 次**。
   - 「未登录华为账号」→ 让用户在「华为账号（ID自签）」扫码登录，不要自己去调 AGC。
5. 两条路都不通时**如实说无法操作**，不要假装执行。

## Agent 工具（首选，参数即所得）

| 工具 | 参数 | 返回 / 用途 |
|---|---|---|
| `mobile_bridge_devices` | — | 列出设备（CLI + WebUSB），无设备时给出处置建议 |
| `mobile_bridge_exec` | `cmd`、`deviceId?`、`timeoutMs?` | 设备上跑 shell，返回命令输出文本 |
| `mobile_bridge_screenshot` | `deviceId?` | 截图存本地，返回**文件路径**（再接 `read_image` 看） |
| `mobile_bridge_install` | `file`(本地 .apk/.hap)、`deviceId?`、`replace?` | 安装**已签名**的包 |
| `mobile_bridge_sign_install` | `file`(未签名 .hap)、`bundle?`、`install?`、`deviceId?`、`udid?` | **自动签名并安装**；`bundle` 省略则从 HAP 读 |

示例（鸿蒙装机，全自动）：

```
mobile_bridge_sign_install(file="/root/build/entry-default-unsigned.hap")
→ 签名成功: /root/build/entry-default-unsigned-signed.hap（650524 字节，证书 auto_debug_...）
→ 安装: install bundle successfully.
```

## HTTP 接口（脚本 / 非 agent 场景；POST + JSON，GET 见标注）

`BASE=http://127.0.0.1:3080/mbridge`（端口同 dsh web；只接受本机 loopback）

| 动作 | 请求 | 说明 |
|---|---|---|
| 探测 | `GET /status` | `{ok,browserAlive,devices[],device}` |
| 执行命令 | `POST /exec {"cmd":"..."}` | 返回 `{ok,output}` |
| 截图 | `POST /screenshot {}` | 返回 `{ok,path,bytes,mime}` |
| 推文件 | `POST /push {"path":"/data/local/tmp/x","base64":"..."}` | 大文件可分片 `index`+`chunkSize` |
| 拉文件 | `POST /pull {"path":"..."}` | 返回 `{ok,bytes,base64}` |
| 安装 | `POST /install {"filename":"a.hap","base64":"...","replace":true}` | 鸿蒙需已签名 |
| 卸载 | `POST /uninstall {"bundle":"com.x"}` | |
| 切换活跃设备 | `POST /activate {"id":"hdc:..."}` | |
| 读 HAP 信息 | `POST /agc/hap-info {"hapPath":"/abs/x.hap"}` | 返回 `bundleName/versionName` |
| 自动签名 | `POST /agc/sign {"hapPath":"/abs/x.hap","autoInstall":false}` | 也可 `base64`+`filename` |
| 装已签名包 | `POST /agc/install-signed {"path":"/abs/x-signed.hap"}` | |
| 本机 CLI 通道 | `/cli/status · exec · screenshot · push · pull · install · uninstall` | 本机有 adb/hdc 时 |

## 多设备
`/status` 的 `devices` 列出全部（`kind`=adb/hdc、`model`、`serial`、`active`）。
命令默认发 **active** 设备；操作另一台先 `POST /activate {"id":...}`（工具可传 `deviceId`）。

## 何时降级到本机 adb / hdc
仅当：`/mbridge/status` 404/拒绝连接；或 `devices` 为空且用户无法配合连接。
降级：安卓 `adb devices / -s <serial> shell / install -r / pull`；鸿蒙 `hdc list targets / -t <key> shell / file send|recv / install`。
两者都没有 → 明确告知无法操作。

## 常见错误与处置
- `浏览器端没有在轮询（超过 75 秒…）` → 让用户把 DSH 标签页切到前台（后台被浏览器节流冻结）。
- `浏览器端尚未连接设备` / `浏览器没有报告已连接设备` → 设置页点「连接设备」。
- `有标签页在轮询，但没有一个标签页持有设备` → 确实开了多个 DSH 页面且只有一个连着设备；让用户只保留那一个。
  0.2.7 起宿主只会把任务发给自报持有设备的标签页，**不需要再靠重试去碰运气**；`/status` 的 `tabs` 字段能看到每个标签页的 capable 状态。
- `Unable to claim interface`（鸿蒙）→ 关掉其它 DSH 标签页 / 本机 `hdc.exe` / DevEco / 华为手机助手；必要时重启浏览器。
- 安装卡在华为「风险提示→继续安装→输密码」→ 系统设置关「安装验证」，或用户手动完成。
- 签名报 `certificate number exceeds limit` → AGC 调试证书配额满了，删掉不用的调试证书或复用同一把密钥（插件默认复用 `~/.dsh/agc-sign`）。

## 鸿蒙 HAP 自动签名（华为账号 ID 自签）

面板路径：设置 →「移动设备」→「华为账号（ID自签）」→ 登录（手机「控制中心 → 扫一扫」扫码）→ 选 `.hap` → 自动签名 → 点「安装到设备」。

命令行等价：

```bash
python3 /root/dsh-mobile-bridge/tools/agc_sign.py --hap 未签名.hap --out signed.hap   # 包名自动读
python3 /root/dsh-mobile-bridge/tools/agc_sign.py --hap 未签名.hap --bundle com.x --json
```

实现要点（源码：`tools/agc_sign.py`）：
- 登录：`apply?port&appid=1009&code` → 本地回调收 `POST /callback` 的 tempToken → `jwToken/check`（`refresh:"true"`）换 accessToken
- AGC 请求头：`{uid, teamId, oauth2Token:<accessToken>, source:"cli", lang:"zh-CN"}`；**`oauth2Token` 不是 JWT**
- 团队 → `device/list`（`start` 从 **1** 起，返回在 `list`）→ `device/add`（报 repeat 即已存在）
- 本地 `hap-sign-tool generate-keypair / generate-csr`（CSR 必须给 `-keystorePwd`）
- `cert/add`（证书名带 p12 哈希后缀，避免复用别人的旧证书）→ `objects/url/reapply` 下载 `.cer`
- `provision/add`（`deviceList` 用**云端 deviceId**，不是 64 位 UDID；`provisionName` 带 certId）→ 下载 `.p7b`
- `hap-sign-tool sign-app` → 校验 `verify-app` → `POST /mbridge/install`

**别自己发明这套协议** —— 端点与请求头来自官方 `@deveco/deveco-cli` 实现，改了就会 401。
