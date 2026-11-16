// Provider registry: every providers/<id>/provider.json is bundled at build
// time. Adding a provider = adding one folder; the manifest's host permissions
// and content-script matches are derived from the same files (vite.config.ts).
import type { ProviderInfo } from './types.js';

const modules = import.meta.glob('./*/provider.json', { eager: true }) as Record<string, { default: ProviderInfo }>;

export const providers: ProviderInfo[] = Object.values(modules)
  .map((module) => module.default)
  .sort((a, b) => a.id.localeCompare(b.id));

/** Convert a Chrome match pattern (scheme://host/path with *) to a RegExp. */
export function matchPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

export function providerForUrl(url: string): ProviderInfo | null {
  return providers.find((provider) => provider.matchPatterns.some((pattern) => matchPatternToRegExp(pattern).test(url))) ?? null;
}
