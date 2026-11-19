// Service-worker side of user plugins: keep the dynamic content-script
// registrations in line with the installed plugins (specs/09 §4.1, R7, R15, R16).
//
// Built-in plugins get the relay from the manifest. A user plugin's sites get it
// from chrome.scripting.registerContentScripts, but only for patterns the
// manifest does not already cover (the relay itself also refuses to run twice).
// The P0 spike showed an extension reload/update clears dynamic registrations,
// so this runs on install/update/startup and whenever plugins or permissions change.
import { mergePlugins, type PluginState } from './merge.ts';
import { loadPluginState } from './store.ts';

/** Self-contained relay build for user-plugin sites (vite.relay.config.ts). */
export const DYNAMIC_RELAY = 'src/content/relay-dynamic.js';
const ID_PREFIX = 'plugin-';

export interface PluginAccess { id: string; patterns: string[]; granted: boolean }

function staticContentScripts(): { matches: Set<string>; mainWorldJs?: string } {
  const scripts = chrome.runtime.getManifest().content_scripts ?? [];
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
    const granted = await chrome.permissions.contains({ origins: patterns }).catch(() => false);
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
    const existing = (await chrome.scripting.getRegisteredContentScripts()).filter((s) => s.id.startsWith(ID_PREFIX));
    if (existing.length > 0) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    const scripts: chrome.scripting.RegisteredContentScript[] = [];
    for (const plugin of access) {
      if (!plugin.granted) continue; // shown as "access revoked" on the Plugins page (R7)
      scripts.push({ id: `${ID_PREFIX}${plugin.id}`, matches: plugin.patterns, js: [DYNAMIC_RELAY], runAt: 'document_idle', persistAcrossSessions: true });
      // The MAIN-world helper that reads React props (code blocks, markdown).
      if (mainWorldJs) scripts.push({ id: `${ID_PREFIX}${plugin.id}-main`, matches: plugin.patterns, js: [mainWorldJs], runAt: 'document_idle', world: 'MAIN', persistAcrossSessions: true });
    }
    if (scripts.length > 0) await chrome.scripting.registerContentScripts(scripts);
  } catch (err) {
    console.error('[BroAgentAI] plugin registration sync failed:', err);
  }
}
