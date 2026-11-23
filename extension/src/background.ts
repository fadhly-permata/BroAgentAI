import { bridge } from './bridge-client';
import { browser } from './browser.ts';
import { syncPluginRegistrations } from './plugins/sync.ts';
import { onPluginStateChange } from './plugins/store.ts';
import { reloadIfManifestStale } from './stale-manifest.ts';

// A rebuilt unpacked install keeps its old manifest until reloaded; pick up the new one.
void reloadIfManifestStale();

// User web chat plugins: their sites get the relay through dynamic content
// scripts, which an extension reload/update clears (specs/09 R15). Re-apply on
// every service-worker start and whenever plugins or site access change.
void syncPluginRegistrations();
browser.runtime.onInstalled.addListener(() => { void syncPluginRegistrations(); });
browser.runtime.onStartup.addListener(() => { void syncPluginRegistrations(); });
onPluginStateChange(() => { void syncPluginRegistrations(); });
browser.permissions.onAdded.addListener(() => { void syncPluginRegistrations(); });
browser.permissions.onRemoved.addListener(() => { void syncPluginRegistrations(); });
// The Plugins page asks for a re-sync, e.g. after "Allow User Scripts" was turned on.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== browser.runtime.id || message?.type !== 'ba.plugins.sync') return undefined;
  void syncPluginRegistrations().then(() => sendResponse({ ok: true }));
  return true;
});

console.log('BroAgentAI background loaded');

// Gemini-style: klik ikon = buka split panel di kanan, bukan popup kecil yang nutup sendiri.
void browser.panel.configure({ path: 'src/sidepanel.html', openOnActionClick: true });

// The side panel is ONE global instance for the whole window, deliberately NOT
// per-tab. The agent session lives in the panel page's memory (session, logs,
// queue in agent-panel.ts); a per-tab panel would be a fresh page for every tab,
// so simply switching tabs would wipe that state and look like a reset. A single
// global panel survives tab switches. (Known gap: the panel can still be torn
// down when Chrome discards the window/panel; see docs/agent-panel-state.md for
// the follow-up that would persist and rehydrate the session - "Option B".)

// 0.4.3: Implementasi koneksi dari Service Worker ke Native Host (ping/pong)
bridge.connect().then(() => {
  console.log('Bridge connected successfully');
}).catch((err) => {
  console.error('Bridge connection failed:', err);
});
