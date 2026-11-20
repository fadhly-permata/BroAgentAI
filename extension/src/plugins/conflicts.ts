// What installing a plugin package means next to the plugins already there
// (specs/09 §4.5, R2, R6, R24, R29). Pure.
import type { PluginManifest } from './manifest.ts';

export interface InstalledPlugin {
  manifest: PluginManifest;
  source: 'builtin' | 'user';
  enabled: boolean;
}

/** Host part of a match pattern ("https://*.example.com/*" → "*.example.com"). */
function hostOf(pattern: string): string {
  const m = /^[^:]+:\/\/([^/]*)\//.exec(pattern);
  return (m ? m[1] : pattern).toLowerCase();
}

/** Could two match patterns ever match the same page? (Hosts decide; paths are treated as overlapping.) */
export function patternsOverlap(a: string, b: string): boolean {
  const ha = hostOf(a);
  const hb = hostOf(b);
  if (ha === hb) return true;
  const covers = (wild: string, host: string) => wild.startsWith('*.') && (host === wild.slice(2) || host.endsWith(wild.slice(1)) || (host.startsWith('*.') && host.slice(1).endsWith(wild.slice(1))));
  return covers(ha, hb) || covers(hb, ha);
}

export function manifestsOverlap(a: PluginManifest, b: PluginManifest): string[] {
  const shared: string[] = [];
  for (const pa of a.matches) for (const pb of b.matches) if (patternsOverlap(pa, pb)) shared.push(pa === pb ? pa : `${pa} ~ ${pb}`);
  return shared;
}

export type InstallPlan =
  /** Nothing with this id yet. */
  | { kind: 'new'; domainConflicts: DomainConflict[] }
  /** Same id as an installed user plugin and the same sites: an update (or rollback). */
  | { kind: 'update'; previous: PluginManifest; downgrade: boolean; authorChanged: boolean; addedMatches: string[]; removedMatches: string[]; domainConflicts: DomainConflict[] }
  /** Same id as a built-in plugin: the import replaces it until "Reset to built-in". */
  | { kind: 'override'; builtin: PluginManifest; addedMatches: string[]; removedMatches: string[]; domainConflicts: DomainConflict[] }
  /** Same id as an installed plugin for different sites: not an update (R29). */
  | { kind: 'idClash'; existing: PluginManifest };

export interface DomainConflict { id: string; name: string; source: 'builtin' | 'user'; patterns: string[] }

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * Classify an import. Domain conflicts list the OTHER enabled plugins that
 * claim the same sites: one active plugin per domain (R2), so the user picks
 * replace (disable them) or cancel.
 */
export function planInstall(candidate: PluginManifest, installed: InstalledPlugin[]): InstallPlan {
  const sameId = installed.filter((p) => p.manifest.id === candidate.id);
  const user = sameId.find((p) => p.source === 'user');
  const builtin = sameId.find((p) => p.source === 'builtin');
  const domainConflicts: DomainConflict[] = installed
    .filter((p) => p.enabled && p.manifest.id !== candidate.id)
    .map((p) => ({ id: p.manifest.id, name: p.manifest.name, source: p.source, patterns: manifestsOverlap(candidate, p.manifest) }))
    .filter((c) => c.patterns.length > 0);

  const reference = user ?? builtin;
  if (reference && manifestsOverlap(candidate, reference.manifest).length === 0) return { kind: 'idClash', existing: reference.manifest };

  const diff = (prev: PluginManifest) => ({
    addedMatches: candidate.matches.filter((m) => !prev.matches.includes(m)),
    removedMatches: prev.matches.filter((m) => !candidate.matches.includes(m)),
  });
  if (user) {
    return {
      kind: 'update',
      previous: user.manifest,
      downgrade: compareVersions(candidate.version, user.manifest.version) < 0,
      authorChanged: (candidate.author ?? '') !== (user.manifest.author ?? ''),
      ...diff(user.manifest),
      domainConflicts,
    };
  }
  if (builtin) return { kind: 'override', builtin: builtin.manifest, ...diff(builtin.manifest), domainConflicts };
  return { kind: 'new', domainConflicts };
}
