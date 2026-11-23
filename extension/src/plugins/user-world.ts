// Running a user plugin's plugin.js (specs/09 §4.1–4.2, P4).
//
// The service worker registers each user plugin's script with
// chrome.userScripts in a world of its own (one worldId per plugin, strict CSP,
// NO extension messaging). Three code sources run there in order:
//   1. userWorldPrelude(id): BroAgentAI.registerPlugin + page helpers + the hook listener
//   2. the plugin's plugin.js
//   3. userWorldReady(id): marks the page so the relay knows the hooks are loaded
// The relay (content script, isolated world) calls a hook through the DOM:
// it writes the call to an attribute, dispatches HOOK_EVENT, and the plugin
// world answers with a result attribute + HOOK_DONE. DOM events cross worlds
// synchronously (P0 spike, C5). Results are plain data; the relay never runs
// anything a hook returns. The page sees these attributes too, which gives it
// nothing it does not already have (it owns the DOM and the replies).

export const HOOK_EVENT = 'broagentai:hook';
export const HOOK_DONE = 'broagentai:hook-done';
export const CALL_ATTR = 'data-ba-hook-call';
export const RESULT_ATTR_PREFIX = 'data-ba-hook-result-';
export const READY_ATTR = 'data-ba-plugin-ready';

/** CSP of every plugin world: no network, no eval (P0 C9). */
export const PLUGIN_WORLD_CSP = "script-src 'self'; connect-src 'none'; object-src 'none'";

export const pluginWorldId = (pluginId: string) => `plugin-${pluginId}`;

/** Code that runs before plugin.js in the plugin's world. */
export function userWorldPrelude(pluginId: string): string {
  const id = JSON.stringify(pluginId);
  return `(() => {
  const PLUGIN_ID = ${id};
  const hooks = {};
  const MAX_SLEEP_MS = 5000;
  const textOf = (el) => (el && (el.innerText ?? el.textContent)) || '';
  const api = {
    $: (s) => document.querySelector(s),
    $$: (s) => Array.from(document.querySelectorAll(s)),
    click(selector, options = {}) {
      const want = options.text;
      const el = Array.from(document.querySelectorAll(selector)).find((c) => want === undefined || (want instanceof RegExp ? want.test(textOf(c)) : textOf(c).includes(want)));
      if (!el) return false;
      el.click();
      return true;
    },
    text(s) {
      const el = s ? document.querySelector(s) : document.body;
      return ((el && (el.innerText ?? el.textContent)) || '').slice(0, 20000);
    },
    setSelect(selector, value) {
      const s = document.querySelector(selector);
      if (!s || s.tagName !== 'SELECT' || !Array.from(s.options).some((o) => o.value === value)) return false;
      if (s.value === value) return true;
      s.value = value;
      s.dispatchEvent(new Event('input', { bubbles: true }));
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(0, Math.min(ms, MAX_SLEEP_MS)))),
  };
  globalThis.BroAgentAI = {
    registerPlugin(id, h) {
      if (id !== PLUGIN_ID) { console.warn('[BroAgentAI] plugin ' + PLUGIN_ID + ' registered hooks as "' + id + '"; ignored'); return; }
      if (!h || typeof h !== 'object') return;
      for (const name of Object.keys(h)) {
        if ((name === 'prepare' || name === 'detectError') && typeof h[name] === 'function') hooks[name] = h[name];
        else console.warn('[BroAgentAI] plugin ' + PLUGIN_ID + ': unknown hook "' + name + '" ignored');
      }
    },
  };
  document.addEventListener(${JSON.stringify(HOOK_EVENT)}, () => {
    const root = document.documentElement;
    let call = null;
    try { call = JSON.parse(root.getAttribute(${JSON.stringify(CALL_ATTR)}) || 'null'); } catch {}
    if (!call || call.plugin !== PLUGIN_ID || typeof call.req !== 'string' || !/^[a-z0-9]{1,32}$/.test(call.req)) return;
    const done = (result) => {
      root.setAttribute(${JSON.stringify(RESULT_ATTR_PREFIX)} + call.req, JSON.stringify(result));
      document.dispatchEvent(new CustomEvent(${JSON.stringify(HOOK_DONE)}));
    };
    const fn = hooks[call.hook];
    if (typeof fn !== 'function') { done({ ran: false }); return; }
    Promise.resolve().then(() => fn(api)).then(
      (value) => done(value === undefined ? { ran: true } : { ran: true, value }),
      (err) => done({ ran: true, error: String((err && err.message) || err) }),
    );
  });
})();`;
}

/** Code that runs after plugin.js: hooks are loaded. */
export function userWorldReady(pluginId: string): string {
  return `document.documentElement.setAttribute(${JSON.stringify(READY_ATTR)}, ${JSON.stringify(pluginId)});`;
}

export interface UserHookResult { ran: boolean; error?: string; value?: unknown }

/**
 * Relay side: call a hook in the plugin's world and wait for its answer
 * (R21: never longer than `timeoutMs`). Without a loaded plugin world
 * (no "Allow User Scripts", or plugin.js failed) it reports that and returns.
 */
export function callUserHook(pluginId: string, hook: 'prepare' | 'detectError', timeoutMs: number): Promise<UserHookResult> {
  const root = document.documentElement;
  if (root.getAttribute(READY_ATTR) !== pluginId) {
    return Promise.resolve({ ran: false, error: 'plugin.js is not running on this page (is "Allow User Scripts" on for BroAgentAI?)' });
  }
  const req = Math.random().toString(36).slice(2, 12) || 'r';
  const resultAttr = RESULT_ATTR_PREFIX + req;
  return new Promise((resolve) => {
    let finished = false;
    const finish = (result: UserHookResult) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      document.removeEventListener(HOOK_DONE, check);
      root.removeAttribute(resultAttr);
      resolve(result);
    };
    const check = () => {
      const raw = root.getAttribute(resultAttr);
      if (raw === null) return;
      try {
        // R12: plain data only, size-capped.
        if (raw.length > 2000) throw new Error('hook result too large');
        const parsed = JSON.parse(raw);
        const result: UserHookResult = { ran: parsed?.ran === true, error: typeof parsed?.error === 'string' ? parsed.error.slice(0, 300) : undefined };
        if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'value')) result.value = parsed.value;
        finish(result);
      } catch {
        finish({ ran: true, error: 'unreadable hook result' });
      }
    };
    const timer = setTimeout(() => finish({ ran: true, error: `${hook} timed out after ${timeoutMs} ms` }), timeoutMs);
    document.addEventListener(HOOK_DONE, check);
    root.setAttribute(CALL_ATTR, JSON.stringify({ plugin: pluginId, hook, req }));
    document.dispatchEvent(new CustomEvent(HOOK_EVENT));
    root.removeAttribute(CALL_ATTR);
    check(); // a synchronous hook may already have answered
  });
}
