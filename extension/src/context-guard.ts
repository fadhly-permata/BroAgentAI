// No native browser right-click menu on extension pages, like VS Code: a
// right-click does nothing unless the element has a menu of its own.
//
// One document-level listener runs after every element handler (bubble phase).
// It leaves the event alone when:
//   - a custom handler already took it (it called preventDefault(), as the
//     Explorer tree does before opening its own menu);
//   - the target is an editable field (text input, textarea, contenteditable -
//     CodeMirror included), so right-click copy/paste keeps working;
//   - the target sits inside [data-context-menu="native"], an explicit opt-in.
// Everything else gets preventDefault(), so the native menu never opens.

/** Text-like fields keep the browser's edit menu (Cut / Copy / Paste). */
const EDITABLE = [
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"])'
    + ':not([type="reset"]):not([type="range"]):not([type="color"]):not([type="file"]):not([type="image"])',
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ');

/** Opt-in marker for an area that should keep the native menu. */
export const NATIVE_MENU_SELECTOR = '[data-context-menu="native"]';

interface MenuTarget { closest(selector: string): unknown }

/** True when the native context menu for this event must be suppressed. */
export function shouldBlockContextMenu(event: { defaultPrevented: boolean; target: unknown }): boolean {
  if (event.defaultPrevented) return false; // a custom menu handled it
  const target = event.target as Partial<MenuTarget> | null;
  if (!target || typeof target.closest !== 'function') return true; // document, text node, window
  if (target.closest(EDITABLE)) return false;
  if (target.closest(NATIVE_MENU_SELECTOR)) return false;
  return true;
}

let installed = false;

/** Install the guard on this page (once). Call it from every extension page's entry script. */
export function installContextMenuGuard(doc: Document = document): void {
  if (installed) return;
  installed = true;
  doc.addEventListener('contextmenu', (event) => {
    if (shouldBlockContextMenu(event)) event.preventDefault();
  });
}
