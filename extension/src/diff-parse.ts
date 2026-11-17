// Pure unified-diff parser (no DOM). Used by diff-view.ts.

export type DiffLineKind = 'context' | 'add' | 'del' | 'noeol';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  binary: boolean;
  renameFrom?: string;
  renameTo?: string;
  oldPath?: string;
  newPath?: string;
  added: number;
  removed: number;
}

export interface SideRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseDiff(diff: string): ParsedDiff {
  const out: ParsedDiff = { hunks: [], binary: false, added: 0, removed: 0 };
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = HUNK_RE.exec(line);
    if (m) {
      hunk = {
        header: line,
        oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2],
        newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4],
        lines: [],
      };
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
      out.hunks.push(hunk);
      continue;
    }
    if (hunk && (hunk.oldCount > 0 || hunk.newCount > 0 || line.startsWith('\\'))) {
      const c = line[0];
      if (c === '+') {
        hunk.lines.push({ kind: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ });
        hunk.newCount--; out.added++;
        continue;
      }
      if (c === '-') {
        hunk.lines.push({ kind: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null });
        hunk.oldCount--; out.removed++;
        continue;
      }
      if (c === ' ') {
        hunk.lines.push({ kind: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
        hunk.oldCount--; hunk.newCount--;
        continue;
      }
      if (c === '\\') {
        hunk.lines.push({ kind: 'noeol', text: line.slice(1).trim() || 'No newline at end of file', oldNo: null, newNo: null });
        continue;
      }
    }
    // Header area (or between files): hunk counters exhausted.
    if (hunk && hunk.oldCount <= 0 && hunk.newCount <= 0 && (line.startsWith('diff ') || line.startsWith('index '))) hunk = null;
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) out.binary = true;
    else if (line.startsWith('rename from ')) out.renameFrom = line.slice(12);
    else if (line.startsWith('rename to ')) out.renameTo = line.slice(10);
    else if (!hunk && line.startsWith('--- ')) out.oldPath = stripPrefix(line.slice(4));
    else if (!hunk && line.startsWith('+++ ')) out.newPath = stripPrefix(line.slice(4));
  }
  return out;
}

function stripPrefix(p: string): string {
  const t = p.split('\t')[0];
  return t === '/dev/null' ? t : t.replace(/^[ab]\//, '');
}

/** Pair lines for side-by-side: deletions align with additions inside a change block. */
export function pairLines(lines: DiffLine[]): SideRow[] {
  const rows: SideRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.kind === 'context') { rows.push({ left: l, right: l }); i++; continue; }
    if (l.kind === 'noeol') {
      // Belongs to the previous line's side.
      const prev = lines[i - 1];
      if (prev) {
        rows.push(prev.kind === 'del' ? { left: l, right: null } : prev.kind === 'add' ? { left: null, right: l } : { left: l, right: l });
      }
      i++; continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && (lines[i].kind === 'del' || lines[i].kind === 'add')) {
      (lines[i].kind === 'del' ? dels : adds).push(lines[i]);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
  }
  return rows;
}
