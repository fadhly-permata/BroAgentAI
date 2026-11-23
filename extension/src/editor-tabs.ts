// Every file the side panel shows opens in ONE browser tab, the editor page
// (editor.html), as an editor tab of its own - like VS Code: a file from
// Explorer or Search, or a diff from Source Control. When the editor page is
// already open the panel focuses it and asks it (runtime message) to open or
// activate the editor tab; only the first file opens a new browser tab.
import { browser } from './browser.ts';

export interface EditorTarget {
  path: string;
  /** 'diff' shows Git changes; omitted = the file itself, editable. */
  mode?: 'file' | 'diff';
  /** Line to reveal (file mode). */
  line?: number;
  /** Diff of the index (staged) instead of the working tree. */
  staged?: boolean;
  /** Diff of one commit instead of the working tree. */
  hash?: string;
  /** Path before a rename, for a commit diff. */
  origPath?: string;
}

/** Message the editor page handles: open (or activate) `target` as an editor tab. */
export const OPEN_MESSAGE = 'broagentai.editor.open';

/** editor.html query for a target. Without the line it is the editor tab's identity (same file = same tab). */
export function editorQuery(target: EditorTarget, withLine = true): string {
  const q = new URLSearchParams();
  q.set('path', target.path);
  if (target.mode === 'diff') {
    q.set('mode', 'diff');
    if (target.hash) q.set('hash', target.hash);
    else if (target.staged) q.set('staged', '1');
    if (target.origPath) q.set('orig', target.origPath);
  } else if (withLine && target.line && target.line > 0) {
    q.set('line', String(target.line));
  }
  return q.toString();
}

/** Identity of the editor tab for a target (line ignored). */
export const editorKey = (target: EditorTarget) => editorQuery(target, false);

/** Read a target back from an editor.html query string. */
export function targetFromQuery(query: string): EditorTarget | null {
  const p = new URLSearchParams(query);
  const path = p.get('path');
  if (!path) return null;
  if (p.get('mode') === 'diff') {
    return { path, mode: 'diff', staged: p.get('staged') === '1', hash: p.get('hash') || undefined, origPath: p.get('orig') || undefined };
  }
  const line = Number(p.get('line')) || 0;
  return line > 0 ? { path, line } : { path };
}

/** Open the target in the editor page: focus the open one and add an editor tab there, or open the page. */
export async function openEditorTab(target: EditorTarget): Promise<void> {
  const base = browser.runtime.getURL('src/editor.html');
  try {
    const pages = (await browser.tabs.query({ url: base + '*' }))
      .filter((t) => t.id !== undefined && t.status === 'complete')
      .sort((a, b) => ((b as any).lastAccessed ?? 0) - ((a as any).lastAccessed ?? 0));
    const page = pages[0];
    if (page?.id !== undefined) {
      const reply = await browser.runtime.sendMessage({ type: OPEN_MESSAGE, tabId: page.id, target }).catch(() => null);
      if (reply?.ok) {
        await browser.tabs.update(page.id, { active: true });
        if (page.windowId !== undefined) await browser.windows.update(page.windowId, { focused: true });
        return;
      }
    }
  } catch { /* fall back to a new editor page */ }
  await browser.tabs.create({ url: `${base}?${editorQuery(target)}` });
}
