import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHandoffSnapshot } from './agent-handoff.ts';
import { SessionResumeService, createSessionId, isValidSessionId, normalizeSessionId, normalizeSessionSummaries } from './session-resume.ts';

function fakeBridge(result: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const rpc = {
    call: async (method: string, params: unknown = {}) => {
      calls.push({ method, params });
      return result[method] ?? null;
    },
  };
  return { calls, rpc: rpc as any };
}

function fakeStore(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get: async (key: string) => ({ [key]: values.get(key) }),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
  };
}

const snapshot = buildHandoffSnapshot({
  provider: 'Claude',
  totalCalls: 3,
  lastSent: 'continue',
  lastReplyText: 'working',
  transcript: [{ role: 'user', text: 'hello' }],
  logs: [{ time: '10:00:00', tool: 'fs.readFile', category: 'read', decision: 'auto', status: 'ok', ms: 2, detail: 'ok' }],
}, new Date('2026-11-23T10:00:00.000Z'));

test('session IDs are bounded and normalized', () => {
  assert.match(createSessionId(), /^[A-Za-z0-9_-]{1,64}$/);
  assert.equal(normalizeSessionId(' task-1 '), 'task-1');
  assert.equal(normalizeSessionId('../etc/passwd'), null);
  assert.equal(normalizeSessionId(''), null);
  assert.equal(isValidSessionId('a'.repeat(64)), true);
  assert.equal(isValidSessionId('a'.repeat(65)), false);
});

test('normalizeSessionSummaries drops bad rows and caps the list', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `s${i}`,
    createdAt: `2026-11-23T10:${String(i).padStart(2, '0')}:00.000Z`,
    provider: 'Claude',
    totalCalls: i,
  }));
  rows.push({ id: 'bad id', createdAt: 'x', provider: 'x', totalCalls: 0 });
  const list = normalizeSessionSummaries(rows);
  assert.equal(list.length, 50);
  assert.equal(list[0]?.id, 's59');
  assert.equal(list.some((item) => item.id === 'bad id'), false);
});

test('SessionResumeService persists, loads, lists and clears validated snapshots', async () => {
  const { calls, rpc } = fakeBridge({
    'session.list': [{ id: 'task-1', createdAt: snapshot.createdAt, provider: snapshot.provider, totalCalls: snapshot.totalCalls }],
    'session.load': snapshot,
    'session.clear': { cleared: true },
  });
  const store = fakeStore();
  const service = new SessionResumeService(rpc, store as any);

  const id = await service.ensureSessionId();
  assert.equal(store.values.get('broagentai.sessionResumeId'), id);
  assert.equal(await service.currentSessionId(), id);
  assert.deepEqual(await service.save(snapshot as any), {
    id,
    createdAt: snapshot.createdAt,
    provider: snapshot.provider,
    totalCalls: snapshot.totalCalls,
  });
  assert.equal(calls.some((call) => call.method === 'session.save'), true);
  assert.deepEqual(await service.load(id), snapshot);
  const list = await service.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, 'task-1');

  assert.equal(await service.useSessionId('task-2'), 'task-2');
  assert.equal(await service.currentSessionId(), 'task-2');
  assert.equal(await service.clear('task-2'), true);
  assert.equal(normalizeSessionId(store.values.get('broagentai.sessionResumeId')), null);
  assert.equal(calls.filter((call) => call.method === 'session.clear').length, 1);
});

test('SessionResumeService rejects malformed bridge data', async () => {
  const { rpc } = fakeBridge({ 'session.load': { version: 9 }, 'session.list': 'bad' });
  const service = new SessionResumeService(rpc, fakeStore() as any);
  assert.equal(await service.load('task-1'), null);
  assert.deepEqual(await service.list(), []);
});
