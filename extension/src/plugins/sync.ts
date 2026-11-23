// Service-worker side of user plugins: keep the dynamic content-script
// registrations in line with the installed plugins (specs/09 §4.1, R7, R15, R16).
//
// Built-in plugins get the relay from the manifest. A user plugin's sites get it
// from chrome.scripting.registerContentScripts, but only for patterns the
// manifest does not already cover (the relay itself also refuses to run twice).
// The P0 spike showed an extension reload/update clears dynamic registrations,
// so this runs on install/update/startup and whenever plugins or permissions change.
import { browser, userScriptsApi, type RegisteredContentScript, type UserScriptsApi } from '../browser.ts';
import { mergePlugins, type PluginState } from './merge.ts';
import { loadPluginState } from './store.ts';
import { PLUGIN_WORLD_CSP, pluginWorldId, userWorldPrelude, userWorldReady } from './user-world.ts';

/** Self-contained relay build for user-plugin sites (vite.relay.config.ts). */
export const DYNAMIC_RELAY = 'src/content/relay-dynamic.js';
const ID_PREFIX = 'plugin-';

export interface PluginAccess { id: string; patterns: string[]; granted: boolean }

function staticContentScripts(): { matches: Set<string>; mainWorldJs?: string } {
  const scripts = browser.runtime.getManifest().content_scripts ?? [];
  const matches = new Set(scripts.flatMap((s) => s.matches ?? []));
  const main = scripts.find((s) => (s as { world?: string }).world === 'MAIN');
  return { matches, mainWorldJs: main?.js?.[0] };
}

/** The dynamic patterns each enabled user plugin needs, and whether Chrome granted them. */
export async function pluginAccess(state: PluginState): Promise<PluginAccess[]> {
  const { matches: staticMatches } = staticContentScripts();
  const { entries } = mergePlugins([], state);
  const out: PluginAccess[] = [];
  for (const entry of entries) {
    if (entry.source !== 'user' || !entry.enabled || entry.problem) continue;
    const patterns = entry.manifest.matches.filter((p) => !staticMatches.has(p));
    if (patterns.length === 0) continue;
    const granted = await browser.permissions.contains({ origins: patterns }).catch(() => false);
    out.push({ id: entry.id, patterns, granted });
  }
  return out;
}

let queue: Promise<void> = Promise.resolve();

/** Re-apply every user-plugin registration. Serialized, idempotent, never throws. */
export function syncPluginRegistrations(): Promise<void> {
  queue = queue.then(doSync, doSync);
  return queue;
}

async function doSync(): Promise<void> {
  try {
    const access = await pluginAccess(await loadPluginState());
    const { mainWorldJs } = staticContentScripts();
    const existing = (await browser.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith(ID_PREFIX));
    if (existing.length > 0) await browser.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    const scripts: RegisteredContentScript[] = [];
    for (const plugin of access) {
      if (!plugin.granted) continue; // shown as "access revoked" on the Plugins page (R7)
      scripts.push({ id: `${ID_PREFIX}${plugin.id}`, matches: plugin.patterns, js: [DYNAMIC_RELAY], runAt: 'document_idle', persistAcrossSessions: true });
      // The MAIN-world helper that reads React props (code blocks, markdown).
      if (mainWorldJs) scripts.push({ id: `${ID_PREFIX}${plugin.id}-main`, matches: plugin.patterns, js: [mainWorldJs], runAt: 'document_idle', world: 'MAIN', persistAcrossSessions: true });
    }
    if (scripts.length > 0) await browser.scripting.registerContentScripts(scripts);
  } catch (err) {
    console.error('[BroAgentAI] plugin registration sync failed:', err);
  }
  await syncUserScripts();
}

/**
 * plugin.js of enabled user plugins, each in its own world (R3) with a strict
 * CSP (R11) and no extension messaging, so a plugin can only touch the page.
 * It runs on all of the plugin's sites, built-in hosts included (an override).
 */
/** Last plugin-script sync, shown on the Plugins page (errors here are otherwise only in the service-worker console). */
export const SCRIPT_SYNC_KEY = 'broagentai.plugins.scriptSync';
export interface ScriptSyncStatus { at: number; available: boolean; registered: string[]; error?: string }

/**
 * Also called from the side panel: after "Allow User Scripts" is turned on, a
 * service worker that was already running still has no chrome.userScripts
 * (only contexts created later get it), so the panel registers the scripts.
 */
export async function syncUserScripts(): Promise<void> {
  const api = userScriptsApi();
  const report = (status: Omit<ScriptSyncStatus, 'at'>) => browser.storage.local.set({ [SCRIPT_SYNC_KEY]: { at: Date.now(), ...status } }).catch(() => {});
  if (!api) { await report({ available: false, registered: [] }); return; } // plugins still run on selectors + style.css
  try {
    const state = await loadPluginState();
    const existing = (await api.getScripts()).filter((s) => s.id.startsWith(ID_PREFIX));
    if (existing.length > 0) await api.unregister({ ids: existing.map((s) => s.id) });
    const scripts: Parameters<UserScriptsApi['register']>[0] = [];
    for (const entry of mergePlugins([], state).entries) {
      const stored = state.user[entry.id];
      if (entry.source !== 'user' || !entry.enabled || entry.problem || !stored?.script) continue;
      if (!(await browser.permissions.contains({ origins: entry.manifest.matches }).catch(() => false))) continue;
      const worldId = pluginWorldId(entry.id);
      await api.configureWorld({ worldId, csp: PLUGIN_WORLD_CSP, messaging: false });
      scripts.push({
        id: `${ID_PREFIX}${entry.id}`,
        matches: entry.manifest.matches,
        js: [{ code: userWorldPrelude(entry.id) }, { code: stored.script }, { code: userWorldReady(entry.id) }],
        runAt: 'document_idle',
        world: 'USER_SCRIPT',
        worldId,
      });
    }
    if (scripts.length > 0) await api.register(scripts);
    await report({ available: true, registered: scripts.map((s) => s.id.slice(ID_PREFIX.length)) });
  } catch (err) {
    console.error('[BroAgentAI] plugin script sync failed:', err);
    await report({ available: true, registered: [], error: err instanceof Error ? err.message : String(err) });
  }
}
