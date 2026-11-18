// Home tab: pick a workspace and an AI provider, then Start. Start switches to
// the Agent tab at once, where the agent opens the provider's chat in a new
// tab, waits for it to load and connects - with the same status line and
// Start/Stop button as the Agent tab's own "Start session". The Home button
// mirrors that state: Stop Session while a session is starting or running.
import './home.css';
import { providers } from './providers/registry.js';
import type { ProviderInfo } from './providers/types.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

export interface HomeWorkspace { id?: string; name: string; path: string }

export interface HomeDeps {
  getWorkspaces(): HomeWorkspace[];
  getActive(): HomeWorkspace | null;
  setActive(ws: any): void | Promise<void>;
  openFolder(): void;
  switchTab(tab: string): void;
  toast(message: string): void;
  sessionState(): 'idle' | 'starting' | 'active';
  /** Open `provider` in a new tab, wait `waitMs`, then connect (the Agent tab shows progress). */
  launchSession(provider: ProviderInfo, waitMs: number): Promise<void>;
  stopSession(): Promise<void>;
}

const PROVIDER_KEY = 'broagentai.homeProvider';
/** Time the freshly opened chat page gets to load before the session starts. */
const LOAD_WAIT_MS = 10_000;

/**
 * Brand-inspired marks (original drawings in each service's colors, 24px grid).
 * A provider without one gets a neutral chat bubble with its initial.
 */
const MARKS: Record<string, string> = {
  qwen: '<defs><linearGradient id="pm-qwen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f74ff"/><stop offset="1" stop-color="#5b3fd1"/></linearGradient></defs>'
    + '<path d="M12 2.2 20.5 7v10L12 21.8 3.5 17V7z" fill="url(#pm-qwen)"/>'
    + '<circle cx="11.4" cy="11.4" r="3.6" fill="none" stroke="#fff" stroke-width="1.9"/><path d="m13.6 13.6 2.6 2.6" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/>',
  deepseek: '<rect x="2" y="2" width="20" height="20" rx="5.5" fill="#4d6bfe"/>'
    + '<path d="M5.2 13.1c.4-3.3 3.2-5.6 6.6-5.6 2.6 0 4.8 1.4 5.8 3.6l1.6-1.3.2 4.4-2-.8c-1 2.4-3.4 4-6.1 4-3.4 0-5.6-1.6-6.1-4.3z" fill="#fff"/>'
    + '<circle cx="10.4" cy="11.4" r="1" fill="#4d6bfe"/>',
  gemini: '<defs><linearGradient id="pm-gemini" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4285f4"/><stop offset=".55" stop-color="#9b72cb"/><stop offset="1" stop-color="#d96570"/></linearGradient></defs>'
    + '<path d="M12 1.8c.7 5.4 4.8 9.5 10.2 10.2-5.4.7-9.5 4.8-10.2 10.2-.7-5.4-4.8-9.5-10.2-10.2C7.2 11.3 11.3 7.2 12 1.8z" fill="url(#pm-gemini)"/>',
};

let deps: HomeDeps;
let selected = providers[0]?.id ?? '';

const esc = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

function providerMark(id: string, label: string): string {
  const body = MARKS[id]
    ?? `<path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5z" fill="var(--home-mark-bg)"/>`
      + `<text x="12" y="14.2" text-anchor="middle" font-size="8.5" font-weight="700" fill="var(--home-mark-fg)">${esc((label[0] || '?').toUpperCase())}</text>`;
  return `<svg class="prov-mark" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}

function workspaceRows(list: HomeWorkspace[], active: HomeWorkspace | null): string {
  if (list.length === 0) {
    return `<button class="home-drop" data-act="open-folder">${icon('new-folder')}<span>${esc(t('homeNoWorkspace'))}</span></button>`;
  }
  return `<div class="home-ws-list" role="listbox" aria-label="${esc(t('homeWorkspace'))}">` + list.map((w, i) => {
    const on = w === active;
    return `<button class="home-ws${on ? ' active' : ''}" data-hws="${i}" role="option" aria-selected="${on}" title="${esc(w.path)}">`
      + `<span class="home-ws-ico">${icon(on ? 'folder-opened' : 'folder')}</span>`
      + `<span class="home-ws-text"><b>${esc(w.name)}</b><small>${esc(w.path)}</small></span>`
      + (on ? `<span class="home-ws-tag">${esc(t('homeActive'))}</span>` : '')
      + `</button>`;
  }).join('') + `</div>`;
}

export function renderHome(): void {
  const body = document.getElementById('homeBody');
  if (!body || !deps) return;
  const active = deps.getActive();
  const provider = providers.find((p) => p.id === selected);
  const cards = providers.map((p) => {
    const on = p.id === selected;
    return `<button class="prov-card${on ? ' selected' : ''}" data-prov="${esc(p.id)}" aria-pressed="${on}" title="${esc(p.description || p.label)}">`
      + `<span class="prov-check" aria-hidden="true">${icon('check')}</span>`
      + providerMark(p.id, p.label)
      + `<b>${esc(p.label)}</b>`
      + `<small>${esc(p.status === 'ready' ? (p.description || p.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '')) : t('homeExperimental'))}</small>`
      + `</button>`;
  }).join('');

  // Same session as the Agent tab: Start while idle, Stop while starting or running.
  const state = deps.sessionState();
  const busy = state !== 'idle';
  const ctaLabel = busy ? t('homeStop') : t('homeStart');
  const hint = state === 'starting'
    ? `<span class="home-spin"></span><span>${esc(t('homeStarting'))}</span>`
    : state === 'active'
      ? `${icon('pulse')}<span>${esc(t('homeSessionActive'))}</span>`
      : active
        ? `${icon('folder-opened')}<span>${esc(active.name)}</span><span class="sep">&middot;</span><span>${esc(provider?.label ?? '-')}</span>`
        : `${icon('info')}<span>${esc(t('homeNeedWorkspace'))}</span>`;

  body.innerHTML =
    `<section class="home-sec">`
      + `<div class="home-sec-head"><h3>${esc(t('homeWorkspace'))}</h3>`
      + `<button id="homeOpenFolder" class="home-head-btn" data-act="open-folder" title="${esc(t('homeOpenFolder'))}">${icon('new-folder')}<span>${esc(t('homeOpenFolder'))}</span></button></div>`
      + workspaceRows(deps.getWorkspaces(), active)
    + `</section>`
    + `<section class="home-sec"><div class="home-sec-head"><h3>${esc(t('homeProvider'))}</h3></div><div class="home-grid">${cards}</div></section>`
    + `<section class="home-sec home-cta-sec">`
      + `<button id="homeStart" class="home-cta${busy ? ' stop' : ''}" data-state="${state}"${busy ? '' : ` title="${esc(t('homeStartHint'))}"`}>`
        + `<span class="home-cta-ico">${icon(busy ? 'debug-stop' : 'play')}</span><span class="home-cta-label">${esc(ctaLabel)}</span>`
      + `</button>`
      + `<p class="home-hint${active || busy ? '' : ' warn'}" role="status" aria-live="polite">${hint}</p>`
    + `</section>`;
}

/** Start, or Stop when a session is starting or running. Either way the Agent tab is where it shows. */
function onCta(): void {
  if (deps.sessionState() !== 'idle') { void deps.stopSession(); return; }
  if (!deps.getActive()) { deps.toast(t('homeNeedWorkspace')); return; }
  const provider = providers.find((p) => p.id === selected);
  if (!provider) return;
  deps.switchTab('agent');
  void deps.launchSession(provider, LOAD_WAIT_MS);
}

export function initHome(dependencies: HomeDeps): void {
  deps = dependencies;
  const body = document.getElementById('homeBody');
  body?.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const w = el.closest('[data-hws]') as HTMLElement | null;
    if (w) { const ws = deps.getWorkspaces()[Number(w.dataset.hws)]; if (ws) void deps.setActive(ws); return; }
    const p = el.closest('[data-prov]') as HTMLElement | null;
    if (p) {
      selected = p.dataset.prov!;
      try { chrome.storage.local.set({ [PROVIDER_KEY]: selected }).catch(() => {}); } catch { /* storage unavailable */ }
      renderHome();
      return;
    }
    if (el.closest('[data-act="open-folder"]')) { deps.openFolder(); return; }
    if (el.closest('#homeStart')) onCta();
  });
  try {
    chrome.storage.local.get(PROVIDER_KEY).then((stored) => {
      const id = stored[PROVIDER_KEY];
      if (typeof id === 'string' && providers.some((p) => p.id === id)) { selected = id; renderHome(); }
    }).catch(() => {});
  } catch { /* storage unavailable */ }
  renderHome();
}
