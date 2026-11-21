/** Explorer context menu + inline dialogs (no window.prompt/confirm). */
import './context-menu.css';
import { bridge } from './bridge-client.js';
import { icon } from './icons.js';
import { ROOT, baseName, baseSelection, joinRel, parentDir, targetDir, toAbsolute, validateName } from './context-menu-paths.js';

export interface ExplorerMenuDeps {
  toast(msg: string): void;
  workspaceRoot(): string | null;
  refresh(): Promise<void> | void;
  onDeleted?(path: string): void;
  onRenamed?(from: string, to: string): void;
}

export interface ExplorerMenuTarget { path: string; isDirectory: boolean }

interface Item { label: string; icon?: string; disabled?: boolean; act: () => void }
type Entry = Item | 'sep';

let closeActive: (() => void) | null = null;

/** Show a floating menu at the cursor. */
function openMenu(e: MouseEvent, entries: Entry[]): void {
  closeActive?.();
  const menu = document.createElement('div');
  menu.className = 'ba-ctx';
  menu.setAttribute('role', 'menu');
  
  // First pass: filter out disabled items and consecutive separators
  const filtered: Entry[] = [];
  let lastWasSep = false;
  for (const en of entries) {
    if (en === 'sep') {
      // Skip separator if it's at start, after another separator, or would be at end
      if (!lastWasSep && filtered.length > 0) {
        filtered.push('sep');
        lastWasSep = true;
      }
      continue;
    }
    // Skip disabled items entirely - don't show them in the menu
    if (en.disabled) continue;
    
    filtered.push(en);
    lastWasSep = false;
  }
  
  // Remove trailing separator if present
  if (filtered.length > 0 && filtered[filtered.length - 1] === 'sep') {
    filtered.pop();
  }
  
  // Don't show empty menu
  if (filtered.length === 0) return;
  
  const buttons: HTMLButtonElement[] = [];
  for (const en of filtered) {
    if (en === 'sep') {
      const s = document.createElement('div');
      s.className = 'ba-ctx-sep';
      menu.appendChild(s);
      continue;
    }
    
    const b = document.createElement('button');
    b.className = 'ba-ctx-item';
    b.setAttribute('role', 'menuitem');
    b.innerHTML = (en.icon ? icon(en.icon) : '<svg class="ico"></svg>') + '<span></span>';
    b.querySelector('span')!.textContent = en.label;
    b.addEventListener('click', () => { close(); en.act(); });
    menu.appendChild(b);
    buttons.push(b);
  }
  
  document.body.appendChild(menu);

  const margin = 4;
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let x = e.clientX, y = e.clientY;
  if (x + w > innerWidth - margin) x = e.clientX - w;
  if (y + h > innerHeight - margin) y = e.clientY - h;
  menu.style.left = Math.max(margin, Math.min(x, innerWidth - w - margin)) + 'px';
  menu.style.top = Math.max(margin, Math.min(y, innerHeight - h - margin)) + 'px';

  const enabled = () => buttons.filter((b) => !b.disabled);
  const move = (d: number) => {
    const list = enabled();
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + d + list.length) % list.length].focus();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
    else if (ev.key === 'Home') { ev.preventDefault(); enabled()[0]?.focus(); }
    else if (ev.key === 'End') { ev.preventDefault(); enabled().at(-1)?.focus(); }
  };
  const onDown = (ev: MouseEvent) => { if (!menu.contains(ev.target as Node)) close(); };
  function close() {
    menu.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    window.removeEventListener('scroll', close, true);
    if (closeActive === close) closeActive = null;
  }
  closeActive = close;
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);
  window.addEventListener('scroll', close, true);
  enabled()[0]?.focus();
}

interface DialogOpts {
  title: string;
  message?: string;
  note?: string;
  input?: { value: string; select?: [number, number] };
  confirmLabel: string;
  danger?: boolean;
  validate?: (v: string) => string | null;
}

/** Small modal dialog; resolves with the input value ('' for confirm-only), null on cancel. */
function dialog(o: DialogOpts): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'ba-dlg-back';
    const dlg = document.createElement('div');
    dlg.className = 'ba-dlg';
    dlg.setAttribute('role', 'dialog');
    const add = (cls: string, text: string) => {
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      dlg.appendChild(d);
      return d;
    };
    add('ba-dlg-title', o.title);
    if (o.message) add('ba-dlg-msg', o.message);
    if (o.note) add('ba-dlg-note', o.note);
    let input: HTMLInputElement | null = null;
    let err: HTMLElement | null = null;
    if (o.input) {
      input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.value = o.input.value;
      dlg.appendChild(input);
      err = add('ba-dlg-err', '');
    }
    const actions = document.createElement('div');
    actions.className = 'ba-dlg-actions';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.textContent = o.confirmLabel;
    ok.className = o.danger ? 'danger' : 'primary';
    actions.append(cancel, ok);
    dlg.appendChild(actions);
    back.appendChild(dlg);
    document.body.appendChild(back);

    const done = (v: string | null) => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const submit = () => {
      if (!input) return done('');
      const v = input.value.trim();
      const msg = o.validate?.(v) ?? null;
      if (msg) { input.classList.add('invalid'); err!.textContent = msg; input.focus(); return; }
      done(v);
    };
    function onKey(ev: KeyboardEvent) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); done(null); }
      else if (ev.key === 'Enter' && document.activeElement !== cancel) { ev.preventDefault(); ev.stopPropagation(); submit(); }
    }
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click', submit);
    back.addEventListener('mousedown', (ev) => { if (ev.target === back) done(null); });
    input?.addEventListener('input', () => { input!.classList.remove('invalid'); err!.textContent = ''; });
    if (input) {
      input.focus();
      const [a, b] = o.input!.select ?? [0, input.value.length];
      input.setSelectionRange(a, b);
    } else (o.danger ? cancel : ok).focus();
  });
}

const errMsg = (err: unknown) => (err as { message?: string })?.message || String(err);

async function create(kind: 'file' | 'folder', dir: string, deps: ExplorerMenuDeps) {
  const name = await dialog({
    title: kind === 'file' ? 'New File' : 'New Folder',
    message: `in ${dir === ROOT ? 'workspace' : dir}`,
    input: { value: '' },
    confirmLabel: 'Create',
    validate: validateName,
  });
  if (name === null) return;
  const path = joinRel(dir, name);
  try {
    await bridge.call(kind === 'file' ? 'fs.createFile' : 'fs.mkdir', { path });
    deps.toast((kind === 'file' ? 'File dibuat: ' : 'Folder dibuat: ') + path);
    await deps.refresh();
  } catch (err) {
    deps.toast(`Gagal membuat ${kind === 'file' ? 'file' : 'folder'}: ${errMsg(err)}`);
  }
}

async function rename(path: string, deps: ExplorerMenuDeps) {
  const current = baseName(path);
  const name = await dialog({
    title: 'Rename',
    message: path,
    input: { value: current, select: baseSelection(current) },
    confirmLabel: 'Rename',
    validate: validateName,
  });
  if (name === null || name === current) return;
  const to = joinRel(parentDir(path), name);
  try {
    await bridge.call('fs.rename', { from: path, to });
    deps.toast(`Renamed: ${path} -> ${to}`);
    deps.onRenamed?.(path, to);
    await deps.refresh();
  } catch (err) {
    deps.toast('Gagal rename: ' + errMsg(err));
  }
}

async function remove(path: string, isDirectory: boolean, deps: ExplorerMenuDeps) {
  const ok = await dialog({
    title: 'Delete',
    message: path,
    note: isDirectory ? 'Folder harus kosong; folder berisi tidak bisa dihapus.' : 'Tindakan ini tidak bisa dibatalkan.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (ok === null) return;
  try {
    await bridge.call('fs.delete', { path });
    deps.toast('Deleted: ' + path);
    deps.onDeleted?.(path);
    await deps.refresh();
  } catch (err) {
    deps.toast('Gagal delete: ' + errMsg(err));
  }
}

async function copy(text: string, deps: ExplorerMenuDeps) {
  try {
    await navigator.clipboard.writeText(text);
    deps.toast('Path disalin: ' + text);
  } catch (err) {
    deps.toast('Gagal menyalin: ' + errMsg(err));
  }
}

export function showExplorerMenu(e: MouseEvent, target: ExplorerMenuTarget, deps: ExplorerMenuDeps): void {
  e.preventDefault();
  const { path, isDirectory } = target;
  const isRoot = path === ROOT;
  const dir = targetDir(path, isDirectory);
  const root = deps.workspaceRoot();
  openMenu(e, [
    { label: 'New File', icon: 'new-file', act: () => void create('file', dir, deps) },
    { label: 'New Folder', icon: 'new-folder', act: () => void create('folder', dir, deps) },
    'sep',
    { label: 'Rename', disabled: isRoot, act: () => void rename(path, deps) },
    'sep',
    { label: 'Copy Path', icon: 'copy', disabled: !root, act: () => void copy(toAbsolute(root!, path), deps) },
    { label: 'Copy Relative Path', icon: 'copy', disabled: isRoot, act: () => void copy(path, deps) },
    'sep',
    { label: 'Delete', icon: 'trash', disabled: isRoot, act: () => void remove(path, isDirectory, deps) },
  ]);
}
