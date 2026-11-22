# HDC「ID 签名」调研与实施方案（第 9 轮）

> 目标：像**小白调试助手 / HOKIT** 那样，用户**用自己的华为账号（ID）**登录一次，
> 插件自动完成「建应用 → 注册设备 UDID → 申请调试证书 → 生成调试 Profile →
> 签名 HAP → 安装」全流程。**不再要求用户手工准备已签名的 HAP。**

---

## 一、参考实现是怎么做的（有源码证据）

**小白调试助手** = `github.com/likuai2010/auto-installer`（master 只有 README，
源码在 `flutter` 分支 commit `24388dd8`）。

### 1.1 它并不是"本地随便签"，而是**调华为 AGC 的私有 Web 接口**

证据：`core/agcService.js`（11486 字节）里完整列出了它用到的接口，
认证方式是 **浏览器登录后的 Cookie**：

```js
headers: {
  "content-type": "application/json",
  "Cookie": this.cookie,          // ← 用户登录开发者联盟后的会话 Cookie
  "x-hd-csrf": this.csrfToken,    // ← 从 Cookie 里取出的 csrfToken
  "agcteamid": this.agcteamid,    // ← 团队 ID（源码里硬编码 2850086000506643987）
}
```

### 1.2 用到的 AGC 接口（逐条摘自源码）

| 用途 | 方法与路径 |
|---|---|
| 校验登录态 | `POST agc-drcn.developer.huawei.com/agc/edge/apios/invokeService/AGCHomePageOrchestration/getUserInfo` |
| 团队列表 | `GET /agc/edge/ups/user-permission-service/v1/user-team-list` |
| 项目列表 | `POST /agc/edge/cpms/project-management-service/v1/projectList` |
| 建项目 | `POST /agc/edge/cpms/project-management-service/v1/projects` |
| 应用列表 | `GET /agc/edge/amis/app-manage/v1/app/list?packageType=7` |
| 查包名占用 | `POST /agc/edge/amis/app-manage/v1/app/check/package-name` |
| 建应用 | `POST /agc/edge/amis/app-manage/v1/app`（`parentType:13, packageType:7`） |
| 证书列表 | `GET /agc/edge/cps/harmony-cert-manage/v1/cert/list` |
| **上传 CSR 换证书** | `POST /agc/edge/cps/harmony-cert-manage/v1/cert`，`{csr, certName, certType}`（**1=调试，2=发布**） |
| Profile 列表 | `GET /agc/edge/cps/provision-manage/v1/provision/list?packageName=X` |
| **创建 Profile** | `POST /agc/edge/cps/provision-manage/v1/provision`，`{provisionName, certList:[certId], provisionType, appId, deviceList:[udid]}` |
| 设备列表 | `GET /agc/edge/cps/device-manage/v1/device/list?deviceName=` |
| **注册设备 UDID** | `POST /agc/edge/cps/device-manage/v1/device`，`{deviceName, udid, deviceType:4}` |
| **下载证书/Profile 文件** | `POST /agc/edge/cfs/file_service/v1/download/object/url?objectId=X&downloadFileName=Y` |

### 1.3 它还内置了签名材料（但**已过期且绑定别人的 bundle**）

仓库 `flutter/hap_installer/assets/store/` 下带了一份公开的调试材料：

- `xiaobai-debug.cer` (2906 B)
- `xiaobai-debug.p7b` (4672 B)

我把它解开了（`openssl cms -verify -noverify`），内容是：

```json
{
  "type": "debug",
  "issuer": "app_gallery",
  "validity": { "not-before": 1741097410, "not-after": 1756649410 },
  "bundle-info": {
    "developer-id": "2850086000506643987",
    "bundle-name": "org.ohosdev.anime",
    "app-identifier": "6918681874777988851",
    "apl": "normal",
    "app-feature": "hos_normal_app"
  },
  "debug-info": {
    "device-ids": [
      "454D55057494E05838360617738713A5F42A38FBE391502AD038F00000000000",
      "454D5504D4143041524D01C2DB8A50F7347CFB1372A10C6BDC37400000000000",
      …
    ]
  }
}
```

**结论（关键）：**
1. 调试 Profile 的 **UDID 白名单在 `debug-info.device-ids`**，一份 Profile 只对列表内的设备有效。
2. 内置那份 **2025-08-31 已过期**，bundle 名也是别人的 → **不能直接复用**。
3. 所以「ID 签名」的本质是：**用登录态调 AGC 自动注册你的设备，再生成属于你的 Profile**。

---

## 二、本机环境核实（已实测）

| 项目 | 状态 |
|---|---|
| Java | ✅ OpenJDK 21.0.12 |
| 官方命令行工具 | ✅ `/opt/harmony26/command-line-tools/` |
| `hap-sign-tool.jar` | ✅ 12,660,750 字节，`generate-keypair/generate-csr/generate-cert/sign-profile/sign-app/verify-app` 全部可用 |
| `hdc` 二进制 | ⚠️ 缺 `libatomic.so.1`（不影响，我们用 WebUSB） |
| 外网 | ✅ github 可达；`agc-drcn.developer.huawei.com` 返回 403（未带 Cookie，属正常） |
| Node crypto | ✅ 支持 EC 生成 |

### 签名命令（实测可用的官方语法）

```bash
# 1) 生成密钥对（ECC NIST-P-256）与 CSR
java -jar hap-sign-tool.jar generate-keypair \
  -keyAlias dsh-key-v1 -keyPwd *** -keyAlg ECC -keySize NIST-P-256 \
  -keystoreFile dsh.keystore -keystorePwd ***

java -jar hap-sign-tool.jar generate-csr \
  -keyAlias dsh-key-v1 -keyPwd *** -subject "C=CN,O=DSH,OU=Bridge,CN=dsh-debug" \
  -signAlg SHA256withECDSA -keystoreFile dsh.keystore -keystorePwd *** -outFile dsh.csr

# 2) 拿到 AGC 下发的 .cer 与 .p7b 之后签名
java -jar hap-sign-tool.jar sign-app -mode localSign \
  -keyAlias dsh-key-v1 -keyPwd *** \
  -appCertFile app-debug.cer -profileFile app-debug.p7b \
  -inFile unsigned.hap -outFile signed.hap \
  -signAlg SHA256withECDSA -keystoreFile dsh.keystore -keystorePwd *** \
  -compatibleVersion 8 -signCode 1
```

---

## 三、要落地的流程（与我们现有能力衔接）

```
[UI] 用户粘贴 AGC 登录 Cookie（一次性，存本地）
  ↓
[宿主] getUserInfo 校验登录态 → 取 teamId
  ↓
[HDC] bm get --udid  ← 我们已有的命令通道
  ↓
[宿主] 确保项目 → 确保应用(packageName) → 注册 UDID
  ↓
[宿主] generate-keypair + generate-csr（首次生成后本地复用）
  ↓
[宿主] createCert(type=1 调试) → 拿 certId → downloadObj 下载 .cer
  ↓
[宿主] createProfile(provisionType=1, certList=[certId], deviceList=[udid]) → downloadObj 下载 .p7b
  ↓
[宿主] sign-app 签名
  ↓
[现有 HDC] push → bm install -p
```

**分工理由：**
- AGC 调用、签名都必须在**宿主（Node，有网、有 Java）**做，浏览器做不了跨域带 Cookie 的请求。
- 设备 UDID、推包、安装走**现有 HDC 通道**，已经验证可用。

---

## 四、必须先确认的点（不猜）

| # | 待确认 | 怎么确认 |
|---|---|---|
| 1 | 2026 年这些 AGC 私有接口是否仍接受 Cookie 认证 | 用户提供 Cookie 后调 `getUserInfo`，返回 `ret.code==0` 即可 |
| 2 | `createCert` / `createProfile` 的响应里 `objectId` 字段名 | 实测一次响应 JSON |
| 3 | 包名未注册时 `createApp` 需要的 `projectId` 归属 | 先 `projectList` 取现有项目，没有再建 |
| 4 | 同一账号可注册的调试设备数量上限 | 实测报错才知道（华为通常有配额） |
| 5 | 自动签名是否需要实名/企业认证 | 账号权限问题，实测 |

---

## 五、需要你提供什么（**只要登录态，不要签名包**）

这是我之前搞错的地方——**不需要你给我已签名的 HAP**。只需要：

1. 浏览器登录 <https://developer.huawei.com/consumer/cn/service/josp/agc/index.html>（登录一次）
2. F12 → Network → 任意一个 `agc-drcn.developer.huawei.com` 请求 →
   复制 **请求头里的 `Cookie`**
3. 把它贴给我（或贴进插件 UI 的「华为账号登录态」输入框）

我会先用它调 `getUserInfo` 验证有效性，再按上面的顺序自动完成注册、证书、Profile、签名、安装。

**安全说明：** Cookie 等同临时登录凭证，只会保存在本机（插件本地配置），
用完可以随时在华为账号里「退出所有设备」使其失效。全程不上传到任何第三方。

---

## 六、实施方案（分三步，每步都有验证门槛）

### 第 1 步：宿主侧 AGC 客户端 + 登录态校验（可立即做）
- 新增 `src-host/agc.js`：`getUserInfo / teamList / projectList / createProject /
  appCheck / createApp / deviceList / createDevice / certList / createCert /
  profileList / createProfile / downloadObj`
- 新增 `/mbridge/agc/status`（校验登录态）、`/mbridge/agc/bootstrap`（一条龙注册）
- **验证**：`getUserInfo` 返回 code=0，并把 teamId 打出来

### 第 2 步：证书与 Profile 自动生成
- 首次 `generate-keypair` + `generate-csr`（本地保存 keystore，权限 600）
- `createCert(type=1)` → 下载 `.cer`
- `createProfile(type=1, deviceList=[udid])` → 下载 `.p7b`
- **验证**：`openssl cms -verify -noverify` 能解出 JSON，且
  `debug-info.device-ids` 含本机 UDID，`bundle-name` 与待装 HAP 一致

### 第 3 步：签名 + 安装 + UI
- `sign-app` 签名 → 校验 `verify-app` 通过
- push → `bm install -p` → 成功/错误码翻译
- UI：登录态输入框、一键「签名并安装」、进度与错误展示
- **验证**：真机装上一个自建的 Hello HAP（我们自己签的）

---

## 七、风险与边界（提前说清）

| 风险 | 说明 |
|---|---|
| 接口是**私有 Web 接口** | 华为随时可能改；改了就按同样思路重新抓包更新 |
| Cookie 有效期短 | 过期需重新粘贴；UI 要能提示"登录态失效" |
| 配额 | 设备/证书/Profile 数量有上限，报错如实转达 |
| 合规 | 用**自己的账号**给自己的设备签名是正常开发行为；**不得**用别人的账号或分发内置账号凭据 |
| 不要内置任何账号凭据 | 与小白不同，我们**不硬编码 teamId/Cookie**，必须由用户自己的登录态驱动 |

---

## 八、当前状态

- ✅ 参考实现原理与接口清单（源码证据）
- ✅ 真实 Profile 结构（已解析）
- ✅ 本机 Java + 官方签名工具（已验证命令）
- ✅ 设备 UDID：`<DEVICE_UDID>`
- ⬜ **等你提供一次 AGC 登录 Cookie** → 我立即跑通接口并落地全流程