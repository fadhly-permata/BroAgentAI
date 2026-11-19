// Merge built-in web chat plugins with the user's installed ones into the
// list the extension works with (specs/09 §4.3, R19, R24). Pure.
import { toProviderInfo, validatePluginManifest, type PluginManifest } from './manifest.ts';
import type { PluginPackage } from './package.ts';
import type { ProviderInfo } from '../providers/types.ts';

/** A user plugin as kept in chrome.storage.local. */
export interface StoredPlugin extends PluginPackage {
  enabled: boolean;
  installedAt: number;
  updatedAt: number;
}

export interface PluginState {
  version: 1;
  user: Record<string, StoredPlugin>;
  /** Built-in plugin ids the user turned off. */
  disabledBuiltins: string[];
}

export const EMPTY_PLUGIN_STATE: PluginState = { version: 1, user: {}, disabledBuiltins: [] };

/** A built-in plugin as bundled (icon as a URL, style.css as text). */
export interface BuiltInPlugin {
  manifest: PluginManifest;
  icon?: string;
  style?: string;
  script?: boolean;
}

/** One row of the Plugins page. */
export interface PluginEntry {
  id: string;
  manifest: PluginManifest;
  source: 'builtin' | 'user';
  /** A user plugin that replaces the built-in with the same id. */
  overridesBuiltin: boolean;
  enabled: boolean;
  /** Set when the stored manifest no longer validates (e.g. an apiVersion this build does not support). */
  problem?: string;
  hasScript: boolean;
  icon?: string;
  style?: string;
  installedAt?: number;
  updatedAt?: number;
}

export function normalizeState(raw: unknown): PluginState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_PLUGIN_STATE, user: {}, disabledBuiltins: [] };
  const r = raw as Partial<PluginState>;
  return {
    version: 1,
    user: r.user && typeof r.user === 'object' ? { ...r.user } : {},
    disabledBuiltins: Array.isArray(r.disabledBuiltins) ? r.disabledBuiltins.filter((id) => typeof id === 'string') : [],
  };
}

export function mergePlugins(builtIns: BuiltInPlugin[], state: PluginState): { entries: PluginEntry[]; providers: ProviderInfo[] } {
  const entries: PluginEntry[] = [];
  for (const b of builtIns) {
    if (state.user[b.manifest.id]) continue; // overridden, shown as the user entry
    entries.push({
      id: b.manifest.id, manifest: b.manifest, source: 'builtin', overridesBuiltin: false,
      enabled: !state.disabledBuiltins.includes(b.manifest.id), hasScript: !!b.script, icon: b.icon, style: b.style,
    });
  }
  const builtinIds = new Set(builtIns.map((b) => b.manifest.id));
  for (const [id, stored] of Object.entries(state.user)) {
    // Re-validate: a plugin stored by an older build may use an apiVersion this build dropped (R19).
    const check = validatePluginManifest(stored.manifest);
    entries.push({
      id, manifest: stored.manifest, source: 'user', overridesBuiltin: builtinIds.has(id),
      enabled: stored.enabled, problem: check.ok ? undefined : check.errors.join('; '),
      hasScript: stored.script !== undefined, icon: stored.icon?.dataUrl, style: stored.style,
      installedAt: stored.installedAt, updatedAt: stored.updatedAt,
    });
  }
  entries.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  const providers = entries
    .filter((e) => e.enabled && !e.problem)
    .map((e): ProviderInfo => ({ ...toProviderInfo(e.manifest, { icon: e.icon, style: e.style }), source: e.source, hasScript: e.hasScript }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries, providers };
}
