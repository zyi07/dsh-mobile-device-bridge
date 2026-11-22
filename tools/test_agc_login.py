"""
离线验证扫码登录的状态判定（不需要手机、不需要网络）。

用鸭子类型的假页面走真实代码路径：poll() → is_on_agc() → _finish_success() → 写 Cookie 文件
"""
import asyncio
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agc_login  # noqa: E402


class StubPage:
    def __init__(self, url, text=""):
        self.url = url
        self._text = text

    async def evaluate(self, _script):
        return self._text

    async def get_by_text(self, *_a, **_k):
        class L:
            async def count(self_inner):
                return 0
        return L()

    async def wait_for_timeout(self, _ms):
        return None

    def locator(self, _sel):
        class L:
            async def count(self_inner):
                return 0
            async def bounding_box(self_inner):
                return None
        return L()

    async def screenshot(self, **_k):
        return b"\x89PNG\r\n\x1a\n" + b"0" * 8000   # 足够大，不会被判为空白


class StubCtx:
    async def cookies(self):
        return [
            {"name": "csrfToken", "value": "abc123", "domain": ".huawei.com", "path": "/"},
            {"name": "HW_id", "value": "x", "domain": ".huawei.com", "path": "/"},
        ]


def make_session(url, text=""):
    s = agc_login.LoginSession()
    s.page = StubPage(url, text)
    s.ctx = StubCtx()
    s.state = "waiting"
    s.started_at = time.time()
    s.qr_at = 0
    s.qr_b64 = "AAAA"
    return s


async def main():
    tmp = tempfile.mkdtemp()
    cookie_file = os.path.join(tmp, "agc-session.json")
    agc_login.COOKIE_FILE = cookie_file
    ok = True

    # 1) 还在登录页 → 不应判定成功
    s = make_session(
        "https://id7.cloud.huawei.com/CAS/portal/loginAuth.html"
        "?reqClientType=89&loginUrl=https%3A%2F%2Fid7.cloud.huawei.com%2FCAS%2Fportal%2FloginAuth.html")
    await s.poll()
    cond = s.state == "waiting" and not os.path.exists(cookie_file)
    print(f"1. 仍在登录页 → state={s.state} 文件未写入={'是' if not os.path.exists(cookie_file) else '否'}  {'✓' if cond else '✗'}")
    ok = ok and cond

    # 2) 回到 AGC 且查询参数里仍带 loginAuth.html → 必须判定成功（这是之前的 bug）
    s = make_session(
        "https://developer.huawei.com/consumer/cn/service/josp/agc/index.html"
        "?loginUrl=https%3A%2F%2Fid7.cloud.huawei.com%2FCAS%2Fportal%2FloginAuth.html")
    await s.poll()
    written = os.path.exists(cookie_file)
    cond = s.state == "success" and written
    print(f"2. 回跳 AGC（URL 带 loginAuth 参数）→ state={s.state} 文件={'已写入' if written else '未写入'}  {'✓' if cond else '✗'}")
    ok = ok and cond

    # 3) Cookie 内容正确
    if written:
        d = json.load(open(cookie_file, encoding="utf-8"))
        cond = "csrfToken=abc123" in d.get("cookieHeader", "") and d.get("csrf") == "abc123"
        print(f"3. Cookie 落盘内容 → csrf={d.get('csrf')!r} 条数={len(d.get('cookies', []))}  {'✓' if cond else '✗'}")
        ok = ok and cond
        mode = oct(os.stat(cookie_file).st_mode & 0o777)
        print(f"4. 文件权限 → {mode}  {'✓' if mode == '0o600' else '✗'}")
        ok = ok and mode == "0o600"

    # 5) 各种 URL 的判定
    cases = [
        ("https://developer.huawei.com/consumer/cn/service/josp/agc/index.html#/", True),
        ("https://developer.huawei.com/consumer/cn/service/josp/agc/index.html?x=1", True),
        ("https://id7.cloud.huawei.com/CAS/portal/loginAuth.html", False),
        ("https://developer.huawei.com/CAS/loginAuth.html", False),
        ("https://evil.example.com/consumer/cn/service/josp/agc/index.html", False),
    ]
    for url, want in cases:
        got = agc_login.is_on_agc(url)
        cond = got == want
        print(f"5. is_on_agc({url[:52]}…) = {got} 期望 {want}  {'✓' if cond else '✗'}")
        ok = ok and cond

    print("\nRESULT:", "全部通过" if ok else "有失败项")
    return 0 if ok else 1


sys.exit(asyncio.run(main()))
