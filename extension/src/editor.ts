// Editor page (editor.html): ONE browser tab with many editor tabs, like VS
// Code. Every file the side panel shows opens here as an editor tab - a file
// from Explorer or Search (editable: CodeMirror, Save with mtime conflict
// detection) or a diff from Source Control. The panel opens the first file with
// the page URL and every later one through OPEN_MESSAGE (editor-tabs.ts).
// URL: ?path=<rel>[&line=N] for a file, ?path=<rel>&mode=diff[&staged=1|&hash=H[&orig=P]] for a diff.
import { EditorView, basicSetup } from 'codemirror';
import { vscodeTheme, languageFor } from './code-theme.js';
import { EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { defaultKeymap, historyKeymap } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { bridge, BridgeErrorCode } from './bridge-client.js';
import { applyTheme, type Theme } from './i18n.js';
import { installContextMenuGuard } from './context-guard.js';
import { createWorkbench, type EditorTab } from './file-preview.js';
import { openDiffTab } from './diff-view.js';
import { OPEN_MESSAGE, editorKey, editorQuery, targetFromQuery, type EditorTarget } from './editor-tabs.js';

// No native right-click menu except on editable fields and custom menus (context-guard.ts).
installContextMenuGuard();

// Same theme as the side panel: its UI settings live in this origin's localStorage.
const UI_SETTINGS_KEY = 'broagentai.ui';
function applyStoredTheme(): void {
  let theme: Theme = 'system';
  try { theme = (JSON.parse(localStorage.getItem(UI_SETTINGS_KEY) || '{}').theme || 'system') as Theme; } catch { /* keep system */ }
  applyTheme(theme);
}
applyStoredTheme();
window.addEventListener('storage', (e) => { if (e.key === UI_SETTINGS_KEY) applyStoredTheme(); });

/** Open editor tabs survive a reload of this browser tab (sessionStorage is per tab). */
const SESSION_KEY = 'broagentai.editorTabs';
const targets = new Map<string, EditorTarget>();
const fileTabs = new Map<string, { view: EditorView | null; mtime: number | null }>();

// createWorkbench paints once before it returns; onChange waits until `workbench` exists.
let workbenchReady = false;
const workbench = createWorkbench(document.body, {
  emptyHtml: 'Tidak ada file yang terbuka.<br>Buka file dari Explorer, Search atau Source Control di side panel.',
  onChange: () => {
    if (!workbenchReady) return;
    const active = workbench.active();
    const target = active ? targets.get(active.key) : undefined;
    history.replaceState(null, '', target ? `?${editorQuery(target, false)}` : location.pathname);
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({
        tabs: workbench.tabs().map((t) => targets.get(t.key)).filter(Boolean),
        active: active?.key ?? null,
      }));
    } catch { /* storage unavailable */ }
  },
});

workbenchReady = true;

const fileInfo = (content: string) => `${content.split('\n').length} lines - ${content.length} chars`;

function updateCursorPos(tab: EditorTab, view: EditorView, left?: string): void {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  tab.setStatus(left ?? (document.getElementById('statusMsg')?.textContent || ''), `Ln ${line.number}, Col ${pos - line.from + 1}`);
}

function revealLine(tab: EditorTab, lineNo: number): void {
  const view = fileTabs.get(tab.key)?.view;
  if (!view || lineNo <= 0) return;
  const line = view.state.doc.line(Math.min(lineNo, view.state.doc.lines));
  view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  view.focus();
}

async function saveFile(tab: EditorTab): Promise<void> {
  const state = fileTabs.get(tab.key);
  const path = tab.spec.path;
  if (!state?.view) { tab.setStatus('Tidak ada file yang dibuka.'); return; }
  tab.setStatus('Menyimpan...');
  const content = state.view.state.doc.toString();
  try {
    // Content + mtime so a file changed on disk since it was opened is not overwritten silently.
    const req: any = { path, content };
    if (state.mtime !== null) req.expectedMtime = state.mtime;
    const res: any = await bridge.call('fs.writeFile', req);
    state.mtime = typeof res.mtime === 'number' ? res.mtime : null;
    tab.setDirty(false);
    tab.setStatus(`Tersimpan: ${path} - ${fileInfo(content)}`);
  } catch (e: any) {
    if (e.code !== BridgeErrorCode.MTIME_CONFLICT) {
      tab.setStatus(`GAGAL menyimpan: ${e.message} - file di disk TIDAK berubah.`);
      return;
    }
    tab.setStatus('KONFLIK: File telah diubah di tempat lain. Simpan dibatalkan untuk mencegah kehilangan data.');
    if (!confirm('File telah diubah di tempat lain sejak Anda membukanya. Apakah Anda ingin menimpa perubahan tersebut?')) {
      tab.setStatus('Simpan dibatalkan oleh pengguna.');
      return;
    }
    try {
      const res: any = await bridge.call('fs.writeFile', { path, content });
      state.mtime = typeof res.mtime === 'number' ? res.mtime : null;
      tab.setDirty(false);
      tab.setStatus(`Tersimpan (force): ${path}`);
    } catch (err: any) {
      tab.setStatus(`GAGAL menyimpan: ${err.message}`);
    }
  }
}

function openFileTab(target: EditorTarget): EditorTab {
  const key = editorKey(target);
  const existing = workbench.find(key);
  if (existing) {
    existing.activate();
    if (target.line) revealLine(existing, target.line);
    return existing;
  }
  const path = target.path;
  targets.set(key, { path });
  fileTabs.set(key, { view: null, mtime: null });
  return workbench.open({
    key, path, kind: 'file',
    actions: [{ act: 'save', id: 'btnSave', icon: 'save', title: 'Save (Ctrl+S)' }],
    onAction: (act, _b, tab) => { if (act === 'save') void saveFile(tab); },
    canClose: () => !workbench.find(key)?.dirty || confirm(`${path} punya perubahan belum disimpan. Tutup?`),
    onClose: () => { fileTabs.get(key)?.view?.destroy(); fileTabs.delete(key); targets.delete(key); },
    onActivate: () => { fileTabs.get(key)?.view?.focus(); },
  }, (tab) => {
    tab.setStatus(`Membuka: ${path}`);
    void (async () => {
      try {
        const res: any = await bridge.call('fs.readFileLines', { path, startLine: 0, endLine: -1 });
        const content = res.content || '';
        const state = fileTabs.get(key);
        if (!state) return; // closed while loading
        state.mtime = typeof res.mtime === 'number' ? res.mtime : null;
        state.view = new EditorView({
          parent: tab.body,
          state: EditorState.create({
            doc: content,
            extensions: [
              basicSetup,
              vscodeTheme,
              languageFor(path),
              keymap.of([
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                { key: 'Mod-s', run: () => { void saveFile(tab); return true; } },
              ]),
              EditorView.updateListener.of((update) => {
                if (update.docChanged) {
                  tab.setDirty(true);
                  updateCursorPos(tab, update.view, `${path} - belum disimpan`);
                } else if (update.selectionSet) {
                  updateCursorPos(tab, update.view, undefined);
                }
              }),
            ],
          }),
        });
        tab.body.classList.add('bro-code-host');
        updateCursorPos(tab, state.view, `Dibuka: ${path} - ${fileInfo(content)}`);
        if (target.line) revealLine(tab, target.line);
        else if (workbench.active() === tab) state.view.focus();
      } catch (e: any) {
        tab.setStatus(`Gagal membuka ${path}: ${e.message}`);
        tab.body.innerHTML = `<div class="dv-empty">Gagal membuka file: ${String(e?.message || e).replace(/</g, '&lt;')}</div>`;
      }
    })();
  });
}

async function openDiff(target: EditorTarget): Promise<void> {
  const key = editorKey(target);
  const existing = workbench.find(key);
  if (existing) { existing.activate(); return; }
  try {
    const res: any = target.hash
      ? await bridge.call('git.commitDiff', { hash: target.hash, path: target.path, origPath: target.origPath })
      : await bridge.call('git.diff', { path: target.path, staged: !!target.staged });
    targets.set(key, target);
    openDiffTab(workbench, key, {
      path: target.path, staged: !!target.staged, diff: res.diff || '', truncated: !!res.truncated,
      label: target.hash ? target.hash.slice(0, 7) : undefined,
      // "Open File" opens the file itself as another editor tab.
      onOpenFile: (p) => { openFileTab({ path: p }); },
      onClose: () => { targets.delete(key); },
    });
  } catch (e: any) {
    targets.set(key, target);
    workbench.open({ key, path: target.path, kind: 'diff', tag: 'diff', onClose: () => { targets.delete(key); } }, (tab) => {
      tab.body.innerHTML = `<div class="dv-empty">Gagal memuat diff: ${String(e?.message || e).replace(/</g, '&lt;')}</div>`;
      tab.setStatus('Gagal memuat diff');
    });
  }
}

/** Open (or activate) a file or diff as an editor tab. */
async function openTarget(target: EditorTarget): Promise<void> {
  if (target.mode === 'diff') await openDiff(target); else openFileTab(target);
}

// The side panel opens later files here instead of a new browser tab.
let myTabId: number | undefined;
try { chrome.tabs.getCurrent((tab) => { myTabId = tab?.id; }); } catch { /* not in a tab */ }
chrome.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.type !== OPEN_MESSAGE || msg.tabId !== myTabId || !msg.target?.path) return;
  void openTarget(msg.target as EditorTarget);
  sendResponse({ ok: true });
});
window.addEventListener('beforeunload', (e) => {
  if (workbench.tabs().some((t) => t.dirty)) { e.preventDefault(); e.returnValue = ''; }
});

// Restore this browser tab's editor tabs after a reload, then open the URL's target.
void (async () => {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as { tabs: EditorTarget[]; active: string | null } | null;
    if (saved?.tabs?.length) {
      for (const t of saved.tabs) await openTarget(t);
      const active = saved.active ? workbench.find(saved.active) : undefined;
      active?.activate();
    }
  } catch { /* nothing to restore */ }
  const fromUrl = targetFromQuery(location.search);
  if (fromUrl) await openTarget(fromUrl);
})();
