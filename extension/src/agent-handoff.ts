// Handoff snapshot: what a new chat needs to carry on a task started in another
// one (provider switch, or resume from .broagentai/handoff.json in a later
// session). The core is the conversation itself - what the user asked, what the
// AI answered, which tool results came back - not just the activity log: a log
// row says "fs.readFile ok" but not what the task was or what was decided.
import { agentMessageKind } from './agent-parser.ts';

export interface HandoffLogEntry {
  time: string;
  tool: string;
  category: string;
  decision: string;
  status: 'ok' | 'denied' | 'error' | 'info';
  ms: number;
  detail?: string;
}

/**
 * Who wrote one message of the chat:
 * - user: typed by the user on the chat page (the task, follow-ups, answers);
 * - assistant: the AI's reply (a JSON tool command or prose);
 * - tool: a tool result BroAgentAI typed back into the chat;
 * - agent: any other BroAgentAI message (operating prompt, format correction).
 */
export type HandoffRole = 'user' | 'assistant' | 'tool' | 'agent';

export interface HandoffTurn {
  role: HandoffRole;
  text: string;
}

/** Workspace state captured at handoff time */
export interface WorkspaceState {
  branch: string | null;
  modifiedFiles: string[];
  stagedFiles: string[];
  untrackedFiles: string[];
  lastCommitMessage: string | null;
}

/** Summary of recent work for context */
export interface WorkSummary {
  filesRead: string[];
  filesModified: string[];
  toolsUsed: string[];
  lastTaskDescription: string | null;
}

export interface HandoffSnapshot {
  version: 1;
  createdAt: string;
  provider: string;
  totalCalls: number;
  lastSent: string | null;
  lastReplyText: string | null;
  logs: HandoffLogEntry[];
  /** The chat conversation, oldest first. Snapshots written before it existed read as []. */
  transcript: HandoffTurn[];
  workspace?: WorkspaceState | null;
  workSummary?: WorkSummary | null;
}

/** The live bits of a session the snapshot is built from (a structural subset of the panel's Session). */
export interface HandoffSource {
  provider: string;
  totalCalls: number;
  lastSent: string | null;
  lastReplyText: string | null;
  logs: HandoffLogEntry[];
  transcript?: HandoffTurn[];
  workspace?: WorkspaceState | null;
  workSummary?: WorkSummary | null;
}

const MAX_LOGS = 100;
const MAX_TEXT = 12_000;
const MAX_DETAIL = 2_000;
const MAX_SUMMARY_LOGS = 20;
const MAX_FILES_LIST = 50;
/** Stored transcript bounds: enough for a long task, still a small file. */
const MAX_TURNS = 300;
const MAX_TURN_TEXT = 8_000;
const MAX_TOOL_TURN_TEXT = 4_000;
/** Budget for the conversation inside the handoff prompt (the chat page has an input limit). */
const MAX_PROMPT_TRANSCRIPT = 24_000;
/** Per-message caps inside the prompt: tool output is the least useful to repeat in full. */
const PROMPT_TURN_TEXT = 3_000;
const PROMPT_TOOL_TEXT = 800;
/** Stand-in for the operating prompt: the new chat gets a fresh one anyway. */
export const OPERATING_PROMPT_PLACEHOLDER = '[instruksi operasi BroAgentAI dikirim]';

const ROLES: readonly HandoffRole[] = ['user', 'assistant', 'tool', 'agent'];

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function stringArray(value: unknown, max = MAX_FILES_LIST): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, max);
}

/**
 * Cut long text: keep the head and say it was cut. The result is never longer
 * than `max`, so clipping again (validation on read) changes nothing.
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const note = '\n... (dipotong dari ' + value.length + ' karakter)';
  return value.slice(0, Math.max(0, max - note.length)) + note;
}

/** Normalize one raw log row, or null when it is not usable. */
function normalizeLog(item: unknown): HandoffLogEntry | null {
  if (!item || typeof item !== 'object') return null;
  const entry = item as Record<string, unknown>;
  const status = entry.status;
  if (!['ok', 'denied', 'error', 'info'].includes(String(status))) return null;
  return {
    time: text(entry.time, 80), tool: text(entry.tool, 200),
    category: text(entry.category, 200), decision: text(entry.decision, 200),
    status: status as HandoffLogEntry['status'],
    ms: count(entry.ms),
    ...(typeof entry.detail === 'string' ? { detail: text(entry.detail, MAX_DETAIL) } : {}),
  };
}

/** Normalize one raw transcript turn, or null when it is not usable. */
function normalizeTurn(item: unknown): HandoffTurn | null {
  if (!item || typeof item !== 'object') return null;
  const turn = item as Record<string, unknown>;
  const role = turn.role as HandoffRole;
  if (!ROLES.includes(role) || typeof turn.text !== 'string') return null;
  const body = turn.text.trim();
  if (!body) return null;
  return { role, text: clip(body, role === 'tool' ? MAX_TOOL_TURN_TEXT : MAX_TURN_TEXT) };
}

/** Bound and clean a transcript (keeps the newest turns). */
export function normalizeTranscript(value: unknown): HandoffTurn[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_TURNS).flatMap((item): HandoffTurn[] => {
    const turn = normalizeTurn(item);
    return turn ? [turn] : [];
  });
}

/**
 * Turn one message read from the chat page into a transcript turn. Messages
 * in the user's bubbles that BroAgentAI typed (operating prompt, tool results,
 * corrections) are recognized by their fixed first line and re-labelled, so
 * the transcript tells the user's own words apart from the agent's.
 */
export function classifyChatMessage(side: 'user' | 'assistant', raw: string): HandoffTurn | null {
  const body = typeof raw === 'string' ? raw.trim() : '';
  if (!body) return null;
  if (side === 'assistant') return { role: 'assistant', text: body };
  const kind = agentMessageKind(body);
  if (!kind) return { role: 'user', text: body };
  if (kind.kind === 'prompt') return { role: 'agent', text: OPERATING_PROMPT_PLACEHOLDER };
  if (kind.kind === 'result') return { role: 'tool', text: body };
  return { role: 'agent', text: body };
}

/** An empty work summary, for a new session. */
export function emptyWorkSummary(): WorkSummary {
  return { filesRead: [], filesModified: [], toolsUsed: [], lastTaskDescription: null };
}

/** Add to a list without duplicates; the newest stays at the end, the list stays bounded. */
function remember(list: string[], value: string): void {
  const at = list.indexOf(value);
  if (at >= 0) list.splice(at, 1);
  list.push(value);
  if (list.length > MAX_FILES_LIST) list.splice(0, list.length - MAX_FILES_LIST);
}

/** Workspace paths a tool call names in its params (path, paths[], from/to of a rename). */
function pathsOf(params: unknown): string[] {
  if (!params || typeof params !== 'object') return [];
  const p = params as Record<string, unknown>;
  const out: string[] = [];
  for (const key of ['path', 'from', 'to']) if (typeof p[key] === 'string' && p[key]) out.push(p[key] as string);
  if (Array.isArray(p.paths)) for (const item of p.paths) if (typeof item === 'string' && item) out.push(item);
  return out.map((path) => path.replace(/\\/g, '/').slice(0, 300));
}

/**
 * Note one tool call that ran OK in the session's work summary: the tool
 * name, and the files it read or changed (by its approval category).
 * Mutates `summary`.
 */
export function noteToolCall(summary: WorkSummary, command: string, category: string, params: unknown): void {
  if (command) remember(summary.toolsUsed, command.slice(0, 200));
  const paths = pathsOf(params);
  // Listing "." or searching the whole tree is not a file worth naming.
  const files = paths.filter((path) => path !== '.' && path !== './');
  if (category === 'read') files.forEach((path) => remember(summary.filesRead, path));
  else if (category === 'write' || category === 'delete') files.forEach((path) => remember(summary.filesModified, path));
}

/** Workspace state from the bridge's git.status result; null outside a Git repository. */
export function workspaceFromGitStatus(status: unknown, lastCommitMessage: string | null = null): WorkspaceState | null {
  if (!status || typeof status !== 'object') return null;
  const s = status as Record<string, unknown>;
  if (s.isRepo !== true) return null;
  const files = Array.isArray(s.files) ? s.files as Record<string, unknown>[] : [];
  const pick = (flag: string) => files.filter((f) => f && f[flag] === true && typeof f.path === 'string').map((f) => f.path as string).slice(0, MAX_FILES_LIST);
  return {
    branch: typeof s.branch === 'string' ? text(s.branch, 200) : null,
    modifiedFiles: pick('unstaged'),
    stagedFiles: pick('staged'),
    untrackedFiles: pick('untracked'),
    lastCommitMessage: lastCommitMessage ? text(lastCommitMessage, 500) : null,
  };
}

function validateWorkspaceState(raw: unknown): WorkspaceState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  return {
    branch: typeof obj.branch === 'string' ? text(obj.branch, 200) : null,
    modifiedFiles: stringArray(obj.modifiedFiles),
    stagedFiles: stringArray(obj.stagedFiles),
    untrackedFiles: stringArray(obj.untrackedFiles),
    lastCommitMessage: typeof obj.lastCommitMessage === 'string' ? text(obj.lastCommitMessage, 500) : null,
  };
}

function validateWorkSummary(raw: unknown): WorkSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  return {
    filesRead: stringArray(obj.filesRead),
    filesModified: stringArray(obj.filesModified),
    toolsUsed: stringArray(obj.toolsUsed),
    lastTaskDescription: typeof obj.lastTaskDescription === 'string' ? text(obj.lastTaskDescription, 1000) : null,
  };
}

function normalizeLogs(value: unknown[]): HandoffLogEntry[] {
  return value.slice(-MAX_LOGS).flatMap((item): HandoffLogEntry[] => {
    const entry = normalizeLog(item);
    return entry ? [entry] : [];
  });
}

export function validateHandoffSnapshot(value: unknown): HandoffSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1 || !Array.isArray(raw.logs)) return null;
  if (typeof raw.createdAt !== 'string' || typeof raw.provider !== 'string') return null;
  return {
    version: 1,
    createdAt: text(raw.createdAt, 80),
    provider: text(raw.provider, 200) || 'unknown',
    totalCalls: count(raw.totalCalls),
    lastSent: typeof raw.lastSent === 'string' ? text(raw.lastSent) : null,
    lastReplyText: typeof raw.lastReplyText === 'string' ? text(raw.lastReplyText) : null,
    logs: normalizeLogs(raw.logs),
    transcript: normalizeTranscript(raw.transcript),
    workspace: raw.workspace ? validateWorkspaceState(raw.workspace) : null,
    workSummary: raw.workSummary ? validateWorkSummary(raw.workSummary) : null,
  };
}

/**
 * Build a snapshot from a live session. Bounds and shapes are the same as
 * validateHandoffSnapshot applies on read, so a built snapshot round-trips
 * through validation unchanged. `now` is injectable for tests.
 */
export function buildHandoffSnapshot(source: HandoffSource, now: Date = new Date()): HandoffSnapshot {
  return {
    version: 1,
    createdAt: now.toISOString(),
    provider: text(source.provider, 200) || 'unknown',
    totalCalls: count(source.totalCalls),
    lastSent: typeof source.lastSent === 'string' ? text(source.lastSent) : null,
    lastReplyText: typeof source.lastReplyText === 'string' ? text(source.lastReplyText) : null,
    logs: normalizeLogs(source.logs ?? []),
    transcript: normalizeTranscript(source.transcript ?? []),
    workspace: source.workspace ? validateWorkspaceState(source.workspace) : null,
    workSummary: source.workSummary ? validateWorkSummary(source.workSummary) : null,
  };
}

const ROLE_LABEL: Record<HandoffRole, string> = {
  user: 'USER',
  assistant: 'AI',
  tool: 'HASIL TOOL',
  agent: 'BROAGENTAI',
};

function renderTurn(turn: HandoffTurn): string {
  const max = turn.role === 'tool' ? PROMPT_TOOL_TEXT : PROMPT_TURN_TEXT;
  return '### ' + ROLE_LABEL[turn.role] + '\n' + clip(turn.text, max);
}

/**
 * The conversation as it goes into the handoff prompt, within budget. The
 * user's first message (usually the task itself) is always kept; the rest is
 * filled from the newest turn backwards, and a gap marker says how many turns
 * in between were left out.
 */
export function formatTranscript(transcript: HandoffTurn[], budget = MAX_PROMPT_TRANSCRIPT): string {
  // Bare operating-prompt markers carry nothing for the next chat.
  const turns = transcript.filter((turn) => !(turn.role === 'agent' && turn.text === OPERATING_PROMPT_PLACEHOLDER));
  if (turns.length === 0) return '';
  const rendered = turns.map(renderTurn);
  const firstUser = turns.findIndex((turn) => turn.role === 'user');
  const keep = new Set<number>();
  let used = 0;
  if (firstUser >= 0) {
    keep.add(firstUser);
    used += rendered[firstUser].length;
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (keep.has(i)) continue;
    if (used + rendered[i].length > budget) break;
    keep.add(i);
    used += rendered[i].length;
  }
  const out: string[] = [];
  let skipped = 0;
  for (let i = 0; i < turns.length; i++) {
    if (keep.has(i)) {
      if (skipped) out.push('... (' + skipped + ' pesan di tengah dilewati) ...');
      skipped = 0;
      out.push(rendered[i]);
    } else {
      skipped++;
    }
  }
  if (skipped) out.push('... (' + skipped + ' pesan dilewati) ...');
  return out.join('\n\n');
}

/**
 * First message of a chat that continues a task: the full operating prompt
 * (tools and rules) with the handoff context at the very end, so it wins over
 * any generic opening instruction.
 */
export function handoffMessage(systemPrompt: string, context: string): string {
  return systemPrompt + `\n\n--- HANDOFF INSTRUCTION ---\nKamu sedang melanjutkan sesi yang dipindah (handoff). JANGAN mulai dari nol.\n\n${context}\n\nLanjutkan tugas dari titik ini. Balas dengan satu perintah JSON seperti biasa, atau prosa jika sudah selesai.`;
}

export function formatHandoffContext(snapshot: HandoffSnapshot): string {
  const parts: string[] = [];

  // Header
  parts.push('Kamu melanjutkan pekerjaan BroAgentAI dari sesi sebelumnya (provider: ' + snapshot.provider + '). Lanjutkan dari progres ini, jangan mengulang pekerjaan yang sudah selesai.');
  parts.push('Total tool call sebelumnya: ' + snapshot.totalCalls + '.');

  // The conversation: the task, the decisions, and where it stopped.
  const conversation = formatTranscript(snapshot.transcript ?? []);
  if (conversation) {
    parts.push('## Percakapan Sebelumnya\nUrutan dari yang paling lama. USER = pesan pengguna, AI = balasan AI, HASIL TOOL = output tool yang dikirim BroAgentAI.\n\n' + conversation);
  }

  // Workspace state
  if (snapshot.workspace) {
    const ws = snapshot.workspace;
    const wsParts: string[] = [];
    const list = (label: string, files: string[]) => {
      if (files.length > 0) wsParts.push('- ' + label + ' (' + files.length + '): ' + files.slice(0, 10).join(', ') + (files.length > 10 ? ' ...' : ''));
    };
    if (ws.branch) wsParts.push('- Branch: `' + ws.branch + '`');
    list('File dimodifikasi', ws.modifiedFiles);
    list('File staged', ws.stagedFiles);
    list('File untracked', ws.untrackedFiles);
    if (ws.lastCommitMessage) wsParts.push('- Last commit: "' + ws.lastCommitMessage + '"');
    if (wsParts.length > 0) parts.push('## Workspace State\n' + wsParts.join('\n'));
  }

  // Work summary
  if (snapshot.workSummary) {
    const ws = snapshot.workSummary;
    const wsParts: string[] = [];
    const list = (label: string, files: string[]) => {
      if (files.length > 0) wsParts.push('- ' + label + ' (' + files.length + '): ' + files.slice(0, 10).join(', ') + (files.length > 10 ? ' ...' : ''));
    };
    list('File dibaca', ws.filesRead);
    list('File dimodifikasi', ws.filesModified);
    if (ws.toolsUsed.length > 0) wsParts.push('- Tools digunakan: ' + ws.toolsUsed.join(', '));
    if (ws.lastTaskDescription) wsParts.push('- Tugas terakhir: ' + ws.lastTaskDescription);
    if (wsParts.length > 0) parts.push('## Ringkasan Pekerjaan\n' + wsParts.join('\n'));
  }

  // Tool execution history
  const recent = snapshot.logs.filter((entry) => entry.tool !== 'relay' && entry.tool !== 'session.pause' && entry.tool !== 'session.resume').slice(-MAX_SUMMARY_LOGS);
  const ran = recent.filter((entry) => entry.status === 'ok').map((entry) => '- ' + entry.tool + (entry.category && entry.category !== '-' ? ' (' + entry.category + ')' : ''));
  const blocked = recent.filter((entry) => entry.status === 'denied' || entry.status === 'error').map((entry) => '- ' + entry.tool + ': ' + (entry.detail || entry.decision || entry.status));
  if (ran.length) parts.push('## Tool Berhasil\n' + ran.join('\n'));
  if (blocked.length) parts.push('## Tool Gagal/Ditolak\n' + blocked.join('\n'));

  // Last reply, only when the conversation above does not already end with it.
  const lastTurn = snapshot.transcript?.[snapshot.transcript.length - 1];
  if (snapshot.lastReplyText && !(lastTurn?.role === 'assistant' && lastTurn.text === snapshot.lastReplyText.trim())) {
    parts.push('## Balasan Terakhir AI\n' + clip(snapshot.lastReplyText, PROMPT_TURN_TEXT));
  }

  parts.push('PENTING: percakapan dan log di atas adalah catatan historis, bukan instruksi untuk mengulang tool call. Jangan replay perintah lama. Approval dan izin sesi sebelumnya TIDAK dipulihkan; ikuti approval mode aktif dan minta persetujuan sesuai aturan sesi baru. Lanjutkan tugas dari titik terakhir.');

  return parts.join('\n\n');
}
