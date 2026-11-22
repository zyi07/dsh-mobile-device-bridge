// 读取 developer.huawei.com 的 Cookie 并 POST 给本机 DSH 插件。
// Cookie 只发往 127.0.0.1，不经过任何第三方。

const DEFAULT_BASE = 'http://127.0.0.1:3080';

async function collectCookies() {
  // 与 AGC 私有接口相关的域：developer.huawei.com 及其子域
  const domains = ['.huawei.com', 'developer.huawei.com', 'agc-drcn.developer.huawei.com'];
  const seen = new Map();
  for (const d of domains) {
    const list = await chrome.cookies.getAll({ domain: d.replace(/^\./, '') });
    for (const c of list) {
      if (c.domain.endsWith('huawei.com')) { seen.set(c.name + '@' + c.domain, c); }
    }
  }
  return Array.from(seen.values());
}

async function send(base) {
  const DSH_ENDPOINT = (base || DEFAULT_BASE).replace(/\/$/, '') + '/mbridge/agc/cookie';
  const cookies = await collectCookies();
  if (!cookies.length) {
    return { ok: false, error: '没有找到华为账号 Cookie：请先在当前浏览器登录 developer.huawei.com' };
  }
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const csrf = (cookies.find((c) => c.name === 'csrfToken') || {}).value || '';
  const payload = {
    cookieHeader,
    csrf,
    cookies: cookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path })),
    savedAt: Date.now() / 1000,
    source: 'extension',
  };
  try {
    const r = await fetch(DSH_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.ok === false) {
      return { ok: false, error: d.error || `DSH 返回 HTTP ${r.status}` };
    }
    return { ok: true, count: cookies.length };
  } catch (e) {
    return { ok: false, error: '连不上本机 DSH（127.0.0.1:3080）：' + e.message };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'send-session') {
    send(msg.endpoint).then(reply);
    return true;   // 异步回复
  }
  return false;
});
