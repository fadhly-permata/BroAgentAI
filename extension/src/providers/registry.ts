// Provider registry: every built-in web chat plugin (extension/plugins/<id>/
// plugin.json, plus its icon) is bundled at build time. vite.config.ts validates
// the same files and derives the manifest's host permissions and content-script
// matches from them, so an invalid plugin fails the build instead of shipping.
// User-installed plugins join this list in a later phase (specs/09 §5 P3).
import type { ProviderInfo } from './types.js';
import { matchPatternToRegExp, toProviderInfo, validatePluginManifest } from '../plugins/manifest.js';

const manifests = import.meta.glob('../../plugins/*/plugin.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const assets = import.meta.glob('../../plugins/*/*.{png,svg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function builtInProviders(): ProviderInfo[] {
  const list: ProviderInfo[] = [];
  for (const [path, raw] of Object.entries(manifests)) {
    const result = validatePluginManifest(raw);
    if (!result.ok) {
      console.warn(`[BroAgentAI] built-in plugin ${path} skipped:`, result.errors);
      continue;
    }
    const folder = path.slice(0, path.lastIndexOf('/') + 1);
    const icon = result.plugin.icon ? assets[folder + result.plugin.icon] : undefined;
    list.push(toProviderInfo(result.plugin, icon));
  }
  return list.sort((a, b) => a.id.localeCompare(b.id));
}

export const providers: ProviderInfo[] = builtInProviders();

export { matchPatternToRegExp };

export function providerForUrl(url: string): ProviderInfo | null {
  return providers.find((provider) => provider.matchPatterns.some((pattern) => matchPatternToRegExp(pattern).test(url))) ?? null;
}
