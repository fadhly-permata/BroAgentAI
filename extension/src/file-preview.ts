// The editor workbench of the editor tab (editor.html): one browser tab, many
// editor tabs, like VS Code. Every file the side panel shows opens here as an
// editor tab - a file from Explorer or Search, a diff from Source Control.
// Layout: tab strip (one tab per file, actions of the active tab on the right),
// breadcrumbs of the active file, its content, and a status bar.
import './file-preview.css';
import { fileIcon, icon } from './icons.js';

export interface PreviewAction {
  act: string;
  title: string;
  /** Codicon name; without it the button shows `label` as text. */
  icon?: string;
  label?: string;
  id?: string;
  className?: string;
}

export interface TabSpec {
  /** Identity: opening a spec with a key that is already open activates that tab. */
  key: string;
  path: string;
  /** 'diff' marks the tab's body with the diff classes (.dv-body). */
  kind: 'file' | 'diff';
  /** Short text after the tab name, e.g. "Working Tree" for a diff. */
  tag?: string;
  /** Extra HTML at the end of the breadcrumb row (e.g. diff stats). */
  metaHtml?: string;
  /** Note under the breadcrumbs (e.g. "Diff truncated"). */
  note?: string;
  actions?: PreviewAction[];
  onAction?(act: string, button: HTMLButtonElement, tab: EditorTab): void;
  /** Return false to keep the tab open (e.g. unsaved changes declined). */
  canClose?(): boolean;
  onClose?(): void;
  onActivate?(): void;
}

export interface EditorTab {
  key: string;
  spec: TabSpec;
  body: HTMLElement;
  dirty: boolean;
  setDirty(dirty: boolean): void;
  setStatus(left: string, right?: string): void;
  /** Mark an action button of this tab as on (toggle state, e.g. Unified / Split). */
  setActionActive(act: string, active: boolean): void;
  activate(): void;
  /** Close; with force the canClose check is skipped. Returns false when it stayed open. */
  close(force?: boolean): boolean;
}

export interface Workbench {
  el: HTMLElement;
  /** Open a tab (or activate the open one with the same key); `mount` fills a new tab's body. */
  open(spec: TabSpec, mount: (tab: EditorTab) => void): EditorTab;
  find(key: string): EditorTab | undefined;
  active(): EditorTab | null;
  tabs(): EditorTab[];
}

export interface WorkbenchOptions {
  /** Shown when no tab is open. */
  emptyHtml?: string;
  /** Called after tabs open, close or switch. */
  onChange?(): void;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function actionHtml(a: PreviewAction, on: boolean): string {
  const id = a.id ? ` id="${esc(a.id)}"` : '';
  const content = a.icon ? icon(a.icon) : esc(a.label ?? a.title);
  const cls = (a.icon ? 'action' : 'fp-text-action') + (a.className ? ' ' + a.className : '') + (on ? ' active' : '');
  return `<button class="${cls}"${id} data-act="${esc(a.act)}" title="${esc(a.title)}" aria-label="${esc(a.title)}">${content}</button>`;
}

function crumbsHtml(path: string): string {
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop() ?? path;
  const dirs = parts.map((p) => `<span class="fp-crumb">${esc(p)}</span><span class="fp-sep">${icon('chevron-right')}</span>`).join('');
  return `${dirs}<span class="fp-crumb fp-crumb-file"><span class="ba-tree-icon">${fileIcon(name)}</span>${esc(name)}</span>`;
}

/** Ids the old single preview used; they always point at the active tab's elements. */
const MOVING_IDS = ['fileName', 'edDirty', 'edClose', 'edArea'];

export function createWorkbench(parent: HTMLElement = document.body, options: WorkbenchOptions = {}): Workbench {
  const el = document.createElement('div');
  el.className = 'fp-overlay';
  el.id = 'editorPreview';
  el.innerHTML = `<div class="fp-tabs"><div class="fp-tablist" role="tablist"></div><div class="fp-actions"></div></div>
    <div class="fp-crumbs"></div>
    <div class="fp-note dv-note hidden"></div>
    <div class="fp-bodies"></div>
    <div class="fp-empty hidden">${options.emptyHtml ?? ''}</div>
    <div class="status-bar"><span id="statusMsg" class="fp-status-l"></span><span id="cursorPos" class="fp-status-r"></span></div>`;
  parent.appendChild(el);
  const q = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const tablist = q('.fp-tablist'), actionsEl = q('.fp-actions'), crumbs = q('.fp-crumbs'), note = q('.fp-note');
  const bodies = q('.fp-bodies'), empty = q('.fp-empty'), statusL = q('.fp-status-l'), statusR = q('.fp-status-r');

  interface Entry { tab: EditorTab; tabEl: HTMLElement; status: [string, string]; on: Set<string> }
  const entries: Entry[] = [];
  let activeEntry: Entry | null = null;

  const paintChrome = () => {
    const e = activeEntry;
    for (const id of MOVING_IDS) document.getElementById(id)?.removeAttribute('id');
    el.classList.toggle('dv-overlay', e?.tab.spec.kind === 'diff');
    empty.classList.toggle('hidden', !!e);
    crumbs.classList.toggle('hidden', !e);
    if (!e) {
      actionsEl.innerHTML = ''; note.classList.add('hidden'); statusL.textContent = ''; statusR.textContent = '';
      document.title = 'BroAgentAI';
      options.onChange?.();
      return;
    }
    const s = e.tab.spec;
    actionsEl.innerHTML = (s.actions ?? []).map((a) => actionHtml(a, e.on.has(a.act))).join('');
    crumbs.innerHTML = crumbsHtml(s.path) + (s.metaHtml ? `<span class="fp-meta">${s.metaHtml}</span>` : '');
    note.textContent = s.note ?? '';
    note.classList.toggle('hidden', !s.note);
    [statusL.textContent, statusR.textContent] = e.status;
    e.tabEl.querySelector('.fp-name')?.setAttribute('id', 'fileName');
    e.tabEl.querySelector('.fp-dirty')?.setAttribute('id', 'edDirty');
    e.tabEl.querySelector('.fp-close')?.setAttribute('id', 'edClose');
    if (s.kind === 'file') e.tab.body.id = 'edArea';
    document.title = (s.path.split('/').pop() || s.path) + (s.kind === 'diff' ? ' (diff)' : '') + ' - BroAgentAI';
    options.onChange?.();
  };

  const activate = (e: Entry) => {
    activeEntry = e;
    for (const x of entries) {
      const on = x === e;
      x.tabEl.classList.toggle('active', on);
      x.tabEl.setAttribute('aria-selected', String(on));
      x.tab.body.classList.toggle('active', on);
    }
    e.tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    paintChrome();
    e.tab.spec.onActivate?.();
  };

  const open = (spec: TabSpec, mount: (tab: EditorTab) => void): EditorTab => {
    const existing = entries.find((x) => x.tab.key === spec.key);
    if (existing) { activate(existing); return existing.tab; }
    const name = spec.path.split('/').pop() || spec.path;
    const tabEl = document.createElement('div');
    tabEl.className = 'fp-tab';
    tabEl.setAttribute('role', 'tab');
    tabEl.title = spec.path + (spec.tag ? ` (${spec.tag})` : '');
    tabEl.innerHTML = `<span class="ba-tree-icon">${fileIcon(name)}</span><span class="fp-name">${esc(name)}</span>`
      + (spec.tag ? `<span class="fp-tag">${esc(spec.tag)}</span>` : '')
      + `<span class="fp-dirty"></span><button class="action fp-close" data-a="close" title="Close" aria-label="Close">${icon('close')}</button>`;
    const body = document.createElement('div');
    body.className = 'fp-body' + (spec.kind === 'diff' ? ' dv-body' : '');
    const entry: Entry = { tabEl, status: ['', ''], on: new Set(), tab: null as unknown as EditorTab };
    const tab: EditorTab = {
      key: spec.key, spec, body, dirty: false,
      setDirty(dirty) {
        tab.dirty = dirty;
        tabEl.classList.toggle('dirty', dirty);
        const d = tabEl.querySelector('.fp-dirty') as HTMLElement;
        d.innerHTML = dirty ? '●<span class="sr-only"> dirty</span>' : '';
        d.title = dirty ? 'Unsaved changes' : '';
      },
      setStatus(left, right = '') {
        entry.status = [left, right];
        if (activeEntry === entry) { statusL.textContent = left; statusR.textContent = right; }
      },
      setActionActive(act, on) {
        if (on) entry.on.add(act); else entry.on.delete(act);
        if (activeEntry === entry) actionsEl.querySelector(`[data-act="${act}"]`)?.classList.toggle('active', on);
      },
      activate: () => activate(entry),
      close(force = false) {
        const i = entries.indexOf(entry);
        if (i < 0) return true;
        if (!force && spec.canClose && !spec.canClose()) return false;
        entries.splice(i, 1);
        tabEl.remove();
        body.remove();
        spec.onClose?.();
        if (activeEntry === entry) {
          activeEntry = null;
          const next = entries[i] ?? entries[i - 1];
          if (next) activate(next); else paintChrome();
        } else {
          options.onChange?.();
        }
        return true;
      },
    };
    entry.tab = tab;
    entries.push(entry);
    tablist.appendChild(tabEl);
    bodies.appendChild(body);
    tabEl.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-a="close"]')) tab.close(); else activate(entry);
    });
    // Middle-click closes a tab, like VS Code.
    tabEl.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); tab.close(); } });
    activate(entry);
    mount(tab);
    return tab;
  };

  actionsEl.addEventListener('click', (e) => {
    const button = (e.target as HTMLElement).closest('button') as HTMLButtonElement | null;
    if (!button || !activeEntry || !button.dataset.act) return;
    activeEntry.tab.spec.onAction?.(button.dataset.act, button, activeEntry.tab);
  });

  paintChrome();
  return {
    el,
    open,
    find: (key) => entries.find((x) => x.tab.key === key)?.tab,
    active: () => activeEntry?.tab ?? null,
    tabs: () => entries.map((x) => x.tab),
  };
}
