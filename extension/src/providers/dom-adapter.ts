// Shared DOM adapter: drives a chat page using only the selectors from provider.json.
import type { ProviderHealth, ProviderInfo, ProviderReply } from './types.js';

function visible(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function first(selector: string | undefined): HTMLElement | null {
  if (!selector) return null;
  for (const el of document.querySelectorAll(selector)) if (visible(el)) return el;
  return null;
}

export class DomAdapter {
  readonly provider: ProviderInfo;

  constructor(provider: ProviderInfo) {
    this.provider = provider;
  }

  /** Outermost assistant message elements (a selector may also match nested nodes). */
  #messages(): HTMLElement[] {
    const all = [...document.querySelectorAll<HTMLElement>(this.provider.selectors.assistantMessage)];
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  health(): ProviderHealth {
    const composer = first(this.provider.selectors.composer) !== null;
    return { ok: composer, provider: this.provider.id, composer, messages: this.#messages().length };
  }

  isGenerating(): boolean {
    return first(this.provider.selectors.generating) !== null;
  }

  readLatestReply(): ProviderReply {
    const messages = this.#messages();
    const last = messages[messages.length - 1];
    if (!last) return { count: 0, text: '', codeBlocks: [] };
    const pres = [...last.querySelectorAll<HTMLElement>('pre')];
    const blocks = pres.length > 0 ? pres : [...last.querySelectorAll<HTMLElement>('code')].filter((code) => (code.textContent ?? '').includes('\n'));
    return {
      count: messages.length,
      text: last.innerText ?? last.textContent ?? '',
      codeBlocks: blocks.map((block) => (block.querySelector('code') ?? block).textContent ?? ''),
    };
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

    await new Promise((resolve) => setTimeout(resolve, 200)); // let the page enable its send button
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
}
