// Self-heal after a rebuild of an unpacked (dev) install.
//
// Chrome reads an unpacked extension's pages and scripts from disk on every
// load, but keeps the manifest it parsed when the extension was last
// (re)loaded. After `npm run build` the side panel therefore already runs the
// new code (a new web chat plugin shows up in Home) while the content scripts
// and host permissions are still the old ones: the new chat site gets no relay
// and every session start fails with "chat tab does not respond". This holds
// per Chrome profile, so reloading in one profile does not fix another.
//
// When the manifest on disk differs from the loaded one in what matters for
// the relay, reload the extension once. A loop guard keeps a manifest that
// Chrome normalizes differently from triggering reload after reload.

export interface ManifestLike {
  version?: string;
  host_permissions?: string[];
  content_scripts?: { matches?: string[]; js?: string[] }[];
}

const GUARD_KEY = 'broagentai.staleManifestReloadAt';
/** Never reload twice within this window, whatever the comparison says. */
export const RELOAD_GUARD_MS = 5 * 60_000;

/** What the relay depends on: version, host access and content-script sites. */
export function manifestFingerprint(m: ManifestLike): string {
  const hosts = [...(m.host_permissions ?? [])].sort();
  const sites = [...new Set((m.content_scripts ?? []).flatMap((cs) => cs.matches ?? []))].sort();
  const scripts = (m.content_scripts ?? []).flatMap((cs) => cs.js ?? []).sort();
  return JSON.stringify({ v: m.version ?? '', hosts, sites, scripts });
}

/** True when `disk` describes a build the running extension has not loaded yet. */
export function isStale(loaded: ManifestLike, disk: ManifestLike): boolean {
  return manifestFingerprint(loaded) !== manifestFingerprint(disk);
}

/** True when a reload attempt at `last` still blocks a new one at `now`. */
export function guardBlocks(last: unknown, now: number): boolean {
  return typeof last === 'number' && now - last >= 0 && now - last < RELOAD_GUARD_MS;
}

/**
 * Reload the extension when its manifest on disk is newer than the loaded one.
 * Returns true when a reload was started (the calling page is about to close).
 * Packed installs never differ, so this is a no-op for them.
 */
export async function reloadIfManifestStale(): Promise<boolean> {
  let disk: ManifestLike;
  try {
    const res = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    if (!res.ok) return false;
    disk = await res.json();
  } catch {
    return false;
  }
  if (!isStale(chrome.runtime.getManifest() as ManifestLike, disk)) return false;
  try {
    const stored = await chrome.storage.local.get(GUARD_KEY);
    if (guardBlocks(stored[GUARD_KEY], Date.now())) return false;
    await chrome.storage.local.set({ [GUARD_KEY]: Date.now() });
  } catch {
    return false; // without a working guard, do not risk a reload loop
  }
  console.warn('[BroAgentAI] manifest on disk is newer than the loaded one; reloading the extension');
  chrome.runtime.reload();
  return true;
}
