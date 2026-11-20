// Hook runtime for web chat plugins (specs/09-WEBCHAT-PLUGINS.md §3.3).
// A plugin's plugin.js calls BroAgentAI.registerPlugin(id, hooks). Built-in
// plugins are bundled into the relay content script (content/plugin-scripts.ts);
// user plugins will reach the same contract through chrome.userScripts (P4).
// No DOM here: the page helpers a hook receives come from hook-api.ts, so this
// file is unit-tested with node:test.

/** Page helpers a hook may use. Nothing here reaches the extension, the bridge or other tabs. */
export interface HookApi {
  $(selector: string): Element | null;
  $$(selector: string): Element[];
  /** Click the first element matching `selector` (and `text`, when given). False when none matched. */
  click(selector: string, options?: { text?: string | RegExp }): boolean;
  /** Pick `value` in a <select> and fire input/change like a user would. False when the select or option is missing. */
  setSelect(selector: string, value: string): boolean;
  /** Wait (capped at 5 s per call). */
  sleep(ms: number): Promise<void>;
}

export interface PluginHooks {
  /**
   * Runs when a session starts on (or moves to) this chat tab, before the
   * operating prompt is typed: close popups, pick the right mode, ...
   * Must be safe to run more than once.
   */
  prepare?(api: HookApi): void | Promise<void>;
}

const HOOK_NAMES = new Set<keyof PluginHooks>(['prepare']);
/** R21: a hook that never finishes must not block the session. */
export const PREPARE_TIMEOUT_MS = 10_000;

const registry = new Map<string, PluginHooks>();

/**
 * Called by plugin.js. Unknown hook names are ignored with a warning (a newer
 * plugin on an older runtime); a hook that is not a function is an error.
 */
export function registerPlugin(id: unknown, hooks: unknown): void {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('BroAgentAI.registerPlugin(id, hooks): id must be the plugin id from plugin.json');
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new Error(`BroAgentAI.registerPlugin("${id}", hooks): hooks must be an object`);
  const clean: PluginHooks = {};
  for (const [name, fn] of Object.entries(hooks)) {
    if (!HOOK_NAMES.has(name as keyof PluginHooks)) {
      console.warn(`[BroAgentAI] plugin "${id}": unknown hook "${name}" ignored`);
      continue;
    }
    if (typeof fn !== 'function') throw new Error(`BroAgentAI.registerPlugin("${id}"): hook "${name}" must be a function`);
    clean[name as keyof PluginHooks] = fn as PluginHooks[keyof PluginHooks];
  }
  registry.set(id, clean);
}

export function hooksFor(id: string): PluginHooks | undefined {
  return registry.get(id);
}

export interface PrepareResult {
  /** False when the plugin has no prepare hook. */
  ran: boolean;
  /** Set when the hook threw or timed out; the session goes on without it. */
  error?: string;
}

/** Run a plugin's prepare hook with a timeout. Never throws. */
export async function runPrepare(id: string, api: HookApi, timeoutMs = PREPARE_TIMEOUT_MS): Promise<PrepareResult> {
  const prepare = registry.get(id)?.prepare;
  if (!prepare) return { ran: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => prepare(api)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`prepare timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    return { ran: true };
  } catch (err) {
    return { ran: true, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
