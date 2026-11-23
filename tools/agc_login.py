#!/usr/bin/env python3
"""
华为账号扫码登录服务（供 DSH 插件宿主调用）

原理：宿主起一个真实 Chromium（Playwright），打开 AGC 登录页。
插件 UI 显示二维码，用户用华为手机扫码确认后，宿主自动抓取会话 Cookie，
交给 AGC 私有接口用来自动注册设备 / 申请调试证书 / 生成调试 Profile。

与小白调试助手的 Electron 内嵌浏览器取 Cookie 是同一原理，只是搬到宿主侧，
因此不需要用户手工从 F12 复制 Cookie。

协议：stdin 读一行命令，stdout 输出一行 JSON。
  start  → {"ok":true,"state":"waiting","qr":"<base64 png>","tick":N}
  status → {"ok":true,"state":"waiting|success|failed","message":"...","url":"..."}
  close  → {"ok":true}
成功时额外返回 {"account":"...","cookieCount":N}，并把 Cookie 写到 cookie_file。
"""

import asyncio
import base64
import io
from urllib.parse import urlsplit, urlencode, unquote
import json
import os
import re
import sys
import time
import urllib.request

CHROME = os.environ.get("AGC_CHROME", "/usr/bin/chromium-browser")
AGC_URL = "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html"
COOKIE_FILE = os.environ.get("AGC_COOKIE_FILE", "/root/.dsh/agc-session.json")
QR_MAX_AGE = 55          # 秒，超时就重新截一张（华为二维码约 2 分钟失效）
LOGIN_TIMEOUT = 480      # 秒，超时判定失败（8 分钟）

# ---- DevEco Studio 官方授权链路（与 IDE「自动签名」用的是同一条）----
# 打开 apply 页 → 华为账号登录（二维码/密码）→ 回调 127.0.0.1:<port>/?tempToken=…
# → temptoken/check 换成 JWT。小白助手之类工具弹网页做的也是这件事。
DEVECO_APPLY = "https://cn.devecostudio.huawei.com/console/DevEcoIDE/apply"
DEVECO_APPID = "1009"
DEVECO_SITE = "CN"
DEVECO_VERSION = os.environ.get("DEVECO_VERSION", "1.0.0")
TOKEN_CHECK = ("https://cn.devecostudio.huawei.com/authrouter/auth/api/"
               "temptoken/check")

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


def _to_png(img) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _rand_code() -> str:
    """apply 页要求的 32 位随机 hex（每次会话一个新值）"""
    return os.urandom(16).hex()


# 在页面里一次求值找出二维码元素（实测是 128×128 的 <img>），返回页面坐标
_QR_BOX_JS = """() => {
  let best = null;
  for (const el of document.querySelectorAll('canvas, img')) {
    const r = el.getBoundingClientRect();
    if (r.width < 100 || r.height < 100) continue;
    if (r.width > 420 || r.height > 420) continue;
    if (Math.abs(r.width - r.height) > 24) continue;
    if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
    if (!best || r.width > best[2]) best = [r.x + scrollX, r.y + scrollY, r.width, r.height];
  }
  return best;
}"""


def is_on_agc(url: str) -> bool:
    """是否已经回到 AGC 页面。

    只能看 hostname + path：跳转回来的 URL 查询参数里仍然可能带
    loginUrl=...loginAuth.html，对整条 URL 做子串判断会永远为假。
    """
    try:
        parts = urlsplit(url)
    except Exception:
        return False
    host = (parts.hostname or "").lower()
    path = (parts.path or "").lower()
    # 注意：path 已小写，必须用小写字面量比较（之前用驼峰 loginAuth 永远匹配不上）
    return host.endswith("developer.huawei.com") and "loginauth" not in path


class LoginSession:
    def __init__(self):
        self.pw = None
        self.browser = None
        self.ctx = None
        self.page = None
        self.state = "idle"
        self.message = ""
        self.qr_b64 = ""
        self.qr_at = 0.0
        self.started_at = 0.0
        self.account = ""
        self.mode = "qr"          # qr | pwd
        self.need_code = False    # 是否需要短信验证码
        self._ticker_task = None
        self.phase = "waiting"    # waiting | scanned | expired（仅扫码模式）
        self.qr_page_expired = False   # 截这张二维码时，页面上是否显示"已过期"
        self.loop = None
        # OAuth 回调
        self.oauth_port = 0
        self.oauth_url = ""
        self.temp_token = ""
        self._cb_server = None
        self.jwt = ""

    async def start(self, mode="qr", force=False):
        # 只有"刚生成不到 25 秒"的会话才复用；否则重开，避免返回一张过期二维码
        if (not force and self.page and self.state == "waiting"
                and self.qr_b64 and (time.time() - self.qr_at) < 25):
            self.mode = mode
            return
        self.mode = mode
        from playwright.async_api import async_playwright
        if self.browser:
            await self.close()
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(
            executable_path=CHROME, headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        # 复用已保存的登录态（cookie + localStorage），否则每次都要重新扫码
        _state = COOKIE_FILE if os.path.exists(COOKIE_FILE) else None
        self.ctx = await self.browser.new_context(
            user_agent=UA, viewport={"width": 1280, "height": 900}, locale="zh-CN",
            **({"storage_state": _state} if _state else {}),
        )
        self.page = await self.ctx.new_page()

        # ① 起本地回调服务：华为登录成功后 302 到 127.0.0.1:<port>/?tempToken=…
        await self._start_callback_server()
        url = (f"{DEVECO_APPLY}?port={self.oauth_port}"
               f"&appid={DEVECO_APPID}&code={_rand_code()}")
        self.oauth_url = url
        self.temp_token = ""
        try:
            await self.page.goto(url, wait_until="domcontentloaded", timeout=45000)
        except Exception as e:
            self.state = "failed"
            self.message = f"打开 DevEco 授权页失败: {str(e)[:120]}"
            return
        # 授权页会自己 302 到 CAS 登录页（二维码就在那里），不需要点任何按钮
        self.started_at = time.time()
        self.state = "waiting"
        if self._ticker_task is None or self._ticker_task.done():
            self._ticker_task = asyncio.create_task(self.ticker())
        got = await self._settle_and_pick()
        if got == "token":
            return
        if got != "qr":
            self.message = ((self.message or "二维码没出来")
                            + "（可点「刷新二维码」重试）")

    # ---------- OAuth loopback ----------
    async def _page_text(self):
        try:
            return await self.page.evaluate(
                "() => (document.body && document.body.innerText) || ''")
        except Exception:
            return ""

    async def _consent_pending(self):
        """已登录华为帐号时，apply 页不会出二维码，而是停在授权确认页：
        「DevEco CLI 想要访问您的华为帐号」+「允许」。点掉它才会回调 tempToken。"""
        body = await self._page_text()
        return ("想要访问您的华为帐号" in body or "允许DevEco" in body
                or "允许 DevEco" in body)

    async def _click_allow(self):
        """点授权确认页的「允许」。

        实测这个按钮是 `<div id="btn-confirm" class="btn-consent btn-confirm">`
        —— 用 text=允许 点它无效（事件绑在 div 上，点中的是内层文本），
        必须按 class/id 点，或者在页面里直接派发 click 事件。
        """
        if not self.page:
            return False
        try:
            if await self.page.locator(".btn-consent.btn-confirm").count():
                try:
                    await self.page.locator(".btn-consent.btn-confirm").first.click(timeout=5000)
                    return True
                except Exception:
                    pass
        except Exception:
            pass
        try:
            r = await self.page.evaluate("""() => {
                const el = document.querySelector('.btn-consent.btn-confirm, #btn-confirm');
                if (!el) return false;
                el.dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
                el.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
                el.click();
                return true;
            }""")
            if r:
                return True
        except Exception:
            pass
        return False

    async def _start_callback_server(self):
        """监听 127.0.0.1:<随机端口>，接华为登录成功后的 tempToken 回调。"""
        if self._cb_server:
            try:
                self._cb_server.close()
            except Exception:
                pass
            self._cb_server = None

        async def handle(reader, writer):
            """接华为的回调。实测是 `POST /callback`，tempToken 在请求体里
            （不是 GET/?tempToken=…）—— 只读第一行会永远拿不到 token。"""
            try:
                buf = b""
                while b"\r\n\r\n" not in buf and len(buf) < 65536:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=10)
                    if not chunk:
                        break
                    buf += chunk
                head, _, rest = buf.partition(b"\r\n\r\n")
                text = head.decode("utf-8", "replace")
                first = text.split("\r\n", 1)[0] if text else ""
                clen = 0
                for ln in text.split("\r\n")[1:]:
                    if ln.lower().startswith("content-length:"):
                        try:
                            clen = int(ln.split(":", 1)[1].strip())
                        except Exception:
                            clen = 0
                while clen and len(rest) < clen:
                    chunk = await asyncio.wait_for(reader.read(4096), timeout=10)
                    if not chunk:
                        break
                    rest += chunk
                body_text = rest.decode("utf-8", "replace")
                if os.environ.get("AGC_DEBUG"):
                    sys.stderr.write("[callback] %s | body=%r\n"
                                     % (first[:200], body_text[:300]))
                    sys.stderr.flush()
                blob = first + "&" + body_text
                m = re.search(r'tempToken["\']?\s*[:=]\s*["\']?([A-Za-z0-9._\-]+)', blob)
                if m:
                    self.temp_token = m.group(1)
                html = ("<html><head><meta charset='utf-8'><title>登录完成</title></head>"
                        "<body style='font-family:system-ui;padding:48px;text-align:center'>"
                        "<h2>登录完成</h2><p>可以关闭此页面，回到 DSH 继续。</p>"
                        "</body></html>").encode("utf-8")
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n"
                             b"Content-Length: " + str(len(html)).encode() +
                             b"\r\nConnection: close\r\n\r\n" + html)
                await writer.drain()
            except Exception:
                pass
            finally:
                try:
                    writer.close()
                except Exception:
                    pass

        # 页面回调用的是 http://localhost:<port>/callback，Chrome 可能解析到 ::1，
        # 只绑 127.0.0.1 会连不上 → 两个回环地址都绑。
        self._cb_server = await asyncio.start_server(handle, ["127.0.0.1", "::1"], 0)
        self.oauth_port = self._cb_server.sockets[0].getsockname()[1]

    async def _exchange_temp_token(self, temp_token):
        """tempToken → JWT（与 DevEco Studio 同一个接口）"""
        q = urlencode({"tempToken": temp_token, "site": DEVECO_SITE,
                       "version": DEVECO_VERSION, "appid": DEVECO_APPID})
        url = f"{TOKEN_CHECK}?{q}"

        def _do():
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "application/json, text/plain, */*",
                "Origin": "https://cn.devecostudio.huawei.com",
                "Referer": "https://cn.devecostudio.huawei.com/",
            })
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")

        raw = (await asyncio.to_thread(_do)).strip()
        # 实测：这个接口成功时**直接返回 JWT 字符串**（eyJ…三段），不是 JSON
        if raw.startswith("eyJ") and raw.count(".") == 2:
            self.jwt = raw
            return raw
        if raw.startswith('"') and raw.endswith('"') and raw.count(".") >= 2:
            self.jwt = raw.strip('"')
            return self.jwt
        try:
            data = json.loads(raw)
        except Exception:
            raise RuntimeError(f"temptoken/check 返回无法解析: {raw[:200]}")
        # 常见形态：{"ret":{"code":0},"token":"..."} / {"jwtToken":"..."} / 直接是字符串
        token = ""
        for k in ("token", "jwtToken", "jwt", "accessToken", "data"):
            v = data.get(k) if isinstance(data, dict) else None
            if isinstance(v, str) and v.count(".") == 2 and len(v) > 100:
                token = v
                break
            if isinstance(v, dict):
                for kk in ("token", "jwtToken", "jwt", "accessToken"):
                    if isinstance(v.get(kk), str) and v[kk].count(".") == 2:
                        token = v[kk]
                        break
            if token:
                break
        if not token:
            raise RuntimeError(f"没换到 JWT: {raw[:300]}")
        self.jwt = token
        return token

    async def _save_session(self, message=""):
        """保存登录态：JWT + Cookie（JWT 才是调 AGC API 的凭证）"""
        cookies = []
        try:
            cookies = await self.ctx.cookies()
        except Exception:
            pass
        payload = {
            "jwt": self.jwt,
            "cookieHeader": "; ".join(f"{c['name']}={c['value']}" for c in cookies),
            "csrf": next((c["value"] for c in cookies if c["name"] == "csrfToken"), ""),
            "cookies": [{k: c[k] for k in ("name", "value", "domain", "path")} for c in cookies],
            "savedAt": time.time(),
            "source": "deveco-oauth",
            "url": self.page.url if self.page else "",
        }
        os.makedirs(os.path.dirname(COOKIE_FILE) or ".", exist_ok=True)
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        try:
            os.chmod(COOKIE_FILE, 0o600)
        except Exception:
            pass
        self.state = "success"
        self.message = message or "登录成功，凭证已保存"
        return payload

    # ---------- 账号密码登录 ----------
    # ---------- 遥控浏览器（滑块验证由用户亲手完成）----------
    async def view(self):
        if not self.page:
            return {"ok": False, "error": "登录会话未启动"}
        try:
            png = await self.page.screenshot()
            vp = self.page.viewport_size or {"width": 1280, "height": 900}
            return {"ok": True, "image": base64.b64encode(png).decode(),
                    "width": vp["width"], "height": vp["height"], "url": self.page.url}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    async def act(self, action):
        if not self.page:
            return {"ok": False, "error": "登录会话未启动"}
        kind = action.get("type")
        try:
            if kind == "click":
                await self.page.mouse.click(float(action["x"]), float(action["y"]))
            elif kind == "drag":
                x1, y1 = float(action["x1"]), float(action["y1"])
                x2, y2 = float(action["x2"]), float(action["y2"])
                await self.page.mouse.move(x1, y1)
                await self.page.mouse.down()
                steps = 25
                for i in range(1, steps + 1):
                    await self.page.mouse.move(x1 + (x2 - x1) * i / steps,
                                               y1 + (y2 - y1) * i / steps)
                    await self.page.wait_for_timeout(12)
                await self.page.mouse.up()
            elif kind == "type":
                await self.page.keyboard.type(str(action.get("text", "")))
            elif kind == "press":
                await self.page.keyboard.press(str(action.get("key", "Enter")))
            else:
                return {"ok": False, "error": f"未知动作 {kind}"}
            await self.page.wait_for_timeout(600)
            # 动作后顺便判定是否已经登录成功
            if is_on_agc(self.page.url):
                await self._finish_success("登录成功（手动验证）")
            return {"ok": True, "state": self.state, "url": self.page.url[:160],
                    "message": self.message}
        except Exception as e:
            return {"ok": False, "error": str(e)[:200]}

    async def submit_password(self, account, password):
        """填账号密码并提交；不记录、不回传密码"""
        if not self.page:
            # 首次调用：自动拉起浏览器并进入登录页
            await self.start(mode="pwd")
            if self.state == "success":
                return
        # 如果当前不在登录页，先切过去
        if "loginAuth" not in self.page.url:
            await self.page.goto(
                "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html",
                wait_until="domcontentloaded")
            await self.page.wait_for_timeout(2500)
            if not await self._already_logged_in():
                await self.page.get_by_text("登录", exact=True).first.click(timeout=8000)
            try:
                await self.page.wait_for_url("**/loginAuth.html**", timeout=20000)
            except Exception:
                pass

        acc = self.page.locator("input.hwid-input.userAccount").first
        pwd = self.page.locator("input.hwid-input-pwd").first
        await acc.wait_for(state="visible", timeout=20000)
        await acc.fill(account)
        await pwd.fill(password)
        await self.page.wait_for_timeout(400)

        btn = self.page.locator('div[ht="click_pwdlogin_submitLogin"]').first
        await btn.click(timeout=15000)
        self.started_at = time.time()
        self.state = "waiting"
        self.message = "已提交账号密码，等待验证…"
        await self._after_submit()

    async def _after_submit(self):
        """提交后判定：成功 / 需要验证码 / 需要滑块 / 报错"""
        for _ in range(20):
            await self.page.wait_for_timeout(1500)
            url = self.page.url
            if is_on_agc(url):
                await self._finish_success("登录成功")
                return
            # 需要短信验证码
            code_input = self.page.locator(
                "input[placeholder*='验证码'], input[maxlength='6'], .hwid-verify-input input")
            try:
                if await code_input.count() > 0 and await code_input.first.is_visible():
                    self.need_code = True
                    self.state = "need_code"
                    self.message = "手机已收到验证码，请填写短信验证码"
                    return
            except Exception:
                pass
            # 滑块/图形验证：按真实文案判定（实测弹窗为「请完成安全验证」+「拖动滑块」）
            try:
                body = await self.page.evaluate(
                    "() => (document.body && document.body.innerText) || ''")
                if ("请完成安全验证" in body or "拖动滑块" in body
                        or "向右拖动" in body or "安全验证" in body):
                    self.state = "need_captcha"
                    self.message = "华为要求完成滑块验证：在下方画面上按住滑块往右拖即可"
                    return
            except Exception:
                pass
            # 明确报错
            for sel in (".hwid-error-tip", "[class*='error-tip']", ".hwid-error", "#errMsg"):
                try:
                    loc = self.page.locator(sel).first
                    if await loc.count() > 0 and await loc.is_visible():
                        txt = (await loc.inner_text())[:120]
                        if txt.strip():
                            self.state = "failed"
                            self.message = txt.strip()
                            return
                except Exception:
                    pass
        self.state = "failed"
        self.message = "提交后未检测到登录成功，请重试或改用扫码"

    async def submit_code(self, code):
        """填短信验证码并提交"""
        if not self.page:
            raise RuntimeError("登录会话未启动（请先提交账号密码）")
        loc = self.page.locator(
            "input[placeholder*='验证码'], input[maxlength='6'], .hwid-verify-input input").first
        await loc.wait_for(state="visible", timeout=15000)
        await loc.fill(code)
        for sel in ('div[ht*="submit"]', ".hwid-login-btn", "div.normalBtn", "button[type=submit]"):
            try:
                b = self.page.locator(sel).first
                if await b.count() > 0 and await b.is_visible():
                    await b.click(timeout=8000)
                    break
            except Exception:
                continue
        await self._after_submit()

    async def _already_logged_in(self):
        """真正判断是否已登录：不能只看"没有登录按钮（加载中的登录页也没有）"。
        必须 URL 在 AGC 域、不在 OAuth/登录域、且页面出现 AGC 后台特征。"""
        try:
            url = (self.page.url or "")
            if any(k in url for k in ("loginAuth", "oauth-login", "remoteLogin", "handleAllianceLogin", "loginCallback")):
                return False
            if "developer.huawei.com" not in url:
                return False
            n = await self.page.get_by_text("登录", exact=True).count()
            if n > 0:
                return False
            try:
                body = (await self.page.inner_text("body"))[:5000]
            except Exception:
                body = ""
            return any(k in body for k in ("证书", "Profile", "应用上架", "我的项目", "我的应用", "开发服务"))
        except Exception:
            return False

    async def _qr_box(self):
        """优先用真实二维码元素的包围盒，拿不到再退回固定区域"""
        for sel in (".hwid-qrCode-root canvas", ".hwid-qrCode-root img",
                    ".hwid-qrcode-full-box canvas", "canvas", "img[src*='qr']"):
            try:
                loc = self.page.locator(sel).first
                if await loc.count() == 0:
                    continue
                box = await loc.bounding_box()
                if box and box["width"] >= 100:
                    return (box["x"], box["y"], box["x"] + box["width"], box["y"] + box["height"])
            except Exception:
                continue
        return None

    @staticmethod
    def _normalize_qr(png: bytes) -> bytes:
        """裁到二维码主体并放大到 580×580。

        元素截图里二维码下方常带着说明文字，直接放大既难看也可能扫偏。
        这里用深色像素的包围盒定位二维码本体，再按正方形裁剪放大。
        """
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(png)).convert("L")
            w, h = img.size
            px = img.load()
            min_x, min_y, max_x, max_y = w, h, -1, -1
            for y in range(0, h, 2):
                for x in range(0, w, 2):
                    if px[x, y] < 100:
                        if x < min_x: min_x = x
                        if x > max_x: max_x = x
                        if y < min_y: min_y = y
                        if y > max_y: max_y = y
            if max_x <= min_x or max_y <= min_y:
                return png
            side = max(max_x - min_x, max_y - min_y) + 8
            cx = (min_x + max_x) // 2
            cy = (min_y + max_y) // 2
            x1 = max(0, cx - side // 2)
            y1 = max(0, cy - side // 2)
            x2 = min(w, x1 + side)
            y2 = min(h, y1 + side)
            square = img.crop((x1, y1, x2, y2)).convert("RGB")
            return _to_png(square.resize((580, 580), Image.LANCZOS))
        except Exception:
            return png

    @staticmethod
    def _crop_qr(png: bytes) -> bytes:
        """从整页截图里裁出二维码区域并放大，否则缩到面板宽度后扫不出来。

        布局来自实测（1280x900 视口，华为 CAS 登录页）：
        二维码位于左侧 368..528 x 255..415。
        """
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(png))
            box = (352, 240, 545, 433)          # 稍微留白
            crop = img.crop(box).resize((580, 580), Image.LANCZOS)
            buf = io.BytesIO()
            crop.save(buf, format="PNG")
            return buf.getvalue()
        except Exception:
            return png

    @staticmethod
    def _dark_ratio(png: bytes) -> float:
        """返回深色像素占比。二维码约 20%~45%；纯白/纯灰接近 0。

        这是唯一可靠的判据：之前用"整页截图大小"判断，整页有文字所以不空白，
        但裁给用户的那块是白的 —— 于是面板显示白板。
        """
        try:
            from PIL import Image
            im = Image.open(io.BytesIO(png)).convert("L")
            data = list(im.getdata())
            if not data:
                return 0.0
            return sum(1 for v in data if v < 128) / len(data)
        except Exception:
            return 0.0

    @staticmethod
    def _looks_blank(png: bytes) -> bool:
        return LoginSession._dark_ratio(png) < 0.03

    def _set_qr(self, png: bytes):
        self.qr_b64 = base64.b64encode(png).decode()
        self.qr_at = time.time()
        self.qr_page_expired = False
        self.message = ""

    async def _capture_qr(self, attempts=20):
        """取一张**确认含二维码**的图。实测 10 秒左右就能拿到。

        判据只有一个：裁出来的图里深色像素占比 >= 5%。
        旧实现按 6 个 CSS 选择器逐个试、每个最多等 6 秒，选择器一旦对不上
        就要卡满 8 分钟 —— 面板一直转圈，这就是「点了没反应」的根因。
        现在：一次 JS 求值找出够大的 canvas/img → 按包围盒裁剪截图；
        拿不到再退回整页截图 + 实测坐标（1280×900 下二维码在 384,270，128×128）。
        """
        if not self.page:
            return False
        last_full = None
        for attempt in range(1, max(1, attempts) + 1):
            try:
                box = None
                try:
                    box = await self.page.evaluate(_QR_BOX_JS)
                except Exception:
                    box = None
                if box:
                    try:
                        png = await self.page.screenshot(clip={
                            "x": float(box[0]), "y": float(box[1]),
                            "width": float(box[2]), "height": float(box[3])})
                        png = self._normalize_qr(png)
                        if self._dark_ratio(png) >= 0.05:
                            self._set_qr(png)
                            return True
                    except Exception:
                        pass
                # 兜底：整页截图 + 固定区域裁剪
                try:
                    from PIL import Image
                    full = await self.page.screenshot()
                    last_full = full
                    img = Image.open(io.BytesIO(full))
                    crop = img.crop((352, 240, 545, 433)).resize((580, 580), Image.LANCZOS)
                    buf = io.BytesIO()
                    crop.save(buf, format="PNG")
                    cand = buf.getvalue()
                    if self._dark_ratio(cand) >= 0.05:
                        self._set_qr(self._normalize_qr(cand))
                        return True
                except Exception:
                    pass
                self.message = f"二维码还没渲染好（第 {attempt} 次），稍候…"
            except Exception as e:
                self.message = f"截图失败（第 {attempt} 次）: {str(e)[:100]}"
            await self.page.wait_for_timeout(1200)
        # 抓不到就把当时的整页截图落盘，方便排查（不然只能猜）
        if last_full:
            try:
                dbg = os.environ.get("AGC_DEBUG_SHOT", "/tmp/agc_qr_fail.png")
                with open(dbg, "wb") as f:
                    f.write(last_full)
                self.message += f"（已存截图 {dbg}）"
            except Exception:
                pass
        # 彻底拿不到：清空图片（绝不把白板发给前端），但**不判死会话**，
        # 保持等待状态，让后台 ticker 继续重试；用户也可以点「开始登录」重开。
        self.qr_b64 = ""
        self.message = "二维码暂时取不到，正在后台重试…（也可点「开始登录」重开）"
        return False

    async def _settle_and_pick(self):
        """apply 页打开后还会再跳一次（→ CAS 登录页，或已登录 → 授权确认页）。

        这段时间 page.evaluate 会抛 "Execution context was destroyed"，
        所以必须在一个循环里反复试：看到确认页就点「允许」，看到二维码就截，
        拿到 tempToken 就结束。这样才不会被中间态卡住。
        """
        for _ in range(25):
            if self.temp_token:
                return "token"
            await self.page.wait_for_timeout(1000)
            try:
                body = await self._page_text()
            except Exception:
                continue
            if body and ("想要访问您的华为帐号" in body or "允许DevEco" in body):
                self.message = "华为帐号已登录，正在完成授权…"
                if await self._click_allow():
                    self.message = "已点「允许」，正在取凭证…"
                    for _ in range(15):
                        if self.temp_token:
                            return "token"
                        await self.page.wait_for_timeout(600)
                    # 授权后通常会跳到 127.0.0.1 回调页
                    if "127.0.0.1" in (self.page.url or ""):
                        return "token"
                continue
            if await self._capture_qr(attempts=1):
                return "qr"
        return ""

    async def _finish_success(self, message=""):
        cookies = await self.ctx.cookies()
        payload = {
            "cookieHeader": "; ".join(f"{c['name']}={c['value']}" for c in cookies),
            "csrf": next((c["value"] for c in cookies if c["name"] == "csrfToken"), ""),
            "cookies": [{k: c[k] for k in ("name", "value", "domain", "path")} for c in cookies],
            "savedAt": time.time(),
            "url": self.page.url,
        }
        os.makedirs(os.path.dirname(COOKIE_FILE), exist_ok=True)
        with open(COOKIE_FILE, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.chmod(COOKIE_FILE, 0o600)
        self.state = "success"
        self.message = message or "登录成功"
        self.account = ""

    async def _click_refresh(self):
        """点掉「二维码已过期」上的刷新按钮（实测按钮文案就是「刷新」）"""
        for sel in ("text=刷新", "text=刷新二维码", "text=点击刷新",
                    ".hwid-qrcode-refresh", "[class*='refresh']"):
            try:
                loc = self.page.locator(sel).first
                if await loc.count() > 0 and await loc.is_visible():
                    await loc.click(timeout=3000)
                    await self.page.wait_for_timeout(1800)
                    return True
            except Exception:
                continue
        return False

    async def _restart_browser(self):
        """彻底重开浏览器并重新进登录页（保留 Cookie 无关紧要，登录本来就没成功）"""
        try:
            await self.close()
        except Exception:
            pass
        await self.start(force=True)

    async def _page_phase(self):
        """读页面文案判断扫码阶段（实测文案：扫码成功 / 请在手机上确认 / 已失效）"""
        try:
            body = await self.page.evaluate(
                "() => (document.body && document.body.innerText) || ''")
        except Exception:
            return "waiting"
        if any(k in body for k in ("已失效", "已过期", "二维码已过期", "点击刷新",
                                   "刷新二维码", "失效", "过期")):
            return "expired"
        if any(k in body for k in ("扫码成功", "请在手机上确认", "已扫描",
                                   "请在手机", "确认登录", "已扫码")):
            return "scanned"
        return "waiting"

    async def ticker(self):
        """后台定时检查：自动刷新二维码、检测扫码/过期，不依赖前端轮询"""
        while True:
            await asyncio.sleep(12)
            try:
                if self.state == "waiting":
                    await self.poll()
            except Exception as e:
                self.message = f"后台检查异常: {str(e)[:100]}"

    async def poll(self):
        if self.state in ("success", "failed", "need_code", "need_captcha"):
            return
        if not self.page:
            self.state = "failed"
            self.message = "会话未启动"
            return
        # ★ 扫码成功的唯一可靠信号：本地回调收到 tempToken
        if self.temp_token:
            try:
                self.message = "扫码成功，正在换取登录凭证…"
                await self._exchange_temp_token(self.temp_token)
                await self._save_session("扫码登录成功，凭证已保存")
            except Exception as e:
                self.state = "failed"
                self.message = f"换取凭证失败: {str(e)[:160]}"
            return
        url = self.page.url
        # 授权确认页（华为帐号已登录时出现，没有二维码）→ 直接点「允许」
        if await self._consent_pending():
            self.message = "华为帐号已登录，正在完成授权…"
            if await self._click_allow():
                return
        # 兜底：万一回调没接住但浏览器已经回到 DevEco/AGC
        if is_on_agc(url):
            await self._finish_success("已返回 AGC，登录态已保存")
            return
        if time.time() - self.started_at > LOGIN_TIMEOUT:
            self.state = "failed"
            self.message = "登录超时（5 分钟），请重新发起"
            return
        # 阶段判定：让用户知道"已扫码，在手机上确认"
        phase = await self._page_phase()
        self.phase = phase
        if phase == "scanned":
            # 已经扫上了：绝不再刷新二维码，也不做过期处理，
            # 否则会把"等待手机确认"的画面覆盖成一张新二维码（用户看到"又让我扫码"）
            self.message = "已扫码，请在手机上确认登录"
            return
        if phase == "expired":
            if time.time() - self.qr_at > 3:
                await self._click_refresh()
                await self._capture_qr()
                # 点了刷新还是过期 → 整个会话重开（最可靠）
                if await self._page_phase() == "expired":
                    self.message = "二维码过期且刷新无效，正在重新打开登录页…"
                    await self._restart_browser()
        elif time.time() - self.qr_at > QR_MAX_AGE:
            await self._capture_qr()

    async def close(self):
        if self._ticker_task:
            self._ticker_task.cancel()
            self._ticker_task = None
        if self._cb_server:
            try:
                self._cb_server.close()
            except Exception:
                pass
            self._cb_server = None
        for obj, fn in ((self.ctx, "close"), (self.browser, "close"), (self.pw, "stop")):
            try:
                if obj:
                    await getattr(obj, fn)()
            except Exception:
                pass
        self.ctx = self.browser = self.pw = self.page = None

    def snapshot(self, with_qr=False):
        out = {"ok": True, "state": self.state, "message": self.message, "mode": self.mode,
               "needCode": self.need_code, "phase": self.phase,
               "qrPageExpired": self.qr_page_expired}
        if self.page:
            out["url"] = self.page.url[:160]
        if with_qr and self.qr_b64 and self.state != "success":
            out["qr"] = self.qr_b64
            age = int(time.time() - self.qr_at)
            out["qrAge"] = age
            out["qrLeft"] = max(0, 110 - age)     # 华为二维码约 2 分钟有效，这里给保守值
        if self.state == "success":
            out["cookieFile"] = COOKIE_FILE
            out["hasJwt"] = bool(self.jwt)
            try:
                with open(COOKIE_FILE, encoding="utf-8") as f:
                    d = json.load(f)
                out["cookieCount"] = len(d.get("cookies") or [])
                out["hasJwt"] = bool(d.get("jwt"))
            except Exception:
                out["cookieCount"] = 0
        return out


def _emit(obj):
    """向宿主写一行 JSON；管道断开时抛 BrokenPipeError 由上层退出"""
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


async def main():
    sess = LoginSession()
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break
        raw = line.decode().strip()
        cmd, _, arg = raw.partition(" ")
        try:
            if cmd == "login-password":
                params = json.loads(arg or "{}")
                await sess.submit_password(params.get("account", ""), params.get("password", ""))
                _emit(sess.snapshot(with_qr=False))
            elif cmd == "view":
                _emit(await sess.view())
            elif cmd == "act":
                _emit(await sess.act(json.loads(arg or "{}")))
            elif cmd == "login-code":
                params = json.loads(arg or "{}")
                await sess.submit_code(params.get("code", ""))
                _emit(sess.snapshot(with_qr=False))
            elif cmd == "start-force":
                await sess.start(force=True)
                _emit(sess.snapshot(with_qr=True))
            elif cmd == "start":
                await sess.start()
                _emit(sess.snapshot(with_qr=True))
            elif cmd == "status":
                await sess.poll()
                _emit(sess.snapshot(with_qr=True))
            elif cmd == "close":
                await sess.close()
                _emit({"ok": True})
                break
            else:
                _emit({"ok": False, "error": f"未知命令 {cmd}"})
        except BrokenPipeError:
            break
        except Exception as e:
            try:
                _emit({"ok": False, "error": str(e)[:300]})
            except BrokenPipeError:
                break
    await sess.close()


if __name__ == "__main__":
    asyncio.run(main())