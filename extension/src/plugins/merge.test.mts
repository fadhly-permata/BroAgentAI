import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePlugins, normalizeState, type BuiltInPlugin, type PluginState, type StoredPlugin } from './merge.ts';
import type { PluginManifest } from './manifest.ts';

const m = (id: string, host: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  apiVersion: 1, id, name: id.toUpperCase(), version: '1.0.0', homepage: `https://${host}/`, matches: [`https://${host}/*`],
  status: 'experimental', selectors: { composer: 'textarea', assistantMessage: '.r' }, ...extra,
});
const builtIns: BuiltInPlugin[] = [
  { manifest: m('deepseek', 'chat.deepseek.com'), icon: '/assets/ds.svg' },
  { manifest: m('qwen', 'chat.qwen.ai'), style: '[data-ba-agent]{}' },
];
const stored = (manifest: PluginManifest, extra: Partial<StoredPlugin> = {}): StoredPlugin =>
  ({ manifest, enabled: true, installedAt: 1, updatedAt: 2, ...extra });
const state = (s: Partial<PluginState>): PluginState => ({ version: 1, user: {}, disabledBuiltins: [], ...s });

test('with no user plugins the providers are the built-ins', () => {
  const { providers, entries } = mergePlugins(builtIns, state({}));
  assert.deepEqual(providers.map((p) => p.id), ['deepseek', 'qwen']);
  assert.equal(providers[0].icon, '/assets/ds.svg');
  assert.ok(entries.every((e) => e.source === 'builtin' && e.enabled));
});

test('a user plugin joins, a user override replaces its built-in (R24)', () => {
  const { providers, entries } = mergePlugins(builtIns, state({ user: {
    mychat: stored(m('mychat', 'chat.example.com'), { icon: { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' } }),
    deepseek: stored(m('deepseek', 'chat.deepseek.com', { version: '2.0.0', name: 'DeepSeek (mine)' })),
  } }));
  assert.deepEqual(providers.map((p) => p.id), ['deepseek', 'mychat', 'qwen']);
  assert.equal(providers.find((p) => p.id === 'deepseek')?.version, '2.0.0');
  assert.equal(providers.find((p) => p.id === 'mychat')?.icon, 'data:image/png;base64,AA==');
  const ds = entries.filter((e) => e.id === 'deepseek');
  assert.equal(ds.length, 1);
  assert.ok(ds[0].source === 'user' && ds[0].overridesBuiltin);
});

test('disabled plugins stay listed but are not providers', () => {
  const { providers, entries } = mergePlugins(builtIns, state({
    disabledBuiltins: ['qwen'],
    user: { mychat: stored(m('mychat', 'chat.example.com'), { enabled: false }) },
  }));
  assert.deepEqual(providers.map((p) => p.id), ['deepseek']);
  assert.equal(entries.find((e) => e.id === 'qwen')?.enabled, false);
  assert.equal(entries.find((e) => e.id === 'mychat')?.enabled, false);
});

test('a stored plugin this build cannot run is listed with its problem, never used (R19)', () => {
  const { providers, entries } = mergePlugins(builtIns, state({ user: { old: stored({ ...m('old', 'old.example.com'), apiVersion: 9 }) } }));
  assert.ok(!providers.some((p) => p.id === 'old'));
  assert.match(entries.find((e) => e.id === 'old')?.problem ?? '', /needs an update/);
});

test('normalizeState repairs missing or broken storage', () => {
  assert.deepEqual(normalizeState(undefined), { version: 1, user: {}, disabledBuiltins: [] });
  assert.deepEqual(normalizeState({ user: null, disabledBuiltins: ['a', 3] }), { version: 1, user: {}, disabledBuiltins: ['a'] });
});
