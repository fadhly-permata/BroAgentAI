// P0 spike service worker: records lifecycle events, user-script messages and
// content-script reports into chrome.storage.local under "p0".

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function record(key, value, keepLast = 10) {
  const { p0 = {} } = await chrome.storage.local.get('p0');
  const list = Array.isArray(p0[key]) ? p0[key] : [];
  list.push(value);
  p0[key] = list.slice(-keepLast);
  await chrome.storage.local.set({ p0 });
}

async function registrations() {
  const out = {};
  try { out.contentScripts = (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({ id: s.id, matches: s.matches, css: s.css, js: s.js, persistAcrossSessions: s.persistAcrossSessions })); }
  catch (e) { out.contentScripts = 'ERR ' + e.message; }
  try { out.userScripts = (await chrome.userScripts.getScripts()).map((s) => ({ id: s.id, worldId: s.worldId, world: s.world, matches: s.matches })); }
  catch (e) { out.userScripts = 'ERR ' + e.message; }
  try { out.worlds = await chrome.userScripts.getWorldConfigurations(); }
  catch (e) { out.worlds = 'ERR ' + e.message; }
  return out;
}

// C7: do dynamic registrations survive an extension reload / browser restart?
chrome.runtime.onInstalled.addListener(async (details) => {
  await record('lifecycle', { event: 'onInstalled', reason: details.reason, time: new Date().toISOString(), ...(await registrations()) });
});
chrome.runtime.onStartup.addListener(async () => {
  await record('lifecycle', { event: 'onStartup', time: new Date().toISOString(), ...(await registrations()) });
});

// C4: messages from user scripts arrive here (not on onMessage). Record which
// sender fields exist, especially whether the user-script world id is exposed.
if (chrome.runtime.onUserScriptMessage) {
  chrome.runtime.onUserScriptMessage.addListener((message, sender, sendResponse) => {
    record('userScriptMessages', {
      time: new Date().toISOString(),
      message,
      senderKeys: Object.keys(sender),
      userScriptWorldId: sender.userScriptWorldId ?? null,
      url: sender.url ?? null,
      tabId: sender.tab?.id ?? null,
      frameId: sender.frameId ?? null,
    });
    sendResponse({ ok: true, echo: message?.from ?? null });
  });
}

// Content-script reports from the test page.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'p0:cs-report') {
    record('contentScriptReports', { ...message.report, senderUrl: sender.url ?? null }, 5).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'p0:registrations') {
    registrations().then(sendResponse);
    return true;
  }
  return undefined;
});
