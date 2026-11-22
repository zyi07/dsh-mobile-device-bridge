import asyncio, json, os
from playwright.async_api import async_playwright

CHROME = "/usr/bin/chromium-browser"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BASE = "https://agc-drcn.developer.huawei.com"

async def main():
    d = json.load(open(os.path.expanduser('~/.dsh/agc-session.json')))
    csrf = d.get('csrf') or ''
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path=CHROME, headless=True,
                                    args=["--no-sandbox","--disable-dev-shm-usage"])
        ctx = await b.new_context(user_agent=UA, viewport={"width":1280,"height":900}, locale="zh-CN")
        cookies = [{'name': c['name'], 'value': c['value'],
                    'domain': c.get('domain') or '.huawei.com',
                    'path': c.get('path') or '/'} for c in (d.get('cookies') or [])]
        await ctx.add_cookies(cookies)

        hdr = {
            'content-type': 'application/json',
            'x-hd-csrf': csrf,
            'Origin': 'https://developer.huawei.com',
            'Referer': 'https://developer.huawei.com/',
            'Accept': 'application/json, text/plain, */*',
        }

        async def call(path, payload=None, method='POST', extra=None):
            h = dict(hdr)
            if extra: h.update(extra)
            fn = ctx.request.post if method == 'POST' else ctx.request.get
            kwargs = {'headers': h, 'timeout': 45000}
            if method == 'POST':
                kwargs['data'] = json.dumps(payload or {})
            r = await fn(BASE + path, **kwargs)
            return r.status, (await r.text())[:1500]

        st, body = await call('/agc/edge/apios/invokeService/AGCHomePageOrchestration/getUserInfo',
                              {'inputParameters': {}})
        print("=== getUserInfo ===  HTTP", st)
        print(body[:900])

        st2, body2 = await call('/agc/edge/ups/user-permission-service/v1/user-team-list', None, 'GET')
        print("\n=== userTeamList ===  HTTP", st2)
        print(body2[:800])
        await b.close()

asyncio.run(main())
