import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardBlocks, isStale, RELOAD_GUARD_MS } from './stale-manifest.ts';

const base = {
  version: '0.1.0',
  host_permissions: ['https://chatgpt.com/*', 'https://ptero.pro/*'],
  content_scripts: [
    { matches: ['https://chatgpt.com/*', 'https://ptero.pro/*'], js: ['assets/relay-a.js'] },
    { matches: ['https://ptero.pro/*', 'https://chatgpt.com/*'], js: ['src/content/page-source.iife.js'] },
  ],
};

test('same manifest, different order, is not stale', () => {
  const shuffled = {
    ...base,
    host_permissions: [...base.host_permissions].reverse(),
    content_scripts: [...base.content_scripts].reverse(),
  };
  assert.equal(isStale(base, shuffled), false);
});

test('a new chat site on disk makes the loaded manifest stale', () => {
  const disk = {
    ...base,
    host_permissions: [...base.host_permissions, 'https://new.tusksearch.com/*'],
    content_scripts: base.content_scripts.map((cs) => ({ ...cs, matches: [...cs.matches, 'https://new.tusksearch.com/*'] })),
  };
  assert.equal(isStale(base, disk), true);
});

test('a rebuilt relay bundle (new hash) is stale', () => {
  const disk = { ...base, content_scripts: [{ ...base.content_scripts[0], js: ['assets/relay-b.js'] }, base.content_scripts[1]] };
  assert.equal(isStale(base, disk), true);
});

test('reload guard blocks a second reload inside the window only', () => {
  const now = 1_000_000_000;
  assert.equal(guardBlocks(undefined, now), false);
  assert.equal(guardBlocks(now - 1000, now), true);
  assert.equal(guardBlocks(now - RELOAD_GUARD_MS, now), false);
  assert.equal(guardBlocks(now + 5000, now), false); // clock went back: do not block forever
});
