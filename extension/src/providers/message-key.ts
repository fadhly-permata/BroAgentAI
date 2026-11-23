import type { ProviderInfo } from './types.js';

export const MESSAGE_KEY_LIMIT = 1_000_000;
const MAX_KEY_TEXT = 240;
const MAX_KEY_ATTRS = 12;
const MAX_KEY_ATTR_VALUE = 120;
const MAX_KEY_DEPTH = 6;

export function boundedMessageKey(parts: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    hash ^= parts.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % (MESSAGE_KEY_LIMIT - 1)) + 1;
}

const normalizeKeyText = (text: string) => text.replace(/\s+/g, ' ').trim();

export function stableMessageKey(el: HTMLElement): number | null {
  const attrs: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && node !== document.body && depth < MAX_KEY_DEPTH && attrs.length < MAX_KEY_ATTRS; depth++, node = node.parentElement) {
    const names = [...node.attributes]
      .map((attr) => attr.name)
      .filter((name) => (name === 'id' || name.startsWith('data-')) && !name.startsWith('data-ba-') && !name.startsWith('data-broagentai-'))
      .sort();
    for (const name of names) {
      const value = normalizeKeyText(node.getAttribute(name) ?? '');
      if (value !== '') attrs.push(`${name}=${value.slice(0, MAX_KEY_ATTR_VALUE)}`);
      if (attrs.length >= MAX_KEY_ATTRS) break;
    }
  }
  const text = normalizeKeyText(el.innerText ?? el.textContent ?? '').slice(0, MAX_KEY_TEXT);
  if (attrs.length === 0 && text === '') return null;
  return boundedMessageKey(`${attrs.join('|')}#${text}`);
}

export function messageKeyOf(el: HTMLElement, provider: ProviderInfo): number | null {
  const attr = provider.selectors.messageKeyAttr;
  if (attr) {
    const raw = el.closest(`[${attr}]`)?.getAttribute(attr);
    const key = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(key) ? Math.abs(key) : null;
  }
  return provider.selectors.messageKeyFallback ? stableMessageKey(el) : null;
}
