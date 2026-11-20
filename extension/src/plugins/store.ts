// User web chat plugins in chrome.storage.local (specs/09 §3.1, §4.4–4.6).
// Used by the side panel (install/update/remove/toggle), the relay (to know
// which plugin owns a page) and the service worker (dynamic registrations).
import { normalizeState, type PluginState, type StoredPlugin } from './merge.ts';
import type { PluginPackage } from './package.ts';

export const PLUGIN_STATE_KEY = 'broagentai.plugins';

export async function loadPluginState(): Promise<PluginState> {
  const stored = await chrome.storage.local.get(PLUGIN_STATE_KEY);
  return normalizeState(stored[PLUGIN_STATE_KEY]);
}

async function savePluginState(state: PluginState): Promise<void> {
  try {
    await chrome.storage.local.set({ [PLUGIN_STATE_KEY]: state });
  } catch (err) {
    // R18: a full storage must surface, not fail silently.
    throw new Error('Could not save plugins (browser storage full or unavailable): ' + (err instanceof Error ? err.message : String(err)));
  }
}

export interface PluginRef { id: string; source: 'builtin' | 'user' }

/**
 * Install or update a user plugin. `disable` lists other plugins that claim
 * the same sites; they are turned off so one plugin owns each domain (R2).
 */
export async function installPackage(pkg: PluginPackage, disable: PluginRef[] = []): Promise<void> {
  const state = await loadPluginState();
  const id = pkg.manifest.id;
  const previous = state.user[id];
  const now = Date.now();
  const record: StoredPlugin = { ...pkg, enabled: true, installedAt: previous?.installedAt ?? now, updatedAt: now };
  state.user[id] = record;
  for (const ref of disable) {
    if (ref.id === id) continue;
    if (ref.source === 'builtin') { if (!state.disabledBuiltins.includes(ref.id)) state.disabledBuiltins.push(ref.id); }
    else if (state.user[ref.id]) state.user[ref.id] = { ...state.user[ref.id], enabled: false };
  }
  await savePluginState(state);
}

/** Remove a user plugin; for an override this brings the built-in back ("Reset to built-in"). */
export async function removeUserPlugin(id: string): Promise<void> {
  const state = await loadPluginState();
  delete state.user[id];
  await savePluginState(state);
}

export async function setPluginEnabled(ref: PluginRef, enabled: boolean): Promise<void> {
  const state = await loadPluginState();
  if (ref.source === 'builtin') {
    state.disabledBuiltins = state.disabledBuiltins.filter((x) => x !== ref.id);
    if (!enabled) state.disabledBuiltins.push(ref.id);
  } else if (state.user[ref.id]) {
    state.user[ref.id] = { ...state.user[ref.id], enabled };
  }
  await savePluginState(state);
}

export function onPluginStateChange(callback: (state: PluginState) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[PLUGIN_STATE_KEY]) callback(normalizeState(changes[PLUGIN_STATE_KEY].newValue));
  });
}
