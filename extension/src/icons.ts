// Monochrome line icons drawn for the side panel (16px grid, currentColor).
// Static markup asks for one with <i data-icon="name"></i>; code calls icon().
// Keeping them inline means the panel needs no icon font or network access.

const PATHS: Record<string, string> = {
  // Activity bar
  files: '<path d="M9.5 1.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-7z"/><path d="M9.5 1.5v3h3"/><path d="M3.5 4.5h-1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1"/>',
  search: '<circle cx="9.5" cy="6.5" r="4"/><path d="M6.6 9.4 1.5 14.5"/>',
  'source-control': '<circle cx="4.5" cy="3" r="1.5"/><circle cx="4.5" cy="13" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 4.5v7"/><path d="M11.5 6.5c0 3-7 2.5-7 5"/>',
  terminal: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="m4 6 2 2-2 2"/><path d="M7.5 10.5h4"/>',
  agent: '<rect x="2.5" y="5" width="11" height="8.5" rx="2"/><path d="M8 5V2.5"/><circle cx="8" cy="2" r=".6"/><circle cx="5.75" cy="9" r=".9"/><circle cx="10.25" cy="9" r=".9"/><path d="M1 8.5v2M15 8.5v2"/>',
  settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/><circle cx="8" cy="8" r="4.6"/>',
  // Actions
  refresh: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M12.5 1.5v3h-3"/>',
  'collapse-all': '<rect x="4.5" y="4.5" width="10" height="10" rx="1"/><path d="M1.5 11.5v-9a1 1 0 0 1 1-1h9"/><path d="M7 9.5h5"/>',
  'new-file': '<path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/><path d="M9.5 1.5v3h3v3"/><path d="M12.5 10v5M10 12.5h5"/>',
  'new-folder': '<path d="M7.5 13.5h-5a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3.5l1.5 1.5h5.5a1 1 0 0 1 1 1v3"/><path d="M12.5 10v5M10 12.5h5"/>',
  eye: '<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z"/><circle cx="8" cy="8" r="2"/>',
  add: '<path d="M8 2.5v11M2.5 8h11"/>',
  remove: '<path d="M2.5 8h11"/>',
  close: '<path d="m3.5 3.5 9 9M12.5 3.5l-9 9"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.6a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9L12 4"/><path d="M6.7 6.5v5M9.3 6.5v5"/>',
  'clear-all': '<path d="M2 3.5h9M2 6.5h7M2 9.5h4"/><path d="m9.5 9.5 4 4M13.5 9.5l-4 4"/>',
  discard: '<path d="M4 6.5h6.5a3 3 0 0 1 0 6H7"/><path d="M6.5 3.5 3.5 6.5l3 3"/>',
  diff: '<path d="M4.5 1.5v6M1.5 4.5h6"/><path d="M8.5 12.5h6"/><path d="M14.5 1.5l-13 13"/>',
  'go-to-file': '<path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9z"/><path d="M9.5 1.5v3h3"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="9" rx="1"/><path d="M10.5 5.5v-3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/>',
  'cloud-download': '<path d="M4.5 11.5h-1a3 3 0 0 1-.4-6 4 4 0 0 1 7.8-.5 3 3 0 0 1 1.6 6.5"/><path d="M8 7.5v7M5.5 12l2.5 2.5 2.5-2.5"/>',
  'arrow-down': '<path d="M8 2v11.5M3.5 9 8 13.5 12.5 9"/>',
  'arrow-up': '<path d="M8 14V2.5M3.5 7 8 2.5 12.5 7"/>',
  check: '<path d="m2.5 8.5 3.5 3.5 7.5-8"/>',
  'chevron-right': '<path d="m6 3.5 4.5 4.5L6 12.5"/>',
  'chevron-down': '<path d="M3.5 6 8 10.5 12.5 6"/>',
  ellipsis: '<circle cx="3" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="13" cy="8" r=".9"/>',
  play: '<path d="M4.5 2.5v11l9-5.5z"/>',
  'debug-stop': '<rect x="3.5" y="3.5" width="9" height="9" rx="1"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7v4.5"/><circle cx="8" cy="4.75" r=".5"/>',
  warning: '<path d="M8 1.8 15 14H1z"/><path d="M8 6v4"/><circle cx="8" cy="12" r=".4"/>',
  pulse: '<path d="M1 8h3l2-5 3 10 2-5h4"/>',
  'git-branch': '<circle cx="4.5" cy="3" r="1.5"/><circle cx="4.5" cy="13" r="1.5"/><circle cx="11.5" cy="5" r="1.5"/><path d="M4.5 4.5v7"/><path d="M11.5 6.5c0 3-7 2.5-7 5"/>',
  'folder-opened': '<path d="M1.5 12.5v-9a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1V6"/><path d="M1.5 12.5 3.3 7h11.2l-1.8 5.5z"/>',
  stethoscope: '<path d="M3.5 1.5v4a3 3 0 0 0 6 0v-4"/><path d="M6.5 8.5v2a3 3 0 0 0 6 0V9"/><circle cx="12.5" cy="7.5" r="1.5"/>',
  'debug-restart': '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M3.5 1.5v3h3"/>',
  window: '<rect x="1.5" y="2.5" width="13" height="11" rx="1"/><path d="M1.5 5.5h13"/>',
  regex: '<path d="M10.5 1.5v6M8 3l5 3M8 6l5-3"/><rect x="2" y="10.5" width="3.5" height="3.5" rx=".5"/>',
};

/** One icon as an SVG string. Unknown names render an empty box rather than throw. */
export function icon(name: string, extraClass = ''): string {
  const body = PATHS[name] ?? '';
  return `<svg class="ico${extraClass ? ' ' + extraClass : ''}" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
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
  if (kind !== 'file') {
    const body = kind === 'dir-open'
      ? '<path d="M1.5 12.5v-9a1 1 0 0 1 1-1h3.5l1.5 1.5h5a1 1 0 0 1 1 1V6"/><path d="M1.5 12.5 3.3 7h11.2l-1.8 5.5z"/>'
      : '<path d="M1.5 12.5v-9a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/>';
    return `<svg class="ico ico-folder" viewBox="0 0 16 16" aria-hidden="true">${body}</svg>`;
  }
  const lower = name.toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  const color = EXT_COLORS[ext] ?? (lower.startsWith('.') ? '#6d8086' : '#9da5b4');
  return `<svg class="ico ico-file" viewBox="0 0 16 16" aria-hidden="true" style="color:${color}"><path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-9z"/><path d="M9.5 1.5v3h3"/></svg>`;
}
