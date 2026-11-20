import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PluginManifest } from './manifest.ts';

// A minimal chrome.storage.local that, like Chrome, hands objects back as copies.
const area: Record<string, unknown> = {};
const listeners: Array<(changes: Record<string, { newValue: unknown }>, area: string) => void> = [];
(globalThis as any).chrome = {
  storage: {
    local: {
      get: async (key: string) => (key in area ? { [key]: structuredClone(area[key]) } : {}),
      set: async (items: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(items)) {
          area[k] = structuredClone(v);
          listeners.forEach((fn) => fn({ [k]: { newValue: structuredClone(v) } }, 'local'));
        }
      },
    },
    onChanged: { addListener: (fn: (typeof listeners)[number]) => listeners.push(fn) },
  },
};
const { installPackage, loadPluginState, removeUserPlugin, setPluginEnabled } = await import('./store.ts');

const m = (version: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  apiVersion: 1, id: 'duck-ai', name: 'Duck.ai', version, homepage: 'https://duck.ai/', matches: ['https://duck.ai/*'],
  status: 'experimental', selectors: { composer: 'textarea', assistantMessage: '.r' }, ...extra,
});

beforeEach(() => { for (const k of Object.keys(area)) delete area[k]; });

test('importing a newer version of an installed plugin updates it in place', async () => {
  await installPackage({ manifest: m('0.1.0'), style: 'a {}' });
  const first = (await loadPluginState()).user['duck-ai'];
  await new Promise((r) => setTimeout(r, 5));
  await installPackage({ manifest: m('0.2.0'), style: 'b {}' });
  const state = await loadPluginState();
  assert.deepEqual(Object.keys(state.user), ['duck-ai']);
  const updated = state.user['duck-ai'];
  assert.equal(updated.manifest.version, '0.2.0');
  assert.equal(updated.style, 'b {}');
  assert.equal(updated.enabled, true);
  assert.equal(updated.installedAt, first.installedAt, 'install time is kept');
  assert.ok(updated.updatedAt > first.updatedAt, 'update time moves');
});

test('installing with domain conflicts turns the other plugins off (R2)', async () => {
  await installPackage({ manifest: m('1.0.0', { id: 'other', matches: ['https://duck.ai/chat/*'] }) });
  await installPackage({ manifest: m('1.0.0') }, [{ id: 'other', source: 'user' }, { id: 'deepseek', source: 'builtin' }]);
  const state = await loadPluginState();
  assert.equal(state.user.other.enabled, false);
  assert.equal(state.user['duck-ai'].enabled, true);
  assert.deepEqual(state.disabledBuiltins, ['deepseek']);
});

test('toggling and removing', async () => {
  await installPackage({ manifest: m('1.0.0') });
  await setPluginEnabled({ id: 'duck-ai', source: 'user' }, false);
  assert.equal((await loadPluginState()).user['duck-ai'].enabled, false);
  await setPluginEnabled({ id: 'gemini', source: 'builtin' }, false);
  await setPluginEnabled({ id: 'gemini', source: 'builtin' }, false);
  assert.deepEqual((await loadPluginState()).disabledBuiltins, ['gemini'], 'no duplicates');
  await setPluginEnabled({ id: 'gemini', source: 'builtin' }, true);
  assert.deepEqual((await loadPluginState()).disabledBuiltins, []);
  await removeUserPlugin('duck-ai');
  assert.deepEqual((await loadPluginState()).user, {});
});
