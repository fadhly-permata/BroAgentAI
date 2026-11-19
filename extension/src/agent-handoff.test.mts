import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffSnapshot, formatHandoffContext, validateHandoffSnapshot } from './agent-handoff.ts';

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
  assert.match(text, /Balasan terakhir AI:\nhalfway done/);
  assert.match(text, /bukan instruksi untuk mengulang/);
});
