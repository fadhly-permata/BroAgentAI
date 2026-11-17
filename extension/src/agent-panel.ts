// Agent tab: relays tool commands between a chat-AI tab and the bridge.
//
// Flow: the user chats on the provider's own page. The content-script relay
// reports each finished assistant reply; a reply carrying one JSON command is
// checked against the approval mode by the bridge (agent.check), approved here
// when needed, executed (agent.callTool), and its result is typed back into
// the chat as the next turn. The loop lives in the side panel on purpose:
// closing the panel stops it, so nothing runs without the approval UI open.
import { bridge } from './bridge-client.js';
import { NATIVE_CALL_REMINDER, formatCorrection, formatToolResult, parseReply } from './agent-parser.js';
import { SEND_ATTEMPTS, retryBackoffMs, sendDelayMs, toolTimeoutMs } from './agent-timing.js';
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
  /** Last message the agent typed into the chat, for "Resend". */
  lastSent: string | null;
  /** Text of the last reply handled, to drop it if it shows up again after the chat tab reloads. */
  lastReplyText: string | null;
  resumeGuard: string | null;
}

type PhaseKind = 'idle' | 'waiting' | 'running' | 'approval' | 'delay' | 'sending' | 'retry' | 'failed' | 'offline';
interface Phase { kind: PhaseKind; label: string; since: number; until?: number }

const MAX_TOOL_CALLS = 40;
const REMINDER_EVERY = 8;
const MODE_KEY = 'broagentai.agentMode';
const DELAY_KEY = 'broagentai.agentDelaySeconds';
/** The panel nudges the chat tab this often; see relay.ts poll(). */
const TICK_MS = 1000;
/** Re-activate a relay that lost its state only once the reloaded chat page settled. */
const RESUME_AFTER_MS = 3000;
/** Waiting longer than this for a reply offers the Resend button. */
const STALL_HINT_MS = 120_000;

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const esc = (text: string) => { const d = document.createElement('div'); d.textContent = text; return d.innerHTML; };

let deps: AgentDeps;
let session: Session | null = null;
let logs: LogEntry[] = [];
let queue: Promise<void> = Promise.resolve();
let pendingApproval: ((decision: 'allow' | 'deny') => void) | null = null;
let phase: Phase | null = null;
/** Phase to return to when an unreachable chat tab answers again. */
let beforeOffline: Phase | null = null;
let ticking = false;

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
  $('ckAi').classList.toggle('done', !!session);
}

function setPhase(kind: PhaseKind, label: string, untilMs?: number): void {
  phase = { kind, label, since: Date.now(), until: untilMs === undefined ? undefined : Date.now() + untilMs };
  renderStatus();
}

/** One line under the session controls: what the agent is doing right now, and for how long. */
function renderStatus(): void {
  const box = $('agentStatus');
  if (!session || !phase) {
    box.classList.add('hidden');
    return;
  }
  const now = Date.now();
  const seconds = (ms: number) => `${Math.max(0, Math.round(ms / 1000))}s`;
  box.classList.remove('hidden');
  box.dataset.phase = phase.kind;
  $('agentStatusText').textContent = phase.kind === 'idle' ? phase.label
    : `${phase.label} - ${phase.until !== undefined ? seconds(phase.until - now) : seconds(now - phase.since)}`;
  const stalled = phase.kind === 'failed' || (phase.kind === 'waiting' && now - phase.since > STALL_HINT_MS);
  $('agentResend').classList.toggle('hidden', !(stalled && session.lastSent));
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

const delayMs = () => sendDelayMs(($('agentDelay') as HTMLInputElement).value);

/** Sleep that ends early (false) when the session stops. */
async function waitFor(active: Session, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (session !== active) return false;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, end - Date.now())));
  }
  return session === active;
}

/**
 * Type an automatic message (tool result, correction) into the chat: wait the
 * delay from Settings first, then send, and retry with a growing pause when
 * the page refuses it (rate limit). Never throws: a final failure is logged
 * and leaves the Resend button, so the loop does not die silently.
 */
async function deliver(text: string, pause = true): Promise<void> {
  const active = session;
  if (!active) return;
  active.lastSent = text;
  const delay = pause ? delayMs() : 0;
  if (delay > 0) {
    setPhase('delay', 'Jeda sebelum kirim', delay);
    if (!(await waitFor(active, delay))) return;
  }
  for (let attempt = 1; ; attempt++) {
    setPhase('sending', 'Mengirim ke chat');
    const res = await tabMessage(active.tabId, { type: 'ba.send', text })
      .catch((err: any) => ({ ok: false, code: 'UNREACHABLE', error: err?.message || String(err) }));
    if (session !== active) return;
    if (res?.ok) {
      setPhase('waiting', 'Menunggu balasan AI');
      return;
    }
    const refused = res?.code === 'NOT_ACCEPTED';
    if (!refused || attempt >= SEND_ATTEMPTS) {
      const why = refused ? 'chat menolak pesan (rate limit?)' : (res?.code === 'UNREACHABLE' ? 'tab chat tidak merespons' : 'gagal mengirim');
      setPhase('failed', `Belum terkirim: ${why}`);
      log({ tool: 'send', category: '-', decision: `${attempt}x dicoba`, status: 'error', ms: 0, detail: `${res?.error || why}. Klik "Kirim ulang", atau tekan kirim di tab chat.` });
      deps.toast(`Pesan agent belum terkirim: ${why}`);
      return;
    }
    const backoff = retryBackoffMs(attempt, delay);
    log({ tool: 'send', category: '-', decision: `retry ${attempt}/${SEND_ATTEMPTS - 1}`, status: 'info', ms: 0, detail: `chat menolak pesan (rate limit?); coba lagi dalam ${Math.round(backoff / 1000)}s` });
    setPhase('retry', `Chat menolak pesan, coba lagi (${attempt}/${SEND_ATTEMPTS - 1})`, backoff);
    if (!(await waitFor(active, backoff))) return;
  }
}

/**
 * Runs every TICK_MS while a session is open: keeps the status time current,
 * nudges the relay to poll (its own timers are throttled in a background tab),
 * and re-activates a relay that lost its state because the chat tab reloaded.
 */
async function tick(): Promise<void> {
  renderStatus();
  if (!session || ticking) return;
  const active = session;
  ticking = true;
  try {
    const res = await tabMessage(active.tabId, { type: 'ba.tick' });
    if (session !== active) return;
    if (phase?.kind === 'offline') {
      phase = beforeOffline;
      beforeOffline = null;
      renderStatus();
    }
    if (res && res.active === false && res.composer && res.loadedMs >= RESUME_AFTER_MS) {
      await tabMessage(active.tabId, { type: 'ba.activate' });
      // The reloaded page shows the history again; never act twice on the reply already handled.
      active.resumeGuard = active.lastReplyText;
      log({ tool: 'relay', category: '-', decision: '-', status: 'info', ms: 0, detail: 'tab chat dimuat ulang - relay disambung lagi' });
    }
  } catch {
    if (session === active && phase?.kind !== 'offline') {
      beforeOffline = phase;
      setPhase('offline', 'Tab chat tidak merespons (sedang reload atau ditidurkan Chrome?)');
    }
  } finally {
    ticking = false;
  }
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
    session = { tabId, provider: found.provider, toolCalls: 0, totalCalls: 0, allowed: new Set(), lastSent: prompt, lastReplyText: null, resumeGuard: null };
    await send(prompt);
    setPhase('waiting', 'Menunggu balasan AI');
    log({ tool: 'session.start', category: found.provider.label, decision: mode(), status: 'info', ms: 0, detail: `${toolCount} tools dikirim ke chat` });
    $('detectedChat').textContent = `${found.provider.label} - ${found.tab.title || ''}`;
  } catch (err: any) {
    session = null;
    tabMessage(tabId, { type: 'ba.deactivate' }).catch(() => {});
    deps.toast('Gagal memulai sesi: ' + (err?.message || err));
  }
  renderSession();
}

async function stopSession(reason = 'dihentikan'): Promise<void> {
  if (!session) return;
  const tabId = session.tabId;
  session = null;
  phase = null;
  beforeOffline = null;
  pendingApproval?.('deny');
  hideApproval();
  renderStatus();
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
  const guard = active.resumeGuard;
  active.resumeGuard = null;
  if (guard !== null && reply.text === guard) {
    log({ tool: 'relay', category: '-', decision: '-', status: 'info', ms: 0, detail: 'balasan lama muncul lagi setelah reload - diabaikan' });
    return;
  }
  active.lastReplyText = reply.text;
  const parsed = parseReply(reply);

  if (parsed.kind === 'final') {
    active.toolCalls = 0;
    log({ tool: 'assistant', category: '-', decision: '-', status: 'info', ms: 0, detail: parsed.text.slice(0, 200) });
    setPhase('idle', 'Selesai - menunggu pesanmu di chat');
    return;
  }
  if (parsed.kind === 'error') {
    log({ tool: 'parser', category: '-', decision: '-', status: 'error', ms: 0, detail: parsed.reason });
    return deliver(formatCorrection(parsed.reason));
  }

  const { command, params } = parsed;
  if (parsed.native) {
    log({ tool: command, category: '-', decision: 'native markup', status: 'info', ms: 0, detail: 'AI memakai format tool-call bawaannya (mis. DSML); dibaca sebagai perintah' });
  }
  if (active.toolCalls >= MAX_TOOL_CALLS) {
    log({ tool: command, category: '-', decision: 'limit', status: 'denied', ms: 0, detail: `batas ${MAX_TOOL_CALLS} tool call per permintaan` });
    return deliver(formatToolResult(command, false, `NOT_ALLOWED: limit of ${MAX_TOOL_CALLS} tool calls per request reached. Summarize your progress and stop.`));
  }
  active.toolCalls++;
  active.totalCalls++;
  setPhase('running', `Memeriksa ${command}`);

  const currentMode = mode();
  let check: any;
  try {
    check = await bridge.call('agent.check', { command, params, mode: currentMode });
  } catch (err: any) {
    log({ tool: command, category: '-', decision: '-', status: 'error', ms: 0, detail: err?.message });
    return deliver(formatToolResult(command, false, `${err?.message || err}\nUse only tools from the catalog you were given.`));
  }

  let approved = false;
  let decision: string = check.decision;
  if (check.decision === 'deny') {
    log({ tool: command, category: check.category, decision: `deny (${currentMode})`, status: 'denied', ms: 0 });
    return deliver(formatToolResult(command, false, `NOT_ALLOWED: ${command} is not allowed in ${currentMode} mode. Do not retry it.`));
  }
  if (check.decision === 'ask') {
    // ask-once: an approval is remembered under the key the bridge returned.
    const remember = currentMode === 'ask-once';
    if (remember && active.allowed.has(check.approvalKey)) {
      approved = true;
      decision = 'approved earlier';
    } else {
      setPhase('approval', `Menunggu persetujuan ${command}`);
      const answer = await askApproval(check, params, remember);
      if (session !== active) return; // session stopped while waiting
      if (answer === 'deny') {
        log({ tool: command, category: check.category, decision: 'denied by user', status: 'denied', ms: 0 });
        return deliver(formatToolResult(command, false, 'NOT_ALLOWED: the user denied this action. Do not retry it; ask what to do instead.'));
      }
      if (remember) active.allowed.add(check.approvalKey);
      approved = true;
      decision = remember ? 'allowed, remembered' : 'allowed';
    }
  }

  const started = performance.now();
  setPhase('running', `Menjalankan ${command}`);
  let message: string;
  try {
    const result: any = await bridge.call('agent.callTool', { command, params, mode: currentMode, approved }, toolTimeoutMs(params));
    log({ tool: command, category: check.category, decision, status: 'ok', ms: Math.round(performance.now() - started) });
    message = formatToolResult(command, true, result.text, result.truncated);
    if (check.category !== 'read') deps.onFilesChanged();
  } catch (err: any) {
    log({ tool: command, category: check.category, decision, status: 'error', ms: Math.round(performance.now() - started), detail: err?.message });
    message = formatToolResult(command, false, String(err?.message || err));
  }
  if (session !== active) return;
  if (parsed.native) {
    message += '\n\n' + NATIVE_CALL_REMINDER;
  } else if (active.totalCalls % REMINDER_EVERY === 0) {
    message += '\n\n[BroAgentAI reminder - automatic, do not reply to it] One fenced JSON command per reply; plain prose when done.';
  }
  await deliver(message);
}

export function initAgent(dependencies: AgentDeps): void {
  deps = dependencies;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'ba.reply') return;
    // Not ours (no session, or another window's panel owns it): stay silent so that panel can answer.
    if (!session || sender.tab?.id !== session.tabId) return;
    // Acknowledge, so the relay re-offers a reply nobody took instead of dropping it.
    sendResponse({ ok: true });
    // One reply at a time, in order.
    queue = queue.then(() => handleReply(message.reply)).catch((err) => {
      log({ tool: 'relay', category: '-', decision: '-', status: 'error', ms: 0, detail: err?.message || String(err) });
    });
  });
  chrome.tabs.onRemoved.addListener((tabId) => { if (session?.tabId === tabId) stopSession('tab chat ditutup'); });

  $('agentStart').addEventListener('click', () => { startSession(); });
  $('agentStop').addEventListener('click', () => { stopSession(); });
  $('agentResend').addEventListener('click', () => {
    const text = session?.lastSent;
    if (!text) return;
    log({ tool: 'send', category: '-', decision: 'manual', status: 'info', ms: 0, detail: 'pesan terakhir dikirim ulang' });
    queue = queue.then(() => deliver(text, false));
  });
  window.setInterval(() => { tick(); }, TICK_MS);

  // Delay before each automatic message (Settings > Agent). Read on every send, so a change applies to the next command.
  const delayInput = $('agentDelay') as HTMLInputElement;
  try {
    chrome.storage.local.get(DELAY_KEY).then((stored) => {
      const raw = stored[DELAY_KEY];
      if (typeof raw === 'number' && raw >= 0) delayInput.value = String(raw);
    });
  } catch { /* storage unavailable */ }
  delayInput.addEventListener('change', () => {
    const seconds = sendDelayMs(delayInput.value) / 1000;
    delayInput.value = String(seconds);
    chrome.storage.local.set({ [DELAY_KEY]: seconds }).catch(() => {});
    deps.toast(seconds > 0 ? `Jeda agent: ${seconds} detik sebelum tiap kirim` : 'Jeda agent dimatikan');
  });

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
