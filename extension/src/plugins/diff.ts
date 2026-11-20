// Line diff for the plugin update review (specs/09 §4.5, R27). Pure.

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

/** Above this many lines on either side the diff is skipped (the review shows the new file instead). */
export const MAX_DIFF_LINES = 2000;

/** LCS line diff. Returns null when either side is too long to diff. */
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before === '' ? [] : before.split(/\r?\n/);
  const b = after === '' ? [] : after.split(/\r?\n/);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null;
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = LCS length of a[i..] and b[j..], flattened.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

/** Keep changed lines plus `context` unchanged lines around them; gaps become null. */
export function compactDiff(lines: DiffLine[], context = 2): Array<DiffLine | null> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | null> = [];
  lines.forEach((line, index) => {
    if (keep[index]) out.push(line);
    else if (out.length > 0 && out[out.length - 1] !== null) out.push(null);
  });
  if (out[out.length - 1] === null) out.pop();
  return out;
}
