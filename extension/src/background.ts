import { bridge } from './bridge-client';

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
