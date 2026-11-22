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
import json
import os
import sys
import time

CHROME = os.environ.get("AGC_CHROME", "/usr/bin/chromium-browser")
AGC_URL = "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html"
COOKIE_FILE = os.environ.get("AGC_COOKIE_FILE", "/root/.dsh/agc-session.json")
QR_MAX_AGE = 90          # 秒，超时就重新截一张
LOGIN_TIMEOUT = 300      # 秒，超时判定失败

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")


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
        self.loop = None

    async def start(self):
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

        await self.page.wait_for_timeout(5000)
        self.started_at = time.time()
        self.state = "waiting"
        await self._capture_qr()

    async def _already_logged_in(self):
        try:
            n = await self.page.get_by_text("登录", exact=True).count()
            return n == 0
        except Exception:
            return False

    async def _capture_qr(self):
        """把登录页上的二维码单独截出来（比整页小得多，便于在面板里显示）"""
        try:
            for sel in ("canvas", "img[src*='qr']", ".qrcode-img", "#qrCode"):
                loc = self.page.locator(sel).first
                if await loc.count() > 0:
                    png = await loc.screenshot()
                    self.qr_b64 = base64.b64encode(png).decode()
                    self.qr_at = time.time()
                    return True
        except Exception as e:
            self.message = f"截取二维码失败: {e}"
        # 兜底：整页截图
        try:
            png = await self.page.screenshot(clip={"x": 300, "y": 180, "width": 560, "height": 420})
            self.qr_b64 = base64.b64encode(png).decode()
            self.qr_at = time.time()
            return True
        except Exception:
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

    async def poll(self):
        if self.state in ("success", "failed"):
            return
        if not self.page:
            self.state = "failed"
            self.message = "会话未启动"
            return
        url = self.page.url
        # 登录成功后会被带回 developer.huawei.com
        if "developer.huawei.com" in url and "loginAuth" not in url:
            if not await self._already_logged_in():
                await self._finish_success("登录成功，已获取会话")
                return
        if time.time() - self.started_at > LOGIN_TIMEOUT:
            self.state = "failed"
            self.message = "登录超时（5 分钟），请重新发起"
            return
        if time.time() - self.qr_at > QR_MAX_AGE:
            await self._capture_qr()

    async def close(self):
        for obj, fn in ((self.ctx, "close"), (self.browser, "close"), (self.pw, "stop")):
            try:
                if obj:
                    await getattr(obj, fn)()
            except Exception:
                pass
        self.ctx = self.browser = self.pw = self.page = None

    def snapshot(self, with_qr=False):
        out = {"ok": True, "state": self.state, "message": self.message}
        if self.page:
            out["url"] = self.page.url[:160]
        if with_qr and self.qr_b64:
            out["qr"] = self.qr_b64
            out["qrAge"] = int(time.time() - self.qr_at)
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
        cmd = line.decode().strip()
        try:
            if cmd == "start":
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