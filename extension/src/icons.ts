// VS Code codicons for the side panel (currentColor, inlined - no icon font,
// no network). Static markup asks for one with <i data-icon="name"></i>; code
// calls icon(). Glyphs come from codicons.ts (generated, CC-BY-4.0); ALIASES
// maps the panel's own names onto codicon names.
import { CODICONS } from './codicons.js';

const ALIASES: Record<string, string> = {
  about: 'info',
  agent: 'robot',
  settings: 'settings-gear',
  stethoscope: 'pulse',
};

/** One icon as an SVG string. Unknown names render an empty box rather than throw. */
export function icon(name: string, extraClass = ''): string {
  const [size, body] = CODICONS[ALIASES[name] ?? name] ?? [16, ''];
  return `<svg class="ico${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Fill every <i data-icon="..."> under root with its SVG. Safe to call twice. */
export function hydrateIcons(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('i[data-icon]').forEach((el) => {
    if (el.dataset.hydrated) return;
    el.innerHTML = icon(el.dataset.icon!);
    el.dataset.hydrated = '1';
  });
}

// File-type tint for the explorer and change lists (Seti-like palette).
const EXT_COLORS: Record<string, string> = {
  ts: '#519aba', tsx: '#519aba', mts: '#519aba', cts: '#519aba',
  js: '#cbcb41', jsx: '#cbcb41', mjs: '#cbcb41', cjs: '#cbcb41',
  json: '#cbcb41', jsonc: '#cbcb41',
  md: '#519aba', css: '#42a5f5', scss: '#f55385', html: '#e37933',
  py: '#3c7bb0', cs: '#2e8540', go: '#519aba', rs: '#a074c4',
  sh: '#4d5a5e', ps1: '#519aba', cmd: '#4d5a5e', bat: '#4d5a5e',
  yml: '#a074c4', yaml: '#a074c4', svg: '#a074c4', png: '#a074c4', jpg: '#a074c4',
  lock: '#8dc149', txt: '#9da5b4',
};

/** File glyph tinted by extension, or a folder glyph. */
export function fileIcon(name: string, kind: 'file' | 'dir' | 'dir-open' = 'file'): string {
  if (kind !== 'file') return icon(kind === 'dir-open' ? 'folder-opened' : 'folder', 'ico-folder');
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const color = EXT_COLORS[ext] ?? (lower.startsWith('.') ? '#6d8086' : '#9da5b4');
  return icon('file', 'ico-file').replace('<svg ', `<svg style="color:${color}" `);
}
