import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTRY_STUB = 'data:text/javascript,export const providers=[];export function providerForUrl(){return null;}export function refreshProviders(){return Promise.resolve([]);}export function watchProviders(){}export const builtInPlugins=[];export const pluginEntries=[];export function matchPatternToRegExp(){return /^$/;}';
const BRIDGE_STUB = 'data:text/javascript,export const bridge={call:(method,params)=>globalThis.__baBridgeCall(method,params),onEvent(){},connect:async()=>{}};';

const rpcCalls: Array<{ method: string; params: any }> = [];
const toasts: string[] = [];
const messageListeners: Array<(message: any, sender: any, sendResponse?: any) => void> = [];

(globalThis as any).__baBridgeCall = async (method: string, params: unknown = {}) => {
  rpcCalls.push({ method, params });
  if (method === 'system.ping') return { version: 2, supported: [1, 2], deprecated: [1] };
  if (method === 'git.status') return { isRepo: false };
  return {};
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const rewritten = specifier.slice(0, -3) + '.ts';
      if (rewritten.includes('providers/registry')) return { url: REGISTRY_STUB, shortCircuit: true };
      if (rewritten.includes('bridge-client')) return { url: BRIDGE_STUB, shortCircuit: true };
      try {
        if (existsSync(fileURLToPath(new URL(rewritten, context.parentURL)))) return nextResolve(rewritten, context);
      } catch {}
    }
    if (specifier.startsWith('.') && specifier.endsWith('.json') && context.parentURL) {
      return { url: 'data:text/javascript,export default {};', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const elements = new Map<string, any>();
function element(id: string): any {
  let cached = elements.get(id);
  if (!cached) {
    cached = {
      id,
      classList: { toggle() {}, add() {}, remove() {} },
      dataset: {},
      value: '',
      textContent: '',
      innerHTML: '',
      disabled: false,
      scrollTop: 0,
      scrollHeight: 0,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {},
      appendChild() {},
      querySelectorAll: () => [],
      options: [],
      selectedIndex: 0,
    };
    elements.set(id, cached);
  }
  return cached;
}

(globalThis as any).chrome = {
  runtime: {
    id: 'broagentai-self',
    onMessage: { addListener: (listener: any) => messageListeners.push(listener) },
    getURL: (path: string) => path,
    getManifest: () => ({}),
    lastError: undefined,
  },
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
    },
  },
  tabs: {
    onRemoved: { addListener() {} },
    onActivated: { addListener() {} },
    sendMessage: async () => { throw new Error('no relay'); },
    query: async () => [],
    get: async () => null,
  },
  windows: { onFocusChanged: { addListener() {} } },
};
(globalThis as any).document = {
  getElementById: element,
  createElement: () => element(`created-${elements.size}`),
  querySelectorAll: () => [],
  documentElement: element('html'),
};
(globalThis as any).window = {
  setInterval: () => 0,
  clearInterval() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
};
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

const panel = await import(new URL('./agent-panel.ts', import.meta.url).href);
panel.initAgent({
  toast: (message: string) => toasts.push(message),
  confirm: async () => false,
  hasWorkspace: () => true,
  onFilesChanged() {},
});

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

test('ba.pluginError listener ignores messages from a different sender', () => {
  const listener = messageListeners[0];
  assert.equal(typeof listener, 'function');
  const message = { type: 'ba.pluginError', pluginId: 'plugin-1', kind: 'quota', message: 'quota exceeded' };
  const before = toasts.length;

  listener(message, { id: 'another-extension' });
  assert.equal(toasts.length, before);

  listener({ ...message, type: 'ba.reply' }, { id: chrome.runtime.id });
  assert.equal(toasts.length, before);

  listener(message, { id: chrome.runtime.id });
  assert.equal(toasts.length, before + 1);
});

test('checkpoint saves both workspace and bridge handoffs exactly once', async () => {
  await flush();
  const before = rpcCalls.length;
  const session = {
    tabId: 1,
    provider: { id: 'plugin-1', label: 'Plugin', source: 'builtin' },
    toolCalls: 0,
    totalCalls: 3,
    allowed: new Set<string>(),
    lastSent: 'continue',
    lastReplyText: 'working',
    resumeGuard: null,
    paused: false,
    carried: [],
    recorded: [{ role: 'user', text: 'hello' }],
    work: { reads: [], writes: [], lastTaskDescription: '' },
  };

  panel.checkpoint(session as any);
  await flush();

  const calls = rpcCalls.slice(before);
  const methods = calls.map((call) => call.method);
  assert.equal(methods.filter((method) => method === 'fs.mkdir').length, 1);
  assert.equal(methods.filter((method) => method === 'fs.writeFile').length, 1);
  assert.equal(methods.filter((method) => method === 'session.save').length, 1);
  assert.equal(calls.find((call) => call.method === 'fs.writeFile')?.params.path, '.broagentai/handoff.json');
  assert.equal(calls.find((call) => call.method === 'session.save')?.params.snapshot.totalCalls, 3);
});
