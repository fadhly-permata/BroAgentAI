// Shared DOM adapter: drives a chat page using only the selectors from a plugin's plugin.json.
import type { ConversationMessage, ProviderHealth, ProviderInfo, ProviderReply } from './types.js';
import { findBlockingPrompt, type BlockingPromptMatch } from './blocking-prompt.js';
import { PAGE_SOURCE_ATTR, PAGE_SOURCE_EVENT, cutText, fencedBlocks, joinLines, spliceCode } from './reply-text.js';

function visible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  // Inside a display:none ancestor (e.g. ChatGPT keeps the previous chat view,
  // composer included, hidden in the DOM). The zero-size fallback below must
  // never pick such an element: text typed there is never sent.
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility()) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) return true;
  // Chrome may report 0,0 for elements in background/frozen tabs.
  // For interactive elements, assume they are visible if not explicitly hidden.
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || el.isContentEditable) return true;
  return false;
}

function first(selector: string | undefined): HTMLElement | null {
  if (!selector) return null;
  for (const el of document.querySelectorAll(selector)) if (visible(el)) return el;
  return null;
}

/** Every text node under `root`, in document order. */
function* textNodes(root: Node): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node as Text;
}

/** Drop elements nested inside another one in the list (a selector may match both). */
function outermost(all: HTMLElement[]): HTMLElement[] {
  return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
}

export class DomAdapter {
  readonly provider: ProviderInfo;

  constructor(provider: ProviderInfo) {
    this.provider = provider;
  }

  /** Outermost assistant message elements (a selector may also match nested nodes). */
  #messages(): HTMLElement[] {
    return outermost([...document.querySelectorAll<HTMLElement>(this.provider.selectors.assistantMessage)]);
  }

  #keyOf(el: HTMLElement): number | null {
    const attr = this.provider.selectors.messageKeyAttr;
    if (!attr) return null;
    const raw = el.closest(`[${attr}]`)?.getAttribute(attr);
    const key = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(key) ? Math.abs(key) : null;
  }

  health(): ProviderHealth {
    const composer = first(this.provider.selectors.composer) !== null;
    return { ok: composer, provider: this.provider.id, composer, messages: this.#messages().length };
  }

  isGenerating(): boolean {
    return first(this.provider.selectors.generating) !== null;
  }

  /**
   * A blocking prompt (plugin's blockingPrompts) showing on the page, with the
   * button that gets past it; null when none shows. Text inside messages is
   * ignored, so a reply that quotes the banner never counts.
   */
  blockingPrompt(): BlockingPromptMatch<HTMLElement> | null {
    const rules = this.provider.blockingPrompts;
    if (!rules || rules.length === 0 || !document.body) return null;
    const { assistantMessage, userMessage } = this.provider.selectors;
    return findBlockingPrompt<HTMLElement>(textNodes(document.body), rules, {
      skip: [assistantMessage, userMessage].filter(Boolean).join(', '),
      visible: (el) => visible(el as unknown as Element),
    });
  }

  /** Press the button of the blocking prompt `id`, if it is still showing. Returns the pressed button's label. */
  pressBlockingPrompt(id: string): string | null {
    const match = this.blockingPrompt();
    if (!match || match.rule.id !== id) return null;
    match.button.click();
    return (match.button.innerText || match.button.textContent || '').trim();
  }

  readLatestReply(): ProviderReply {
    const messages = this.#messages();
    const last = messages[messages.length - 1];
    if (!last) return { count: 0, key: null, text: '', codeBlocks: [] };
    return { count: messages.length, ...this.#readMessage(last) };
  }

  /**
   * Every message on the page, user and assistant, in document order. User
   * bubbles come from the plugin's userMessage selector, else from the
   * messageKeyAttr wrappers that hold no assistant reply; with neither, only
   * the assistant side is read. Pages that virtualize the list only return
   * what is currently in the DOM.
   */
  readConversation(): ConversationMessage[] {
    const assistant = this.#messages();
    const { userMessage, messageKeyAttr } = this.provider.selectors;
    // Without a userMessage selector, a page that wraps every message in an
    // element carrying the ordering key (DeepSeek) still tells them apart:
    // a wrapper with no assistant reply inside is a user message.
    const userSelector = userMessage || (messageKeyAttr ? `[${messageKeyAttr}]` : '');
    const user = userSelector ? outermost([...document.querySelectorAll<HTMLElement>(userSelector)]) : [];
    const tagged = [
      ...assistant.map((el) => ({ el, side: 'assistant' as const })),
      ...user.filter((el) => !assistant.some((a) => a.contains(el) || el.contains(a))).map((el) => ({ el, side: 'user' as const })),
    ];
    tagged.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return tagged.map(({ el, side }) => ({
      side,
      text: side === 'assistant' ? this.#readMessage(el).text : (el.innerText ?? el.textContent ?? ''),
    }));
  }

  /** Text and code blocks of one assistant message element. */
  #readMessage(last: HTMLElement): Omit<ProviderReply, 'count'> {
    const key = this.#keyOf(last);
    const source = this.#markdownOf(last);
    if (source !== null) return { key, text: source, codeBlocks: fencedBlocks(source) };

    const { codeBlock, codeLine, exclude } = this.provider.selectors;
    const blocks = codeBlock ? outermost([...last.querySelectorAll<HTMLElement>(codeBlock)]) : this.#preBlocks(last);
    const codeBlocks = blocks.map((block) => this.#codeOf(block));
    const chromeText = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(exclude ?? '')].map((el) => el.innerText ?? '');
    let text = last.innerText ?? last.textContent ?? '';
    if (exclude) text = cutText(text, chromeText(last));
    // Editor-rendered blocks: swap their label/gutter text for the real code, fenced.
    if (codeLine || codeBlock) {
      text = spliceCode(text, blocks.map((block, i) => ({
        rendered: exclude ? cutText(block.innerText ?? '', chromeText(block)) : block.innerText ?? '',
        code: codeBlocks[i],
      })));
    }
    return { key, text, codeBlocks };
  }

  /**
   * The reply's markdown as the page holds it, through the MAIN-world helper
   * (content/page-source.iife.ts). Null when the provider does not use it or
   * any part could not be read; the caller then reads the rendered DOM.
   */
  #markdownOf(message: HTMLElement): string | null {
    const selector = this.provider.selectors.markdownSource;
    if (!selector) return null;
    const parts = [...message.querySelectorAll<HTMLElement>(selector)];
    if (parts.length === 0) return null;
    const sources: string[] = [];
    for (const part of parts) {
      const source = this.#pageSource(part);
      if (source === null) return null;
      sources.push(source);
    }
    return sources.join('\n\n');
  }

  /** Text the MAIN-world helper finds in the element's React props, or null. */
  #pageSource(el: HTMLElement): string | null {
    el.removeAttribute(PAGE_SOURCE_ATTR);
    el.dispatchEvent(new CustomEvent(PAGE_SOURCE_EVENT, { bubbles: true }));
    const source = el.getAttribute(PAGE_SOURCE_ATTR);
    el.removeAttribute(PAGE_SOURCE_ATTR);
    return source;
  }

  #preBlocks(message: HTMLElement): HTMLElement[] {
    const pres = [...message.querySelectorAll<HTMLElement>('pre')];
    return pres.length > 0 ? pres : [...message.querySelectorAll<HTMLElement>('code')].filter((code) => (code.textContent ?? '').includes('\n'));
  }

  #codeOf(block: HTMLElement): string {
    if (this.provider.selectors.codeBlock) {
      const source = this.#pageSource(block);
      if (source !== null) return source;
    }
    const lineSelector = this.provider.selectors.codeLine;
    const lines = lineSelector ? [...block.querySelectorAll<HTMLElement>(lineSelector)] : [];
    if (lines.length > 0) return joinLines(lines.map((line) => ({ top: line.style.top, text: line.textContent ?? '' })));
    return (block.querySelector('code') ?? block.querySelector('pre') ?? block).textContent ?? '';
  }

  /** Put text into the composer and submit it. */
  async sendPrompt(text: string): Promise<void> {
    const composer = first(this.provider.selectors.composer);
    if (!composer) throw new Error('composer not found - is the chat page loaded and logged in?');
    composer.focus();

    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      // Framework-controlled inputs only notice a change made through the native setter.
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(composer, text);
      composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    } else {
      const selection = window.getSelection();
      selection?.selectAllChildren(composer);
      if (!document.execCommand('insertText', false, text)) {
        composer.textContent = text;
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    }

    await sleep(200); // let the page enable its send button
    // A page that refuses a message (rate limit, still busy) leaves it in the
    // composer. Press once more in case the send button enabled late; if the
    // text is still there, report it so the panel can wait and retry instead
    // of waiting forever for a reply that will never come.
    for (let press = 0; press < 2; press++) {
      this.#submit(composer);
      if (await this.#accepted(text, ACCEPT_WAIT_MS)) return;
    }
    throw new Error(`${NOT_ACCEPTED}: the chat page kept the message in its input box (rate limit or still busy)`);
  }

  #submit(composer: HTMLElement): void {
    const submit = first(this.provider.selectors.submit);
    if (submit && !(submit as HTMLButtonElement).disabled) {
      submit.click();
      return;
    }
    const init: KeyboardEventInit = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    composer.dispatchEvent(new KeyboardEvent('keydown', init));
    composer.dispatchEvent(new KeyboardEvent('keypress', init));
    composer.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /** Did the page take the message, i.e. is the composer no longer holding it? */
  async #accepted(text: string, waitMs: number): Promise<boolean> {
    const head = normalize(text).slice(0, 40);
    const deadline = Date.now() + waitMs;
    for (;;) {
      const composer = first(this.provider.selectors.composer);
      if (!composer) return true; // re-rendered away: the page moved on
      const current = normalize(composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
        ? composer.value
        : composer.innerText ?? composer.textContent ?? '');
      if (current === '' || !current.startsWith(head)) return true;
      if (Date.now() >= deadline) return false;
      await sleep(150);
    }
  }
}

/** Error prefix: the page did not take the message; worth retrying later. */
export const NOT_ACCEPTED = 'NOT_ACCEPTED';
const ACCEPT_WAIT_MS = 3000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
