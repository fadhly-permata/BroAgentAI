import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCorrection, formatToolResult, parseReply } from './agent-parser.ts';

const reply = (text: string, codeBlocks: string[] = []) => ({ text, codeBlocks });

test('command in a DOM code block (fences lost in innerText)', () => {
  const parsed = parseReply(reply('Saya baca dulu.\njson\n{"command":"fs.readFile","params":{"path":"README.md"}}', ['{"command":"fs.readFile","params":{"path":"README.md"}}']));
  assert.deepEqual(parsed, { kind: 'command', command: 'fs.readFile', params: { path: 'README.md' } });
});

test('command in a markdown fence inside plain text', () => {
  const parsed = parseReply(reply('Ok:\n```json\n{ "command": "git.status" }\n```'));
  assert.deepEqual(parsed, { kind: 'command', command: 'git.status', params: {} });
});

test('"tool" + "arguments" aliases and bare JSON are accepted', () => {
  assert.deepEqual(parseReply(reply('{"tool":"fs.listDir","arguments":{"path":"."}}')), { kind: 'command', command: 'fs.listDir', params: { path: '.' } });
});

test('the same command seen in both the code block and the fence counts once', () => {
  const json = '{"command":"fs.stat","params":{"path":"a"}}';
  assert.equal(parseReply(reply('```json\n' + json + '\n```', [json])).kind, 'command');
});

test('plain prose is a final answer; unrelated code blocks do not make it a command', () => {
  assert.deepEqual(parseReply(reply('  Selesai, file sudah diubah.  ')), { kind: 'final', text: 'Selesai, file sudah diubah.' });
  assert.equal(parseReply(reply('Contoh:', ['const x = 1;\nconsole.log(x);'])).kind, 'final');
  assert.equal(parseReply(reply('Config:', ['{"name":"pkg","version":"1.0.0"}'])).kind, 'final');
});

test('multiple commands are rejected', () => {
  const parsed = parseReply(reply('', ['{"command":"fs.readFile","params":{"path":"a"}}', '{"command":"fs.readFile","params":{"path":"b"}}']));
  assert.equal(parsed.kind, 'error');
  assert.match((parsed as any).reason, /exactly ONE/);
});

test('malformed command JSON and wrong shapes produce a correction, not a final answer', () => {
  assert.equal(parseReply(reply('', ['{"command":"fs.readFile","params":{"path":"a"']))?.kind, 'error');
  assert.equal(parseReply(reply('', ['{"command":42}'])).kind, 'error');
  assert.equal(parseReply(reply('', ['{"command":"fs.readFile","params":"README.md"}'])).kind, 'error');
});

test('provider-native tool markup gets a specific correction', () => {
  const parsed = parseReply(reply('<tool_call>{"name":"read"}</tool_call>'));
  assert.equal(parsed.kind, 'error');
  assert.match((parsed as any).reason, /native tool-call markup/);
});

test('feedback messages carry the marker the prompt promises', () => {
  assert.match(formatToolResult('fs.readFile', true, 'content'), /^\[BroAgentAI tool result\] fs\.readFile OK\n\ncontent$/);
  assert.match(formatToolResult('fs.writeFile', false, 'NOT_ALLOWED', true), /ERROR[\s\S]*\[result truncated\]$/);
  assert.match(formatCorrection('bad'), /"command":"fs\.readFile"/);
});
