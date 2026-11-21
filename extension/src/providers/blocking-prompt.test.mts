import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BLOCKED, blockingPending, findBlockingPrompt, GENERATING_GRACE_MS, isBillingControl, MAX_PENDING_CHARS, MAX_RENEWALS, newChatReady,
  RENEW_COOLDOWN_MS, renewalContext, renewDecision, sendFailureAction, type PromptElement, type PromptTextNode,
} from './blocking-prompt.ts';
import type { BlockingPromptRule } from './types.ts';

const chatgpt = JSON.parse(readFileSync(fileURLToPath(new URL('../../plugins/chatgpt/plugin.json', import.meta.url)), 'utf8'));
const rules: BlockingPromptRule[] = chatgpt.blockingPrompts;
const SKIP = '.assistant, .user';

/** A tiny element: enough DOM for the matcher (class/tag selectors, buttons, text). */
class El implements PromptElement {
  parentElement: El | null = null;
  readonly children: El[];
  readonly tag: string;
  readonly attrs: Record<string, string>;
  constructor(tag: string, attrs: Record<string, string> = {}, children: (El | string)[] = []) {
    this.tag = tag;
    this.attrs = attrs;
    this.children = children.map((child) => (typeof child === 'string' ? new El('#text', { data: child }) : child));
    for (const child of this.children) child.parentElement = this;
  }
  get textContent(): string {
    return this.tag === '#text' ? this.attrs.data : this.children.map((c) => c.textContent).join(' ');
  }
  getAttribute(name: string): string | null { return this.attrs[name] ?? null; }
  matches(selector: string): boolean {
    return selector.split(',').map((s) => s.trim()).some((s) =>
      s === this.tag
      || (s.startsWith('.') && (this.attrs.class ?? '').split(' ').includes(s.slice(1)))
      || (s === '[role="button"]' && this.attrs.role === 'button'));
  }
  closest(selector: string): El | null {
    for (let el: El | null = this; el; el = el.parentElement) if (el.tag !== '#text' && el.matches(selector)) return el;
    return null;
  }
  *descendants(): Generator<El> {
    for (const child of this.children) { yield child; yield* child.descendants(); }
  }
  querySelectorAll(selector: string): El[] {
    return [...this.descendants()].filter((el) => el.tag !== '#text' && el.matches(selector));
  }
  /** Text nodes as the DOM adapter hands them in. */
  texts(): PromptTextNode[] {
    return [...this.descendants()].filter((el) => el.tag === '#text').map((el) => ({ data: el.attrs.data, parentElement: el.parentElement }));
  }
}

const h = (tag: string, attrs: Record<string, string>, ...children: (El | string)[]) => new El(tag, attrs, children);

const sidebar = () => h('nav', {}, h('a', { href: '/' }, 'New chat'), h('a', { href: '/c/1' }, 'Old conversation'), h('a', { href: '/pricing' }, 'Upgrade plan'));
const banner = (buttons: El[] = [h('button', {}, 'New chat'), h('button', {}, h('svg', {}), 'Upgrade to Plus')]) => h('div', { class: 'banner' },
  h('div', {}, h('div', {}, 'Context window full'), h('p', {}, 'Start a new chat with an automatic summary of this conversation, or upgrade to continue here with more context available in every chat.')),
  h('div', {}, ...buttons));
const reply = (text: string) => h('div', { class: 'assistant' }, h('p', {}, text));

function page(...main: El[]): El {
  return h('body', {}, sidebar(), h('main', {}, reply('Manifest Stack Overflow berhasil ditulis.'), ...main));
}

test('the ChatGPT plugin ships the Context window full rule', () => {
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'context-window-full');
  assert.equal(rules[0].action, 'new-chat');
});

test('finds the banner and picks its New chat button, not Upgrade to Plus', () => {
  const body = page(banner());
  const match = findBlockingPrompt<El>(body.texts(), rules, { skip: SKIP });
  assert.ok(match);
  assert.equal(match.rule.id, 'context-window-full');
  assert.equal(match.button.textContent.trim(), 'New chat');
  assert.equal(match.button.closest('.banner') !== null, true, 'the button is inside the banner');
});

test('banner above a composer that still holds the stuck tool result (live layout) is found', () => {
  // As seen live: disclaimer line, then the banner, then the composer with the
  // typed tool result and its send button (which ChatGPT's `generating` selector matches).
  const stuck = '[BroAgentAI tool result] fs.writeFile OK {"path": "extension/plugins/stackoverflow/plugin.json", "mtime": "2026-11-21T03:03:00Z"} ' + 'x'.repeat(700);
  const composerArea = h('div', { class: 'composer-area' },
    h('div', {}, 'ChatGPT can make mistakes. Check important info.'),
    banner(),
    h('form', {}, h('div', { class: 'composer' }, h('p', {}, stuck)), h('button', { class: 'size-token-button-composer' }, h('svg', {}))));
  const body = page(composerArea);
  const match = findBlockingPrompt<El>(body.texts(), rules, { skip: SKIP });
  assert.equal(match?.button.textContent.trim(), 'New chat');
  assert.ok(match?.button.closest('.banner'));
});

test('sendFailureAction: banner + composer still there + send not accepted opens a new chat, never retries', () => {
  const idle = { renewing: false, renewBlocked: false };
  // The relay saw the banner itself (before typing, or after the refused send).
  assert.deepEqual(sendFailureAction({ code: BLOCKED, blocking: 'context-window-full' }, idle, 1, 3), { kind: 'renew', id: 'context-window-full' });
  // NOT_ACCEPTED (text kept in the input) and the panel's own check sees the banner: not a rate limit.
  assert.deepEqual(sendFailureAction({ code: 'NOT_ACCEPTED' }, idle, 1, 3, 'context-window-full'), { kind: 'renew', id: 'context-window-full' });
  assert.deepEqual(sendFailureAction({ code: 'SEND_FAILED' }, idle, 3, 3, 'context-window-full'), { kind: 'renew', id: 'context-window-full' });
  // Already gave up, or a new chat is being opened: no click, no retry.
  assert.deepEqual(sendFailureAction({ code: 'NOT_ACCEPTED' }, { renewBlocked: true }, 1, 3, 'context-window-full'), { kind: 'blocked', id: 'context-window-full' });
  assert.deepEqual(sendFailureAction({ code: BLOCKED, blocking: 'context-window-full' }, { renewing: true }, 1, 3), { kind: 'blocked', id: 'context-window-full' });
  // Without a banner the old behaviour stays: retry a refused send, then fail.
  assert.deepEqual(sendFailureAction({ code: 'NOT_ACCEPTED' }, idle, 1, 3), { kind: 'retry' });
  assert.deepEqual(sendFailureAction({ code: 'NOT_ACCEPTED' }, idle, 3, 3), { kind: 'fail' });
  assert.deepEqual(sendFailureAction({ code: 'UNREACHABLE' }, idle, 1, 3), { kind: 'fail' });
  assert.deepEqual(sendFailureAction({ code: 'PAUSED' }, idle, 1, 3, 'context-window-full'), { kind: 'paused' });
});

test('newChatReady: needs a composer and no banner; "generating" only delays it', () => {
  assert.equal(newChatReady({ composer: true, blocking: null, generating: false }, 0), true);
  assert.equal(newChatReady({ composer: false, blocking: null, generating: false }, 60_000), false);
  assert.equal(newChatReady({ composer: true, blocking: 'context-window-full', generating: false }, 60_000), false);
  // A draft left in the composer shows the send button, which reads as generating.
  assert.equal(newChatReady({ composer: true, blocking: null, generating: true }, 1_000), false);
  assert.equal(newChatReady({ composer: true, blocking: null, generating: true }, GENERATING_GRACE_MS), true);
});

test('the sidebar New chat link alone is not a blocking prompt', () => {
  assert.equal(findBlockingPrompt(page().texts(), rules, { skip: SKIP }), null);
});

test('a title without its button nearby does not count (the sidebar link is too far)', () => {
  const titleOnly = h('div', {}, h('div', {}, 'Context window full'), h('p', {}, 'x '.repeat(500)));
  assert.equal(findBlockingPrompt(page(titleOnly).texts(), rules, { skip: SKIP }), null);
});

test('a banner whose own button is missing never falls back to the sidebar link', () => {
  // Small page: the climb would reach <body> (and the sidebar's "New chat")
  // within the size limit; it stops at the chat column, which holds messages.
  const noButton = page(banner([h('button', {}, 'Dismiss')]));
  assert.equal(findBlockingPrompt(noButton.texts(), rules, { skip: SKIP }), null);
});

test('a reply that quotes the banner is ignored', () => {
  const quoting = h('div', { class: 'assistant' }, h('div', {}, 'Context window full'), h('button', {}, 'New chat'));
  assert.equal(findBlockingPrompt(page(quoting).texts(), rules, { skip: SKIP }), null);
});

test('a hidden banner is ignored', () => {
  const body = page(banner());
  const hidden = (el: PromptElement) => (el as El).closest('.banner') === null;
  assert.equal(findBlockingPrompt(body.texts(), rules, { skip: SKIP, visible: hidden }), null);
});

test('upgrade and billing buttons are never picked, even by a loose rule', () => {
  const loose: BlockingPromptRule[] = [{ id: 'loose', text: 'context window full', button: 'upgrade|plus|chat', action: 'new-chat' }];
  const upgradeOnly = page(banner([h('button', {}, h('svg', {}), 'Upgrade to Plus'), h('a', { href: '/pricing' }, 'See chat plans')]));
  assert.equal(findBlockingPrompt(upgradeOnly.texts(), loose, { skip: SKIP }), null);
  assert.equal(isBillingControl(h('button', {}, 'Upgrade to Plus')), true);
  assert.equal(isBillingControl(h('button', { 'aria-label': 'Get ChatGPT Plus' }, '')), true);
  assert.equal(isBillingControl(h('a', { href: 'https://chatgpt.com/#pricing' }, 'More')), true);
  assert.equal(isBillingControl(h('button', {}, 'New chat')), false);
});

test('role=button controls count, and nothing matches without rules or with an unknown action', () => {
  const body = page(banner([h('div', { role: 'button' }, 'New chat')]));
  assert.equal(findBlockingPrompt<El>(body.texts(), rules, { skip: SKIP })?.button.tag, 'div');
  assert.equal(findBlockingPrompt(body.texts(), undefined), null);
  assert.equal(findBlockingPrompt(body.texts(), []), null);
  assert.equal(findBlockingPrompt(body.texts(), [{ ...rules[0], action: 'click' as 'new-chat' }]), null);
  assert.equal(findBlockingPrompt(body.texts(), [{ ...rules[0], text: '(broken' }]), null);
});

test('renewDecision: acts, then stops when the banner is back right away or after too many new chats', () => {
  const now = 1_000_000;
  assert.deepEqual(renewDecision({ count: 0, lastAt: null }, now), { act: true });
  assert.deepEqual(renewDecision({ count: 1, lastAt: now - 5_000 }, now), { act: false, reason: 'too-soon' });
  assert.deepEqual(renewDecision({ count: 1, lastAt: now - RENEW_COOLDOWN_MS }, now), { act: true });
  assert.deepEqual(renewDecision({ count: MAX_RENEWALS, lastAt: null }, now), { act: false, reason: 'too-many' });
});

test('blockingPending: an undelivered message, else the unanswered last message, else nothing', () => {
  assert.equal(blockingPending({ undelivered: 'tool result', awaitingReply: false, lastSent: 'older' }), 'tool result');
  assert.equal(blockingPending({ undelivered: null, awaitingReply: true, lastSent: 'sent' }), 'sent');
  // A final answer came: the user's turn, nothing to carry over.
  assert.equal(blockingPending({ undelivered: null, awaitingReply: false, lastSent: 'sent' }), null);
  assert.equal(blockingPending({ awaitingReply: true, lastSent: null }), null);
});

test('renewalContext appends the pending message, clipped', () => {
  assert.equal(renewalContext('HANDOFF', null), 'HANDOFF');
  assert.equal(renewalContext('HANDOFF', '   '), 'HANDOFF');
  const withPending = renewalContext('HANDOFF', '[BroAgentAI tool result] shell.run ok');
  assert.ok(withPending.startsWith('HANDOFF\n\n## Pesan Terakhir yang Belum Dijawab'));
  assert.ok(withPending.endsWith('[BroAgentAI tool result] shell.run ok'));
  const long = renewalContext('H', 'x'.repeat(MAX_PENDING_CHARS + 100));
  assert.ok(long.includes('(dipotong dari ' + (MAX_PENDING_CHARS + 100) + ' karakter)'));
  assert.ok(long.length < MAX_PENDING_CHARS + 400);
});
