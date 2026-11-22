"""分片推送：每块一个独立 HTTP 请求，天然幂等，支持断点续传。"""
import base64, json, os, sys, time, urllib.request

B = "http://127.0.0.1:3080/mbridge"
SRC = sys.argv[1] if len(sys.argv) > 1 else "dsh_small_signed.hap"
REMOTE = "/data/local/tmp/" + os.path.basename(SRC)
CHUNK = 65536

def post(path, obj, timeout=180):
    data = json.dumps(obj).encode()
    req = urllib.request.Request(B + path, data=data,
                                 headers={'content-type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {'ok': False, 'error': repr(e)[:160]}

def shell(cmd, timeout=60):
    r = post('/exec', {'cmd': cmd, 'timeoutMs': timeout * 1000}, timeout + 30)
    if not r.get('ok'):
        return ''
    out = r.get('output') or ''
    return out.split('\n', 1)[1] if '\n' in out else out

data = open(SRC, 'rb').read()
total = (len(data) + CHUNK - 1) // CHUNK
print(f"文件 {len(data)} 字节，共 {total} 块")

# 询问远端已有多少字节，从断点继续
remote_size = 0
line = shell(f"ls -l {REMOTE} 2>/dev/null")
import re
m = re.search(r'\s(\d+)\s+\d{4}-\d{2}-\d{2}', line or '')
if m:
    remote_size = int(m.group(1))
    print(f"远端已有 {remote_size} 字节")
start = remote_size // CHUNK
print(f"从第 {start} 块继续")

t0 = time.time()
fail = 0
for i in range(start, total):
    chunk = data[i*CHUNK:(i+1)*CHUNK]
    r = post('/push', {
        'path': REMOTE,
        'base64': base64.b64encode(chunk).decode(),
        'index': i, 'chunkSize': CHUNK, 'timeoutMs': 120000,
    })
    if not r.get('ok'):
        fail += 1
        print(f"  块 {i} 失败({fail}): {str(r.get('error'))[:90]}")
        if fail >= 3:
            print("连续失败 3 次，停止（可重跑本脚本续传）")
            break
        time.sleep(1.0)
        continue
    fail = 0
    if i % 10 == 0 or i == total - 1:
        pct = (i + 1) * 100 // total
        print(f"  {pct:3d}%  块 {i+1}/{total}  {time.time()-t0:.0f}s")
print(f"完成，用时 {time.time()-t0:.1f}s")
