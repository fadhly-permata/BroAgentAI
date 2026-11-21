// Diff rendering (unified / side-by-side) for Source Control, shown as an editor
// tab of the editor page's workbench (file-preview.ts) like every other file.
import './diff-view.css';
import type { EditorTab, Workbench } from './file-preview.js';
import { highlightToHtml } from './code-view.js';
import { pairLines, parseDiff, type DiffLine } from './diff-parse.js';

export interface DiffViewOptions {
  path: string;
  staged: boolean;
  diff: string;
  truncated: boolean;
  /** Tag shown next to the file name; defaults to "Staged" / "Working Tree". */
  label?: string;
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

/** Open a diff as an editor tab of the workbench (or activate it when `key` is already open). */
export function openDiffTab(workbench: Workbench, key: string, opts: DiffViewOptions): EditorTab {
  const parsed = parseDiff(opts.diff);
  let mode = loadMode();
  const tag = opts.label ?? (opts.staged ? 'Staged' : 'Working Tree');
  const paint = (tab: EditorTab) => {
    tab.body.innerHTML = bodyHtml(opts, mode);
    tab.body.scrollTop = 0;
    tab.setActionActive('unified', mode === 'unified');
    tab.setActionActive('split', mode === 'split');
  };
  return workbench.open({
    key,
    path: opts.path,
    kind: 'diff',
    tag,
    metaHtml: `<span class="dv-stats"><span class="a">+${parsed.added}</span><span class="d">-${parsed.removed}</span></span>`,
    note: opts.truncated ? 'Diff truncated (too large).' : undefined,
    actions: [
      { act: 'unified', label: 'Unified', title: 'Unified', className: 'dv-btn' },
      { act: 'split', label: 'Split', title: 'Side-by-side', className: 'dv-btn' },
      ...(opts.onOpenFile ? [{ act: 'open', icon: 'go-to-file', title: 'Open File' }] : []),
    ],
    onAction(act, _button, tab) {
      if (act === 'unified' || act === 'split') { mode = act; saveMode(mode); paint(tab); }
      else if (act === 'open') opts.onOpenFile?.(opts.path);
    },
    onClose: opts.onClose,
  }, (tab) => {
    paint(tab);
    tab.setStatus(`+${parsed.added} -${parsed.removed}`, tag);
  });
}
