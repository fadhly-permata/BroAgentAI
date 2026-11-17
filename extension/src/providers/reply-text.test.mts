import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutText, fencedBlocks, joinLines, spliceCode } from './reply-text.ts';
import { parseReply } from '../agent-parser.ts';

test('fenced blocks are read from markdown, language tag dropped', () => {
  // Markdown as Qwen holds it in its React props.
  const md = 'Here is your requested code block.\n\n```bash\necho hello\n```';
  assert.deepEqual(fencedBlocks(md), ['echo hello']);
});

test('a longer fence is not closed by a shorter one inside it', () => {
  const md = '````json\n{"command":"fs.writeFile","params":{"path":"a.md","content":"```\\nx\\n```"}}\n```\nstill inside\n````\nafter';
  assert.deepEqual(fencedBlocks(md), ['{"command":"fs.writeFile","params":{"path":"a.md","content":"```\\nx\\n```"}}\n```\nstill inside']);
});

test('an unclosed fence runs to the end; inline ``` is not a fence', () => {
  assert.deepEqual(fencedBlocks('use ```x``` inline\n~~~\na\nb'), ['a\nb']);
});

test('a markdown source reply parses into one command', () => {
  const md = 'I will read the README.\n\n```json\n{"command": "fs.readFile", "params": {"path": "README.md"}}\n```';
  assert.deepEqual(parseReply({ text: md, codeBlocks: fencedBlocks(md) }), {
    kind: 'command', command: 'fs.readFile', params: { path: 'README.md' },
  });
});

test('editor lines are joined top to bottom, whatever their DOM order', () => {
  const code = joinLines([
    { top: '40px', text: '}' },
    { top: '0px', text: '{' },
    { top: '20px', text: '  "command": "fs.readFile"' },
  ]);
  assert.equal(code, '{\n  "command": "fs.readFile"\n}');
});

test('lines without a usable top keep DOM order', () => {
  assert.equal(joinLines([{ top: '', text: 'a' }, { top: '', text: 'b' }]), 'a\nb');
});

test('a Monaco block (label + gutter) becomes a fenced block a command can be parsed from', () => {
  // innerText of a Qwen reply as seen on chat.qwen.ai: label "json", gutter numbers, then the lines.
  const rendered = 'json\n1\n2\n3\n{\n"command": "fs.readFile",\n"params": {"path": "README.md"}}';
  const text = 'I will read the README.\n' + rendered + '\nDone.';
  const code = '{\n  "command": "fs.readFile",\n  "params": {"path": "README.md"}}';

  const spliced = spliceCode(text, [{ rendered, code }]);
  assert.equal(spliced, 'I will read the README.\n```\n' + code + '\n```\nDone.');
  assert.deepEqual(parseReply({ text: spliced, codeBlocks: [code] }), {
    kind: 'command', command: 'fs.readFile', params: { path: 'README.md' },
  });
});

test('blocks are spliced in order and a missing one is skipped', () => {
  const text = 'A\nx1\nB\ny1\nC';
  assert.equal(
    spliceCode(text, [{ rendered: 'x1', code: 'x' }, { rendered: 'zz', code: 'z' }, { rendered: 'y1', code: 'y' }]),
    'A\n```\nx\n```\nB\n```\ny\n```\nC',
  );
});

test('page chrome is cut from a Gemini reply, whole lines only', () => {
  // innerText of a Gemini reply as seen on gemini.google.com: code block label, then suggestion chips.
  const text = 'Here is a Bash script.\n\nBash\necho hello\n\nTo explore further:\nRun a Python script instead';
  assert.equal(
    cutText(text, ['Bash', 'To explore further:\nRun a Python script instead']),
    'Here is a Bash script.\n\necho hello',
  );
});

test('a chrome part that is not on its own lines is left alone', () => {
  assert.equal(cutText('use Bash here', ['Bash']), 'use Bash here');
});
