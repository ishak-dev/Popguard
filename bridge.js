// Runs in the extension's isolated world next to inpage.js. The page world can't talk to the
// extension directly, so inpage.js fires a DOM event and this forwards it to the background.
if (!globalThis.__popguardBridge__) {
  globalThis.__popguardBridge__ = true;
  document.addEventListener('popguard:blocked', (e) => {
    let data;
    try {
      data = JSON.parse(e.detail);
    } catch {
      return;
    }
    chrome.runtime.sendMessage({ type: 'blocked', kind: String(data.kind), url: String(data.url) }).catch(() => {});
  });
}
