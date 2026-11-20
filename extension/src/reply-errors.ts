// Failed generations: a web chat that could not produce an answer shows its own
// failure text where the reply would be ("Something went wrong generating that
// response"). Read as a reply, that plain prose looks like "the task is done"
// and the session silently stops. Plugins list that text as `errorReplies`
// patterns; a reply that matches is retried instead. Pure functions only.

/** Longer replies are real answers that may merely talk about an error. */
export const MAX_ERROR_REPLY_CHARS = 500;
/** Automatic resends after a failed generation, then the user decides. */
export const MAX_ERROR_RETRIES = 2;
/** Pause before each automatic resend (the site may be briefly overloaded). */
export const ERROR_RETRY_DELAYS_MS: readonly number[] = [3_000, 8_000];

const cache = new Map<string, RegExp | null>();

function compile(source: string): RegExp | null {
  let re = cache.get(source);
  if (re === undefined) {
    try { re = new RegExp(source, 'i'); } catch { re = null; }
    cache.set(source, re);
  }
  return re;
}

/** True when `text` is the site's failure message rather than an answer. */
export function isErrorReply(text: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.length > MAX_ERROR_REPLY_CHARS) return false;
  return patterns.some((source) => compile(source)?.test(trimmed) ?? false);
}

/** Delay before resend number `attempt` (1-based), or null when retries are used up. */
export function errorRetryDelay(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ERROR_RETRIES) return null;
  return ERROR_RETRY_DELAYS_MS[Math.min(attempt, ERROR_RETRY_DELAYS_MS.length) - 1];
}
