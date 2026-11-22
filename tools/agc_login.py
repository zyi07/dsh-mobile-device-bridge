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
from urllib.parse import urlsplit
import json
import os
import sys
import time

CHROME = os.environ.get("AGC_CHROME", "/usr/bin/chromium-browser")
AGC_URL = "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html"
COOKIE_FILE = os.environ.get("AGC_COOKIE_FILE", "/root/.dsh/agc-session.json")
QR_MAX_AGE = 55          # 秒，超时就重新截一张（华为二维码约 2 分钟失效）
LOGIN_TIMEOUT = 480      # 秒，超时判定失败（8 分钟）

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


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
        self.ctx = await self.browser.new_context(
            user_agent=UA, viewport={"width": 1280, "height": 900}, locale="zh-CN",
        )
        self.page = await self.ctx.new_page()
        await self.page.goto(AGC_URL, wait_until="domcontentloaded", timeout=45000)
        await self.page.wait_for_timeout(3000)

        # 已登录就不会出现「登录」按钮
        if await self._already_logged_in():
            await self._finish_success("cookie 已存在，无需重新登录")
            return

        try:
            await self.page.get_by_text("登录", exact=True).first.click(timeout=8000)
        except Exception:
            # 兜底：直接跳到登录页
            await self.page.goto(
                "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html",
                wait_until="domcontentloaded")
            await self.page.get_by_text("登录", exact=True).first.click(timeout=8000)

        # 等登录页真正出来（URL 变成 CAS 登录页）
        try:
            await self.page.wait_for_url("**/loginAuth.html**", timeout=25000)
        except Exception:
            pass
        self.started_at = time.time()
        self.state = "waiting"
        if self._ticker_task is None or self._ticker_task.done():
            self._ticker_task = asyncio.create_task(self.ticker())
        ok = await self._capture_qr()
        if not ok:
            self.message = (self.message or "") + "（可点「刷新二维码」重试）" 

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
        try:
            n = await self.page.get_by_text("登录", exact=True).count()
            return n == 0
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
    def _looks_blank(png: bytes) -> bool:
        """空白页截图会被压得很小；二维码页通常在 10KB 以上"""
        return len(png) < 6000

    async def _capture_qr(self):
        """等到登录页真正渲染出来再截图。

        之前直接截会在页面还没画完时抓到一张纯白图（插件里表现为白屏），
        所以这里：轮询等待 → 截图 → 检查是否空白 → 反复重试。
        """
        for attempt in range(1, 13):
            if not self.page:
                return False
            try:
                await self.page.wait_for_timeout(1200)
                png = await self.page.screenshot()          # 整页：用户也能看到「短信验证码登录」等其它入口
                if not self._looks_blank(png):
                    self.qr_page_expired = (await self._page_phase()) == "expired"
                    self.qr_b64 = base64.b64encode(self._crop_qr(png)).decode()
                    self.qr_at = time.time()
                    self.message = ""
                    return True
                self.message = f"登录页渲染中（第 {attempt} 次），稍候…"
            except Exception as e:
                self.message = f"截屏失败（第 {attempt} 次）: {str(e)[:120]}"
            await self.page.wait_for_timeout(1000)
        self.message = "登录页一直没能渲染出来，请点「刷新二维码」重试"
        return False

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
        if "扫码成功" in body or "请在手机上确认" in body or "已扫描" in body:
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
        url = self.page.url
        # 登录成功后会被带回 AGC。
        # 注意：跳转回来的 URL 查询参数里仍可能带着 loginUrl=...loginAuth.html，
        # 所以只能看 hostname + path，不能对整条 URL 做 "loginAuth not in url" 判断。
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
        if with_qr and self.qr_b64:
            out["qr"] = self.qr_b64
            age = int(time.time() - self.qr_at)
            out["qrAge"] = age
            out["qrLeft"] = max(0, 110 - age)     # 华为二维码约 2 分钟有效，这里给保守值
        if self.state == "success":
            out["cookieFile"] = COOKIE_FILE
            try:
                with open(COOKIE_FILE, encoding="utf-8") as f:
                    d = json.load(f)
                out["cookieCount"] = len(d.get("cookies") or [])
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