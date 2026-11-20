import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph, refChips } from './git-graph.ts';

test('linear history stays in lane 0', () => {
  const rows = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((r) => r.width), [1, 1, 1]);
  // Root commit has no bottom edge.
  assert.equal(rows[2].edges.filter((e) => e.half === 'bottom').length, 0);
});

test('merge opens a second lane that converges back', () => {
  // m merges f (feature) into b (main); both come from a.
  const rows = layoutGraph([
    { hash: 'm', parents: ['b', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0, 0]);
  // Merge row: dot connects down to lane 0 and lane 1.
  const mergeDown = rows[0].edges.filter((e) => e.half === 'bottom').map((e) => [e.from, e.to]);
  assert.deepEqual(mergeDown.sort(), [[0, 0], [0, 1]]);
  // At a, the feature lane (1) converges into lane 0.
  const top = rows[3].edges.filter((e) => e.half === 'top').map((e) => [e.from, e.to]);
  assert.deepEqual(top.sort(), [[0, 0], [1, 0]]);
  assert.equal(rows[3].width, 2);
});

test('unrelated branch tip gets its own lane with a new colour', () => {
  const rows = layoutGraph([
    { hash: 'x', parents: ['a'] },
    { hash: 'y', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.lane), [0, 1, 0]);
  assert.notEqual(rows[0].color, rows[1].color);
});

test('merge into a lane that is already waiting keeps that lane continuous', () => {
  // Lane 1 (f2 -> f1) waits for f1. The merge m on lane 0 also has f1 as its
  // second parent: lane 1 must still run through the merge row down to f1.
  const rows = layoutGraph([
    { hash: 'f2', parents: ['f1'] },
    { hash: 'm', parents: ['b', 'f1'] },
    { hash: 'f1', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  const merge = rows[1];
  const f2Lane = rows[0].lane;
  const bottom = merge.edges.filter((e) => e.half === 'bottom').map((e) => `${e.from}>${e.to}`);
  assert.ok(bottom.includes(`${f2Lane}>${f2Lane}`), `lane ${f2Lane} must pass through: ${bottom}`);
  assert.ok(bottom.includes(`${merge.lane}>${f2Lane}`), `merge must connect to lane ${f2Lane}: ${bottom}`);
});

test('every lane that enters a row from above leaves it or ends at the dot', () => {
  const commits = [
    { hash: 'x', parents: ['m2'] },
    { hash: 'm2', parents: ['m1', 'p'] },
    { hash: 'p', parents: ['q'] },
    { hash: 'm1', parents: ['a', 'q'] },
    { hash: 'q', parents: ['a'] },
    { hash: 'a', parents: [] },
  ];
  const rows = layoutGraph(commits);
  for (let r = 1; r < rows.length; r++) {
    const above = new Set(rows[r - 1].edges.filter((e) => e.half === 'bottom').map((e) => e.to));
    const below = new Set(rows[r].edges.filter((e) => e.half === 'top').map((e) => e.from));
    assert.deepEqual([...below].sort(), [...above].sort(), `row ${r} lanes mismatch`);
  }
});

test('refChips classifies decorations', () => {
  assert.deepEqual(refChips(['HEAD -> main', 'origin/main', 'tag: v1.0', 'dev']), [
    { label: 'main', kind: 'head' },
    { label: 'origin/main', kind: 'remote' },
    { label: 'v1.0', kind: 'tag' },
    { label: 'dev', kind: 'branch' },
  ]);
});
