import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A tiny document: attributes on <html>, events, and a <select> for setSelect.
class FakeElement extends EventTarget {
  attrs = new Map<string, string>();
  tagName = 'HTML';
  getAttribute(name: string) { return this.attrs.has(name) ? this.attrs.get(name)! : null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  removeAttribute(name: string) { this.attrs.delete(name); }
}
class FakeSelect extends FakeElement {
  tagName = 'SELECT';
  value = 'smart';
  options = [{ value: 'smart' }, { value: 'quick' }];
  changes = 0;
  constructor() { super(); this.addEventListener('change', () => { this.changes++; }); }
}
class FakeDocument extends EventTarget {
  documentElement = new FakeElement();
  select = new FakeSelect();
  querySelector(sel: string) { return sel === '#mode' ? this.select : null; }
  querySelectorAll(sel: string) { return sel === '#mode' ? [this.select] : []; }
}
let doc: FakeDocument;
beforeEach(() => { doc = new FakeDocument(); (globalThis as any).document = doc; delete (globalThis as any).BroAgentAI; });

const { userWorldPrelude, userWorldReady, callUserHook, READY_ATTR } = await import('./user-world.ts');
/** Run the three sources the way chrome.userScripts runs them in the plugin world. */
function loadPlugin(id: string, pluginJs: string) {
  new Function(userWorldPrelude(id))();
  try { new Function(pluginJs)(); } catch { /* a broken plugin.js must not stop the ready marker */ }
  new Function(userWorldReady(id))();
}

test('a plugin prepare hook runs through the DOM bridge and can drive the page', async () => {
  loadPlugin('my-chat', `BroAgentAI.registerPlugin('my-chat', { async prepare(api) { api.setSelect('#mode', 'quick'); await api.sleep(5); } });`);
  assert.equal(doc.documentElement.getAttribute(READY_ATTR), 'my-chat');
  const result = await callUserHook('my-chat', 'prepare', 1000);
  assert.deepEqual(result, { ran: true, error: undefined });
  assert.equal(doc.select.value, 'quick');
  assert.equal(doc.select.changes, 1);
  // The bridge leaves no call or result attributes behind.
  assert.deepEqual([...doc.documentElement.attrs.keys()], [READY_ATTR]);
});

test('a throwing hook reports its error; a hanging hook times out (R21)', async () => {
  loadPlugin('boom', `BroAgentAI.registerPlugin('boom', { prepare() { throw new Error('nope'); } });`);
  assert.deepEqual(await callUserHook('boom', 'prepare', 1000), { ran: true, error: 'nope' });
  doc = new FakeDocument(); (globalThis as any).document = doc;
  loadPlugin('hang', `BroAgentAI.registerPlugin('hang', { prepare: () => new Promise(() => {}) });`);
  const hung = await callUserHook('hang', 'prepare', 30);
  assert.match(hung.error ?? '', /timed out after 30 ms/);
});

test('a plugin cannot register hooks under another id, and an unknown hook is ignored', async () => {
  loadPlugin('mine', `BroAgentAI.registerPlugin('someone-else', { prepare() { document.documentElement.setAttribute('x', '1'); } }); BroAgentAI.registerPlugin('mine', { fancy() {} });`);
  assert.deepEqual(await callUserHook('mine', 'prepare', 500), { ran: false, error: undefined });
  assert.equal(doc.documentElement.getAttribute('x'), null);
});

test('without the plugin world loaded the relay is told so at once', async () => {
  const result = await callUserHook('absent', 'prepare', 5000);
  assert.equal(result.ran, false);
  assert.match(result.error ?? '', /Allow User Scripts/);
});

test('a plugin.js with a syntax error still lets the page load; its hooks are just missing', async () => {
  loadPlugin('broken', `BroAgentAI.registerPlugin('broken', { prepare() { ) } });`);
  assert.deepEqual(await callUserHook('broken', 'prepare', 500), { ran: false, error: undefined });
});
