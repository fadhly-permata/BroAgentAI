// P0 spike content script (isolated world), registered dynamically by the panel.
// Runs the bridge check, collects what the user scripts wrote, and prints every
// stored result into the page so it can be read from the tab itself.
(async () => {
  const root = document.documentElement;

  // C5: does a DOM event reach the user-script worlds and get answered synchronously?
  const probe = document.createElement('div');
  probe.id = 'p0-probe';
  probe.hidden = true;
  document.body.appendChild(probe);
  const t0 = performance.now();
  probe.dispatchEvent(new CustomEvent('p0:ping', { bubbles: true }));
  const syncBridge = {
    replyA: probe.getAttribute('data-p0-reply-A'),
    replyB: probe.getAttribute('data-p0-reply-B'),
    ms: Math.round((performance.now() - t0) * 1000) / 1000,
  };

  // C6: was the dynamically registered CSS applied?
  const cssVar = getComputedStyle(root).getPropertyValue('--p0-css').trim();

  // Give the async checks (messaging, fetch) time to finish.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const attrs = {};
  for (const a of root.attributes) if (a.name.startsWith('data-p0')) attrs[a.name] = a.value;

  const report = {
    url: location.href,
    time: new Date().toISOString(),
    syncBridge,
    cssVar,
    attrs,
    contentScriptSeesUserGlobal: typeof window.__p0Name,
  };
  try { await chrome.runtime.sendMessage({ type: 'p0:cs-report', report }); } catch { /* panel closed is fine */ }

  const { p0 = {} } = await chrome.storage.local.get('p0');
  const pre = document.createElement('pre');
  pre.id = 'p0-results';
  pre.style.cssText = 'white-space:pre-wrap;font:12px monospace;background:#eef;padding:8px;margin:12px';
  pre.textContent = JSON.stringify({ thisLoad: report, stored: p0 }, null, 2);
  document.body.appendChild(pre);
})();
