const DEFAULT_ENDPOINT = 'http://127.0.0.1:3080';
const ep = document.getElementById('endpoint');
chrome.storage.local.get(['endpoint'], (v) => {
  ep.value = v.endpoint || DEFAULT_ENDPOINT;
});
ep.addEventListener('change', () => {
  chrome.storage.local.set({ endpoint: ep.value.trim() || DEFAULT_ENDPOINT });
});
const btn = document.getElementById('send');
const msg = document.getElementById('msg');

btn.addEventListener('click', () => {
  btn.disabled = true;
  msg.className = '';
  msg.textContent = '正在读取 Cookie 并发送…';
  chrome.runtime.sendMessage({ type: 'send-session', endpoint: ep.value.trim() || DEFAULT_ENDPOINT }, (res) => {
    btn.disabled = false;
    if (res && res.ok) {
      msg.className = 'ok';
      msg.textContent = `已发送 ${res.count} 条 Cookie。回到 DSH 插件面板即可继续。`;
    } else {
      msg.className = 'err';
      msg.textContent = (res && res.error) || '发送失败';
    }
  });
});
