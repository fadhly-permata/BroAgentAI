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
import { buildHandoffSnapshot, classifyChatMessage, emptyWorkSummary, formatHandoffContext, normalizeTranscript, noteToolCall, validateHandoffSnapshot, workspaceFromGitStatus, type HandoffSnapshot, type HandoffTurn, type WorkSummary, type WorkspaceState } from './agent-handoff.js';
import { t } from './i18n.js';
import { providers, providerForUrl } from './providers/registry.js';
import type { ProviderInfo, ProviderReply } from './providers/types.js';
import { reloadIfManifestStale } from './stale-manifest.js';
import { errorRetryDelay, isErrorReply, MAX_ERROR_RETRIES } from './reply-errors.js';

export interface AgentDeps {
  toast(message: string): void;
  /** Ask with OK/Cancel; resolves false when the user closes it any other way. */
  confirm(title: string, bodyHtml: string): Promise<boolean>;
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
  /** R10: the user confirmed Auto approve for this session's custom (user-installed) plugin. */
  customAutoOk?: boolean;
  /** Last message the agent typed into the chat, for "Resend". */
  lastSent: string | null;
  /**
   * The agent's last message has not been answered yet. A failed generation
   * is only resent automatically when it failed on the agent's own message;
   * one that failed on the user's message is the user's to resend.
   */
  awaitingReply?: boolean;
  /** Automatic resends after failed generations in a row (see reply-errors.ts). */
  errorRetries?: number;
  /** Text of the last reply handled, to drop it if it shows up again after the chat tab reloads. */
  lastReplyText: string | null;
  resumeGuard: string | null;
  /**
   * True while the chat tab is not the focused tab: the loop and the relay are
   * held. A paused session still exists (Start shows Stop) and resumes on its
   * own when the user comes back to the chat tab.
   */
  paused: boolean;
  /**
   * Conversation from before this chat tab: earlier providers (a switch) or a
   * resumed .broagentai/handoff.json. The current tab's own part is read from
   * the page when a snapshot is made.
   */
  carried: HandoffTurn[];
  /** Messages of the current tab as the panel saw them; fallback when the page cannot be read. */
  recorded: HandoffTurn[];
  /** Tools that ran OK and the files they read or changed, over the whole task. */
  work: WorkSummary;
}

type PhaseKind = 'opening' | 'connecting' | 'idle' | 'waiting' | 'running' | 'approval' | 'delay' | 'sending' | 'retry' | 'paused' | 'failed' | 'offline';
interface Phase { kind: PhaseKind; label: string; since: number; until?: number }

/** How long a switch waits for the target chat tab to load and show its composer. */
const SWITCH_READY_MS = 30_000;
/** Same for Start session (the tab may have just been reloaded to inject the relay). */
const CONNECT_READY_MS = 20_000;
/** True while a session is being moved to another provider (focus changes are expected then). */
let switching = false;

const MAX_TOOL_CALLS = 40;
/** Workspace file the session is saved to, so a later session can resume the task. */
const HANDOFF_FILE = '.broagentai/handoff.json';
const MAX_RECORDED = 400;
const REMINDER_EVERY = 8;
const MODE_KEY = 'broagentai.agentMode';
const NOTICE_KEY = 'broagentai.agentNoticeDismissed';
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
/**
 * A start in progress (opening the chat tab, waiting for it, connecting). It
 * shows in the status line and turns Start into Stop like a live session, so
 * the user sees the process and can cancel it. `cancelled` is set by Stop.
 */
interface Launch { cancelled: boolean }
let launching: Launch | null = null;
const sessionListeners: (() => void)[] = [];

export type AgentSessionState = 'idle' | 'starting' | 'active';
export function agentSessionState(): AgentSessionState { return session ? 'active' : launching ? 'starting' : 'idle'; }
/** Called whenever the session starts, stops, or a start begins or ends (Home mirrors it). */
export function onAgentSessionChange(listener: () => void): void { sessionListeners.push(listener); }
/** Phase to return to when an unreachable chat tab answers again. */
let beforeOffline: Phase | null = null;
let ticking = false;

const mode = () => ($('modeSel') as HTMLSelectElement).value;

/** Phase that was showing when the tab lost focus, restored on resume. */
let phaseBeforePause: Phase | null = null;

/**
 * Tell the user something even while they look at another tab: a toast for
 * the panel, plus a system notification that shows outside the browser. The
 * notification is best-effort - a missing icon or a denied permission must
 * never break the session, so the toast always fires regardless.
 */
function notify(title: string, message: string): void {
  deps.toast(message);
  try {
    chrome.notifications.create({
      type: 'basic',
      title,
      message,
      // No packaged PNG ships with the extension; a tiny inline SVG works as the
      // notification icon. Wrapped so a rejecting icon still leaves the toast.
      iconUrl: 'data:image/svg+xml;utf8,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#2563eb"/><text x="64" y="84" font-size="72" text-anchor="middle" fill="#fff" font-family="sans-serif">B</text></svg>',
      ),
    }, () => { /* notifications unavailable */ });
  } catch { /* notifications unavailable */ }
}

function log(entry: Omit<LogEntry, 'time'>): void {
  logs.push({ ...entry, time: new Date().toLocaleTimeString() });
  if (logs.length > 500) logs = logs.slice(-500);
  renderLog();
}

/** Human word for a status, shown in the row badge. */
const STATUS_LABEL: Record<LogEntry['status'], string> = { ok: 'ok', denied: 'denied', error: 'error', info: 'info' };

/**
 * Activity rows, two tiers each: a headline (badge + tool + decision + duration +
 * time) and an indented detail line. The badge and a left stripe carry the
 * severity at a glance, so errors stand out from the wall of info lines.
 */
function renderLog(): void {
  const filter = ($('logFilter') as HTMLSelectElement).value;
  const rows = logs.filter((l) => filter === 'all' || l.status === filter);
  $('cmdLog').innerHTML = rows.map((l) => {
    // Only the fields that carry something; no columns of bare dashes.
    const meta = [l.category, l.decision].filter((v) => v && v !== '-');
    const dur = l.ms ? l.ms + 'ms' : '';
    return '<div class="log-row" data-log-status="' + l.status + '" data-log-tool="' + esc(l.tool) + '">'
      + '<div class="log-line">'
      + '<span class="log-badge log-badge-' + l.status + '">' + STATUS_LABEL[l.status] + '</span>'
      + '<b class="log-tool">' + esc(l.tool) + '</b>'
      + (meta.length ? '<span class="log-meta">' + esc(meta.join(' · ')) + '</span>' : '')
      + (dur ? '<span class="log-dur">' + dur + '</span>' : '')
      + '<span class="log-time">' + esc(l.time) + '</span>'
      + '</div>'
      + (l.detail ? '<small class="log-detail">' + esc(l.detail) + '</small>' : '')
      + '</div>';
  }).join('') || '<p class="muted">Belum ada aktivitas.</p>';
  $('cmdLog').scrollTop = $('cmdLog').scrollHeight;
}

/** A custom (user-installed) plugin is labelled as such wherever the session shows (R10). */
const providerLabel = (p: ProviderInfo) => (p.source === 'user' ? `${p.label} (custom)` : p.label);

/**
 * R10: a custom plugin's chat page can write any reply, and Auto approve runs
 * the commands in it without asking. Ask once per session; declining switches
 * the session to "Always ask".
 */
async function guardCustomAutoApprove(active: Pick<Session, 'provider' | 'customAutoOk'>, stillCurrent: () => boolean = () => session === active): Promise<void> {
  if (active.provider.source !== 'user' || mode() !== 'auto-approve' || active.customAutoOk) return;
  const ok = await deps.confirm('Auto approve + plugin custom',
    `<p><b>${esc(active.provider.label)}</b> adalah plugin <b>custom</b> (bukan bawaan BroAgentAI). Halaman chat yang ditanganinya bisa menulis balasan apa saja, dan <b>Auto approve</b> langsung menjalankan perintah di dalamnya: tulis/hapus file, shell, push.</p>`
    + `<p>OK = tetap Auto approve untuk sesi ini. Batal = pindah ke <b>Always ask</b>.</p>`);
  if (!stillCurrent()) return;
  if (ok) { active.customAutoOk = true; return; }
  const select = $('modeSel') as HTMLSelectElement;
  select.value = 'always-ask';
  select.dispatchEvent(new Event('change'));
  log({ tool: 'mode', category: active.provider.label, decision: 'always-ask', status: 'info', ms: 0, detail: 'Auto approve tidak dikonfirmasi untuk plugin custom' });
}

function renderSession(): void {
  const busy = !!session || !!launching;
  $('agentSession').textContent = session
    ? (session.paused ? `Sesi dijeda - ${providerLabel(session.provider)}` : `Sesi aktif - ${providerLabel(session.provider)}`)
    : launching ? 'Memulai sesi...' : 'Belum ada sesi';
  $('agentPill').className = 'pill ' + (session ? (session.paused ? 'pill-warn' : 'pill-ok') : launching ? 'pill-info' : 'pill-warn');
  $('agentStart').classList.toggle('hidden', busy);
  $('agentStop').classList.toggle('hidden', !busy);
  $('ckAi').textContent = session ? 'x' : 'o';
  $('ckAi').classList.toggle('done', !!session);
  for (const listener of sessionListeners) { try { listener(); } catch { /* a listener's bug must not break the panel */ } }
}

function setPhase(kind: PhaseKind, label: string, untilMs?: number): void {
  phase = { kind, label, since: Date.now(), until: untilMs === undefined ? undefined : Date.now() + untilMs };
  renderStatus();
}

/** One line under the session controls: what the agent is doing right now, and for how long. */
function renderStatus(): void {
  const box = $('agentStatus');
  if ((!session && !launching) || !phase) {
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
  $('agentResend').classList.toggle('hidden', !(stalled && session?.lastSent));
}


async function tabMessage(tabId: number, message: unknown): Promise<any> {
  return chrome.tabs.sendMessage(tabId, message);
}

/** Activate a chat tab's relay; it runs the plugin's prepare hook first. Logs what the hook did. */
async function activateRelay(tabId: number, provider: ProviderInfo): Promise<void> {
  const res = await tabMessage(tabId, { type: 'ba.activate' });
  const prepare = res?.prepare as { ran?: boolean; error?: string } | undefined;
  if (prepare?.error) log({ tool: 'plugin.prepare', category: provider.label, decision: '-', status: 'error', ms: 0, detail: 'hook prepare gagal, sesi tetap jalan: ' + prepare.error });
  else if (prepare?.ran) log({ tool: 'plugin.prepare', category: provider.label, decision: '-', status: 'info', ms: 0, detail: 'halaman chat disiapkan oleh plugin ' + provider.label });
}

/** Find an open tab of a bundled provider; the active tab wins. */
async function findChatTab(preferredTabId?: number): Promise<{ tab: chrome.tabs.Tab; provider: ProviderInfo } | null> {
  const tabs = await chrome.tabs.query({});
  const matches = tabs
    .map((tab) => ({ tab, provider: tab.url ? providerForUrl(tab.url) : null }))
    .filter((m): m is { tab: chrome.tabs.Tab; provider: ProviderInfo } => m.provider !== null && m.tab.id !== undefined);
  matches.sort((a, b) => Number(b.tab.id === preferredTabId) - Number(a.tab.id === preferredTabId) || Number(b.tab.active) - Number(a.tab.active));
  return matches[0] ?? null;
}

/** An open tab of `provider` other than `exclude`: the active one wins, then the most recently used. */
async function findProviderTab(provider: ProviderInfo, exclude?: number): Promise<chrome.tabs.Tab | null> {
  const tabs = (await chrome.tabs.query({}))
    .filter((tab) => tab.id !== undefined && tab.id !== exclude && !!tab.url && providerForUrl(tab.url)?.id === provider.id);
  const used = (tab: chrome.tabs.Tab) => (tab as { lastAccessed?: number }).lastAccessed ?? 0;
  tabs.sort((a, b) => Number(b.active) - Number(a.active) || used(b) - used(a));
  return tabs[0] ?? null;
}

/**
 * Wait until a chat tab is usable: loaded, relay answering, composer rendered.
 * A tab that was just opened is still loading (and chat apps draw the composer
 * after load), so check the status first; ensureRelay reloads a tab whose relay
 * does not answer, which must not happen to a page that is merely loading.
 */
async function waitForChatReady(tabId: number, timeoutMs: number, launch?: Launch): Promise<any> {
  const end = Date.now() + timeoutMs;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < end && !launch?.cancelled) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete') break;
    await sleep(300);
  }
  const health = await ensureRelay(tabId, launch);
  if (!health) return null;
  let latest = health;
  while (!latest?.composer && Date.now() < end && !launch?.cancelled) {
    await sleep(500);
    latest = await tabMessage(tabId, { type: 'ba.ping' }).catch(() => latest);
  }
  return latest;
}

/** Remember one message of the current chat tab (fallback for when the page cannot be read). */
function record(active: Session, side: 'user' | 'assistant', text: string): void {
  const turn = classifyChatMessage(side, text);
  if (!turn) return;
  active.recorded.push(turn);
  if (active.recorded.length > MAX_RECORDED) active.recorded = active.recorded.slice(-MAX_RECORDED);
}

/**
 * The whole conversation of the session: what was carried in from earlier
 * chats, then the current chat tab read from the page (it has the user's own
 * messages, which the panel never sees). Falls back to what the panel
 * recorded when the page cannot be read or shows less (virtualized list,
 * plugin without a userMessage selector, tab closed).
 */
async function collectTranscript(active: Session): Promise<HandoffTurn[]> {
  let current = active.recorded;
  try {
    const res = await tabMessage(active.tabId, { type: 'ba.transcript' });
    if (res?.ok && Array.isArray(res.messages)) {
      const fromPage = res.messages.flatMap((m: any): HandoffTurn[] => {
        const turn = classifyChatMessage(m?.side === 'assistant' ? 'assistant' : 'user', String(m?.text ?? ''));
        return turn ? [turn] : [];
      });
      // Use the page only when it still shows everything the panel saw itself
      // (a virtualized list drops old messages); then it adds the user's own words.
      if (fromPage.filter((turn: HandoffTurn) => turn.role !== 'user').length >= current.length) current = fromPage;
    }
  } catch { /* tab gone or reloading: keep what the panel recorded */ }
  return normalizeTranscript([...active.carried, ...current]);
}

/** Branch and changed files of the workspace right now; null outside Git or when the bridge is unreachable. */
async function currentWorkspace(): Promise<WorkspaceState | null> {
  try {
    return workspaceFromGitStatus(await bridge.call('git.status'));
  } catch {
    return null;
  }
}

function snapshotOf(active: Session, transcript: HandoffTurn[], workspace: WorkspaceState | null): HandoffSnapshot {
  const lastUser = [...transcript].reverse().find((turn) => turn.role === 'user');
  return buildHandoffSnapshot({
    provider: active.provider.label,
    totalCalls: active.totalCalls,
    lastSent: active.lastSent,
    lastReplyText: active.lastReplyText,
    logs,
    transcript,
    workspace,
    workSummary: { ...active.work, lastTaskDescription: lastUser ? lastUser.text.slice(0, 1000) : active.work.lastTaskDescription },
  });
}

/** True when a snapshot holds something to continue from (not just the operating prompt). */
function worthResuming(snapshot: HandoffSnapshot): boolean {
  return snapshot.totalCalls > 0 || snapshot.transcript.some((turn) => turn.role === 'user' || turn.role === 'assistant');
}

/**
 * First message of a chat that continues a task: the full operating prompt
 * (tools and rules) with the handoff context at the very end, so it wins over
 * any generic opening instruction.
 */
function handoffMessage(systemPrompt: string, context: string): string {
  return systemPrompt + `\n\n--- HANDOFF INSTRUCTION ---\nKamu sedang melanjutkan sesi yang dipindah (handoff). JANGAN mulai dari nol.\n\n${context}\n\nLanjutkan tugas dari titik ini. Balas dengan satu perintah JSON seperti biasa, atau prosa jika sudah selesai.`;
}

let saving: Promise<void> = Promise.resolve();

/**
 * Write the session to .broagentai/handoff.json in the workspace, so a later
 * session (another window, profile or day) can pick the task up. Writes are
 * queued one after another; a failure only warns - it must never break the loop.
 */
function saveWorkspaceHandoff(active: Session): Promise<void> {
  if (!deps.hasWorkspace()) return saving;
  saving = saving.then(async () => {
    const snapshot = snapshotOf(active, await collectTranscript(active), await currentWorkspace());
    if (!worthResuming(snapshot)) return;
    await bridge.call('fs.mkdir', { path: '.broagentai' }).catch(() => {});
    await bridge.call('fs.writeFile', { path: HANDOFF_FILE, content: JSON.stringify(snapshot, null, 2) + '\n' });
  }).catch((err) => { console.warn('Failed to save workspace handoff:', err); });
  return saving;
}

async function readWorkspaceHandoff(): Promise<HandoffSnapshot | null> {
  try {
    const res: any = await bridge.call('fs.readFile', { path: HANDOFF_FILE });
    if (typeof res?.content !== 'string' || !res.content.trim()) return null;
    return validateHandoffSnapshot(JSON.parse(res.content));
  } catch {
    return null; // no file, or not a snapshot
  }
}

async function deleteWorkspaceHandoff(): Promise<void> {
  await bridge.call('fs.delete', { path: HANDOFF_FILE }).catch(() => {});
}

/**
 * A saved session in this workspace? Ask whether to continue it. Yes returns
 * the snapshot (its conversation goes into the first prompt); no deletes the
 * file so the new task starts clean.
 */
async function offerWorkspaceResume(launch: Launch): Promise<HandoffSnapshot | null> {
  const saved = await readWorkspaceHandoff();
  if (!saved || !worthResuming(saved) || launch.cancelled) return null;
  const userTurns = saved.transcript.filter((turn) => turn.role === 'user').length;
  const ok = await deps.confirm('Lanjutkan pekerjaan sebelumnya?',
    '<p>Ditemukan <code>' + esc(HANDOFF_FILE) + '</code> di workspace ini (' + esc(saved.provider) + ', ' + esc(new Date(saved.createdAt).toLocaleString()) + ').</p>'
    + '<p>Isinya: ' + saved.transcript.length + ' pesan percakapan (' + userTurns + ' dari kamu), ' + saved.totalCalls + ' tool call.</p>'
    + '<p><b>OK</b> = lanjutkan pekerjaan itu<br><b>Batal</b> = mulai tugas baru (file dihapus)</p>');
  if (launch.cancelled) return null;
  if (!ok) {
    await deleteWorkspaceHandoff();
    log({ tool: 'handoff.reset', category: '-', decision: 'user-declined', status: 'info', ms: 0, detail: 'mulai tugas baru; ' + HANDOFF_FILE + ' dihapus' });
    return null;
  }
  log({ tool: 'handoff.resume', category: saved.provider, decision: 'user-approved', status: 'info', ms: 0, detail: 'melanjutkan dari ' + HANDOFF_FILE + ' (' + saved.transcript.length + ' pesan)' });
  return saved;
}

/** Fill the switch-provider <select> with every provider except the current one. */
function renderSwitchProviders(): void {
  const sel = $('switchProvider') as HTMLSelectElement;
  if (!sel) return;
  const currentId = session?.provider.id;
  const options = providers.filter((p) => p.id !== currentId);
  sel.innerHTML = options.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.label) + '</option>').join('');
  const hasChoice = options.length > 0 && !!session;
  sel.disabled = !hasChoice;
  const btn = $('agentSwitch') as HTMLButtonElement;
  if (btn) btn.disabled = !hasChoice;
}

/**
 * Move a running session to another provider's chat tab: summarize where the
 * work stands, activate the target tab relay, deactivate the old one, point
 * the session at the new tab and send the handoff prompt. Logs and ask-once
 * approvals are kept on purpose (same task, same trust); the per-request
 * tool-call counter resets so the new chat gets a fresh budget.
 */
export async function switchProviderSession(targetId: string): Promise<void> {
  const active = session;
  if (!active) { deps.toast('Mulai sesi dulu sebelum pindah provider'); return; }
  const target = providers.find((p) => p.id === targetId);
  if (!target) { deps.toast('Provider tidak dikenal: ' + targetId); return; }
  if (target.id === active.provider.id) { deps.toast('Sudah di ' + target.label); return; }

  if (switching) return;
  switching = true;
  try {
    await moveSession(active, target);
  } finally {
    switching = false;
    // Focus changes during the move were ignored; align pause/resume now.
    void syncFocusWithSession();
  }
}

async function moveSession(active: Session, target: ProviderInfo): Promise<void> {
  const oldTabId = active.tabId;
  // Read the old chat before leaving it: the new one never saw that conversation.
  const transcript = await collectTranscript(active);
  if (session !== active) return;
  const handoff = formatHandoffContext(snapshotOf(active, transcript, await currentWorkspace()));
  if (session !== active) return;
  setPhase('connecting', 'Pindah ke ' + target.label);

  // Reuse an open tab of the TARGET provider (never the session's own tab), else open one.
  let targetTab = await findProviderTab(target, oldTabId).catch(() => null);
  try {
    if (targetTab?.id !== undefined) {
      await chrome.tabs.update(targetTab.id, { active: true });
      await chrome.windows.update(targetTab.windowId, { focused: true }).catch(() => {});
    } else {
      targetTab = await chrome.tabs.create({ url: target.homepage, active: true });
    }
  } catch (err: any) {
    deps.toast('Gagal membuka tab ' + target.label + ': ' + (err?.message || err));
    setPhase('failed', 'Gagal pindah provider');
    return;
  }
  const targetTabId = targetTab?.id;
  if (targetTabId === undefined) { deps.toast('Tab ' + target.label + ' tidak ditemukan'); setPhase('failed', 'Gagal pindah provider'); return; }

  // Wait for the page to load and draw its composer (a new tab needs a while).
  setPhase('connecting', 'Menunggu ' + target.label + ' termuat');
  const health = await waitForChatReady(targetTabId, SWITCH_READY_MS);
  if (session !== active) return;
  if (!health?.composer) {
    deps.toast('Kolom chat ' + target.label + ' belum siap. Login/termuat dulu, lalu coba lagi.');
    setPhase('failed', 'Pindah provider gagal - tab belum siap');
    return;
  }

  // Activate the new relay, retire the old one, then re-point the session.
  await activateRelay(targetTabId, target);
  if (session !== active) return;
  try { await tabMessage(oldTabId, { type: 'ba.deactivate' }); } catch { /* old tab gone */ }
  active.tabId = targetTabId;
  active.provider = target;
  active.carried = transcript;
  active.recorded = [];
  active.toolCalls = 0;
  active.resumeGuard = null;
  active.paused = false;
  phaseBeforePause = null;
  // Fetch full system prompt and inject handoff context so the new AI knows its tools and rules
  let promptToSend = handoff;
  try {
    // handoff: the prompt does not end with "reply READY" (that reply would end the loop).
    const { prompt: systemPrompt }: any = await bridge.call('agent.prompt', { mode: mode(), handoff: true });
    // Append handoff context at the very end to override any "reply READY" instruction (recency bias)
    promptToSend = handoffMessage(systemPrompt, handoff);
  } catch (err) {
    console.warn('Failed to get system prompt for handoff, using basic handoff:', err);
  }

  active.lastSent = promptToSend;
  $('detectedChat').textContent = target.label + ' - ' + (targetTab?.title || '');

  log({ tool: 'session.switch', category: active.provider.label, decision: 'handoff', status: 'info', ms: 0, detail: 'pindah provider; konteks diringkas ke prompt baru (' + active.totalCalls + ' tool call sejauh ini)' });
  notify('BroAgentAI - Pindah provider', 'Sesi dipindah ke ' + target.label + '. Agent melanjutkan dengan ringkasan pekerjaan.');
  renderSession();
  renderSwitchProviders();

  // R10: moving to a custom plugin under Auto approve needs its own OK.
  active.customAutoOk = false;
  await guardCustomAutoApprove(active);
  setPhase('sending', 'Mengirim ringkasan ke ' + target.label);
  try {
    await send(promptToSend);
    setPhase('waiting', 'Menunggu balasan AI');
    void saveWorkspaceHandoff(active);
  } catch (err: any) {
    setPhase('failed', 'Ringkasan gagal terkirim: ' + (err?.message || err));
    deps.toast('Ringkasan handoff gagal terkirim. Coba Resend di tab baru.');
  }
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
  session.awaitingReply = true;
  record(session, 'user', text);
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
      active.awaitingReply = true;
      record(active, 'user', text);
      setPhase('waiting', 'Menunggu balasan AI');
      return;
    }
    // Held because the chat tab lost focus: not a failure. The message stays
    // queued and goes out once the user is back (Resend or the next tool).
    if (res?.code === 'PAUSED') {
      setPhase('paused', 'Dijeda - tab chat tidak aktif');
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
 * While paused it only keeps the clock going: the relay is asked to hold, so a
 * background tab does no work until the user is back on it.
 */
async function tick(): Promise<void> {
  renderStatus();
  if (!session || ticking) return;
  const active = session;
  ticking = true;
  try {
    if (active.paused) return;
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
    if (session === active && phase?.kind !== 'offline' && phase?.kind !== 'paused') {
      beforeOffline = phase;
      setPhase('offline', 'Tab chat tidak merespons (sedang reload atau ditidurkan Chrome?)');
    }
  } finally {
    ticking = false;
  }
}

/**
 * True when the session's chat tab is the one the user is looking at: it is the
 * active tab and its window has focus. Decides pause / resume.
 */
async function isChatTabFocused(tabId: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !tab.active) return false;
    const win = await chrome.windows.get(tab.windowId);
    return !!win?.focused;
  } catch {
    // The tab is gone; treat as not focused (the close handler stops the session).
    return false;
  }
}

/**
 * Hold the session: the chat tab is no longer focused. The relay is told to
 * stop reporting and refuse sends, the tick stops nudging it, and the status
 * line shows the pause. The session (and its approvals) stay intact so resume
 * can continue exactly where it stopped.
 */
async function pauseSession(): Promise<void> {
  const active = session;
  if (!active || active.paused) return;
  active.paused = true;
  phaseBeforePause = phase;
  setPhase('paused', 'Dijeda - tab chat tidak aktif');
  renderSession();
  log({ tool: 'session.pause', category: '-', decision: '-', status: 'info', ms: 0, detail: 'tab chat kehilangan fokus - sesi dijeda' });
  notify('BroAgentAI - Sesi dijeda', 'Tab chat tidak aktif. Kembali ke tab itu untuk melanjutkan.');
  try { await tabMessage(active.tabId, { type: 'ba.pause' }); } catch { /* tab gone; the close handler stops it */ }
}

/** Resume a held session once its chat tab is the focused one again. */
async function resumeSession(): Promise<void> {
  const active = session;
  if (!active || !active.paused) return;
  active.paused = false;
  // Return to whatever the agent was doing before the pause (waiting, delay, ...).
  phase = phaseBeforePause ?? { kind: 'waiting', label: 'Menunggu balasan AI', since: Date.now() };
  phaseBeforePause = null;
  renderStatus();
  renderSession();
  log({ tool: 'session.resume', category: '-', decision: '-', status: 'info', ms: 0, detail: 'tab chat fokus lagi - sesi dilanjutkan' });
  notify('BroAgentAI - Sesi dilanjutkan', 'Tab chat aktif lagi. Agent melanjutkan prosesnya.');
  try { await tabMessage(active.tabId, { type: 'ba.resume' }); } catch { /* tab gone */ }
}

/**
 * Align pause / resume with the tab the user is looking at. Called on every tab
 * activation and window focus change; cheap because it only acts on a change.
 */
async function syncFocusWithSession(): Promise<void> {
  const active = session;
  // Mid-switch the old tab loses focus on purpose; the move re-syncs when done.
  if (!active || switching) return;
  const focused = await isChatTabFocused(active.tabId);
  if (session !== active) return; // stopped while we were checking
  if (focused && active.paused) await resumeSession();
  else if (!focused && !active.paused) await pauseSession();
}

/** Begin a start: the status line shows it and Start becomes Stop. Null when one is already running. */
function beginLaunch(): Launch | null {
  if (session || launching) return null;
  if (!deps.hasWorkspace()) { deps.toast('Pilih workspace dulu'); return null; }
  launching = { cancelled: false };
  renderSession();
  return launching;
}

function endLaunch(launch: Launch): void {
  if (launching !== launch) return; // cancelled: Stop already cleaned up
  launching = null;
  if (!session) phase = null;
  renderStatus();
  renderSession();
}

/** Start the agent session; preferredTabId (e.g. a tab just opened from Home) wins over other chat tabs. */
export async function startAgentSession(preferredTabId?: number): Promise<void> {
  const launch = beginLaunch();
  if (!launch) return;
  try { await connect(launch, preferredTabId); } finally { endLaunch(launch); }
}

/**
 * Home's Start: open the provider's chat in a new tab, give it `waitMs` to load
 * and sign in, then connect to that tab - all visible in the Agent tab's status
 * line, and cancellable with Stop.
 */
export async function launchAgentSession(provider: ProviderInfo, waitMs: number): Promise<void> {
  const launch = beginLaunch();
  if (!launch) return;
  try {
    setPhase('opening', `Membuka ${provider.label}`);
    let tabId: number | undefined;
    try {
      tabId = (await chrome.tabs.create({ url: provider.homepage, active: true })).id;
    } catch (err: any) {
      log({ tool: 'session.start', category: provider.label, decision: '-', status: 'error', ms: 0, detail: 'tab chat gagal dibuka: ' + (err?.message || err) });
      deps.toast('Gagal membuka tab: ' + (err?.message || err));
      return;
    }
    log({ tool: 'session.start', category: provider.label, decision: '-', status: 'info', ms: 0, detail: `tab chat dibuka; sesi dimulai dalam ${Math.round(waitMs / 1000)} detik` });
    setPhase('opening', `Menunggu ${provider.label} termuat`, waitMs);
    // Whole-second steps against a fixed end time: a hidden panel's timers are
    // clamped to at least 1s each, so shorter steps would stretch the wait.
    const end = Date.now() + waitMs;
    while (Date.now() < end) {
      if (launch.cancelled) return;
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, end - Date.now())));
    }
    if (launch.cancelled) return;
    await connect(launch, tabId);
  } finally {
    endLaunch(launch);
  }
}

/**
 * Ping the relay, retrying briefly. If it still does not answer, the content
 * script is missing on that tab - typical right after the extension was
 * reloaded, which does not re-inject content scripts into tabs already open.
 * Reloading the tab lets Chrome inject it again, so the user does not have to
 * do it by hand. Returns the health object or null.
 */
async function ensureRelay(tabId: number, launch?: Launch): Promise<any> {
  const ping = async (): Promise<any> => {
    try { return await tabMessage(tabId, { type: 'ba.ping' }); } catch { return null; }
  };
  // First: a few quick tries (the tab may just still be settling).
  for (let i = 0; i < 5; i++) {
    const health = await ping();
    if (health) return health;
    if (launch?.cancelled) return null;
    await new Promise((r) => setTimeout(r, 400));
  }
  // Still nothing: reload the tab so Chrome injects the content script again.
  try { await chrome.tabs.reload(tabId); } catch { return null; }
  // Wait for the reload to reach "complete", then keep pinging while it boots.
  for (let i = 0; i < 20; i++) {
    if (launch?.cancelled) return null;
    await new Promise((r) => setTimeout(r, 500));
    const health = await ping();
    if (health) return health;
  }
  return null;
}
/** Find the chat tab, check its composer, send the operating prompt. Toasts and logs every failure. */
async function connect(launch: Launch, preferredTabId?: number): Promise<void> {
  setPhase('connecting', 'Menyambung ke tab chat');
  const fail = (message: string) => {
    log({ tool: 'session.start', category: '-', decision: '-', status: 'error', ms: 0, detail: message });
    deps.toast(message);
  };
  const found = await findChatTab(preferredTabId);
  if (launch.cancelled) return;
  if (!found) {
    const provider = providers[0];
    if (provider) await chrome.tabs.create({ url: provider.homepage });
    return fail('Tab chat dibuka. Login di sana, lalu klik Start session lagi.');
  }
  const tabId = found.tab.id!;
  const health = await waitForChatReady(tabId, CONNECT_READY_MS, launch);
  if (launch.cancelled) return;
  if (!health) {
    // Usual cause after a rebuild: Chrome still runs the old manifest, so this site gets no relay.
    if (await reloadIfManifestStale()) return fail('BroAgentAI baru di-build ulang; extension dimuat ulang otomatis. Buka side panel lagi lalu Start.');
    return fail('Tab chat tidak merespons walau sudah dimuat ulang otomatis. Tutup tab itu lalu buka lagi dari Home.');
  }
  if (!health?.composer) return fail(`Kolom chat ${found.provider.label} tidak ditemukan. Pastikan sudah login dan halaman chat terbuka.`);

  try {
    // R10 first: the prompt below states the approval mode, so settle it before building it.
    const pending: Session = { tabId, provider: found.provider, toolCalls: 0, totalCalls: 0, allowed: new Set(), lastSent: null, lastReplyText: null, resumeGuard: null, paused: false, carried: [], recorded: [], work: emptyWorkSummary() };
    await guardCustomAutoApprove(pending, () => !launch.cancelled);
    if (launch.cancelled) return;
    // A saved session in this workspace: continue it (its conversation goes into the first prompt) or start fresh.
    const resume = await offerWorkspaceResume(launch);
    if (launch.cancelled) return;
    setPhase('connecting', resume ? 'Mengirim instruksi + percakapan sebelumnya' : 'Mengirim instruksi agent');
    // handoff: the prompt does not end with "reply READY" (that reply would end the loop).
    const { prompt: systemPrompt, toolCount }: any = await bridge.call('agent.prompt', { mode: mode(), handoff: !!resume });
    if (launch.cancelled) return;
    const prompt = resume ? handoffMessage(systemPrompt, formatHandoffContext(resume)) : systemPrompt;
    if (resume) {
      pending.carried = resume.transcript;
      pending.totalCalls = resume.totalCalls;
      if (resume.workSummary) pending.work = { ...resume.workSummary };
    }
    await activateRelay(tabId, found.provider);
    session = { ...pending, lastSent: prompt };
    await send(prompt);
    setPhase('waiting', 'Menunggu balasan AI');
    log({ tool: 'session.start', category: found.provider.label, decision: mode(), status: 'info', ms: 0, detail: `${toolCount} tools dikirim ke chat` });
    $('detectedChat').textContent = `${found.provider.label} - ${found.tab.title || ''}`;
    // The session now exists: refresh the session pill and the switch-provider
    // control so it lists the OTHER providers and is clickable right away.
    renderSession();
    renderSwitchProviders();
    // The chat tab may not be focused right after connect (Home opened it but the
    // user could already be elsewhere): align the pause state now.
    void syncFocusWithSession();
  } catch (err: any) {
    session = null;
    tabMessage(tabId, { type: 'ba.deactivate' }).catch(() => {});
    fail('Gagal memulai sesi: ' + (err?.message || err));
  }
}

/** Stop the live session, or cancel a start that is still opening / connecting. */
export async function stopAgentSession(): Promise<void> {
  if (launching && !session) {
    launching.cancelled = true;
    launching = null;
    phase = null;
    renderStatus();
    log({ tool: 'session.start', category: '-', decision: '-', status: 'info', ms: 0, detail: 'dibatalkan sebelum sesi tersambung' });
    renderSession();
    return;
  }
  await stopSession();
}

async function stopSession(reason = 'dihentikan', opts: { notifyUser?: boolean } = {}): Promise<void> {
  if (!session) return;
  const stopped = session;
  const tabId = stopped.tabId;
  // Keep the conversation for a later session (read before the relay is retired).
  void saveWorkspaceHandoff(stopped);
  session = null;
  phase = null;
  phaseBeforePause = null;
  beforeOffline = null;
  pendingApproval?.('deny');
  hideApproval();
  renderStatus();
  try { await tabMessage(tabId, { type: 'ba.deactivate' }); } catch { /* tab gone */ }
  log({ tool: 'session.stop', category: '-', decision: '-', status: 'info', ms: 0, detail: reason });
  renderSession();
  if (opts.notifyUser) notify('BroAgentAI - Sesi dihentikan', reason);
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

/**
 * The chat site failed to generate a reply and showed its own error text. That
 * is not the AI's answer: resend the agent's last message a couple of times,
 * then leave it to the user (Resend button) instead of ending the turn silently.
 */
async function handleErrorReply(active: Session, text: string): Promise<void> {
  const label = providerLabel(active.provider);
  const shown = text.trim().slice(0, 160);
  if (!active.awaitingReply || !active.lastSent) {
    log({ tool: 'assistant', category: label, decision: '-', status: 'error', ms: 0, detail: `${label} gagal membalas pesanmu: "${shown}". Kirim ulang pesanmu di tab chat.` });
    setPhase('idle', `${label} gagal membalas - kirim ulang pesanmu di chat`);
    deps.toast(`${label} gagal membalas. Kirim ulang pesanmu di tab chat.`);
    return;
  }
  const attempt = (active.errorRetries ?? 0) + 1;
  const wait = errorRetryDelay(attempt);
  if (wait === null) {
    active.errorRetries = 0;
    log({ tool: 'assistant', category: label, decision: `${MAX_ERROR_RETRIES}x dicoba`, status: 'error', ms: 0, detail: `${label} tetap gagal membalas: "${shown}". Klik "Kirim ulang" atau tulis di tab chat.` });
    setPhase('failed', `${label} gagal membalas`);
    deps.toast(`${label} gagal membalas setelah ${MAX_ERROR_RETRIES}x coba ulang. Klik Kirim ulang.`);
    notify('BroAgentAI - ' + label + ' gagal membalas', 'Pesan agent sudah dikirim ulang ' + MAX_ERROR_RETRIES + 'x. Klik Kirim ulang di side panel.');
    void saveWorkspaceHandoff(active);
    return;
  }
  active.errorRetries = attempt;
  log({ tool: 'assistant', category: label, decision: `retry ${attempt}/${MAX_ERROR_RETRIES}`, status: 'error', ms: 0, detail: `${label} gagal membalas: "${shown}"; pesan terakhir dikirim ulang dalam ${Math.round(wait / 1000)}s` });
  setPhase('retry', `${label} gagal membalas, kirim ulang (${attempt}/${MAX_ERROR_RETRIES})`, wait);
  if (!(await waitFor(active, wait))) return;
  await deliver(active.lastSent, false);
}

async function handleReply(reply: ProviderReply): Promise<void> {
  if (!session) return;
  const active = session;
  // While paused nothing is acted on: the relay holds the reply and re-offers
  // it once resumed (the panel also does not nudge a paused relay).
  if (active.paused) return;
  const guard = active.resumeGuard;
  active.resumeGuard = null;
  if (guard !== null && reply.text === guard) {
    log({ tool: 'relay', category: '-', decision: '-', status: 'info', ms: 0, detail: 'balasan lama muncul lagi setelah reload - diabaikan' });
    return;
  }
  active.lastReplyText = reply.text;
  if (isErrorReply(reply.text, active.provider.errorReplies)) return handleErrorReply(active, reply.text);
  active.errorRetries = 0;
  active.awaitingReply = false;
  record(active, 'assistant', reply.text);
  const parsed = parseReply(reply);

  if (parsed.kind === 'final') {
    active.toolCalls = 0;
    log({ tool: 'assistant', category: '-', decision: '-', status: 'info', ms: 0, detail: parsed.text.slice(0, 200) });
    setPhase('idle', 'Selesai - menunggu pesanmu di chat');
    void saveWorkspaceHandoff(active);
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
    noteToolCall(active.work, command, check.category, params);
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
  if (session === active) void saveWorkspaceHandoff(active);
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
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (session?.tabId === tabId) stopSession('Tab chat ditutup - sesi dihentikan.', { notifyUser: true });
  });

  // Pause the session when the chat tab loses focus, resume it when the user
  // returns. A tab switch fires onActivated; switching apps or minimizing fires
  // onFocusChanged. Both are cheap: syncFocusWithSession only acts on a change.
  chrome.tabs.onActivated.addListener(() => { void syncFocusWithSession(); });
  chrome.windows.onFocusChanged.addListener(() => { void syncFocusWithSession(); });

  // Closable "Monitoring & Approval Agent" banner; dismissal persists across reloads.
  const setNoticeDismissed = (dismissed: boolean, persist: boolean) => {
    $('agentNotice').classList.toggle('hidden', dismissed);
    $('agentNoticeShow').classList.toggle('hidden', !dismissed);
    if (!persist) return;
    try { chrome.storage.local.set({ [NOTICE_KEY]: dismissed }).catch(() => {}); } catch { /* storage unavailable */ }
  };
  try {
    chrome.storage.local.get(NOTICE_KEY).then((stored) => setNoticeDismissed(stored[NOTICE_KEY] === true, false)).catch(() => {});
  } catch { /* storage unavailable: banner stays visible */ }
  $('agentNoticeClose').addEventListener('click', () => setNoticeDismissed(true, true));
  $('agentNoticeShow').addEventListener('click', () => setNoticeDismissed(false, true));

  $('agentStart').addEventListener('click', () => { startAgentSession(); });
  $('agentStop').addEventListener('click', () => { stopAgentSession(); });
  $('agentSwitch').addEventListener('click', () => {
    const sel = $('switchProvider') as HTMLSelectElement;
    if (sel && sel.value) void switchProviderSession(sel.value);
  });
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
    if (session && select.value === 'auto-approve') void guardCustomAutoApprove(session);
    if (session) log({ tool: 'mode', category: '-', decision: select.value, status: 'info', ms: 0, detail: 'berlaku untuk perintah berikutnya' });
    deps.toast('Approval mode: ' + select.options[select.selectedIndex].text);
  });
  showHint();

  renderLog();
  renderSession();
  renderSwitchProviders();
}

/** Re-render the provider controls after web chat plugins changed (installed, removed, toggled). */
export function refreshProviderControls(): void {
  renderSwitchProviders();
}

/** Called when the Agent tab becomes visible. */
export function hasAgentSession(): boolean { return !!session; }

export function showAgent(): void {
  refreshDetected();
}
