import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchPatternProblem, toProviderInfo, validatePluginManifest } from './manifest.ts';

const pluginsDir = fileURLToPath(new URL('../../plugins', import.meta.url));

function minimal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: 1,
    id: 'my-chat',
    name: 'My Chat',
    version: '1.0.0',
    homepage: 'https://chat.example.com/',
    matches: ['https://chat.example.com/*'],
    status: 'experimental',
    selectors: { composer: 'textarea', assistantMessage: '.reply' },
    ...overrides,
  };
}

const errorsOf = (raw: unknown) => {
  const result = validatePluginManifest(raw);
  return result.ok ? [] : result.errors;
};

test('every built-in plugin is valid, named after its folder, with its icon present', () => {
  const folders = readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  assert.deepEqual(folders.sort(), ['chatgpt', 'deepseek', 'gemini', 'meta', 'ptero', 'qwen']);
  for (const folder of folders) {
    const raw = JSON.parse(readFileSync(join(pluginsDir, folder, 'plugin.json'), 'utf8'));
    const result = validatePluginManifest(raw);
    assert.ok(result.ok, `${folder}: ${result.ok ? '' : result.errors.join('; ')}`);
    assert.deepEqual(result.warnings, [], `${folder} warnings`);
    assert.equal(result.plugin.id, folder);
    assert.ok(result.plugin.icon && existsSync(join(pluginsDir, folder, result.plugin.icon)), `${folder} icon file`);
    for (const key of ['script', 'style'] as const) {
      const file = result.plugin[key];
      if (file) assert.ok(existsSync(join(pluginsDir, folder, file)), `${folder} ${key} file ${file}`);
    }
  }
});

test('a minimal selector-only plugin is valid', () => {
  const result = validatePluginManifest(minimal());
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, []);
});

test('over-broad or non-https match patterns are refused (R5)', () => {
  for (const pattern of ['<all_urls>', 'https://*/*', '*://*/*', 'https://*.com/*', 'http://chat.example.com/*', 'https://localhost/*', 'https://chat.*.com/*', 'chat.example.com']) {
    assert.ok(matchPatternProblem(pattern), `${pattern} should be refused`);
  }
  for (const pattern of ['https://chat.example.com/*', 'https://*.example.com/*', 'https://ptero.pro/*', 'https://gemini.google.com/app/*']) {
    assert.equal(matchPatternProblem(pattern), null, `${pattern} should be allowed`);
  }
  assert.ok(errorsOf(minimal({ matches: ['https://*/*'] })).length > 0);
  assert.ok(errorsOf(minimal({ matches: [] })).length > 0);
});

test('an unsupported apiVersion asks for a plugin update (R19)', () => {
  const errors = errorsOf(minimal({ apiVersion: 2 }));
  assert.ok(errors.some((e) => /apiVersion 2 is not supported.*needs an update/.test(e)), errors.join('; '));
  assert.ok(errorsOf(minimal({ apiVersion: '1' })).length > 0);
});

test('required fields and selectors are enforced', () => {
  assert.ok(errorsOf(minimal({ id: 'My Chat' })).some((e) => e.startsWith('id ')));
  assert.ok(errorsOf(minimal({ version: '1.0' })).some((e) => e.startsWith('version ')));
  assert.ok(errorsOf(minimal({ status: 'stable' })).some((e) => e.startsWith('status ')));
  assert.ok(errorsOf(minimal({ homepage: 'http://chat.example.com/' })).some((e) => e.startsWith('homepage ')));
  assert.ok(errorsOf(minimal({ selectors: { composer: 'textarea' } })).some((e) => e.includes('selectors.assistantMessage')));
  assert.ok(errorsOf(minimal({ selectors: { composer: 'textarea', assistantMessage: '.r', submit: 42 } })).some((e) => e.includes('selectors.submit')));
  assert.ok(errorsOf(minimal({ script: '../evil.js' })).some((e) => e.startsWith('script ')));
  assert.ok(errorsOf('not an object').length > 0);
  assert.ok(errorsOf(null).length > 0);
});

test('unknown fields and a homepage outside matches only warn', () => {
  const result = validatePluginManifest(minimal({ extra: true, homepage: 'https://other.example.com/', selectors: { composer: 'textarea', assistantMessage: '.r', fancy: 'x' } }));
  assert.ok(result.ok);
  assert.equal(result.warnings.length, 3, result.warnings.join('; '));
});

test('toProviderInfo maps the manifest to the provider the panel uses', () => {
  const result = validatePluginManifest(minimal({ author: 'Someone', description: 'A chat' }));
  assert.ok(result.ok);
  const info = toProviderInfo(result.plugin, { icon: '/assets/icon-abc.png', style: '[data-ba-agent] { color: red }' });
  assert.deepEqual(info, {
    id: 'my-chat',
    label: 'My Chat',
    description: 'A chat',
    homepage: 'https://chat.example.com/',
    matchPatterns: ['https://chat.example.com/*'],
    status: 'experimental',
    selectors: { composer: 'textarea', assistantMessage: '.reply' },
    version: '1.0.0',
    author: 'Someone',
    icon: '/assets/icon-abc.png',
    style: '[data-ba-agent] { color: red }',
  });
});

test('errorReplies: valid patterns pass and reach ProviderInfo', () => {
  const res = validatePluginManifest(minimal({ errorReplies: ['^Something went wrong', 'rate limit'] }));
  assert.equal(res.ok, true);
  if (res.ok) assert.deepEqual(toProviderInfo(res.plugin).errorReplies, ['^Something went wrong', 'rate limit']);
});

const contextFull = { id: 'context-window-full', text: '^Context window full$', button: '^New chat$', action: 'new-chat', reason: 'context window full' };

test('blockingPrompts: a valid rule passes and reaches ProviderInfo', () => {
  const res = validatePluginManifest(minimal({ blockingPrompts: [contextFull] }));
  assert.ok(res.ok, res.ok ? '' : res.errors.join('; '));
  if (res.ok) {
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(toProviderInfo(res.plugin).blockingPrompts, [contextFull]);
  }
  assert.equal('blockingPrompts' in toProviderInfo((validatePluginManifest(minimal()) as { plugin: never }).plugin), false);
});

test('blockingPrompts: billing buttons, bad patterns, unknown actions and duplicates are refused', () => {
  const refused = (rule: Record<string, unknown>) => errorsOf(minimal({ blockingPrompts: [rule] }));
  assert.match(refused({ ...contextFull, button: 'Upgrade to Plus' }).join(), /never pressed/);
  assert.match(refused({ ...contextFull, button: 'plus|chat' }).join(), /never pressed/);
  assert.match(refused({ ...contextFull, text: '(broken' }).join(), /not a valid regular expression/);
  assert.match(refused({ ...contextFull, button: '.*' }).join(), /matches empty text/);
  assert.match(refused({ ...contextFull, action: 'click' }).join(), /action must be one of/);
  assert.match(refused({ ...contextFull, id: 'Bad Id' }).join(), /id must be/);
  assert.match(errorsOf(minimal({ blockingPrompts: [contextFull, contextFull] })).join(), /used twice/);
  assert.match(errorsOf(minimal({ blockingPrompts: 'nope' })).join(), /blockingPrompts must be a list/);
  assert.match(errorsOf(minimal({ blockingPrompts: ['nope'] })).join(), /must be an object/);
  const extra = validatePluginManifest(minimal({ blockingPrompts: [{ ...contextFull, selector: '.x' }] }));
  assert.ok(extra.ok);
  assert.deepEqual(extra.warnings, ['unknown field "blockingPrompts[0].selector" is ignored']);
});

test('errorReplies: bad regex, catch-all pattern, wrong type and too many are refused', () => {
  const errorsOf = (value: unknown) => {
    const res = validatePluginManifest(minimal({ errorReplies: value }));
    return res.ok ? [] : res.errors;
  };
  assert.match(errorsOf(['(unclosed']).join(' '), /not a valid regular expression/);
  assert.match(errorsOf(['.*']).join(' '), /matches an empty reply/);
  assert.match(errorsOf(['']).join(' '), /must be text/);
  assert.match(errorsOf('oops').join(' '), /at most 10 patterns/);
  assert.match(errorsOf(Array.from({ length: 11 }, (_, i) => `err${i}`)).join(' '), /at most 10 patterns/);
});
