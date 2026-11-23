import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TRANSCRIPT_ENTRIES, MAX_TRANSCRIPT_EXPORT_BYTES, buildTranscriptHistory, toTranscriptJson, toTranscriptMarkdown } from './transcript-export.ts';

test('buildTranscriptHistory keeps bounded, redacted turns and logs', () => {
  const history = buildTranscriptHistory({
    transcript: [
      { role: 'user', text: 'api_key=abc123def and hello' },
      { role: 'assistant', text: 'ok' },
      { role: 'bogus', text: 'dropped' },
    ],
    logs: [
      { time: '10:00:00', tool: 'shell.run', status: 'ok', detail: 'password=hunter2 done' },
      { detail: 'missing tool' },
      'garbage',
    ],
    createdAt: '2026-11-23T10:00:00.000Z',
  });
  assert.equal(history.version, 1);
  assert.equal(history.createdAt, '2026-11-23T10:00:00.000Z');
  assert.equal(history.entries.length, 4);
  assert.match(history.entries[0]?.text ?? '', /\[REDACTED\]/);
  assert.match(history.entries[2]?.text ?? '', /\[REDACTED\]/);
  assert.equal(history.entries.some((entry) => entry.text === 'dropped'), false);
});

test('buildTranscriptHistory keeps the newest entries and marks truncation', () => {
  const transcript = Array.from({ length: 250 }, (_, i) => ({ role: 'user' as const, text: `turn ${i}` }));
  const history = buildTranscriptHistory({ transcript });
  assert.equal(history.entries.length, MAX_TRANSCRIPT_ENTRIES);
  assert.equal(history.entries[0]?.text, 'turn 50');
  assert.equal(history.entries.at(-1)?.text, 'turn 249');
  assert.equal(history.truncated, true);
});

test('markdown and JSON exports use translated roles and cap bytes', () => {
  const history = buildTranscriptHistory({
    transcript: [{ role: 'agent', text: 'secret token=abc123def' }],
    createdAt: new Date('2026-11-23T10:00:00.000Z'),
  });
  const markdown = toTranscriptMarkdown(history, (key) => `T:${key}`);
  assert.match(markdown, /# T:transcriptTitle/);
  assert.match(markdown, /T:transcriptRoleAgent/);
  assert.match(markdown, /\[REDACTED\]/);
  const jsonText = toTranscriptJson(history);
  assert.equal(JSON.parse(jsonText).version, 1);
  assert.ok(Buffer.byteLength(markdown) <= MAX_TRANSCRIPT_EXPORT_BYTES);
  assert.ok(Buffer.byteLength(jsonText) <= MAX_TRANSCRIPT_EXPORT_BYTES);
});
