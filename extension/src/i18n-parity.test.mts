import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const en = JSON.parse(readFileSync(new URL('./i18n/en.json', import.meta.url), 'utf8'));
const id = JSON.parse(readFileSync(new URL('./i18n/id.json', import.meta.url), 'utf8'));
const html = readFileSync(new URL('./sidepanel.html', import.meta.url), 'utf8');

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
}

test('English and Indonesian locale files have the same non-empty keys', () => {
  const enKeys = Object.keys(en).sort();
  const idKeys = Object.keys(id).sort();
  assert.deepEqual(idKeys, enKeys);
  for (const key of enKeys) {
    assert.equal(typeof en[key], 'string', `en:${key}`);
    assert.equal(typeof id[key], 'string', `id:${key}`);
    assert.ok(en[key].trim().length > 0, `en:${key} empty`);
    assert.ok(id[key].trim().length > 0, `id:${key} empty`);
  }
});

test('locale values preserve the same placeholders', () => {
  for (const key of Object.keys(en)) {
    assert.deepEqual(placeholders(id[key]), placeholders(en[key]), `key ${key}`);
  }
});

test('sidepanel data-i18n keys exist in both locales', () => {
  const keys = [...html.matchAll(/data-i18n(?:-placeholder|-title)?="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) {
    assert.equal(typeof en[key], 'string', `en:${key}`);
    assert.equal(typeof id[key], 'string', `id:${key}`);
  }
});
