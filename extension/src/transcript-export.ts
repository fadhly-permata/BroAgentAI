import { normalizeTranscript, type HandoffTurn } from './agent-handoff.ts';
import { redactSecrets } from './agent-parser.ts';

export type TranscriptRole = HandoffTurn['role'] | 'event';

export interface TranscriptEntry {
  role: TranscriptRole;
  text: string;
  time?: string;
  tool?: string;
  status?: string;
}

export interface TranscriptHistory {
  version: 1;
  createdAt: string;
  entries: TranscriptEntry[];
  truncated: boolean;
}

export const MAX_TRANSCRIPT_ENTRIES = 200;
export const MAX_TRANSCRIPT_TEXT = 4_000;
export const MAX_TRANSCRIPT_EXPORT_BYTES = 64 * 1024;

const encoder = new TextEncoder();

function clean(value: unknown, max: number): { text: string; clipped: boolean } {
  const text = redactSecrets(typeof value === 'string' ? value : '').trim();
  return text.length <= max ? { text, clipped: false } : { text: text.slice(0, max), clipped: true };
}

function capBytes(value: string, max: number): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= max) return value;
  const marker = '\n[TRUNCATED]';
  const budget = Math.max(0, max - encoder.encode(marker).length);
  return decoder.decode(bytes.slice(0, budget)) + marker;
}

const decoder = new TextDecoder();

function logEntries(value: unknown): { entries: TranscriptEntry[]; clipped: boolean; count: number } {
  if (!Array.isArray(value)) return { entries: [], clipped: false, count: 0 };
  let clipped = false;
  const entries: TranscriptEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (typeof row.tool !== 'string' && typeof row.detail !== 'string') continue;
    const detail = clean(row.detail, MAX_TRANSCRIPT_TEXT);
    const tool = clean(row.tool, 200);
    clipped = clipped || detail.clipped || tool.clipped;
    entries.push({
      role: 'event',
      text: detail.text,
      ...(typeof row.time === 'string' ? { time: clean(row.time, 80).text } : {}),
      ...(tool.text ? { tool: tool.text } : {}),
      ...(typeof row.status === 'string' ? { status: clean(row.status, 40).text } : {}),
    });
  }
  return { entries, clipped, count: entries.length };
}

export function buildTranscriptHistory(input: {
  transcript?: unknown;
  logs?: unknown;
  createdAt?: string | Date;
}): TranscriptHistory {
  let clipped = false;
  const turns = normalizeTranscript(input.transcript).map((turn) => {
    const body = clean(turn.text, MAX_TRANSCRIPT_TEXT);
    clipped = clipped || body.clipped;
    return { role: turn.role, text: body.text } as TranscriptEntry;
  });
  const logs = logEntries(input.logs);
  clipped = clipped || logs.clipped;
  const all = [...turns, ...logs.entries];
  const overflow = all.length > MAX_TRANSCRIPT_ENTRIES;
  const createdAt = input.createdAt instanceof Date ? input.createdAt.toISOString()
    : typeof input.createdAt === 'string' ? input.createdAt.slice(0, 80) : new Date().toISOString();
  return {
    version: 1,
    createdAt,
    entries: overflow ? all.slice(-MAX_TRANSCRIPT_ENTRIES) : all,
    truncated: clipped || overflow,
  };
}

const ROLE_KEYS: Record<TranscriptRole, string> = {
  user: 'transcriptRoleUser',
  assistant: 'transcriptRoleAssistant',
  tool: 'transcriptRoleTool',
  agent: 'transcriptRoleAgent',
  event: 'transcriptRoleEvent',
};

export function toTranscriptMarkdown(history: TranscriptHistory, translate: (key: string) => string = (key) => key): string {
  const lines = [
    '# ' + translate('transcriptTitle'),
    '',
    translate('transcriptGenerated') + ': ' + history.createdAt,
  ];
  if (history.truncated) lines.push('> ' + translate('transcriptTruncated'));
  for (const entry of history.entries) {
    const role = translate(ROLE_KEYS[entry.role]);
    const prefix = entry.time ? entry.time + ' ' : '';
    const tool = entry.tool ? ' ' + entry.tool + (entry.status ? ' (' + entry.status + ')' : '') : '';
    lines.push('', '## ' + prefix + role + tool, '', entry.text.replace(/```/g, '~~~'));
  }
  return capBytes(lines.join('\n') + '\n', MAX_TRANSCRIPT_EXPORT_BYTES);
}

export function toTranscriptJson(history: TranscriptHistory): string {
  return capBytes(JSON.stringify(history, null, 2), MAX_TRANSCRIPT_EXPORT_BYTES);
}

export function downloadTranscript(content: string, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
