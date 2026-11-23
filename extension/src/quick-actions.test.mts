import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_QUICK_PROMPT_CHARS, QUICK_ACTIONS, buildQuickActionPrompt, isQuickActionId } from './quick-actions.ts';

test('quick actions have unique ids and translation keys', () => {
  const ids = QUICK_ACTIONS.map((action) => action.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const action of QUICK_ACTIONS) {
    assert.match(action.labelKey, /^quickAction/);
    assert.match(action.promptKey, /Prompt$/);
    assert.equal(isQuickActionId(action.id), true);
  }
  assert.equal(isQuickActionId('deleteEverything'), false);
});

test('quick action prompts are bounded, localized and redacted', () => {
  const dictionary: Record<string, string> = {
    quickActionInstruction: 'INSTRUCTION',
    quickActionRunTestsPrompt: 'RUN TESTS',
    quickActionWorkspace: 'PROVIDER {0}',
  };
  const prompt = buildQuickActionPrompt('runTests', (key) => dictionary[key] ?? key, 'token=abc123def');
  assert.ok(prompt);
  assert.match(prompt, /INSTRUCTION/);
  assert.match(prompt, /RUN TESTS/);
  assert.match(prompt, /PROVIDER token=\[REDACTED\]/);
  assert.match(prompt, /shell\.run/);
  assert.ok(prompt.length <= MAX_QUICK_PROMPT_CHARS);
  assert.equal(buildQuickActionPrompt('bogus' as any), null);
});

test('oversized quick action prompts are clipped', () => {
  const prompt = buildQuickActionPrompt('explainDiff', () => 'x'.repeat(5000), 'y'.repeat(5000));
  assert.ok(prompt);
  assert.equal(prompt.length, MAX_QUICK_PROMPT_CHARS);
});
