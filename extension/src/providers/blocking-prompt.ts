// Blocking prompts: a banner a web chat shows in place of its composer, which
// stops the agent until a button in it is pressed. ChatGPT's "Context window
// full" banner is one: the conversation is too long, the composer is gone, and
// its "New chat" button starts a new chat with a summary. Without help the
// agent stalls there (no composer to type the next tool result into).
//
// Plugins describe such banners declaratively (`blockingPrompts` in
// plugin.json): a regex for the banner's title, a regex for the one button to
// press, and what pressing it does. Shared code never names a site.
//
// Pure functions only: the DOM adapter hands in the page's text nodes, the
// panel the session's history. Billing controls are never pressed, whatever a
// rule says.
import type { BlockingPromptRule } from './types.js';

/** A banner's title is short; longer text is a message or a page section. */
export const MAX_TITLE_CHARS = 200;
/** The banner (title, a line of text, its buttons) stays small; the sidebar or the whole thread does not. */
export const MAX_BANNER_CHARS = 600;
/** How many ancestors of the title are searched for the button. */
export const MAX_CLIMB = 8;
/** Clickable things inside a banner. */
export const BUTTON_SELECTOR = 'button, [role="button"], a';

/** Ticks in a row the banner must be seen before the panel acts (lets a reply that came with it arrive first). */
export const CONFIRM_TICKS = 3;
/** A banner back this soon after a new chat means the new chat did not help: stop instead of clicking again. */
export const RENEW_COOLDOWN_MS = 90_000;
/** New chats opened automatically in one session, at most. */
export const MAX_RENEWALS = 5;

/**
 * Labels of upgrade / payment controls. A button whose text, aria-label or
 * link matches is never pressed, even when a rule's pattern matches it.
 */
const BILLING_RE = /upgrade|subscri|billing|pricing|payment|checkout|purchase|\bbuy\b|\btrial\b|\bplus\b|\bpremium\b|\bpro\b/i;

/** The DOM bits the matcher reads; a real Element satisfies this. */
export interface PromptElement {
  readonly textContent: string | null;
  readonly parentElement: PromptElement | null;
  closest(selectors: string): unknown;
  querySelectorAll(selectors: string): Iterable<PromptElement>;
  getAttribute(name: string): string | null;
}

/** A text node of the page; a real Text satisfies this. */
export interface PromptTextNode {
  readonly data: string;
  readonly parentElement: PromptElement | null;
}

export interface FindOptions {
  /** Selector of areas that are conversation, not page chrome (messages): never a banner. */
  skip?: string;
  /** Visibility check for the title and the button; default: everything counts as visible. */
  visible?: (el: PromptElement) => boolean;
}

export interface BlockingPromptMatch<E extends PromptElement = PromptElement> {
  rule: BlockingPromptRule;
  button: E;
}

const cache = new Map<string, RegExp | null>();

function compile(source: string): RegExp | null {
  let re = cache.get(source);
  if (re === undefined) {
    try { re = new RegExp(source, 'i'); } catch { re = null; }
    cache.set(source, re);
  }
  return re;
}

export const normalize = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** True for an upgrade / billing control (by its text, aria-label, title or link). */
export function isBillingControl(el: PromptElement): boolean {
  const said = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('href')].map(normalize).join(' ');
  return BILLING_RE.test(said);
}

/**
 * The first banner on the page that matches a rule: an element whose own text
 * matches the rule's `text`, inside a small container (at most MAX_BANNER_CHARS
 * of text) that holds a button matching `button`. A "New chat" link elsewhere
 * on the page (the sidebar) is never inside such a container with the title,
 * so it never counts. Text inside `skip` (the messages) is ignored, so a reply
 * that merely quotes the banner does not trigger it.
 */
export function findBlockingPrompt<E extends PromptElement>(
  texts: Iterable<PromptTextNode>,
  rules: readonly BlockingPromptRule[] | undefined,
  options: FindOptions = {},
): BlockingPromptMatch<E> | null {
  if (!rules || rules.length === 0) return null;
  const compiled = rules.flatMap((rule) => {
    const title = compile(rule.text);
    const button = compile(rule.button);
    return title && button && rule.action === 'new-chat' ? [{ rule, title, button }] : [];
  });
  if (compiled.length === 0) return null;
  const visible = options.visible ?? (() => true);
  const seen = new Set<PromptElement>();
  for (const node of texts) {
    if (normalize(node.data) === '') continue;
    const owner = node.parentElement;
    if (!owner || seen.has(owner)) continue;
    seen.add(owner);
    const title = normalize(owner.textContent);
    if (title.length > MAX_TITLE_CHARS) continue;
    const hits = compiled.filter((c) => c.title.test(title));
    if (hits.length === 0) continue;
    if (options.skip && owner.closest(options.skip)) continue;
    if (!visible(owner)) continue;
    for (const { rule, button } of hits) {
      const found = buttonNear<E>(owner, button, visible, options.skip);
      if (found) return { rule, button: found };
    }
  }
  return null;
}

/**
 * The matching button in the smallest ancestor of `title` that has one. The
 * climb stops at the banner size limit and at the first ancestor that holds
 * messages (`skip`): past that point it is the chat column or the page, where
 * a "New chat" link (the sidebar) is not the banner's button.
 */
function buttonNear<E extends PromptElement>(title: PromptElement, pattern: RegExp, visible: (el: PromptElement) => boolean, skip?: string): E | null {
  let box: PromptElement | null = title;
  for (let depth = 0; box && depth <= MAX_CLIMB; depth++, box = box.parentElement) {
    if (normalize(box.textContent).length > MAX_BANNER_CHARS) return null;
    if (skip && !box.querySelectorAll(skip)[Symbol.iterator]().next().done) return null;
    for (const candidate of box.querySelectorAll(BUTTON_SELECTOR)) {
      const label = normalize(candidate.textContent) || normalize(candidate.getAttribute('aria-label'));
      if (label && pattern.test(label) && !isBillingControl(candidate) && visible(candidate)) return candidate as E;
    }
  }
  return null;
}

/** What the session did about blocking prompts so far. */
export interface RenewHistory {
  /** New chats opened automatically in this session. */
  count: number;
  /** When the last one was opened (ms), or null. */
  lastAt: number | null;
}

export type RenewDecision = { act: true } | { act: false; reason: 'too-soon' | 'too-many' };

/**
 * Open a new chat for a blocking prompt, or stop? Stops when the banner is back
 * right after the last new chat (the new chat did not help, clicking again
 * would loop) or after MAX_RENEWALS new chats in one session.
 */
export function renewDecision(history: RenewHistory, now: number): RenewDecision {
  if (history.count >= MAX_RENEWALS) return { act: false, reason: 'too-many' };
  if (history.lastAt !== null && now - history.lastAt < RENEW_COOLDOWN_MS) return { act: false, reason: 'too-soon' };
  return { act: true };
}

/** Relay error code: a blocking prompt shows, so the message was not sent (or not taken). */
export const BLOCKED = 'BLOCKED';

/** A relay's answer to a send that did not go through. */
export interface SendFailure {
  code?: string;
  /** Rule id when the relay saw a blocking prompt (code BLOCKED). */
  blocking?: string | null;
}

export type SendFailureAction =
  | { kind: 'paused' }
  /** Open a new chat through the blocking prompt and carry the message over. */
  | { kind: 'renew'; id: string }
  /** A blocking prompt shows but the automation already gave up (or is busy opening one): no retry. */
  | { kind: 'blocked'; id: string }
  /** Refused without a banner: probably a rate limit, try again later. */
  | { kind: 'retry' }
  | { kind: 'fail' };

/**
 * What to do with a send that did not go through. A blocking prompt wins over
 * everything else: ChatGPT keeps a message in its input under "Context window
 * full" (NOT_ACCEPTED, composer still there), which looks like a rate limit
 * but never clears by retrying. `blockingNow` is the panel's own check for
 * relays that do not report BLOCKED themselves.
 */
export function sendFailureAction(
  res: SendFailure | null | undefined,
  state: { renewing?: boolean; renewBlocked?: boolean },
  attempt: number,
  maxAttempts: number,
  blockingNow: string | null = null,
): SendFailureAction {
  if (res?.code === 'PAUSED') return { kind: 'paused' };
  const id = (res?.code === BLOCKED && typeof res.blocking === 'string' && res.blocking) || blockingNow;
  if (id) return state.renewBlocked || state.renewing ? { kind: 'blocked', id } : { kind: 'renew', id };
  if (res?.code === 'NOT_ACCEPTED' && attempt < maxAttempts) return { kind: 'retry' };
  return { kind: 'fail' };
}

/** How long a new chat may look "generating" before the agent sends anyway. */
export const GENERATING_GRACE_MS = 8_000;

/**
 * Is the new chat (opened through a blocking prompt) ready for the handoff?
 * It needs a composer and no banner. "Generating" only delays it for a while:
 * the site may write its own summary first, but ChatGPT's `generating`
 * selector also matches the send button, which shows whenever the composer
 * holds text (a draft carried over), so waiting on it alone could never end.
 */
export function newChatReady(page: { composer: boolean; blocking: string | null; generating: boolean }, elapsedMs: number): boolean {
  if (!page.composer || page.blocking) return false;
  return !page.generating || elapsedMs >= GENERATING_GRACE_MS;
}

/** The bits of a session that say whether the agent has something in flight. */
export interface PendingState {
  /** An automatic message that could not be typed (the composer was gone). */
  undelivered?: string | null;
  /** The agent's last message is still unanswered. */
  awaitingReply?: boolean;
  lastSent: string | null;
}

/**
 * The agent's message the blocked chat never answered, or null when the agent
 * is not waiting on the chat (a final answer was given: the user's turn). Only
 * a pending message is worth opening a new chat for automatically.
 */
export function blockingPending(state: PendingState): string | null {
  if (state.undelivered) return state.undelivered;
  return state.awaitingReply && state.lastSent ? state.lastSent : null;
}

/** Longest pending message repeated in the new chat (the chat page has an input limit). */
export const MAX_PENDING_CHARS = 8_000;

/**
 * Handoff context for the new chat, plus the agent's message the old chat
 * never answered (a tool result that could not be typed, or one sent just
 * before the banner). The site's own summary does not have it, nor the
 * operating rules, so the agent sends both.
 */
export function renewalContext(handoff: string, pending: string | null): string {
  const body = pending?.trim();
  if (!body) return handoff;
  const shown = body.length <= MAX_PENDING_CHARS ? body : body.slice(0, MAX_PENDING_CHARS) + '\n... (dipotong dari ' + body.length + ' karakter)';
  return handoff + '\n\n## Pesan Terakhir yang Belum Dijawab\nChat sebelumnya penuh sebelum menjawab pesan BroAgentAI ini. Tanggapi pesan ini sekarang (jika hasil tool terpotong, jalankan ulang tool itu bila perlu):\n\n' + shown;
}
