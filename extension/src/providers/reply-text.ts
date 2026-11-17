// Pure helpers that turn what a chat page shows into the reply the parser
// reads. No DOM here: the DOM part stays in dom-adapter.ts, so these are
// unit-tested with node:test.

/** Shared with the MAIN-world helper (content/page-source.iife.ts). */
export const PAGE_SOURCE_EVENT = 'broagentai:page-source';
export const PAGE_SOURCE_ATTR = 'data-broagentai-source';

/**
 * Contents of the fenced code blocks in markdown, in order. A fence closes only
 * on the same character repeated at least as often, so a JSON string that
 * holds a shorter ``` fence does not end the block early. An unclosed fence
 * (reply cut off) runs to the end.
 */
export function fencedBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let open: { fence: string; lines: string[] } | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
        blocks.push(open.lines.join('\n'));
        open = null;
      } else {
        open.lines.push(line);
      }
      continue;
    }
    const start = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (start && !(start[1][0] === '`' && start[2].includes('`'))) open = { fence: start[1], lines: [] };
  }
  if (open) blocks.push(open.lines.join('\n'));
  return blocks;
}

/** Index of needle in text at or after `from`, only where it fills whole lines. */
function indexOfLines(text: string, needle: string, from: number): number {
  for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + 1)) {
    const end = at + needle.length;
    if ((at === 0 || text[at - 1] === '\n') && (end === text.length || text[end] === '\n')) return at;
  }
  return -1;
}

/**
 * Cut the rendered text of page chrome inside a reply (suggestion chips, code
 * block headers) out of the reply text, in order. Chrome elements are blocks,
 * so a part only matches whole lines: a "Bash" label never eats the word in
 * "a Bash script". A part not found is skipped.
 */
export function cutText(text: string, parts: string[]): string {
  let out = '';
  let cursor = 0;
  for (const part of parts) {
    const needle = part.trim();
    if (needle === '') continue;
    const at = indexOfLines(text, needle, cursor);
    if (at < 0) continue;
    out += text.slice(cursor, at);
    cursor = at + needle.length;
  }
  return (out + text.slice(cursor)).replace(/\n{3,}/g, '\n\n').trim();
}

export interface RenderedLine {
  /** Inline `top` style of the line ("40px"); editors position lines absolutely. */
  top: string;
  text: string;
}

/**
 * Code from the lines an editor widget (Qwen uses Monaco) rendered, ordered by
 * position, editor spaces made plain. Editors render only the lines on screen,
 * so this is a fallback for when the page's markdown source is unavailable.
 */
export function joinLines(lines: RenderedLine[]): string {
  const tops = lines.map((line) => parseFloat(line.top));
  const ordered = tops.every(Number.isFinite)
    ? lines.map((line, i) => ({ line, top: tops[i] })).sort((a, b) => a.top - b.top).map((entry) => entry.line)
    : lines;
  return ordered.map((line) => line.text.replace(/ /g, ' ').replace(/​/g, '')).join('\n');
}

/**
 * Replace each rendered code block (language label, toolbar and line-number
 * gutter included) inside the reply text with a fenced copy of its code, in
 * order. A block whose rendered text is not found is left alone.
 */
export function spliceCode(text: string, blocks: { rendered: string; code: string }[]): string {
  let out = '';
  let cursor = 0;
  for (const block of blocks) {
    const rendered = block.rendered.trim();
    if (rendered === '') continue;
    const at = text.indexOf(rendered, cursor);
    if (at < 0) continue;
    out += text.slice(cursor, at) + '```\n' + block.code + '\n```';
    cursor = at + rendered.length;
  }
  return out + text.slice(cursor);
}
