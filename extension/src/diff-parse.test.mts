import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiff, pairLines } from './diff-parse.ts';

const SAMPLE = [
  'diff --git a/a.txt b/a.txt',
  'index 111..222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,4 +1,4 @@ fn',
  ' one',
  '-two',
  '-three',
  '+TWO',
  ' four',
  '@@ -10 +10,2 @@',
  '-x',
  '\\ No newline at end of file',
  '+y',
  '+z',
  '',
].join('\n');

test('parses hunks with line numbers', () => {
  const d = parseDiff(SAMPLE);
  assert.equal(d.hunks.length, 2);
  assert.equal(d.oldPath, 'a.txt');
  assert.equal(d.newPath, 'a.txt');
  assert.equal(d.added, 3);
  assert.equal(d.removed, 3);
  const [a, b] = d.hunks;
  assert.deepEqual(a.lines.map((l) => [l.kind, l.oldNo, l.newNo]), [
    ['context', 1, 1], ['del', 2, null], ['del', 3, null], ['add', null, 2], ['context', 4, 3],
  ]);
  assert.equal(b.oldStart, 10);
  assert.equal(b.lines[0].kind, 'del');
  assert.equal(b.lines[1].kind, 'noeol');
  assert.equal(b.lines[3].newNo, 11);
});

test('binary and rename headers', () => {
  const d = parseDiff('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n');
  assert.equal(d.binary, true);
  assert.equal(d.hunks.length, 0);
  const r = parseDiff('diff --git a/a b/b\nsimilarity index 100%\nrename from a\nrename to b\n');
  assert.equal(r.renameFrom, 'a');
  assert.equal(r.renameTo, 'b');
});

test('empty diff', () => {
  const d = parseDiff('');
  assert.equal(d.hunks.length, 0);
  assert.equal(d.binary, false);
});

test('pairs deletions with additions', () => {
  const rows = pairLines(parseDiff(SAMPLE).hunks[0].lines);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].left?.text, 'two');
  assert.equal(rows[1].right?.text, 'TWO');
  assert.equal(rows[2].left?.text, 'three');
  assert.equal(rows[2].right, null);
  assert.equal(rows[0].left, rows[0].right);
});
