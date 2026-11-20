import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hooksFor, registerPlugin, runPrepare, type HookApi } from './hooks.ts';

function fakeApi(): HookApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    $: () => null,
    $$: () => [],
    click: (selector, options) => { calls.push(`click ${selector} ${options?.text ?? ''}`); return true; },
    setSelect: (selector, value) => { calls.push(`select ${selector}=${value}`); return true; },
    sleep: async () => { calls.push('sleep'); },
  };
}

test('registerPlugin keeps known hooks and ignores unknown ones', () => {
  registerPlugin('t-known', { prepare() {}, fancyHook() {} });
  const hooks = hooksFor('t-known');
  assert.equal(typeof hooks?.prepare, 'function');
  assert.equal((hooks as Record<string, unknown>).fancyHook, undefined);
});

test('registerPlugin rejects a missing id, non-object hooks and non-function hooks', () => {
  assert.throws(() => registerPlugin('', {}), /id must be/);
  assert.throws(() => registerPlugin(undefined, {}), /id must be/);
  assert.throws(() => registerPlugin('t-bad', null), /hooks must be an object/);
  assert.throws(() => registerPlugin('t-bad', { prepare: 'yes' }), /must be a function/);
});

test('runPrepare without a hook does nothing', async () => {
  assert.deepEqual(await runPrepare('t-none', fakeApi()), { ran: false });
});

test('runPrepare reports a throwing hook instead of failing (R21)', async () => {
  registerPlugin('t-throw', { prepare() { throw new Error('boom'); } });
  assert.deepEqual(await runPrepare('t-throw', fakeApi()), { ran: true, error: 'boom' });
});

test('runPrepare gives up on a hook that never finishes (R21)', async () => {
  registerPlugin('t-hang', { prepare: () => new Promise(() => {}) });
  const result = await runPrepare('t-hang', fakeApi(), 30);
  assert.equal(result.ran, true);
  assert.match(result.error ?? '', /timed out after 30 ms/);
});

test('the built-in Ptero plugin closes the welcome dialog and selects Quick Answer', async () => {
  // Evaluate plugin.js the way the relay does: with a global BroAgentAI.registerPlugin.
  (globalThis as Record<string, unknown>).BroAgentAI = { registerPlugin };
  const source = readFileSync(fileURLToPath(new URL('../../plugins/ptero/plugin.js', import.meta.url)), 'utf8');
  new Function(source)();
  const api = fakeApi();
  assert.deepEqual(await runPrepare('ptero', api), { ran: true });
  assert.deepEqual(api.calls, ['click button /Everything fine/i', 'select #chat-mode-select=quick', 'sleep']);
});

test('the built-in TuskSearch plugin selects Central AI, and leaves an active Central AI alone', async () => {
  (globalThis as Record<string, unknown>).BroAgentAI = { registerPlugin };
  const source = readFileSync(fileURLToPath(new URL('../../plugins/tusksearch/plugin.js', import.meta.url)), 'utf8');
  new Function(source)();

  // Search mode active: the inactive Central AI button is clicked, then the page gets a moment.
  const searchMode = fakeApi();
  assert.deepEqual(await runPrepare('tusksearch', searchMode), { ran: true });
  assert.deepEqual(searchMode.calls, ['click .search-mode-button:not(.active) /Central AI/i', 'sleep']);

  // Central AI already active: nothing matches the click, so no wait either.
  const chatMode = { ...fakeApi(), calls: [] as string[] };
  chatMode.click = (selector, options) => { chatMode.calls.push(`click ${selector} ${options?.text ?? ''}`); return false; };
  chatMode.sleep = async () => { chatMode.calls.push('sleep'); };
  assert.deepEqual(await runPrepare('tusksearch', chatMode), { ran: true });
  assert.deepEqual(chatMode.calls, ['click .search-mode-button:not(.active) /Central AI/i']);
});
