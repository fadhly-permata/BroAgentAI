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
  text(selector?: string): string;
  /** Wait (capped at 5 s per call). */
  sleep(ms: number): Promise<void>;
}

export interface PluginError {
  kind: 'quota' | 'blocked' | 'other';
  message: string;
}

export interface PluginErrorMessage {
  type: 'ba.pluginError';
  pluginId: string;
  kind: PluginError['kind'];
  message: string;
}

export interface PluginHooks {
  /**
   * Runs when a session starts on (or moves to) this chat tab, before the
   * operating prompt is typed: close popups, pick the right mode, ...
   * Must be safe to run more than once.
   */
  prepare?(api: HookApi): void | Promise<void>;
  detectError?(api: HookApi): PluginError | null | Promise<PluginError | null>;
}

const HOOK_NAMES = new Set<keyof PluginHooks>(['prepare', 'detectError']);
/** R21: a hook that never finishes must not block the session. */
export const PREPARE_TIMEOUT_MS = 10_000;
export const DETECT_ERROR_TIMEOUT_MS = 5_000;
const MAX_ERROR_MESSAGE = 300;

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
    (clean as Record<string, unknown>)[name] = fn;
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

export function parsePluginError(value: unknown): PluginError | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('detectError must return an object or null');
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'quota' && raw.kind !== 'blocked' && raw.kind !== 'other') throw new Error('detectError kind must be "quota", "blocked" or "other"');
  if (typeof raw.message !== 'string' || raw.message.trim() === '') throw new Error('detectError message must be text');
  return { kind: raw.kind, message: raw.message.trim().slice(0, MAX_ERROR_MESSAGE) };
}

export function pluginErrorMessage(pluginId: string, error: PluginError): PluginErrorMessage {
  return { type: 'ba.pluginError', pluginId, kind: error.kind, message: error.message };
}

export interface DetectErrorResult {
  ran: boolean;
  result?: PluginError;
  error?: string;
}

export async function runDetectError(id: string, api: HookApi, timeoutMs = DETECT_ERROR_TIMEOUT_MS): Promise<DetectErrorResult> {
  const detectError = registry.get(id)?.detectError;
  if (!detectError) return { ran: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => detectError(api)),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`detectError timed out after ${timeoutMs} ms`)), timeoutMs); }),
    ]);
    const result = parsePluginError(raw);
    return result ? { ran: true, result } : { ran: true };
  } catch (err) {
    return { ran: true, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
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
