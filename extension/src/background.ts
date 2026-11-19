import { bridge } from './bridge-client';
import { syncPluginRegistrations } from './plugins/sync.ts';
import { onPluginStateChange } from './plugins/store.ts';

// User web chat plugins: their sites get the relay through dynamic content
// scripts, which an extension reload/update clears (specs/09 R15). Re-apply on
// every service-worker start and whenever plugins or site access change.
void syncPluginRegistrations();
chrome.runtime.onInstalled.addListener(() => { void syncPluginRegistrations(); });
chrome.runtime.onStartup.addListener(() => { void syncPluginRegistrations(); });
onPluginStateChange(() => { void syncPluginRegistrations(); });
chrome.permissions.onAdded.addListener(() => { void syncPluginRegistrations(); });
chrome.permissions.onRemoved.addListener(() => { void syncPluginRegistrations(); });

console.log('BroAgentAI background loaded');

// Gemini-style: klik ikon = buka split panel di kanan, bukan popup kecil yang nutup sendiri.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// The side panel is ONE global instance for the whole window, deliberately NOT
// per-tab. The agent session lives in the panel page's memory (session, logs,
// queue in agent-panel.ts); a per-tab panel would be a fresh page for every tab,
// so simply switching tabs would wipe that state and look like a reset. A single
// global panel survives tab switches. (Known gap: the panel can still be torn
// down when Chrome discards the window/panel; see docs/agent-panel-state.md for
// the follow-up that would persist and rehydrate the session - "Option B".)
chrome.sidePanel.setOptions({ path: 'src/sidepanel.html', enabled: true }).catch(() => {});

// 0.4.3: Implementasi koneksi dari Service Worker ke Native Host (ping/pong)
bridge.connect().then(() => {
  console.log('Bridge connected successfully');
}).catch((err) => {
  console.error('Bridge connection failed:', err);
});
