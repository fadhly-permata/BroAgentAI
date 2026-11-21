import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editorKey, editorQuery, targetFromQuery } from './editor-tabs.ts';

test('file query keeps the line, diff query its source', () => {
  assert.equal(editorQuery({ path: 'src/a.ts', line: 12 }), 'path=src%2Fa.ts&line=12');
  assert.equal(editorQuery({ path: 'src/a.ts', mode: 'diff', staged: true }), 'path=src%2Fa.ts&mode=diff&staged=1');
  assert.equal(editorQuery({ path: 'b.ts', mode: 'diff', hash: 'abc123', origPath: 'a.ts' }), 'path=b.ts&mode=diff&hash=abc123&orig=a.ts');
});

test('the editor tab key ignores the line (same file = same tab)', () => {
  assert.equal(editorKey({ path: 'src/a.ts', line: 3 }), editorKey({ path: 'src/a.ts', line: 40 }));
  assert.equal(editorKey({ path: 'src/a.ts' }), editorKey({ path: 'src/a.ts', line: 1 }));
});

test('file, working-tree diff, staged diff and commit diff are different tabs', () => {
  const keys = [
    editorKey({ path: 'a.ts' }),
    editorKey({ path: 'a.ts', mode: 'diff' }),
    editorKey({ path: 'a.ts', mode: 'diff', staged: true }),
    editorKey({ path: 'a.ts', mode: 'diff', hash: '1' }),
    editorKey({ path: 'a.ts', mode: 'diff', hash: '2' }),
    editorKey({ path: 'b.ts' }),
  ];
  assert.equal(new Set(keys).size, keys.length);
});

test('targetFromQuery reads back what editorQuery wrote', () => {
  for (const t of [
    { path: 'src/a.ts' },
    { path: 'src/a.ts', line: 7 },
    { path: 'a b.ts', mode: 'diff' as const, staged: true, hash: undefined, origPath: undefined },
    { path: 'b.ts', mode: 'diff' as const, staged: false, hash: 'abc', origPath: 'a.ts' },
  ]) {
    assert.deepEqual(targetFromQuery(editorQuery(t)), t);
  }
  assert.equal(targetFromQuery('line=3'), null);
});
