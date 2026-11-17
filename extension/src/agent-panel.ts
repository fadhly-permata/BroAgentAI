// Agent tab: relays tool commands between a chat-AI tab and the bridge.
//
// Flow: the user chats on the provider's own page. The content-script relay
// reports each finished assistant reply; a reply carrying one JSON command is
// checked against the approval mode by the bridge (agent.check), approved here
// when needed, executed (agent.callTool), and its result is typed back into
// the chat as the next turn. The loop lives in the side panel on purpose:
// closing the panel stops it, so nothing runs without the approval UI open.
import { bridge } from './bridge-client.js';
import { formatCorrection, formatToolResult, parseReply } from './agent-parser.js';
import { t } from './i18n.js';
import { providers, providerForUrl } from './providers/registry.js';
import type { ProviderInfo, ProviderReply } from './providers/types.js';

export interface AgentDeps {
  toast(message: string): void;
  hasWorkspace(): boolean;
  /** Called after a tool changed files so the explorer / SCM can refresh. */
  onFilesChanged(): void;
}

interface LogEntry {
  time: string;
  tool: string;
  category: string;
  decision: string;
  status: 'ok' | 'denied' | 'error' | 'info';
  ms: number;
  detail?: string;
}

interface Session {
  tabId: number;
  provider: ProviderInfo;
  toolCalls: number; // since the last final answer
  totalCalls: number;
  /** Approval keys (tool name, or one shell command line) remembered in ask-once mode. */
  allowed: Set<string>;
}

const MAX_TOOL_CALLS = 40;
const REMINDER_EVERY = 8;
const MODE_KEY = 'broagentai.agentMode';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

let deps: AgentDeps;
let session: Session | null = null;
let logs: LogEntry[] = [];
let queue: Promise<void> = Promise.resolve();
let pendingApproval: ((decision: 'allow' | 'deny') => void) | null = null;

const mode = () => ($('modeSel') as HTMLSelectElement).value;

function log(entry: Omit<LogEntry, 'time'>): void {
  logs.push({ ...entry, time: new Date().toLocaleTimeString() });
  if (logs.length > 500) logs = logs.slice(-500);
  renderLog();
}

function renderLog(): void {
  const filter = ($('logFilter') as HTMLSelectElement).value;
  const rows = logs.filter((l) => filter === 'all' || l.status === filter);
  $('cmdLog').innerHTML = rows.map((l) =>
    `<div class="log-row" data-log-status="${l.status}" data-log-tool="${esc(l.tool)}"><span class="muted">${esc(l.time)}</span> <b>${esc(l.tool)}</b> - ${esc(l.category)} - ${esc(l.decision)} - <span class="log-${l.status}">${l.status}</span>${l.ms ? ' - ' + l.ms + 'ms' : ''}${l.detail ? '<br><small>' + esc(l.detail) + '</small>' : ''}</div>`
  ).join('') || '<p class="muted">Belum ada aktivitas.</p>';
  $('cmdLog').scrollTop = $('cmdLog').scrollHeight;
}

function renderSession(): void {
  $('agentSession').textContent = session ? `Sesi aktif - ${session.provider.label}` : 'Belum ada sesi';
  $('agentPill').className = 'pill ' + (session ? 'pill-ok' : 'pill-warn');
  $('agentStart').classList.toggle('hidden', !!session);
  $('agentStop').classList.toggle('hidden', !session);
  $('ckAi').textContent = session ? 'x' : 'o';
}

function renderProviders(): void {
  $('providerList').innerHTML = '<h4>Chat providers</h4>' + providers.map((p) =>
    `<div class="log-row" data-provider="${esc(p.id)}"><b>${esc(p.label)}</b> - <code>${esc(p.matchPatterns.join(', '))}</code> - ${p.status === 'ready' ? 'ready' : 'experimental (selector belum diverifikasi di situs asli)'}</div>`
  ).join('');
}

async function tabMessage(tabId: number, message: unknown): Promise<any> {
  return chrome.tabs.sendMessage(tabId, message);
}

/** Find an open tab of a bundled provider; the active tab wins. */
async function findChatTab(): Promise<{ tab: chrome.tabs.Tab; provider: ProviderInfo } | null> {
  const tabs = await chrome.tabs.query({});
  const matches = tabs
    .map((tab) => ({ tab, provider: tab.url ? providerForUrl(tab.url) : null }))
    .filter((m): m is { tab: chrome.tabs.Tab; provider: ProviderInfo } => m.provider !== null && m.tab.id !== undefined);
  matches.sort((a, b) => Number(b.tab.active) - Number(a.tab.active));
  return matches[0] ?? null;
}

async function refreshDetected(): Promise<void> {
  if (session) return;
  const found = await findChatTab().catch(() => null);
  $('detectedChat').textContent = found ? `${found.provider.label} - ${found.tab.title || found.tab.url || ''}` : 'Tidak ada tab chat terbuka';
}

async function send(text: string): Promise<void> {
  if (!session) return;
  const res = await tabMessage(session.tabId, { type: 'ba.send', text });
  if (!res?.ok) throw new Error(res?.error || 'gagal mengirim ke tab chat');
}

async function startSession(): Promise<void> {
  if (session) return;
  if (!deps.hasWorkspace()) return deps.toast('Pilih workspace dulu');
  const found = await findChatTab();
  if (!found) {
    const provider = providers[0];
    if (provider) await chrome.tabs.create({ url: provider.homepage });
    return deps.toast('Tab chat dibuka. Login di sana, lalu klik Start session lagi.');
  }
  const tabId = found.tab.id!;
  let health: any;
  try {
    health = await tabMessage(tabId, { type: 'ba.ping' });
  } catch {
    return deps.toast('Tab chat belum terhubung. Reload tab chat itu, lalu coba lagi.');
  }
  if (!health?.composer) return deps.toast(`Kolom chat ${found.provider.label} tidak ditemukan. Pastikan sudah login dan halaman chat terbuka.`);

  try {
    const { prompt, toolCount }: any = await bridge.call('agent.prompt', { mode: mode() });
    await tabMessage(tabId, { type: 'ba.activate' });
    session = { tabId, provider: found.provider, toolCalls: 0, totalCalls: 0, allowed: new Set() };
    await send(prompt);
    log({ tool: 'session.start', category: found.provider.label, decision: mode(), status: 'info', ms: 0, detail: `${toolCount} tools dikirim ke chat` });
    $('detectedChat').textContent = `${found.provider.label} - ${found.tab.title || ''}`;
  } catch (err: any) {
    session = null;
    deps.toast('Gagal memulai sesi: ' + (err?.message || err));
  }
  renderSession();
}

async function stopSession(reason = 'dihentikan'): Promise<void> {
  if (!session) return;
  const tabId = session.tabId;
  session = null;
  pendingApproval?.('deny');
  hideApproval();
  try { await tabMessage(tabId, { type: 'ba.deactivate' }); } catch { /* tab gone */ }
  log({ tool: 'session.stop', category: '-', decision: '-', status: 'info', ms: 0, detail: reason });
  renderSession();
  refreshDetected();
}

function hideApproval(): void {
  $('approvalCard').classList.add('hidden');
  pendingApproval = null;
}

function askApproval(check: any, params: Record<string, unknown>, remember: boolean): Promise<'allow' | 'deny'> {
  $('apRisk').textContent = String(check.category).toUpperCase();
  $('apRisk').className = 'risk risk-' + (check.category === 'read' ? 'read' : 'write');
  $('apTool').textContent = check.command;
  $('apSummary').textContent = check.category === 'execute'
    ? 'Perintah shell. Berjalan dengan hak akunmu dan TIDAK dibatasi ke workspace.'
    : (check.source === 'mcp' ? 'MCP tool. ' : '') + (check.paths?.length ? 'Path: ' + check.paths.join(', ') : 'Tidak ada path spesifik.');
  $('apDiff').textContent = check.preview || '';
  $('apDiff').classList.toggle('hidden', !check.preview);
  const shown = JSON.stringify(params, null, 2);
  $('apParams').textContent = shown.length > 4000 ? shown.slice(0, 4000) + '\n... (dipotong)' : shown;
  $('apNote').textContent = !remember ? ''
    : check.category === 'execute' ? 'Tanya sekali: perintah yang persis sama tidak akan ditanyakan lagi di sesi ini.'
    : `Tanya sekali: ${check.command} tidak akan ditanyakan lagi di sesi ini.`;
  $('approvalCard').classList.remove('hidden');
  return new Promise((resolve) => {
    pendingApproval = (decision) => { hideApproval(); resolve(decision); };
  });
}

async function handleReply(reply: ProviderReply): Promise<void> {
  if (!session) return;
  const active = session;
  const parsed = parseReply(reply);

  if (parsed.kind === 'final') {
    active.toolCalls = 0;
    log({ tool: 'assistant', category: '-', decision: '-', status: 'info', ms: 0, detail: parsed.text.slice(0, 200) });
    return;
  }
  if (parsed.kind === 'error') {
    log({ tool: 'parser', category: '-', decision: '-', status: 'error', ms: 0, detail: parsed.reason });
    return send(formatCorrection(parsed.reason));
  }

  const { command, params } = parsed;
  if (active.toolCalls >= MAX_TOOL_CALLS) {
    log({ tool: command, category: '-', decision: 'limit', status: 'denied', ms: 0, detail: `batas ${MAX_TOOL_CALLS} tool call per permintaan` });
    return send(formatToolResult(command, false, `NOT_ALLOWED: limit of ${MAX_TOOL_CALLS} tool calls per request reached. Summarize your progress and stop.`));
  }
  active.toolCalls++;
  active.totalCalls++;

  const currentMode = mode();
  let check: any;
  try {
    check = await bridge.call('agent.check', { command, params, mode: currentMode });
  } catch (err: any) {
    log({ tool: command, category: '-', decision: '-', status: 'error', ms: 0, detail: err?.message });
    return send(formatToolResult(command, false, `${err?.message || err}\nUse only tools from the catalog you were given.`));
  }

  let approved = false;
  let decision: string = check.decision;
  if (check.decision === 'deny') {
    log({ tool: command, category: check.category, decision: `deny (${currentMode})`, status: 'denied', ms: 0 });
    return send(formatToolResult(command, false, `NOT_ALLOWED: ${command} is not allowed in ${currentMode} mode. Do not retry it.`));
  }
  if (check.decision === 'ask') {
    // ask-once: an approval is remembered under the key the bridge returned.
    const remember = currentMode === 'ask-once';
    if (remember && active.allowed.has(check.approvalKey)) {
      approved = true;
      decision = 'approved earlier';
    } else {
      const answer = await askApproval(check, params, remember);
      if (session !== active) return; // session stopped while waiting
      if (answer === 'deny') {
        log({ tool: command, category: check.category, decision: 'denied by user', status: 'denied', ms: 0 });
        return send(formatToolResult(command, false, 'NOT_ALLOWED: the user denied this action. Do not retry it; ask what to do instead.'));
      }
      if (remember) active.allowed.add(check.approvalKey);
      approved = true;
      decision = remember ? 'allowed, remembered' : 'allowed';
    }
  }

  const started = performance.now();
  let message: string;
  try {
    const result: any = await bridge.call('agent.callTool', { command, params, mode: currentMode, approved }, 130000);
    log({ tool: command, category: check.category, decision, status: 'ok', ms: Math.round(performance.now() - started) });
    message = formatToolResult(command, true, result.text, result.truncated);
    if (check.category !== 'read') deps.onFilesChanged();
  } catch (err: any) {
    log({ tool: command, category: check.category, decision, status: 'error', ms: Math.round(performance.now() - started), detail: err?.message });
    message = formatToolResult(command, false, String(err?.message || err));
  }
  if (session !== active) return;
  if (active.totalCalls % REMINDER_EVERY === 0) {
    message += '\n\n[BroAgentAI reminder - automatic, do not reply to it] One fenced JSON command per reply; plain prose when done.';
  }
  await send(message);
}

export function initAgent(dependencies: AgentDeps): void {
  deps = dependencies;

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'ba.reply') return;
    if (!session || sender.tab?.id !== session.tabId) return;
    // One reply at a time, in order.
    queue = queue.then(() => handleReply(message.reply)).catch((err) => {
      log({ tool: 'relay', category: '-', decision: '-', status: 'error', ms: 0, detail: err?.message || String(err) });
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => { if (session?.tabId === tabId) stopSession('tab chat ditutup'); });

  $('agentStart').addEventListener('click', () => { startSession(); });
  $('agentStop').addEventListener('click', () => { stopSession(); });
  $('apAllow').addEventListener('click', () => pendingApproval?.('allow'));
  $('apDeny').addEventListener('click', () => pendingApproval?.('deny'));
  $('logFilter').addEventListener('change', renderLog);
  $('clearLog').addEventListener('click', () => { logs = []; renderLog(); });
  $('copyLog').addEventListener('click', () => {
    navigator.clipboard.writeText(JSON.stringify(logs, null, 2)).then(() => deps.toast('Log disalin'));
  });

  const select = $('modeSel') as HTMLSelectElement;
  const HINTS: Record<string, string> = {
    'read-only': 'modeHintReadOnly', 'always-ask': 'modeHintAlwaysAsk', 'ask-once': 'modeHintAskOnce', 'auto-approve': 'modeHintAutoApprove',
  };
  const showHint = () => { const key = HINTS[select.value]; $('modeHint').dataset.i18n = key; $('modeHint').textContent = t(key); };
  // Values saved before the four-mode model.
  const LEGACY: Record<string, string> = { ask: 'always-ask', 'auto-edit': 'ask-once', 'full-auto': 'auto-approve' };
  try {
    chrome.storage.local.get(MODE_KEY).then((stored) => {
      const raw = stored[MODE_KEY];
      const value = typeof raw === 'string' ? (LEGACY[raw] ?? raw) : null;
      if (value && [...select.options].some((o) => o.value === value)) select.value = value;
      showHint();
    });
  } catch { /* storage unavailable */ }
  select.addEventListener('change', () => {
    chrome.storage.local.set({ [MODE_KEY]: select.value }).catch(() => {});
    // Leaving ask-once (or tightening the mode) must not carry old approvals along.
    session?.allowed.clear();
    showHint();
    if (session) log({ tool: 'mode', category: '-', decision: select.value, status: 'info', ms: 0, detail: 'berlaku untuk perintah berikutnya' });
    deps.toast('Approval mode: ' + select.options[select.selectedIndex].text);
  });
  showHint();

  renderLog();
  renderSession();
  renderProviders();
}

/** Called when the Agent tab becomes visible. */
export function showAgent(): void {
  refreshDetected();
}
