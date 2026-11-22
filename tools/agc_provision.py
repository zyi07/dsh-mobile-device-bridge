import asyncio, json, os, urllib.parse
from playwright.async_api import async_playwright
CHROME="/usr/bin/chromium-browser"
UA=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
BASE="https://agc-drcn.developer.huawei.com"; TEAM="<TEAM_ID>"
CERT_ID="2089416742357996352"; PROJECT="101653523865686153"; DEVICE_ID="<CLOUD_DEVICE_ID>"
PKG="com.dsh.bridgeapp"

async def main():
    d=json.load(open(os.path.expanduser('~/.dsh/agc-session.json'))); csrf=d.get('csrf') or ''
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path=CHROME,headless=True,args=["--no-sandbox","--disable-dev-shm-usage"])
        ctx=await b.new_context(user_agent=UA,viewport={"width":1280,"height":900},locale="zh-CN")
        await ctx.add_cookies([{'name':c['name'],'value':c['value'],'domain':c.get('domain') or '.huawei.com','path':c.get('path') or '/'} for c in (d.get('cookies') or [])])
        async def call(path,payload=None,method='POST'):
            h={'content-type':'application/json','x-hd-csrf':csrf,'agcteamid':TEAM,
               'Origin':'https://developer.huawei.com','Referer':'https://developer.huawei.com/'}
            kw={'headers':h,'timeout':60000}
            if method=='POST': kw['data']=json.dumps(payload or {})
            fn=ctx.request.post if method=='POST' else ctx.request.get
            r=await fn(BASE+path,**kw); return r.status,(await r.text())

        # 1) 创建应用
        st,body=await call('/agc/edge/amis/app-manage/v1/app', {
            "appName":"DSH Bridge Demo","packageName":PKG,"defaultLang":"zh-CN","parentType":13,
            "createCountry":"CN","projectId":PROJECT,"packageType":7,
            "deviceTypes":[{"deviceType":4}],"appDevelopStatus":0,"installationFree":0,"createChannel":0})
        print("1) 创建应用 HTTP",st); print("   ", body[:300])
        appid=None
        try:
            j=json.loads(body); appid=(j.get('appInfo') or {}).get('appId') or j.get('appId')
        except Exception: pass
        if not appid:
            st,body=await call('/agc/edge/amis/app-manage/v1/app/list?maxReqCount=50&packageType=7&fromRecCount=1',None,'GET')
            for a in (json.loads(body).get('appList') or []):
                if a.get('packageName')==PKG: appid=a.get('appId')
        print("   appId =", appid)
        if not appid: await b.close(); return

        # 2) 创建调试 Profile
        st,body=await call('/agc/edge/cps/provision-manage/v1/provision', {
            "provisionName":"dsh_debug_profile","certList":[CERT_ID],
            "provisionType":1,"appId":appid,"deviceList":[DEVICE_ID],"permissionList":[]})
        print("\n2) 创建 Profile HTTP",st); print("   ", body[:500])
        pid=None; pobj=None
        try:
            j=json.loads(body)
            pi=j.get('provisionInfo') or j.get('provision') or {}
            pid=pi.get('id') or j.get('id')
            pobj=pi.get('provisionObjectId') or pi.get('objectId') or j.get('objectId')
        except Exception: pass
        print("   profileId =", pid, "| objectId =", pobj)

        # 3) 若没拿到 objectId，查 profile 列表
        if not pobj:
            st,body=await call(f'/agc/edge/cps/provision-manage/v1/provision/list?start=1&pageSize=20&packageName={PKG}',None,'GET')
            j=json.loads(body)
            for x in (j.get('provisionList') or j.get('list') or []):
                if x.get('provisionName')=='dsh_debug_profile' or x.get('packageName')==PKG:
                    pid=pid or x.get('id')
                    pobj=x.get('provisionObjectId') or x.get('objectId')
            print("   回查 profileId =", pid, "| objectId =", pobj)

        # 4) 下载 Profile
        if pobj:
            qs=urllib.parse.urlencode({'objectId':pobj,'downloadFileName':'dsh_debug_profile.p7b'})
            st,body=await call('/agc/edge/cfs/file_service/v1/download/object/url?'+qs,{})
            url=json.loads(body)['urlInfo']['url']
            r=await ctx.request.get(url, timeout=60000)
            data=await r.body(); open('dsh_debug_profile.p7b','wb').write(data)
            print("\n3) Profile 下载 HTTP",r.status, len(data),"字节")
        json.dump({"appId":appid,"profileId":pid,"profileObj":pobj}, open('ids.json','w'))
        await b.close()
asyncio.run(main())
