export type Lang = 'en' | 'id';
export type Theme = 'system' | 'dark' | 'light';

import translationsEN from './i18n/en.json';
import translationsID from './i18n/id.json';

const translations: Record<Lang, Record<string, string>> = {
  en: translationsEN,
  id: translationsID
};

/** The theme setting last applied; 'system' keeps following the OS. */
let currentTheme: Theme = 'system';
let followingOs = false;

/**
 * Set data-theme on the page. With 'system' it also follows later OS changes
 * (light <-> dark, e.g. an automatic switch at sunset) without a reload: the
 * media query's change event re-applies it while the setting stays 'system'.
 */
export function applyTheme(theme: Theme) {
  currentTheme = theme;
  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  root.setAttribute('data-theme', theme === 'system' ? (media.matches ? 'dark' : 'light') : theme);
  if (!followingOs) {
    followingOs = true;
    media.addEventListener('change', (event) => {
      if (currentTheme === 'system') root.setAttribute('data-theme', event.matches ? 'dark' : 'light');
    });
  }
}

let currentLang: Lang = 'id';

/**
 * Translate one key in the current language. Use this for text set from code:
 * looking the string up in the DOM breaks as soon as the element that carried
 * the `data-i18n` attribute is re-rendered.
 */
export function t(key: string): string {
  const table = translations[currentLang];
  return table[key] ?? translations.en[key] ?? key;
}

export function translatePage(lang: Lang) {
  const t = translations[lang];
  if (!t) return;
  currentLang = lang;

  // Generic pass: every element that declares its key gets translated, so new
  // markup only needs the attribute. Keys without a translation keep their text.
  const table = t as Record<string, string>;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const value = table[el.dataset.i18n!];
    if (value !== undefined && el.id !== 'headerWs') el.textContent = value;
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    const value = table[el.dataset.i18nTitle!];
    if (value !== undefined) el.title = value;
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    const value = table[el.dataset.i18nPlaceholder!];
    if (value !== undefined) el.placeholder = value;
  });
}
