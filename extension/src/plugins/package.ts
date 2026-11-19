// Turn the files of a plugin folder or .zip into a validated plugin package
// (specs/09 §3–4.4). Pure: no DOM, no chrome.* APIs.
import { validatePluginManifest, type PluginManifest } from './manifest.ts';

/** Per-file size caps (R18). */
export const FILE_LIMITS = {
  manifest: 32 * 1024,
  script: 256 * 1024,
  style: 64 * 1024,
  icon: 64 * 1024,
};

export interface PluginIcon { mime: 'image/png' | 'image/svg+xml'; dataUrl: string }

/** Everything a plugin brings, ready to store. */
export interface PluginPackage {
  manifest: PluginManifest;
  script?: string;
  style?: string;
  icon?: PluginIcon;
}

export type PackageResult =
  | { ok: true; pkg: PluginPackage; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const utf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * Selectors in a plugin's style.css that do not target BroAgentAI's own marks
 * (`[data-ba-...]`). They restyle the chat site itself, which is allowed but
 * shown as a warning on the review screen (R9).
 */
export function cssOutsideMarks(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const outside: string[] = [];
  // Selector lists are what precedes a "{" that is not an at-rule.
  for (const match of text.matchAll(/([^{}]+)\{/g)) {
    const selectorList = match[1].trim();
    if (selectorList === '' || selectorList.startsWith('@')) continue;
    for (const selector of selectorList.split(',').map((s) => s.trim())) {
      if (selector !== '' && !selector.includes('[data-ba-')) outside.push(selector);
    }
  }
  return outside;
}

/** Build a plugin package from the files at the plugin root. */
export function buildPackage(files: Map<string, Uint8Array>): PackageResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const rawJson = files.get('plugin.json');
  if (!rawJson) return { ok: false, errors: ['plugin.json is missing at the plugin root'], warnings };
  if (rawJson.length > FILE_LIMITS.manifest) return { ok: false, errors: [`plugin.json is larger than ${FILE_LIMITS.manifest / 1024} KB`], warnings };

  let parsed: unknown;
  try { parsed = JSON.parse(utf8(rawJson)); } catch (err) {
    return { ok: false, errors: ['plugin.json is not valid UTF-8 JSON: ' + (err instanceof Error ? err.message : String(err))], warnings };
  }
  const result = validatePluginManifest(parsed);
  warnings.push(...result.warnings);
  if (!result.ok) return { ok: false, errors: result.errors, warnings };
  const manifest = result.plugin;
  const pkg: PluginPackage = { manifest };
  const used = new Set(['plugin.json']);

  const text = (name: string, limit: number, label: string): string | undefined => {
    used.add(name);
    const bytes = files.get(name);
    if (!bytes) { errors.push(`${label} "${name}" named in plugin.json is missing`); return undefined; }
    if (bytes.length > limit) { errors.push(`${label} "${name}" is larger than ${limit / 1024} KB`); return undefined; }
    try { return utf8(bytes); } catch { errors.push(`${label} "${name}" is not valid UTF-8 text`); return undefined; }
  };

  if (manifest.script) {
    pkg.script = text(manifest.script, FILE_LIMITS.script, 'script');
    if (pkg.script !== undefined) warnings.push(`${manifest.script} contains code that runs on ${manifest.matches.join(', ')}; review it before installing. It only runs once "Allow User Scripts" is on for BroAgentAI.`);
  }
  if (manifest.style) {
    pkg.style = text(manifest.style, FILE_LIMITS.style, 'style');
    if (pkg.style !== undefined) {
      const outside = cssOutsideMarks(pkg.style);
      if (outside.length > 0) warnings.push(`${manifest.style} also restyles the chat site itself, not only BroAgentAI's marks: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', ...' : ''}`);
    }
  }
  if (manifest.icon) {
    used.add(manifest.icon);
    const bytes = files.get(manifest.icon);
    const mime = /\.png$/i.test(manifest.icon) ? 'image/png' : /\.svg$/i.test(manifest.icon) ? 'image/svg+xml' : null;
    if (!bytes) errors.push(`icon "${manifest.icon}" named in plugin.json is missing`);
    else if (!mime) errors.push(`icon "${manifest.icon}" must be a .png or .svg file`);
    else if (bytes.length > FILE_LIMITS.icon) errors.push(`icon "${manifest.icon}" is larger than ${FILE_LIMITS.icon / 1024} KB`);
    else pkg.icon = { mime, dataUrl: `data:${mime};base64,${base64(bytes)}` };
  }

  for (const name of files.keys()) if (!used.has(name)) warnings.push(`${name} is not named in plugin.json and is ignored`);
  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, pkg, warnings };
}

/** The files of a stored package again, for "Export .zip". */
export function packageFiles(pkg: PluginPackage): Map<string, Uint8Array> {
  const enc = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  // chrome.storage returns objects with sorted keys; write plugin.json in the usual field order.
  const order = ['apiVersion', 'id', 'name', 'version', 'author', 'description', 'homepage', 'matches', 'status', 'script', 'style', 'icon', 'verified', 'selectors'];
  const raw = pkg.manifest as unknown as Record<string, unknown>;
  const manifest = Object.fromEntries([
    ...order.filter((key) => key in raw).map((key) => [key, raw[key]]),
    ...Object.entries(raw).filter(([key]) => !order.includes(key)),
  ]);
  files.set('plugin.json', enc.encode(JSON.stringify(manifest, null, 2) + '\n'));
  if (pkg.manifest.script && pkg.script !== undefined) files.set(pkg.manifest.script, enc.encode(pkg.script));
  if (pkg.manifest.style && pkg.style !== undefined) files.set(pkg.manifest.style, enc.encode(pkg.style));
  if (pkg.manifest.icon && pkg.icon) {
    const b64 = pkg.icon.dataUrl.slice(pkg.icon.dataUrl.indexOf(',') + 1);
    const binary = atob(b64);
    files.set(pkg.manifest.icon, Uint8Array.from(binary, (c) => c.charCodeAt(0)));
  }
  return files;
}
