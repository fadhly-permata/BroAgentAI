// The page helpers passed to plugin hooks (see hooks.ts HookApi). DOM only.
import type { HookApi } from './hooks.js';

const MAX_SLEEP_MS = 5_000;

function matchesText(el: Element, text: string | RegExp | undefined): boolean {
  if (text === undefined) return true;
  const value = (el as HTMLElement).innerText ?? el.textContent ?? '';
  return text instanceof RegExp ? text.test(value) : value.includes(text);
}

export function createHookApi(): HookApi {
  return {
    $: (selector) => document.querySelector(selector),
    $$: (selector) => [...document.querySelectorAll(selector)],
    click(selector, options = {}) {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) => matchesText(candidate, options.text));
      if (!el) return false;
      el.click();
      return true;
    },
    setSelect(selector, value) {
      const select = document.querySelector(selector);
      if (!(select instanceof HTMLSelectElement)) return false;
      if (![...select.options].some((option) => option.value === value)) return false;
      if (select.value === value) return true;
      select.value = value;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(ms, MAX_SLEEP_MS)))),
  };
}
