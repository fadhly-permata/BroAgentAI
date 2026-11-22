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

let deps: HomeDeps;
let selected = providers[0]?.id ?? '';

const esc = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

/** The plugin's own icon (bundled locally, so it renders instantly and passes the CSP), else a neutral mark. */
function providerMark(p: ProviderInfo): string {
  if (p.icon) {
    return `<img class="prov-mark" src="${esc(p.icon)}" alt="${esc(p.label)}" />`;
  }
  // Fallback to a neutral chat bubble with its initial
  return `<svg class="prov-mark" viewBox="0 0 24 24" aria-hidden="true">`
    + `<path d="M4 4.5h16a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 4 4.5z" class="prov-mark-bg"/>`
    + `<text x="12" y="14.2" text-anchor="middle" font-size="8.5" font-weight="700" class="prov-mark-fg">${esc(((p.label)[0] || '?').toUpperCase())}</text>`
    + `</svg>`;
}

function workspaceRows(list: HomeWorkspace[], active: HomeWorkspace | null): string {
  if (list.length === 0) {
    return `<button class="home-drop" data-act="open-folder">${icon('new-folder')}<span>${esc(t('homeNoWorkspace'))}</span></button>`;
  }
  return `<div class="home-ws-list" role="listbox" aria-label="${esc(t('homeWorkspace'))}">` + list.map((w, i) => {
    const on = w === active;
    return `<div class="home-ws-row${on ? ' active' : ''}" data-hws="${i}" role="option" aria-selected="${on}" title="${esc(w.path)}">`
      + `<button class="home-ws-btn" data-ws-select="${i}">`
      + `<span class="home-ws-ico">${icon(on ? 'folder-opened' : 'folder')}</span>`
      + `<span class="home-ws-text"><b>${esc(w.name)}</b><small>${esc(w.path)}</small></span>`
      + (on ? `<span class="home-ws-tag">${esc(t('homeActive'))}</span>` : '')
      + `</button>`
      + `<button class="home-ws-remove" data-ws-remove="${i}" title="${esc(t('removeWorkspace'))}" aria-label="${esc(t('removeWorkspace').replace('{0}', w.name))}">${icon('trash')}</button>`
      + `</div>`;
  }).join('') + `</div>`;
}

export function renderHome(): void {
  const body = document.getElementById('homeBody');
  if (!body || !deps) return;
  const active = deps.getActive();
  // The selected plugin may have been removed or turned off.
  if (!providers.some((p) => p.id === selected)) selected = providers[0]?.id ?? '';
  const provider = providers.find((p) => p.id === selected);
  const cards = providers.map((p) => {
    const on = p.id === selected;
    return `<button class="prov-card${on ? ' selected' : ''}" data-prov="${esc(p.id)}" aria-pressed="${on}" title="${esc(p.description || p.label)}">`
      + `<span class="prov-check" aria-hidden="true">${icon('check')}</span>`
      + providerMark(p)
      + `<b>${esc(p.label)}</b>`
      + `<small>${esc(p.status === 'ready' ? (p.description || p.homepage.replace(/^https?:\/\//, '').replace(/\/$/, '')) : t('homeExperimental'))}</small>`
      + `</button>`;
  }).join('');

  // Same session as the Agent tab: Start while idle, Stop while starting or running.
  const state = deps.sessionState();
  const busy = state !== 'idle';
  const ctaLabel = busy ? t('homeStop') : t('homeStart');
  const hint = state === 'starting'
    ? `<span class="home-spin">${icon('loading')}</span><span>${esc(t('homeStarting'))}</span>`
    : state === 'active'
      ? `${icon('pulse')}<span>${esc(t('homeSessionActive'))}</span>`
      : active
        ? `${icon('folder-opened')}<span>${esc(active.name)}</span><span class="sep">&middot;</span><span>${esc(provider?.label ?? '-')}</span>`
        : `${icon('info')}<span>${esc(t('homeNeedWorkspace'))}</span>`;

  body.innerHTML =
    `<section class="home-sec">`
      + `<div class="home-sec-head"><h3 class="section-title">${esc(t('homeWorkspace'))}</h3>`
      + `<button id="homeOpenFolder" class="home-head-btn" data-act="open-folder" title="${esc(t('homeOpenFolder'))}">${icon('new-folder')}<span>${esc(t('homeOpenFolder'))}</span></button></div>`
      + workspaceRows(deps.getWorkspaces(), active)
    + `</section>`
    + `<section class="home-sec"><div class="home-sec-head"><h3 class="section-title">${esc(t('homeProvider'))}</h3></div><div class="home-grid">${cards}</div></section>`
    + `<section class="home-sec home-cta-sec">`
      + `<button id="homeStart" class="home-cta ${busy ? 'danger stop' : 'primary'}" data-state="${state}"${busy ? '' : ` title="${esc(t('homeStartHint'))}"`}>`
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
    
    // Handle workspace remove button
    const removeBtn = el.closest('[data-ws-remove]') as HTMLElement | null;
    if (removeBtn) {
      e.stopPropagation();
      const idx = Number(removeBtn.dataset.wsRemove);
      const ws = deps.getWorkspaces()[idx];
      if (ws && ws.id) {
        // Import bridge dynamically to avoid circular dependency
        import('./bridge-client.js').then(({ bridge }) => {
          bridge.call('workspace.remove', { id: ws.id }).then(() => {
            deps.toast(t('workspaceRemoved'));
            // Reload workspaces by triggering a refresh
            window.location.reload();
          }).catch((err: any) => {
            deps.toast(t('failedRemoveWorkspace').replace('{0}', err?.message || String(err)));
          });
        });
      }
      return;
    }
    
    // Handle workspace select button
    const selectBtn = el.closest('[data-ws-select]') as HTMLElement | null;
    if (selectBtn) {
      const ws = deps.getWorkspaces()[Number(selectBtn.dataset.wsSelect)];
      if (ws) void deps.setActive(ws);
      return;
    }
    
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
      // Kept even when its plugin is not merged yet (user plugins load async); renderHome falls back if it is gone.
      if (typeof id === 'string') { selected = id; renderHome(); }
    }).catch(() => {});
  } catch { /* storage unavailable */ }
  renderHome();
}
