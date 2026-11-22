// Settings > MCP: real server list, trust review, start/stop/restart and tool browser.
// The bridge is the MCP host; this panel only sends mcp.* / workspace.trust RPCs.
import { bridge } from './bridge-client.js';
import { t } from './i18n.js';

interface McpServerInfo {
  id: string;
  origin: 'global' | 'project' | 'local';
  transport: 'stdio' | 'http';
  enabled: boolean;
  trusted: boolean;
  status: string;
  toolCount: number;
  error: string | null;
  command: string[] | null;
  cwd: string | null;
  url: string | null;
  environmentKeys: string[];
  headerKeys: string[];
  risk: string | null;
}

interface McpListing {
  trusted: boolean;
  hasProjectServers: boolean;
  warnings: string[];
  servers: McpServerInfo[];
}

export interface McpDeps {
  toast(message: string): void;
  openModal(title: string, bodyHtml: string, onOk: () => void): void;
  hasWorkspace(): boolean;
}

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

let deps: McpDeps;
let listing: McpListing | null = null;
let refreshTimer: any = null;

function reviewHtml(servers: McpServerInfo[]): string {
  return `<p>${t('mcpReviewIntro')}</p>` +
    servers.map((s) => `<div class="card"><b>${esc(s.id)}</b> (${s.transport})` +
      (s.command ? `<div>Command: <code>${esc(JSON.stringify(s.command))}</code></div><div>Cwd: <code>${esc(s.cwd || '')}</code></div>` : '') +
      (s.url ? `<div>URL: <code>${esc(s.url)}</code></div>` : '') +
      `<div>Env keys: <code>${esc(s.environmentKeys.join(', ') || '-')}</code></div>` +
      `<div>Header keys: <code>${esc(s.headerKeys.join(', ') || '-')}</code></div>` +
      (s.risk ? `<div>Risk override: <code>${esc(s.risk)}</code></div>` : '') + '</div>').join('') +
    `<p class="muted">${t('mcpReviewNotice')}</p>`;
}

function render(tools: any[]): void {
  if (!listing) return;
  const warn = listing.warnings.map((w) => `<p class="err">${esc(w)}</p>`).join('');
  const trust = !listing.hasProjectServers ? ''
    : listing.trusted
      ? `<div class="banner" id="mcpTrustBanner"><span>${t('mcpTrusted')}</span><button class="mini danger" data-mcp-act="untrust">${t('revokeTrust')}</button></div>`
      : `<div class="banner" id="mcpTrustBanner"><span>${t('mcpUntrusted')}</span><button class="mini primary" data-mcp-act="review">${t('reviewTrust')}</button></div>`;
  const cards = listing.servers.map((s) => {
    const running = s.status === 'ready' || s.status === 'starting';
    const blocked = s.status === 'untrusted' || s.status === 'disabled';
    const buttons = running
      ? `<button class="mini" data-mcp-act="stop" data-server="${esc(s.id)}">${t('stop')}</button> <button class="mini" data-mcp-act="restart" data-server="${esc(s.id)}">${t('restart')}</button>`
      : `<button class="mini primary" data-mcp-act="start" data-server="${esc(s.id)}" ${blocked ? 'disabled' : ''}>${t('start')}</button>`;
    return `<div class="card" data-mcp-server="${esc(s.id)}"><div class="card-head"><strong>${esc(s.id)}</strong><span class="mcp-status mcp-${esc(s.status)}">${esc(s.status)}</span></div>` +
      `<small>${s.transport} - origin: ${s.origin} - ${s.toolCount} tools</small>` +
      (s.error ? `<p class="err">${esc(s.error)}</p>` : '') + `<div>${buttons}</div></div>`;
  }).join('');
  $('mcpList').innerHTML = warn + trust + (cards || `<p class="muted">${t('noMcpServers')}</p>`);
  $('mcpTools').innerHTML = tools.length === 0 ? ''
    : '<h4>Tools</h4>' + tools.map((t) => `<div class="log-row" data-mcp-tool="${esc(t.name)}"><b>${esc(t.name)}</b> - <span class="risk-${esc(t.risk)}">${esc(t.risk)}</span> - ${esc(t.description)}</div>`).join('');
}

/** Reload server list and tool catalog from the bridge. */
export async function refreshMcp(): Promise<void> {
  if (!deps.hasWorkspace()) {
    listing = null;
    $('mcpList').innerHTML = `<p class="muted">${t('selectWorkspaceMcp')}</p>`;
    $('mcpTools').innerHTML = '';
    return;
  }
  try {
    listing = await bridge.call('mcp.servers');
    const tools: any = await bridge.call('mcp.tools');
    render(tools.tools || []);
  } catch (err: any) {
    $('mcpList').innerHTML = `<p class="err">${esc(t('failedLoadMcp').replace('{0}', err?.message || String(err)))}</p>`;
  }
}

async function act(action: string, server: string): Promise<void> {
  try {
    if (action === 'review') {
      const project = (listing?.servers || []).filter((s) => s.origin === 'project');
      deps.openModal(t('reviewMcpProject'), reviewHtml(project), async () => {
        try { await bridge.call('workspace.trust'); deps.toast(t('trustWorkspaceStart')); }
        catch (err: any) { deps.toast(t('mcpError').replace('{0}', err?.message || String(err))); }
        await refreshMcp();
      });
      return;
    }
    if (action === 'untrust') { await bridge.call('workspace.untrust'); deps.toast(t('trustRevoked')); }
    else { await bridge.call('mcp.' + action, { server }, 45000); deps.toast(t('mcpActionComplete').replace('{0}', server).replace('{1}', action)); }
  } catch (err: any) {
    deps.toast(t('mcpError').replace('{0}', err?.message || String(err)));
  }
  await refreshMcp();
}

export function initMcp(dependencies: McpDeps): void {
  deps = dependencies;
  $('mcpList').addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest('[data-mcp-act]') as HTMLButtonElement | null;
    if (!target || target.disabled) return;
    act(target.dataset.mcpAct!, target.dataset.server || '');
  });
  $('mcpReload').addEventListener('click', () => { refreshMcp(); });
  bridge.onEvent((ev: any) => {
    if (ev?.event !== 'mcp.status') return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshMcp, 150);
  });
}
