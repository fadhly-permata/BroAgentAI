import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OPERATING_PROMPT_PLACEHOLDER, buildHandoffSnapshot, classifyChatMessage, emptyWorkSummary, formatHandoffContext, formatTranscript, noteToolCall, validateHandoffSnapshot, workspaceFromGitStatus } from './agent-handoff.ts';
import { PROMPT_HEADING, formatCorrection, formatToolResult } from './agent-parser.ts';

const now = new Date('2026-01-02T03:04:05.000Z');

function entry(over: Record<string, unknown> = {}) {
  return { time: '10:00:00', tool: 'fs.readFile', category: 'read', decision: 'auto', status: 'ok', ms: 5, ...over };
}

test('buildHandoffSnapshot produces a snapshot that round-trips through validation', () => {
  const snap = buildHandoffSnapshot({
    provider: 'Claude',
    totalCalls: 7,
    lastSent: 'hi',
    lastReplyText: 'working',
    logs: [entry()],
  }, now);
  assert.equal(snap.version, 1);
  assert.equal(snap.createdAt, now.toISOString());
  assert.deepEqual(validateHandoffSnapshot(snap), snap);
});

test('buildHandoffSnapshot bounds logs and rejects unusable rows', () => {
  const many = Array.from({ length: 150 }, () => entry());
  const snap = buildHandoffSnapshot({ provider: 'X', totalCalls: 0, lastSent: null, lastReplyText: null, logs: many }, now);
  assert.equal(snap.logs.length, 100, 'capped at MAX_LOGS');

  const dirty = buildHandoffSnapshot({ provider: 'X', totalCalls: 0, lastSent: null, lastReplyText: null, logs: [entry({ status: 'weird' }), entry()] as any }, now);
  assert.equal(dirty.logs.length, 1, 'bad status rows dropped');
});

test('buildHandoffSnapshot normalizes counts and text bounds', () => {
  const snap = buildHandoffSnapshot({ provider: '', totalCalls: -3.7, lastSent: 5 as any, lastReplyText: 'a'.repeat(20_000), logs: [] }, now);
  assert.equal(snap.provider, 'unknown');
  assert.equal(snap.totalCalls, 0);
  assert.equal(snap.lastSent, null);
  assert.equal(snap.lastReplyText?.length, 12_000);
});

test('validateHandoffSnapshot rejects wrong shape and version', () => {
  assert.equal(validateHandoffSnapshot(null), null);
  assert.equal(validateHandoffSnapshot({}), null);
  assert.equal(validateHandoffSnapshot({ version: 2, createdAt: 'x', provider: 'y', logs: [] }), null);
  assert.equal(validateHandoffSnapshot({ version: 1, createdAt: 'x', provider: 'y', logs: 'no' }), null);
});

test('formatHandoffContext summarizes ran/blocked tools and warns against replay', () => {
  const snap = buildHandoffSnapshot({
    provider: 'Gemini',
    totalCalls: 3,
    lastSent: null,
    lastReplyText: 'halfway done',
    logs: [
      entry({ tool: 'fs.readFile', status: 'ok' }),
      entry({ tool: 'git.push', category: 'sync', status: 'denied', detail: 'user said no' }),
      entry({ tool: 'relay', status: 'info' }),
      entry({ tool: 'session.pause', status: 'info' }),
    ],
  }, now);
  const text = formatHandoffContext(snap);
  assert.match(text, /Gemini/);
  assert.match(text, /Total tool call sebelumnya: 3/);
  assert.match(text, /- fs\.readFile/);
  assert.match(text, /- git\.push: user said no/);
  assert.doesNotMatch(text, /- relay/);
  assert.doesNotMatch(text, /- session\.pause/);
  assert.match(text, /## Balasan Terakhir AI\nhalfway done/);
  assert.match(text, /bukan instruksi untuk mengulang/);
});

test('validateHandoffSnapshot reads a snapshot saved before transcripts existed', () => {
  const old = { version: 1, createdAt: 'x', provider: 'ChatGPT', totalCalls: 2, lastSent: null, lastReplyText: null, logs: [] };
  assert.deepEqual(validateHandoffSnapshot(old)?.transcript, []);
});

test('classifyChatMessage tells the user apart from messages BroAgentAI typed', () => {
  assert.deepEqual(classifyChatMessage('user', '  buat fitur export CSV '), { role: 'user', text: 'buat fitur export CSV' });
  assert.deepEqual(classifyChatMessage('assistant', 'siap'), { role: 'assistant', text: 'siap' });
  assert.deepEqual(classifyChatMessage('user', '# ' + PROMPT_HEADING + '\n\nlong rules...'), { role: 'agent', text: OPERATING_PROMPT_PLACEHOLDER });
  assert.equal(classifyChatMessage('user', formatToolResult('fs.readFile', true, 'isi file'))?.role, 'tool');
  assert.equal(classifyChatMessage('user', formatCorrection('no JSON'))?.role, 'agent');
  assert.equal(classifyChatMessage('user', '   '), null);
});

test('buildHandoffSnapshot keeps the transcript, drops junk, round-trips', () => {
  const snap = buildHandoffSnapshot({
    provider: 'ChatGPT', totalCalls: 1, lastSent: null, lastReplyText: null, logs: [],
    transcript: [
      { role: 'user', text: 'refactor modul auth' },
      { role: 'weird' as any, text: 'x' },
      { role: 'assistant', text: '' },
      { role: 'tool', text: 'y'.repeat(10_000) },
    ],
  }, now);
  assert.equal(snap.transcript.length, 2);
  assert.ok(snap.transcript[1].text.length <= 4_000, 'tool output capped');
  assert.deepEqual(validateHandoffSnapshot(JSON.parse(JSON.stringify(snap))), snap);
});

test('formatHandoffContext carries the conversation, not just the log', () => {
  const snap = buildHandoffSnapshot({
    provider: 'ChatGPT', totalCalls: 1, lastSent: null, lastReplyText: 'Sudah kubaca, lanjut edit login.ts',
    logs: [entry()],
    transcript: [
      { role: 'agent', text: OPERATING_PROMPT_PLACEHOLDER },
      { role: 'user', text: 'Tolong pindahkan validasi password ke login.ts' },
      { role: 'assistant', text: '{"command":"fs.readFile","params":{"path":"login.ts"}}' },
      { role: 'tool', text: formatToolResult('fs.readFile', true, 'export function login() {}') },
      { role: 'assistant', text: 'Sudah kubaca, lanjut edit login.ts' },
    ],
  }, now);
  const text = formatHandoffContext(snap);
  assert.match(text, /## Percakapan Sebelumnya/);
  assert.match(text, /### USER\nTolong pindahkan validasi password ke login\.ts/);
  assert.match(text, /### HASIL TOOL\n\[BroAgentAI tool result\] fs\.readFile OK/);
  assert.doesNotMatch(text, /instruksi operasi BroAgentAI dikirim/, 'bare prompt marker is noise');
  assert.doesNotMatch(text, /## Balasan Terakhir AI/, 'already the last turn of the conversation');
});

test('formatTranscript keeps the first user message and the newest turns within budget', () => {
  const turns = [
    { role: 'user' as const, text: 'TUGAS UTAMA: migrasi ke API v2' },
    ...Array.from({ length: 50 }, (_, i) => ({ role: 'assistant' as const, text: 'langkah ' + i + ' ' + 'z'.repeat(200) })),
  ];
  const out = formatTranscript(turns, 2_000);
  assert.ok(out.length < 2_600);
  assert.match(out, /TUGAS UTAMA/);
  assert.match(out, /langkah 49 /);
  assert.doesNotMatch(out, /langkah 0 /);
  assert.match(out, /pesan di tengah dilewati/);
});

test('noteToolCall tracks tools and files read / changed, without duplicates', () => {
  const work = emptyWorkSummary();
  noteToolCall(work, 'fs.listTree', 'read', { path: '.' });
  noteToolCall(work, 'fs.readFile', 'read', { path: 'src/a.ts' });
  noteToolCall(work, 'fs.readFile', 'read', { path: 'src/a.ts' });
  noteToolCall(work, 'fs.writeFile', 'write', { path: 'src/a.ts', content: 'x' });
  noteToolCall(work, 'fs.rename', 'write', { from: 'old.ts', to: 'new.ts' });
  noteToolCall(work, 'git.stage', 'write', { paths: ['src/a.ts', 'b.ts'] });
  assert.deepEqual(work.toolsUsed, ['fs.listTree', 'fs.readFile', 'fs.writeFile', 'fs.rename', 'git.stage']);
  assert.deepEqual(work.filesRead, ['src/a.ts']);
  assert.deepEqual(work.filesModified, ['old.ts', 'new.ts', 'src/a.ts', 'b.ts']);
});

test('workspaceFromGitStatus maps git.status, null outside a repository', () => {
  assert.equal(workspaceFromGitStatus({ isRepo: false, files: [] }), null);
  assert.equal(workspaceFromGitStatus(null), null);
  const ws = workspaceFromGitStatus({
    isRepo: true, branch: 'feat/x',
    files: [
      { path: 'a.ts', staged: true, unstaged: true, untracked: false },
      { path: 'b.ts', staged: false, unstaged: true, untracked: false },
      { path: 'new.md', staged: false, unstaged: false, untracked: true },
    ],
  });
  assert.deepEqual(ws, { branch: 'feat/x', modifiedFiles: ['a.ts', 'b.ts'], stagedFiles: ['a.ts'], untrackedFiles: ['new.md'], lastCommitMessage: null });
});
