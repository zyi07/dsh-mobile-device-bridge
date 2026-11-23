---
name: prefer-mobile-bridge
description: 当需要通过 adb/hdc 操作手机（执行命令/截图/传文件/安装卸载应用）时，先检查 dsh-mobile-bridge 插件是否已连接设备；已连接就优先用它的 /mbridge 远程接口，未连接再回落本机 adb/hdc 通道。
whenToUse: 要执行 adb/hdc 命令、截屏、推送/拉取文件、安装或卸载 App 时；尤其是手机插在用户电脑上、当前机器没有 adb/hdc 或没接数据线、需要远程操作设备时。
tags: adb, hdc, mobile, bridge, webusb
---

# 优先用 dsh-mobile-bridge 插件操作手机（adb / hdc）

## 何时适用
需要通过 **adb / hdc** 操作手机——执行命令、截屏、推/拉文件、安装/卸载 App——
**先检查 dsh-mobile-bridge 插件是否已连接设备**。
已连接 → 用插件的 `/mbridge` 远程接口（适合：手机插在用户电脑上、本机没有 adb/hdc、远程操作）。
未连接/不可用 → 再回落本机 `adb` / `hdc` 命令。

## 第一步：探测插件与设备
```bash
BASE=http://127.0.0.1:3080/mbridge        # 端口与 dsh web 一致，常见 3080
curl -s -m 5 "$BASE/status"
```
返回示例：
```json
{"ok":true,"browserAlive":true,
 "devices":[
   {"id":"adb:RPGGK...","kind":"adb","model":"TNY-AL00","serial":"RPGGK...","active":true},
   {"id":"hdc:3EV02...","kind":"hdc","model":"PLA-AL10","serial":"3EV02...","active":false}],
 "device":{...}}
```
判定：
- **`devices` 非空 且 `browserAlive=true` → 走插件**（用下面的接口）
- `devices` 为空 / 404 / 连接被拒 → 插件不可用 → **回落本机 adb/hdc**
- `browserAlive=false` → 用户浏览器标签页不在前台（被节流），**提示用户把 DSH 页面切到前台**

## 插件接口（POST + JSON；除非注明 GET）
| 动作 | 请求 | 说明 |
|---|---|---|
| 执行命令 | `POST /exec {"cmd":"getprop ro.product.model","timeoutMs":25000}` | 返回 `{"ok":true,"output":"$ cmd\n结果\n[exit 0]"}` |
| 截图 | `POST /screenshot {}` | 返回 `{"ok":true,"path":"/tmp/xxx.png","bytes":N,"mime":"image/png"}`（鸿蒙 JPEG / 安卓 PNG） |
| 推文件 | `POST /push {"path":"/data/local/tmp/x.bin","base64":"..."}` | 大文件可分片：再加 `index`+`chunkSize`（64KiB） |
| 拉文件 | `POST /pull {"path":"/data/local/tmp/x.bin"}` | 返回 `{"ok":true,"bytes":N,"base64":"..."}` |
| 安装 | `POST /install {"filename":"a.apk","base64":"...","replace":true}` | 安卓 `pm install` / 鸿蒙 `bm install`；base64 为包体 |
| 卸载 | `POST /uninstall {"bundle":"com.xxx"}` | 安卓包名 / 鸿蒙 bundleName 均可 |
| 切换活跃设备 | `POST /activate {"id":"hdc:3EV02..."}` | 命令默认打到 active 设备 |

示例：
```bash
curl -s -m 25 -X POST "$BASE/exec" -H 'content-type: application/json' \
  -d '{"cmd":"getprop ro.product.model","timeoutMs":20000}'
```

## 多设备
- `/status` 的 `devices` 列出所有已连接设备（`kind` = adb/hdc、`model`、`serial`、`active`）。
- 命令默认发给 **active** 设备；要操作另一台，先 `POST /activate {"id":...}` 再执行。
- 一台安卓 + 一台鸿蒙可同时连，互不影响；切换不会串。

## 何时降级到本机 adb / hdc
- `/mbridge/status` 返回 404 或连接被拒（插件没装/没开）
- `devices` 为空（用户还没在插件里点「连接设备」）
- 反复报「浏览器没有在轮询」且用户无法配合把 DSH 页面切前台
降级后：
- 安卓：`adb devices` / `adb -s <serial> shell ...` / `adb install -r x.apk` / `adb pull`
- 鸿蒙：`hdc list targets` / `hdc -t <connectKey> shell ...` / `hdc file send|recv` / `hdc install`
- 若**既没有插件设备、本机也没有 adb/hdc**：明确告知用户无法操作，**不要假装执行**。

## 常见错误与处置
- `浏览器端没有在轮询（超过 75 秒…）` → 让用户把 DSH 标签页切到**前台**（后台标签页被浏览器冻结）。
- `浏览器没有报告已连接设备` → 让用户在设置页「移动设备」点「连接设备」。
- `Unable to claim interface`（鸿蒙）→ 接口被占用：关掉其它 DSH 标签页 / 本机 `hdc.exe`、DevEco、华为手机助手；必要时重启浏览器。
  注意：本插件早期版本的 claim 泄漏 bug 已修复；若仍出现，优先怀疑多标签页或本机 hdc 进程。
- 安装卡在华为「风险提示→继续安装→输密码」→ 需在手机系统设置关闭「安装验证」，或由用户手动完成。

## 端口与访问限制
- `BASE` 默认 `127.0.0.1:3080`（与 dsh web 相同）。若 dsh web 用了别的端口，
  用 `ps aux | grep "dsh .*web" | grep -oE 'port [0-9]+'` 或 `ss -tlnp | grep node` 查。
- `/mbridge` **只接受本机 127.0.0.1 调用**（loopback），跨机访问会被 403。agent 与 dsh 同机时可用。

## 原则
1. **先探测再决定**：永远先 `GET /status`，别一上来就 `adb shell`。
2. **插件优先**：插件已连设备时，用插件接口，不要再去抢本机 adb/hdc（会和插件的 USB claim 打架）。
3. **降级要说明**：回落本机通道时，在回复里说明「插件未连接，改用本机 adb/hdc」。
4. **不假装**：两条路都不通时如实说无法操作。

## 两条通道（WebUSB / 本机 CLI）
插件现在有两条**互不影响**的通道，按运行环境选：

- **WebUSB 通道**（`/mbridge/exec|screenshot|push|pull|install|uninstall|activate`）
  浏览器里有 `navigator.usb` 且通过 `requestDevice` 连了设备时用（Chrome/Edge 直接访问 DSH web）。
- **本机 CLI 通道**（`/mbridge/cli/status|exec|screenshot|push|pull|install|uninstall|activate`）
  宿主能探测到本机 adb/hdc 时用（**DSH 桌面端 Electron 首选**：绕开 WebUSB 限制和 WinUSB 驱动问题）。
  探测：`GET /mbridge/cli/status` → `{available, adb, hdc, devices, activeId}`；
  设备 id 形如 `cli:adb:<serial>` / `cli:hdc:<connectKey>`，用 `deviceId` 指定或用 active。

选通道顺序：
1. 需要操作手机 → 先 `GET /mbridge/cli/status`，`available=true` 且有 devices → **走 CLI**（桌面端/本机最稳）
2. 否则 `GET /mbridge/status`，`devices` 非空 → 走 WebUSB
3. 两者都没有 → 让用户连接设备；都不可用就如实说无法操作
