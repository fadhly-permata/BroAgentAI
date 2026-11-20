/**
 * Co-authored-by trailers for commits made through BroAgentAI.
 *
 * Every commit credits BUILT_IN_CO_AUTHORS. Users can add more as
 * `coAuthors` (a list of "Name <email>") in ~/.broagentai/config.json,
 * <workspace>/broagentai.jsonc or <workspace>/.broagentai/config.json
 * (see config.ts). GitHub credits a co-author by email; for a GitHub
 * account use its noreply address, "<id>+<login>@users.noreply.github.com".
 */

/** Credited on every commit made through BroAgentAI, ahead of any configured co-authors. */
export const BUILT_IN_CO_AUTHORS: readonly string[] = [
  "Fadhly Permata <8925077+fadhly-permata@users.noreply.github.com>",
  // The BroAgentAI GitHub App's bot account (github.com/apps/broagentai).
  "BroAgentAI <359335139+broagentai[bot]@users.noreply.github.com>",
];

/** Built-in co-authors first, then the configured ones (duplicates by email are dropped later). */
export function commitCoAuthors(configured: readonly string[]): string[] {
  return [...BUILT_IN_CO_AUTHORS, ...configured];
}

const CO_AUTHOR_RE = /^[^<>\r\n]+ <[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+>$/;
const TRAILER_LINE_RE = /^[A-Za-z0-9-]+:\s.+$/;
export const MAX_CO_AUTHORS = 10;

/** True for one well-formed "Name <email>" entry. */
export function isCoAuthor(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && CO_AUTHOR_RE.test(value.trim());
}

/** Keep the well-formed entries (trimmed, de-duplicated by email, at most MAX_CO_AUTHORS). */
export function normalizeCoAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (!isCoAuthor(entry)) continue;
    const trimmed = entry.trim();
    const email = trimmed.slice(trimmed.lastIndexOf("<")).toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push(trimmed);
    if (out.length >= MAX_CO_AUTHORS) break;
  }
  return out;
}

/**
 * Append a Co-authored-by trailer per co-author that the message does not
 * credit yet (matched by email, case-insensitive). Trailers go into the
 * message's existing trailer block when it ends with one, else into a new
 * paragraph, as git interpret-trailers would place them.
 */
export function addCoAuthorTrailers(message: string, coAuthors: readonly string[]): string {
  const body = message.replace(/\s+$/, "");
  const present = new Set(
    body.split("\n")
      .map((line) => /^co-authored-by:\s*.*(<[^>]+>)\s*$/i.exec(line.trim())?.[1]?.toLowerCase())
      .filter((email): email is string => !!email),
  );
  const lines = normalizeCoAuthors(coAuthors)
    .filter((entry) => !present.has(entry.slice(entry.lastIndexOf("<")).toLowerCase()))
    .map((entry) => `Co-authored-by: ${entry}`);
  if (lines.length === 0) return body;

  const paragraphs = body.split(/\n[ \t]*\n/);
  const last = paragraphs[paragraphs.length - 1];
  const endsWithTrailers = paragraphs.length > 1 && last.split("\n").every((line) => TRAILER_LINE_RE.test(line.trim()));
  return endsWithTrailers ? `${body}\n${lines.join("\n")}` : `${body}\n\n${lines.join("\n")}`;
}
