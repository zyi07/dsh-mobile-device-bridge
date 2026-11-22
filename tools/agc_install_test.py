import base64, json, os, subprocess, sys, time
import urllib.request

B = "http://127.0.0.1:3080/mbridge"
HAP = sys.argv[1] if len(sys.argv) > 1 else "dsh_mini_signed.hap"
remote = "/data/local/tmp/" + os.path.basename(HAP)

def post(path, obj, timeout=900):
    data = json.dumps(obj).encode()
    req = urllib.request.Request(B + path, data=data,
                                 headers={'content-type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode())
    except Exception as e:
        return -1, {'error': repr(e)}

def status():
    try:
        with urllib.request.urlopen(B + "/status", timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {'error': repr(e)}

st = status()
print("设备:", st.get('device'), "| browserAlive:", st.get('browserAlive'))
if not st.get('device'):
    sys.exit("设备未连接")

size = os.path.getsize(HAP)
print(f"包大小: {size/1048576:.2f} MB")
payload = {'path': remote, 'base64': base64.b64encode(open(HAP,'rb').read()).decode(),
           'timeoutMs': 900000}
t0 = time.time()
code, res = post('/push', payload)
print(f"push HTTP {code} {time.time()-t0:.1f}s →", 'ok' if res.get('ok') else res.get('error') or res)
if not res.get('ok'):
    sys.exit(1)

# 校验远端大小
code, res = post('/exec', {'cmd': f'ls -l {remote}; sha256sum {remote}', 'timeoutMs': 60000})
if res.get('ok'):
    out = (res.get('output') or '').split('\n', 1)
    print("远端:", (out[1] if len(out) > 1 else out[0]).strip())

# 安装
print("\n=== bm install -p ===")
code, res = post('/exec', {'cmd': f'bm install -p {remote}', 'timeoutMs': 300000})
print("HTTP", code)
print((res.get('output') or res.get('error') or '')[:800])
