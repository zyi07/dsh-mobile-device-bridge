#!/usr/bin/env python3
"""
用华为账号自动申请调试证书 / Profile 并给 HAP 签名。

复刻 DevEco / deveco-cli 的自动签名链路（端点与请求头取自 @deveco/deveco-cli 1.3.4 的 dist/cli.js）：
  jwt → jwToken/check → accessToken
  → GET  /api/ups/user-permission-service/v1/user-team-list      (oauth2Token/uid/source/lang)
  → POST /api/cps/device-manage/v1/device/add                    {deviceName,udid,deviceType}
  → 本地 hap-sign-tool generate-keypair / generate-csr
  → POST /api/cps/harmony-cert-manage/v1/cert/add                {csr,certName,certType:"1"}
  → POST /api/amis/app-manage/v1/objects/url/reapply             {sourceUrls:[certObjectId]}
  → POST /api/cps/provision-manage/v1/ide/test/provision/add     {certList,packageName,deviceList,provisionName}
  → 本地 hap-sign-tool sign-app

用法：
  python3 agc_sign.py --hap a.hap --bundle com.example.app [--out b.hap] [--product 名] [--json]
"""
import argparse
import base64
import hashlib
import json
import os
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

CN = "https://cn.devecostudio.huawei.com"
API = "https://connect-api.cloud.huawei.com"
SESSION = os.environ.get("AGC_SESSION_FILE", os.path.expanduser("~/.dsh/agc-session.json"))
JAR = os.environ.get(
    "HAP_SIGN_JAR",
    "/opt/harmony26/command-line-tools/sdk/default/openharmony/toolchains/lib/hap-sign-tool.jar",
)
UA = "devecocli/1.3.4"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http(method, url, headers=None, body=None, timeout=60):
    h = {"User-Agent": UA, "Accept": "application/json"}
    data = None
    if headers:
        h.update(headers)
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=h, data=data, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return -1, repr(e).encode()


def http_json(method, url, headers=None, body=None, timeout=60):
    st, raw = http(method, url, headers, body, timeout)
    txt = raw.decode("utf-8", "replace") if isinstance(raw, bytes) else str(raw)
    try:
        return st, json.loads(txt) if txt.strip() else {}
    except Exception:
        return st, {"_raw": txt}


def load_jwt():
    with open(SESSION, encoding="utf-8") as f:
        d = json.load(f)
    jwt = d.get("jwt")
    if not jwt:
        raise RuntimeError(f"{SESSION} 里没有 jwt，请先在插件里扫码登录")
    return jwt


def get_access_token(jwt):
    # refresh 必须是 "true"：false 只会返回上次缓存的 accessToken（很快就过期 → 后续 AGC 全 401）
    st, d = http_json("GET", f"{CN}/authrouter/auth/api/jwToken/check",
                      {"jwtToken": jwt, "refresh": "true"})
    if st != 200 or not d.get("status"):
        raise RuntimeError(f"jwToken/check 失败: HTTP {st} {str(d)[:200]}")
    ui = d.get("userInfo") or {}
    at = ui.get("accessToken")
    if not at:
        raise RuntimeError("jwToken/check 没返回 accessToken")
    return str(ui.get("userId") or ""), at


def hdr(uid, team_id, at):
    return {"uid": str(uid), "teamId": str(team_id), "oauth2Token": at,
            "source": "cli", "lang": "zh-CN"}


def list_teams(uid, at):
    st, d = http_json("GET", f"{API}/api/ups/user-permission-service/v1/user-team-list",
                      {"uid": str(uid), "oauth2Token": at, "source": "cli", "lang": "zh-CN"})
    if st != 200:
        raise RuntimeError(f"team-list HTTP {st}")
    ret = d.get("ret") or {}
    if ret.get("code") != 0:
        raise RuntimeError(f"team-list ret={ret}")
    return d.get("teams") or []


def list_devices(h):
    """注意：start 是 1 起始（传 0 会报 must be >= 1），返回体在 list 字段"""
    out, start = [], 1
    for _ in range(50):
        q = urllib.parse.urlencode({"encodeFlag": 0, "start": start, "pageSize": 100})
        st, d = http_json("GET", f"{API}/api/cps/device-manage/v1/device/list?{q}", h)
        if st != 200:
            raise RuntimeError(f"device/list HTTP {st}")
        ret = (d or {}).get("ret") or {}
        if ret.get("code") not in (0, None):
            raise RuntimeError(f"device/list ret={ret}")
        lst = (d.get("list") or d.get("deviceList")
               or (d.get("data") or {}).get("list") or [])
        out.extend(lst)
        total = d.get("totalCount")
        if len(lst) < 100 or (isinstance(total, int) and len(out) >= total):
            break
        start += 100
    return out


def add_device(h, udid, dtype):
    name = "auto_sign_device_No.%d%d" % (int(secrets.randbelow(3000)), int(secrets.randbelow(10**6)))
    st, d = http_json("POST", f"{API}/api/cps/device-manage/v1/device/add", h,
                      {"deviceName": name, "udid": udid, "deviceType": str(dtype)})
    ret = (d or {}).get("ret") or {}
    if st != 200:
        raise RuntimeError(f"device/add 失败: HTTP {st} {str(d)[:300]}")
    if ret.get("code") != 0:
        # 已注册过同一个 UDID 时 AGC 会报 repeat，视为成功
        if "repeat" in str(ret.get("msg") or "").lower():
            return name
        raise RuntimeError(f"device/add 失败: HTTP {st} {str(d)[:300]}")
    return name


def list_certs(h):
    st, d = http_json("GET", f"{API}/api/cps/harmony-cert-manage/v1/cert/list", h)
    if st != 200:
        raise RuntimeError(f"cert/list HTTP {st}")
    return d.get("certList") or []


def add_cert(h, csr, cert_name):
    st, d = http_json("POST", f"{API}/api/cps/harmony-cert-manage/v1/cert/add", h,
                      {"csr": csr, "certName": cert_name, "certType": "1"})
    ret = (d or {}).get("ret") or {}
    if st != 200 or ret.get("code") != 0:
        raise RuntimeError(f"cert/add 失败: HTTP {st} {str(d)[:300]}")
    return d


def reapply(h, source_urls):
    """把对象地址换成带签名的临时下载地址"""
    st, d = http_json("POST", f"{API}/api/amis/app-manage/v1/objects/url/reapply", h,
                      {"sourceUrls": source_urls})
    if st != 200:
        raise RuntimeError(f"reapply HTTP {st} {str(d)[:200]}")
    for key in ("urlsInfo", "urlList"):
        lst = d.get(key)
        if isinstance(lst, list) and lst:
            it = lst[0]
            u = it.get("newUrl") or it.get("url") or it.get("downloadUrl")
            if u:
                return u, it.get("sha256") or ""
    raise RuntimeError(f"reapply 没有拿到下载地址: {str(d)[:300]}")


def download(url, dest, sha256=""):
    st, raw = http("GET", url, timeout=120)
    if st != 200:
        raise RuntimeError(f"下载失败 HTTP {st}: {url[:80]}")
    with open(dest, "wb") as f:
        f.write(raw)
    if sha256:
        got = hashlib.sha256(raw).hexdigest()
        if got.lower() != sha256.lower():
            raise RuntimeError(f"下载校验失败 sha256 不一致: {got} != {sha256}")
    return dest


def add_provision(h, cert_id, bundle, udids, provision_name):
    body = {"certList": [cert_id], "packageName": bundle,
            "deviceList": udids, "provisionName": provision_name,
            "aclPermissionList": []}
    st, d = http_json("POST", f"{API}/api/cps/provision-manage/v1/ide/test/provision/add", h, body)
    ret = (d or {}).get("ret") or {}
    if st != 200 or ret.get("code") != 0:
        raise RuntimeError(f"provision/add 失败: HTTP {st} {str(d)[:400]}")
    url = d.get("provisionFileUrl")
    if not url:
        raise RuntimeError(f"provision/add 没返回 provisionFileUrl: {str(d)[:300]}")
    return d.get("id"), url


def run_jar(args, what):
    cmd = ["java", "-jar", JAR] + args
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if p.returncode != 0:
        raise RuntimeError(f"{what} 失败 (exit {p.returncode}):\n{p.stdout[-800:]}\n{p.stderr[-800:]}")
    return p.stdout


def rand_pwd(n=16):
    alpha = string.ascii_letters + string.digits
    return "".join(secrets.choice(alpha) for _ in range(n))


def sign_hap(unsigned, out, p12, pwd, cer, p7b):
    run_jar(["sign-app", "-keyAlias", "debugKey", "-signAlg", "SHA256withECDSA",
             "-mode", "localSign", "-appCertFile", cer, "-profileFile", p7b,
             "-inFile", unsigned, "-outFile", out,
             "-keystoreFile", p12, "-keyPwd", pwd, "-keystorePwd", pwd], "sign-app")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hap", required=True, help="未签名的 HAP")
    ap.add_argument("--bundle", required=True, help="bundleName（profile 绑定的包名）")
    ap.add_argument("--out", default="", help="输出文件（默认 <hap>-signed.hap）")
    ap.add_argument("--product", default="", help="provisionName 前缀，可留空")
    ap.add_argument("--udid", default="", help="目标设备 UDID；留空则用账号里所有设备")
    ap.add_argument("--device-type", default="4", help="设备类型码，手机=4")
    ap.add_argument("--workdir", default="", help="材料目录（默认临时目录）")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()

    out = a.out or (os.path.splitext(a.hap)[0] + "-signed.hap")
    # 密钥材料必须持久复用：每次新 p12 就会申请一张新证书，AGC 有数量上限，
    # 很快会报 "certificate number exceeds limit"。
    work = (a.workdir or os.environ.get("AGC_SIGN_DIR")
            or os.path.expanduser("~/.dsh/agc-sign"))
    os.makedirs(work, exist_ok=True)
    # 首次：把之前生成的密钥材料迁过来（同 p12 → 同证书名 → 复用已有证书，不新增）
    _legacy = "/root/agc-work"
    if not os.path.exists(os.path.join(work, "debugKey.pwd")) and os.path.isdir(_legacy):
        for _fn in os.listdir(_legacy):
            if _fn.endswith(".p12") or _fn.endswith(".pwd") or _fn.endswith(".cer"):
                try:
                    shutil.copy2(os.path.join(_legacy, _fn), os.path.join(work, _fn))
                except Exception:
                    pass
    os.makedirs(work, exist_ok=True)
    result = {"ok": False, "workdir": work}

    try:
        jwt = load_jwt()
        uid, at = get_access_token(jwt)
        log(f"[1/6] accessToken 就绪 userId={uid}")
        teams = list_teams(uid, at)
        if not teams:
            raise RuntimeError("账号下没有团队")
        team_id = str(teams[0].get("id") or uid)
        h = hdr(uid, team_id, at)
        log(f"[1/6] 团队 teamId={team_id} name={teams[0].get('name')}")
        result.update(teamId=team_id, teamName=teams[0].get("name"))

        # 2) 设备
        devs = list_devices(h)
        by_udid = {str(x.get("udid")): x for x in devs if x.get("udid")}
        log(f"[2/6] 账号已有 {len(by_udid)} 台设备")
        if a.udid:
            if a.udid not in by_udid:
                add_device(h, a.udid, a.device_type)
                devs = list_devices(h)
                by_udid = {str(x.get("udid")): x for x in devs if x.get("udid")}
                log(f"[2/6] 已注册设备 {a.udid}")
            else:
                log(f"[2/6] 设备已在账号里 {a.udid}")
            entry = by_udid.get(a.udid)
            if not entry or not entry.get("id"):
                raise RuntimeError("注册后仍查不到该设备（拿不到云端 deviceId）")
            # ★ deviceList 要的是云端 deviceId（每台一个 ~19 位数字），不是 UDID（64 位 hex）
            target_ids = [str(entry["id"])]
        else:
            if not by_udid:
                raise RuntimeError("账号里没有设备，请用 --udid 指定")
            target_ids = [str(x["id"]) for x in by_udid.values() if x.get("id")]
        result["devices"] = list(by_udid.keys())
        result["deviceIds"] = target_ids

        # 3) 密钥 + CSR
        p12 = os.path.join(work, "debugKey.p12")
        csr = os.path.join(work, "debugKey.csr")
        pwd_file = os.path.join(work, "debugKey.pwd")
        # 口令必须和 p12 配套：存在就复用，不存在（或 p12 无口令记录）就重建，避免
        # "keystore password was incorrect" —— 每次随机生成又不落盘就是这个坑
        if os.path.exists(p12) and os.path.exists(pwd_file):
            with open(pwd_file, encoding="utf-8") as f:
                pwd = f.read().strip()
        else:
            pwd = rand_pwd()
            with open(pwd_file, "w", encoding="utf-8") as f:
                f.write(pwd)
            os.chmod(pwd_file, 0o600)
            if os.path.exists(p12):
                os.unlink(p12)
            run_jar(["generate-keypair", "-keyAlias", "debugKey", "-keyAlg", "ECC",
                     "-keySize", "NIST-P-256", "-keystoreFile", p12,
                     "-keyPwd", pwd, "-keystorePwd", pwd], "generate-keypair")
        run_jar(["generate-csr", "-keyAlias", "debugKey", "-subject", "CN=DebugKey",
                 "-signAlg", "SHA256withECDSA", "-keystoreFile", p12,
                 "-keyPwd", pwd, "-keystorePwd", pwd, "-outFile", csr], "generate-csr")
        log(f"[3/6] 本地密钥与 CSR 就绪 {p12}")

        # 4) 证书
        # 证书名必须和这把私钥配套：AGC 账号里可能早有同名证书（别人/旧密钥签的），
        # 直接复用会导致 sign-app 报 "Certificates error / check keyAlias"。
        # 用 p12 文件的哈希做后缀 —— 同一把密钥永远同名，换密钥就是新证书。
        _kh = hashlib.sha256(open(p12, "rb").read()).hexdigest()[:8]
        cert_name = "auto_debug_" + "".join(
            ch for ch in team_id if ch not in "\\/.:") + "_" + _kh + ".cer"
        certs = list_certs(h)
        cert = next((c for c in certs if c.get("certName") == cert_name), None)
        if not cert:
            with open(csr, encoding="utf-8") as f:
                add_cert(h, f.read(), cert_name)
            certs = list_certs(h)
            cert = next((c for c in certs if c.get("certName") == cert_name), None)
            if not cert:
                raise RuntimeError("申请证书后仍查不到 " + cert_name)
            log(f"[4/6] 已新建证书 {cert_name}")
        else:
            log(f"[4/6] 复用已有证书 {cert_name}")
        cer_file = os.path.join(work, "debugKey.cer")
        u, sha = reapply(h, cert.get("certObjectId"))
        download(u, cer_file, sha)
        log(f"[4/6] 证书已下载 {cer_file}")
        result.update(certId=cert.get("id"), certName=cert_name)

        # 5) Profile
        # provisionName 带上证书 id：AGC 按名字去重，同名会直接返回
        # 已存在的 profile（里面绑的可能是别的证书 → 签名必失败）
        pname = hashlib.sha256(("%s_%s_%s_%s" % (a.product + "_" if a.product else "",
                                                 a.bundle, a.bundle,
                                                 cert.get("id"))).encode()).hexdigest()[:16]
        pid, purl = add_provision(h, cert.get("id"), a.bundle, target_ids, pname)
        p7b = os.path.join(work, "debugProfile.p7b")
        u2, sha2 = reapply(h, purl)
        download(u2, p7b, sha2)
        log(f"[5/6] Profile 已申请并下载 {p7b} (id={pid})")
        result.update(provisionId=pid, provisionName=pname)

        # 6) 签名
        sign_hap(a.hap, out, p12, pwd, cer_file, p7b)
        size = os.path.getsize(out)
        log(f"[6/6] 签名完成 {out} ({size} bytes)")
        result.update(ok=True, signed=out, bytes=size,
                      p12=p12, pwd=pwd, cer=cer_file, p7b=p7b, bundle=a.bundle)
    except Exception as e:
        result.update(ok=False, error=str(e)[:800])
        log("失败:", e)
    if a.json:
        print(json.dumps(result, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
