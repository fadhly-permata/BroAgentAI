// Full-height diff preview overlay (unified / side-by-side) for the Source Control panel.
import './diff-view.css';
import { fileIcon } from './icons.js';
import { highlightToHtml } from './code-view.js';
import { pairLines, parseDiff, type DiffLine } from './diff-parse.js';

export interface DiffViewOptions {
  path: string;
  staged: boolean;
  diff: string;
  truncated: boolean;
  onClose?(): void;
  onOpenFile?(path: string): void;
}

type Mode = 'unified' | 'split';
const MODE_KEY = 'broagentai.diffMode';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function loadMode(): Mode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'unified' || v === 'split') return v;
  } catch { /* storage unavailable */ }
  return window.innerWidth < 600 ? 'unified' : 'split';
}

function saveMode(mode: Mode): void {
  try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ }
}

/**
 * Single place where a line's text becomes HTML: Dark Modern token colors per line.
 * Lines are highlighted one at a time, so a construct spanning lines (block comment)
 * is only colored on lines that show its delimiters.
 */
export function renderLineText(text: string, path: string): string {
  if (text === '') return '&nbsp;';
  try { return highlightToHtml(text, path); } catch { return esc(text); }
}

const MARK: Record<string, string> = { add: '+', del: '-', context: '', noeol: '' };

function rowHtml(l: DiffLine, path: string): string {
  return `<div class="dv-row ${l.kind}"><span class="dv-no">${l.oldNo ?? ''}</span><span class="dv-no">${l.newNo ?? ''}</span>`
    + `<span class="dv-mark">${MARK[l.kind]}</span><span class="dv-code">${renderLineText(l.text, path)}</span></div>`;
}

function cellHtml(l: DiffLine | null, side: 'left' | 'right', path: string): string {
  if (!l) return '<div class="dv-row blank"><span class="dv-no"></span><span class="dv-mark"></span><span class="dv-code">&nbsp;</span></div>';
  const no = side === 'left' ? l.oldNo : l.newNo;
  const kind = l.kind === 'context' ? 'context' : l.kind;
  return `<div class="dv-row ${kind}"><span class="dv-no">${no ?? ''}</span><span class="dv-mark">${MARK[l.kind]}</span>`
    + `<span class="dv-code">${renderLineText(l.text, path)}</span></div>`;
}

function bodyHtml(opts: DiffViewOptions, mode: Mode): string {
  const parsed = parseDiff(opts.diff);
  if (parsed.binary && parsed.hunks.length === 0) return '<div class="dv-empty">Binary file - no preview available.</div>';
  if (parsed.hunks.length === 0) {
    const rename = parsed.renameFrom && parsed.renameTo ? `Renamed: ${esc(parsed.renameFrom)} &rarr; ${esc(parsed.renameTo)}` : '';
    return `<div class="dv-empty">${rename || 'No changes'}</div>`;
  }
  if (mode === 'unified') {
    return parsed.hunks.map((h) => `<div class="dv-hunk">${esc(h.header)}</div>` + h.lines.map((l) => rowHtml(l, opts.path)).join('')).join('');
  }
  let left = '';
  let right = '';
  for (const h of parsed.hunks) {
    const head = `<div class="dv-hunk">${esc(h.header)}</div>`;
    left += head; right += head;
    for (const r of pairLines(h.lines)) {
      left += cellHtml(r.left, 'left', opts.path);
      right += cellHtml(r.right, 'right', opts.path);
    }
  }
  return `<div class="dv-split"><div class="dv-col">${left}</div><div class="dv-col">${right}</div></div>`;
}

let current: { el: HTMLElement; close(): void } | null = null;

/** Open the diff overlay. Replaces any diff view that is already open. */
export function openDiffView(opts: DiffViewOptions): void {
  current?.close();
  const parsed = parseDiff(opts.diff);
  let mode = loadMode();
  const slash = opts.path.lastIndexOf('/');
  const name = slash < 0 ? opts.path : opts.path.slice(slash + 1);
  const dir = slash < 0 ? '' : opts.path.slice(0, slash);

  const el = document.createElement('div');
  el.className = 'dv-overlay';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Diff ' + opts.path);
  el.innerHTML = `<div class="dv-head">
    <div class="dv-file" title="${esc(opts.path)}"><span class="ba-tree-icon">${fileIcon(name)}</span><span class="dv-name">${esc(name)}</span>${dir ? `<span class="dv-dir">${esc(dir)}</span>` : ''}</div>
    <span class="dv-tag ${opts.staged ? 'staged' : ''}">${opts.staged ? 'Staged' : 'Working Tree'}</span>
    <span class="dv-stats"><span class="a">+${parsed.added}</span><span class="d">-${parsed.removed}</span></span>
    <div class="dv-tools">
      <button class="dv-btn" data-m="unified" title="Unified">Unified</button>
      <button class="dv-btn" data-m="split" title="Side-by-side">Split</button>
      ${opts.onOpenFile ? '<button class="dv-btn" data-a="open" title="Open file">Open</button>' : ''}
      <button class="dv-btn close" data-a="close" title="Close (Esc)" aria-label="Close">&times;</button>
    </div></div>
    ${opts.truncated ? '<div class="dv-note">Diff truncated (too large).</div>' : ''}
    <div class="dv-body"></div>`;
  const body = el.querySelector('.dv-body') as HTMLElement;

  const paint = () => {
    body.innerHTML = bodyHtml(opts, mode);
    body.scrollTop = 0;
    el.querySelectorAll<HTMLElement>('[data-m]').forEach((b) => b.classList.toggle('active', b.dataset.m === mode));
  };

  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    el.remove();
    if (current?.el === el) current = null;
    opts.onClose?.();
  };

  el.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!t) return;
    if (t.dataset.m) { mode = t.dataset.m as Mode; saveMode(mode); paint(); }
    else if (t.dataset.a === 'close') close();
    else if (t.dataset.a === 'open') opts.onOpenFile?.(opts.path);
  });
  document.addEventListener('keydown', onKey, true);
  paint();
  document.body.appendChild(el);
  current = { el, close };
}
