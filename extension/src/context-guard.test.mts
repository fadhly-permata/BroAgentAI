import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldBlockContextMenu } from './context-guard.ts';

/** Minimal element stand-in: `closest` matches when the selector names one of its traits. */
function el(...traits: string[]) {
  return {
    closest(selector: string) {
      return selector.split(',').some((part) => traits.some((trait) => part.trim().startsWith(trait))) ? this : null;
    },
  };
}

test('blocks the native menu on plain elements', () => {
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: el('div') }), true);
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: el('button') }), true);
});

test('leaves events a custom menu already handled', () => {
  assert.equal(shouldBlockContextMenu({ defaultPrevented: true, target: el('div') }), false);
});

test('keeps the native edit menu on editable fields', () => {
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: el('input:not') }), false);
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: el('textarea') }), false);
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: el('[contenteditable]') }), false);
});

test('keeps the native menu inside an explicit opt-in area', () => {
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: el('[data-context-menu="native"]') }), false);
});

test('blocks when the target is not an element (document, text node)', () => {
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: null }), true);
  assert.equal(shouldBlockContextMenu({ defaultPrevented: false, target: { nodeType: 3 } }), true);
});
