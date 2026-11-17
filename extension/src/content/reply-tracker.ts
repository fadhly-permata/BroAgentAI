// Decides when the latest assistant reply on a chat page is new and finished,
// and remembers what was already handed to the side panel. Pure logic (no DOM,
// no timers) so the relay can feed it from any source - its own interval or
// the side panel's tick - and tests can drive it with a fake clock.

export interface ReplySnapshot {
  /** Number of assistant messages in the DOM. */
  count: number;
  /** Ordering key of the latest message, when the provider exposes one. */
  key: number | null;
  /** Visible text of the latest message. */
  text: string;
}

export class ReplyTracker {
  readonly stableMs: number;
  #reported: ReplySnapshot = { count: 0, key: null, text: '' };
  #candidate: (ReplySnapshot & { since: number }) | null = null;
  #inFlight = false;

  /** @param stableMs a reply counts as finished once its text stayed unchanged this long. */
  constructor(stableMs: number) {
    this.stableMs = stableMs;
  }

  /** Everything currently on the page belongs to the past; only later replies are reported. */
  reset(current: ReplySnapshot): void {
    this.#reported = { count: current.count, key: current.key, text: current.text };
    this.#candidate = null;
    this.#inFlight = false;
  }

  /**
   * Is this reply one we have not handled yet?
   * With an ordering key the answer does not depend on what is currently in
   * the DOM: an older message that scrolled back into view has a lower key and
   * is never treated as new. Without a key, fall back to count + text.
   */
  isNew(reply: ReplySnapshot): boolean {
    const reported = this.#reported;
    if (reply.key !== null && reported.key !== null) {
      if (reply.key < reported.key) return false;
      return reply.key > reported.key || reply.text !== reported.text;
    }
    return reply.count !== reported.count || reply.text !== reported.text;
  }

  /**
   * Feed one observation of the page. Returns the reply to deliver now, or
   * null. A returned reply stays "in flight" until delivered() or failed().
   */
  observe(reply: ReplySnapshot, generating: boolean, now: number): ReplySnapshot | null {
    if (this.#inFlight) return null;
    if (reply.count === 0 || generating) {
      this.#candidate = null;
      return null;
    }
    if (!this.isNew(reply)) return null;

    const c = this.#candidate;
    if (!c || c.key !== reply.key || c.count !== reply.count || c.text !== reply.text) {
      this.#candidate = { count: reply.count, key: reply.key, text: reply.text, since: now };
      return null;
    }
    if (now - c.since < this.stableMs || reply.text.trim() === '') return null;
    this.#inFlight = true;
    return { count: reply.count, key: reply.key, text: reply.text };
  }

  /** The side panel took the reply: never report it again. */
  delivered(reply: ReplySnapshot): void {
    this.#reported = { count: reply.count, key: reply.key, text: reply.text };
    this.#candidate = null;
    this.#inFlight = false;
  }

  /** Nobody took the reply (panel busy, reloading or closed): offer it again later. */
  failed(): void {
    this.#inFlight = false;
  }
}
