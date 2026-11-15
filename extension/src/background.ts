console.log('BrowserAgent background loaded');
// Gemini-style: klik ikon = buka split panel di kanan, bukan popup kecil yang nutup sendiri.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try { await chrome.sidePanel.setOptions({ tabId, path: 'src/sidepanel.html', enabled: true }); } catch {}
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status === 'complete') {
    try { await chrome.sidePanel.setOptions({ tabId, path: 'src/sidepanel.html', enabled: true }); } catch {}
  }
});
