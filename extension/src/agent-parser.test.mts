import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentMessageKind, formatCorrection, formatToolResult, parseReply } from './agent-parser.ts';

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

test('agent-typed messages are recognized from the text the agent sends', () => {
  assert.deepEqual(agentMessageKind(formatToolResult('fs.readFile', true, 'x')), { kind: 'result', command: 'fs.readFile', ok: true });
  assert.deepEqual(agentMessageKind(formatToolResult('git.push', false, 'NOT_ALLOWED')), { kind: 'result', command: 'git.push', ok: false });
  assert.deepEqual(agentMessageKind(formatCorrection('bad')), { kind: 'note' });
  assert.deepEqual(agentMessageKind('# BroAgentAI operating instructions\n\nYou are...'), { kind: 'prompt' });
  // A chat page may render the prompt's markdown heading without the "#".
  assert.deepEqual(agentMessageKind('  BroAgentAI operating instructions'), { kind: 'prompt' });
});

test("the user's own messages are not taken for agent messages", () => {
  assert.equal(agentMessageKind('tolong baca README'), null);
  assert.equal(agentMessageKind('what does [BroAgentAI tool result] mean?'), null);
  assert.equal(agentMessageKind('[BroAgentAI tool result] tanpa status'), null);
  assert.equal(agentMessageKind('[BroAgentAI]'), null);
});

test('a command on its own lines without a fence is read (Gemini placeholder instead of ```)', () => {
  // innerText of a live Gemini reply: no code block rendered, a placeholder line where the fence was.
  const text = 'Bash is a shell.\n\n[KONTAINER_KODE]json\n{"command":"fs.readFile","params":{"path":"README.md"}}\n[KONTAINER_KODE]';
  assert.deepEqual(parseReply({ text, codeBlocks: [] }), { kind: 'command', command: 'fs.readFile', params: { path: 'README.md' } });
});

test('a multi-line bare command is read; inline braces in prose are not', () => {
  const text = 'Writing it now.\n{\n  "command": "fs.writeFile",\n  "params": {"path": "a.txt", "content": "x {y} z"}\n}';
  assert.deepEqual(parseReply({ text, codeBlocks: [] }), { kind: 'command', command: 'fs.writeFile', params: { path: 'a.txt', content: 'x {y} z' } });
  assert.equal(parseReply({ text: 'Use an object like {"a": 1} inline.', codeBlocks: [] }).kind, 'final');
});

test('two bare commands are refused like two fenced ones', () => {
  const text = '{"command":"fs.readFile","params":{"path":"a"}}\n{"command":"fs.readFile","params":{"path":"b"}}';
  assert.equal(parseReply({ text, codeBlocks: [] }).kind, 'error');
});
