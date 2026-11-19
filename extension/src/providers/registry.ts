// Provider registry: the built-in web chat plugins (extension/plugins/<id>/,
// bundled at build time and validated by vite.config.ts) merged with the
// user's installed plugins from chrome.storage.local (specs/09 §4.3).
//
// `providers` starts with the enabled built-ins, so code that runs before the
// first refresh still works; refreshProviders() merges the user plugins and
// watchProviders() keeps the list current when plugins change.
import type { ProviderInfo } from './types.js';
import { matchPatternToRegExp, validatePluginManifest } from '../plugins/manifest.ts';
import { EMPTY_PLUGIN_STATE, mergePlugins, type BuiltInPlugin, type PluginEntry, type PluginState } from '../plugins/merge.ts';
import { loadPluginState, onPluginStateChange } from '../plugins/store.ts';

const manifests = import.meta.glob('../../plugins/*/plugin.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const assets = import.meta.glob('../../plugins/*/*.{png,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const styles = import.meta.glob('../../plugins/*/*.css', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

function loadBuiltIns(): BuiltInPlugin[] {
  const list: BuiltInPlugin[] = [];
  for (const [path, raw] of Object.entries(manifests)) {
    const result = validatePluginManifest(raw);
    if (!result.ok) {
      console.warn(`[BroAgentAI] built-in plugin ${path} skipped:`, result.errors);
      continue;
    }
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    const { icon, style, script } = result.plugin;
    list.push({
      manifest: result.plugin,
      icon: icon ? assets[folder + icon] : undefined,
      style: style ? styles[folder + style] : undefined,
      script: !!script, // vite.config.ts already checked the file exists
    });
  }
  return list;
}

export const builtInPlugins: BuiltInPlugin[] = loadBuiltIns();

let merged = mergePlugins(builtInPlugins, EMPTY_PLUGIN_STATE);
/** Enabled providers (built-in and user), sorted by id. Reassigned on refresh. */
export let providers: ProviderInfo[] = merged.providers;
/** Every plugin, enabled or not, for the Plugins page. */
export let pluginEntries: PluginEntry[] = merged.entries;

function apply(state: PluginState): void {
  merged = mergePlugins(builtInPlugins, state);
  providers = merged.providers;
  pluginEntries = merged.entries;
}

/** Merge the user's installed plugins in. Falls back to built-ins only when storage is unavailable. */
export async function refreshProviders(): Promise<ProviderInfo[]> {
  try { apply(await loadPluginState()); } catch (err) { console.warn('[BroAgentAI] plugin storage unavailable:', err); }
  return providers;
}

/** Re-merge and call `onChange` whenever plugins are installed, updated, removed or toggled. */
export function watchProviders(onChange: () => void): void {
  onPluginStateChange((state) => { apply(state); onChange(); });
}

export { matchPatternToRegExp };

export function providerForUrl(url: string): ProviderInfo | null {
  return providers.find((provider) => provider.matchPatterns.some((pattern) => matchPatternToRegExp(pattern).test(url))) ?? null;
}
