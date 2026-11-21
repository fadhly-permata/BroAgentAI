// Web chat plugin manifest (plugin.json): schema, validation and the mapping to
// the ProviderInfo the rest of the extension uses. Pure functions, no DOM and no
// chrome.* APIs, so the build (vite.config.ts) and unit tests use them too.
// See specs/09-WEBCHAT-PLUGINS.md §3.
import type { BlockingPromptRule, ProviderInfo, ProviderSelectors } from '../providers/types.js';

/** plugin.json apiVersion values this build understands (R19). */
export const SUPPORTED_API_VERSIONS: readonly number[] = [1];

export interface PluginManifest {
  apiVersion: number;
  id: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  homepage: string;
  matches: string[];
  status: 'ready' | 'experimental';
  selectors: ProviderSelectors;
  /** Optional files next to plugin.json (used from P2 on). */
  script?: string;
  style?: string;
  icon?: string;
  /** Free text: how and when the selectors were checked on the live site. */
  verified?: string;
  /**
   * Regular expressions (case-insensitive) for the site's own failure text,
   * e.g. "^Something went wrong generating". A short reply that matches is a
   * failed generation: the panel sends the last message again instead of
   * treating it as the AI's answer.
   */
  errorReplies?: string[];
  /**
   * Banners the site shows in place of its composer, each with the one button
   * that gets past it (see providers/blocking-prompt.ts), e.g. ChatGPT's
   * "Context window full" with its "New chat" button. The panel presses it,
   * then carries on in the new chat with a handoff. Upgrade or billing
   * buttons are refused here and never pressed at runtime.
   */
  blockingPrompts?: BlockingPromptRule[];
}

export type ManifestResult =
  | { ok: true; plugin: PluginManifest; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

const TOP_LEVEL_KEYS = new Set(['apiVersion', 'id', 'name', 'version', 'author', 'description', 'homepage', 'matches', 'status', 'selectors', 'script', 'style', 'icon', 'verified', 'errorReplies', 'blockingPrompts']);
const SELECTOR_KEYS = new Set<keyof ProviderSelectors>(['composer', 'submit', 'assistantMessage', 'userMessage', 'generating', 'messageKeyAttr', 'codeLine', 'codeBlock', 'markdownSource', 'exclude']);
const REQUIRED_SELECTORS: (keyof ProviderSelectors)[] = ['composer', 'assistantMessage'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_MATCHES = 10;
const MAX_TEXT = 2000;
const MAX_ERROR_REPLIES = 10;
const MAX_ERROR_REPLY_LENGTH = 300;
const MAX_BLOCKING_PROMPTS = 5;
const BLOCKING_PROMPT_KEYS = new Set(['id', 'text', 'button', 'action', 'reason']);
const BLOCKING_ACTIONS: readonly string[] = ['new-chat'];
/** Labels a blockingPrompts button pattern must never match: the panel does not press upgrade or payment buttons. */
const BILLING_LABELS = ['Upgrade to Plus', 'Upgrade', 'Upgrade plan', 'Get Plus', 'Try Plus', 'Go Pro', 'Subscribe', 'Buy', 'Start free trial', 'Billing', 'Pricing'];

/** Convert a Chrome match pattern (scheme://host/path with *) to a RegExp. */
export function matchPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * A plugin may only claim concrete https hosts (R5): `https://host/path`, with at
 * most one leading `*.` subdomain wildcard and at least two labels after it.
 * Public suffixes such as "*.co.uk" are not detected here.
 * Returns why a pattern is refused, or null when it is fine.
 */
export function matchPatternProblem(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.trim() === '') return 'empty pattern';
  if (pattern === '<all_urls>') return '<all_urls> is not allowed';
  const m = /^([^:]+):\/\/([^/]*)(\/.*)$/.exec(pattern);
  if (!m) return `"${pattern}" is not a match pattern (scheme://host/path)`;
  const [, scheme, host] = m;
  if (scheme !== 'https') return `"${pattern}" must use https://`;
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  if (bare.includes('*')) return `"${pattern}" may only use one leading "*." in the host`;
  // At least two labels, so "*.com" or a bare "localhost" never pass.
  if (!/^([a-z0-9-]+\.)+[a-z0-9-]+$/i.test(bare)) return `"${pattern}" needs a concrete host like chat.example.com`;
  return null;
}

const isText = (v: unknown, max = MAX_TEXT): v is string => typeof v === 'string' && v.trim() !== '' && v.length <= max;

/** Validate a parsed plugin.json. Errors block the plugin; warnings do not. */
export function validatePluginManifest(raw: unknown): ManifestResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['plugin.json must be a JSON object'], warnings };
  const m = raw as Record<string, unknown>;

  for (const key of Object.keys(m)) if (!TOP_LEVEL_KEYS.has(key)) warnings.push(`unknown field "${key}" is ignored`);

  if (typeof m.apiVersion !== 'number' || !SUPPORTED_API_VERSIONS.includes(m.apiVersion)) {
    errors.push(`apiVersion ${JSON.stringify(m.apiVersion)} is not supported (supported: ${SUPPORTED_API_VERSIONS.join(', ')}); the plugin needs an update`);
  }
  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) errors.push('id must be 1-40 lowercase letters, digits or "-", starting with a letter or digit');
  if (!isText(m.name, 60)) errors.push('name is required (max 60 characters)');
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) errors.push('version must look like 1.0.0');
  if (m.author !== undefined && !isText(m.author, 100)) errors.push('author must be text (max 100 characters)');
  if (m.description !== undefined && !isText(m.description, 300)) errors.push('description must be text (max 300 characters)');
  if (m.verified !== undefined && !isText(m.verified)) errors.push(`verified must be text (max ${MAX_TEXT} characters)`);
  if (m.status !== 'ready' && m.status !== 'experimental') errors.push('status must be "ready" or "experimental"');

  const matches = Array.isArray(m.matches) ? m.matches : null;
  if (!matches || matches.length === 0) errors.push('matches must list at least one URL pattern');
  else if (matches.length > MAX_MATCHES) errors.push(`matches may list at most ${MAX_MATCHES} patterns`);
  else for (const pattern of matches) { const problem = matchPatternProblem(pattern as string); if (problem) errors.push(problem); }

  if (typeof m.homepage !== 'string' || !/^https:\/\/\S+$/.test(m.homepage)) errors.push('homepage must be an https:// URL');
  else if (matches && matches.every((p) => typeof p === 'string') && !(matches as string[]).some((p) => matchPatternToRegExp(p).test(m.homepage as string))) {
    warnings.push('homepage is not covered by matches, so the chat page it opens will not get the relay');
  }

  const selectors = m.selectors;
  if (!selectors || typeof selectors !== 'object' || Array.isArray(selectors)) errors.push('selectors must be an object');
  else {
    const s = selectors as Record<string, unknown>;
    for (const key of REQUIRED_SELECTORS) if (!isText(s[key])) errors.push(`selectors.${key} is required`);
    for (const [key, value] of Object.entries(s)) {
      if (!SELECTOR_KEYS.has(key as keyof ProviderSelectors)) { warnings.push(`unknown selector "${key}" is ignored`); continue; }
      if (typeof value !== 'string' || value.length > MAX_TEXT) errors.push(`selectors.${key} must be text (max ${MAX_TEXT} characters)`);
    }
  }

  if (m.errorReplies !== undefined) {
    const list = m.errorReplies;
    if (!Array.isArray(list) || list.length > MAX_ERROR_REPLIES) errors.push(`errorReplies must be a list of at most ${MAX_ERROR_REPLIES} patterns`);
    else for (const source of list) {
      const problem = errorReplyProblem(source);
      if (problem) errors.push(problem);
    }
  }

  if (m.blockingPrompts !== undefined) {
    const list = m.blockingPrompts;
    if (!Array.isArray(list) || list.length > MAX_BLOCKING_PROMPTS) errors.push(`blockingPrompts must be a list of at most ${MAX_BLOCKING_PROMPTS} rules`);
    else {
      const ids = new Set<string>();
      list.forEach((rule, i) => {
        const result = blockingPromptProblems(rule, i);
        errors.push(...result.errors);
        warnings.push(...result.warnings);
        const id = (rule as { id?: unknown })?.id;
        if (typeof id === 'string') {
          if (ids.has(id)) errors.push(`blockingPrompts[${i}].id "${id}" is used twice`);
          ids.add(id);
        }
      });
    }
  }

  for (const key of ['script', 'style', 'icon'] as const) {
    if (m[key] !== undefined && (typeof m[key] !== 'string' || !FILE_RE.test(m[key] as string))) errors.push(`${key} must be a file name next to plugin.json`);
  }

  if (errors.length > 0) return { ok: false, errors, warnings };
  return { ok: true, plugin: raw as PluginManifest, warnings };
}

/** Why one errorReplies entry is refused, or null when it is fine. */
export function errorReplyProblem(source: unknown): string | null {
  if (typeof source !== 'string' || source.trim() === '' || source.length > MAX_ERROR_REPLY_LENGTH) {
    return `errorReplies entries must be text (max ${MAX_ERROR_REPLY_LENGTH} characters)`;
  }
  let re: RegExp;
  try { re = new RegExp(source, 'i'); } catch { return `errorReplies "${source}" is not a valid regular expression`; }
  // A pattern that matches the empty string matches every reply.
  if (re.test('')) return `errorReplies "${source}" matches an empty reply, so it would match every reply`;
  return null;
}

/** A regex source for a blockingPrompts field: why it is refused, or null. */
function patternProblem(where: string, source: unknown): string | null {
  if (typeof source !== 'string' || source.trim() === '' || source.length > MAX_ERROR_REPLY_LENGTH) return `${where} must be text (max ${MAX_ERROR_REPLY_LENGTH} characters)`;
  let re: RegExp;
  try { re = new RegExp(source, 'i'); } catch { return `${where} "${source}" is not a valid regular expression`; }
  if (re.test('')) return `${where} "${source}" matches empty text, so it would match anything`;
  return null;
}

/** Errors and warnings for one blockingPrompts rule (`i` is its index, for the messages). */
export function blockingPromptProblems(raw: unknown, i = 0): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const at = `blockingPrompts[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { errors: [`${at} must be an object`], warnings };
  const rule = raw as Record<string, unknown>;
  for (const key of Object.keys(rule)) if (!BLOCKING_PROMPT_KEYS.has(key)) warnings.push(`unknown field "${at}.${key}" is ignored`);
  if (typeof rule.id !== 'string' || !ID_RE.test(rule.id)) errors.push(`${at}.id must be 1-40 lowercase letters, digits or "-"`);
  const text = patternProblem(`${at}.text`, rule.text);
  if (text) errors.push(text);
  const button = patternProblem(`${at}.button`, rule.button);
  if (button) errors.push(button);
  else {
    const re = new RegExp(rule.button as string, 'i');
    const billing = BILLING_LABELS.find((label) => re.test(label));
    if (billing) errors.push(`${at}.button "${rule.button}" matches "${billing}": upgrade and billing buttons are never pressed`);
  }
  if (typeof rule.action !== 'string' || !BLOCKING_ACTIONS.includes(rule.action)) errors.push(`${at}.action must be one of: ${BLOCKING_ACTIONS.join(', ')}`);
  if (rule.reason !== undefined && !isText(rule.reason, 80)) errors.push(`${at}.reason must be text (max 80 characters)`);
  return { errors, warnings };
}

/** The provider the panel, Home cards and relay work with. `files` holds the plugin's loaded icon URL and style.css text. */
export function toProviderInfo(plugin: PluginManifest, files: { icon?: string; style?: string } = {}): ProviderInfo {
  return {
    id: plugin.id,
    label: plugin.name,
    description: plugin.description,
    homepage: plugin.homepage,
    matchPatterns: [...plugin.matches],
    status: plugin.status,
    selectors: { ...plugin.selectors },
    version: plugin.version,
    author: plugin.author,
    icon: files.icon,
    style: files.style,
    ...(plugin.errorReplies ? { errorReplies: [...plugin.errorReplies] } : {}),
    ...(plugin.blockingPrompts ? { blockingPrompts: plugin.blockingPrompts.map((rule) => ({ ...rule })) } : {}),
  };
}
