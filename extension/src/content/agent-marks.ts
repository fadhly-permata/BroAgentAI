// Marks the chat messages the agent typed (operating prompt, tool results,
// format corrections) so they no longer look like the user's own messages.
//
// Detection is by text only: every agent message starts with a fixed marker
// (agentMessageKind), so the marks come back after a page reload and on
// virtualized lists that re-create message nodes. Styling only sets attributes
// and pseudo-elements on the page's own nodes - it never adds or removes
// children, which would upset the page's framework.
//
// Agent messages start collapsed (a short preview under the label) so they
// stay out of the way of the user's own chat; a click on a collapsed message
// expands it, a click on the label strip of an expanded one collapses it again.
// The only layout change is that height, which virtualized lists re-measure.
import { agentMessageKind, PROMPT_HEADING, NOTE_TAG, type AgentMessage } from '../agent-parser.js';
import type { ProviderInfo } from '../providers/types.js';

const ATTR = 'data-ba-agent';
const LABEL_ATTR = 'data-ba-agent-label';
const COLLAPSED_ATTR = 'data-ba-collapsed';
const STYLE_ID = 'ba-agent-style';
/** How far up from the marker text a message bubble may sit. */
const MAX_CLIMB = 8;
const SCAN_DELAY_MS = 300;
/**
 * Label strip at the top of every agent message (the badge sits in it, so it
 * never covers the text) and the collapsed height: the strip plus one line.
 * A click inside the strip of an expanded message collapses it.
 */
const HEADER_PX = 28;
const COLLAPSED_PX = 60;
const TITLE_COLLAPSED = 'Sent automatically by BroAgentAI, not typed by you. Click to expand.';
const TITLE_EXPANDED = 'Sent automatically by BroAgentAI, not typed by you. Click the top bar to collapse.';

const MONO = `'Cascadia Code', 'JetBrains Mono', Consolas, 'SFMono-Regular', Menlo, monospace`;

/**
 * Base look, shared by every site. It keeps the page's own bubble shape and
 * side padding (no border-radius here) and only adds: a tint, an accent bar, a
 * label strip on top, monospace text and the collapsed height. Site-specific
 * fixes live in each web chat plugin's style.css (extension/plugins/<id>/).
 */
const CSS = `
[${ATTR}] {
  position: relative !important;
  box-sizing: border-box !important;
  min-width: min(100%, 300px) !important;
  padding-top: ${HEADER_PX}px !important;
  background-color: rgba(0, 122, 204, 0.12) !important;
  box-shadow: inset 3px 0 0 #007acc !important;
}
/* Machine-written text: monospace and a size smaller than the user's own messages.
   Icons are left alone: icon fonts draw glyphs from ligature text ("expand_more"),
   which a text font would print as letters. */
[${ATTR}], [${ATTR}] *:not(mat-icon):not([class*="icon"]):not([class*="symbol"]) {
  font-family: ${MONO} !important;
  font-size: 12px !important;
  line-height: 1.55 !important;
}
[${ATTR}][${COLLAPSED_ATTR}] {
  max-height: ${COLLAPSED_PX}px !important;
  overflow: hidden !important;
  cursor: pointer;
  -webkit-mask-image: linear-gradient(to bottom, #000 75%, transparent);
  mask-image: linear-gradient(to bottom, #000 75%, transparent);
}
[${ATTR}][${COLLAPSED_ATTR}]:hover { background-color: rgba(0, 122, 204, 0.2) !important; }
[${ATTR}]::after {
  content: '\\25BE  ' attr(${LABEL_ATTR});
  /* In the label strip (padding-top), so it never covers the message text. */
  position: absolute; top: 6px; right: 10px; z-index: 1;
  padding: 1px 7px;
  border-radius: 9px;
  background: #007acc; color: #ffffff;
  font: 600 10px/16px 'Segoe UI', system-ui, -apple-system, sans-serif;
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
}
[${ATTR}][${COLLAPSED_ATTR}]::after { content: '\\25B8  ' attr(${LABEL_ATTR}); }
[${ATTR}="error"] { background-color: rgba(241, 76, 76, 0.1) !important; box-shadow: inset 3px 0 0 #f14c4c !important; }
[${ATTR}="error"]::after { background: #c72e2e; }
[${ATTR}="note"] { background-color: rgba(204, 167, 0, 0.1) !important; box-shadow: inset 3px 0 0 #cca700 !important; }
[${ATTR}="note"]::after { background: #8a7100; }
`;

function label(msg: AgentMessage): { kind: string; text: string } {
  if (msg.kind === 'prompt') return { kind: 'prompt', text: 'BroAgentAI · instructions' };
  if (msg.kind === 'note') return { kind: 'note', text: 'BroAgentAI · format correction' };
  return { kind: msg.ok ? 'result' : 'error', text: `BroAgentAI · ${msg.command} ${msg.ok ? '✓' : '✗ error'}` };
}

/** Cheap pre-filter on a text node before the full check. */
function maybeMarker(text: string): boolean {
  const head = text.trimStart();
  // NOTE_TAG minus its "]" also covers "[BroAgentAI tool result]".
  return head.startsWith(NOTE_TAG.slice(0, -1)) || head.replace(/^#+\s*/, '').startsWith(PROMPT_HEADING);
}

/**
 * Screen-reader-only labels that pages put before a message ("You said" on
 * Gemini, inside .cdk-visually-hidden): not shown, so not part of its text.
 */
const HIDDEN_LABELS = '.cdk-visually-hidden, .sr-only, .visually-hidden';

/** textContent without screen-reader-only labels. */
function visibleText(el: Element): string {
  if (!el.querySelector(HIDDEN_LABELS)) return el.textContent ?? '';
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(HIDDEN_LABELS)) hidden.remove();
  return copy.textContent ?? '';
}

const hasBackground = (el: Element) => {
  const bg = getComputedStyle(el).backgroundColor;
  return bg !== '' && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg);
};

/**
 * The message element that holds a marker text node: walk up while the
 * ancestor still starts with the marker and holds no assistant reply, no
 * composer and no other message. Prefer the outermost one that paints a
 * background (the bubble); else the nearest block element.
 */
function bubbleFor(textNode: Text, provider: ProviderInfo): HTMLElement | null {
  const { assistantMessage, composer, userMessage, messageKeyAttr } = provider.selectors;
  const start = textNode.parentElement;
  if (!start) return null;
  if (start.closest(assistantMessage) || start.closest(composer) || start.closest('[contenteditable="true"], textarea, script, style')) return null;
  // On pages whose chat rows carry a message key, a message lives inside such a
  // row. Copies of the text elsewhere (DeepSeek's off-screen conversation
  // outline, for one) are not messages.
  if (messageKeyAttr && !start.closest(`[${messageKeyAttr}]`)) return null;
  if (userMessage) return start.closest<HTMLElement>(userMessage);

  const marker = (textNode.data.trimStart().split('\n')[0] ?? '').slice(0, 40);
  const chain: HTMLElement[] = [];
  let el: HTMLElement | null = start;
  for (let depth = 0; el && el !== document.body && depth < MAX_CLIMB; depth++, el = el.parentElement) {
    const text = visibleText(el).trimStart();
    if (!text.replace(/^#+\s*/, '').startsWith(marker.replace(/^#+\s*/, ''))) break;
    if (el.querySelector(assistantMessage) || el.querySelector(composer)) break;
    chain.push(el);
    if (messageKeyAttr && el.hasAttribute(messageKeyAttr)) break; // one virtual-list row = one message
  }
  if (chain.length === 0) return null;
  for (let i = chain.length - 1; i >= 0; i--) if (hasBackground(chain[i])) return chain[i];
  return chain.find((node) => getComputedStyle(node).display !== 'inline') ?? chain[0];
}

function scan(provider: ProviderInfo): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (maybeMarker((node as Text).data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    // Already marked: skip before bubbleFor, whose getComputedStyle calls force
    // a style recalc - on every scan, while a reply streams, in long chats.
    if (node.parentElement?.closest(`[${ATTR}]`)) continue;
    const bubble = bubbleFor(node, provider);
    if (!bubble || bubble.hasAttribute(ATTR)) continue;
    const msg = agentMessageKind(visibleText(bubble));
    if (!msg) continue;
    const { kind, text } = label(msg);
    bubble.setAttribute(ATTR, kind);
    bubble.setAttribute(LABEL_ATTR, text);
    setCollapsed(bubble, !expanded.has(signature(bubble)));
  }
}

/**
 * Messages the user expanded, by text, so a virtualized list that re-creates
 * the node (scrolling away and back) shows it expanded again. Page lifetime only.
 */
const expanded = new Set<string>();

function signature(bubble: HTMLElement): string {
  const text = visibleText(bubble);
  return `${bubble.getAttribute(ATTR)}|${text.length}|${text.slice(0, 160)}`;
}

function setCollapsed(bubble: HTMLElement, collapsed: boolean): void {
  bubble.toggleAttribute(COLLAPSED_ATTR, collapsed);
  bubble.title = collapsed ? TITLE_COLLAPSED : TITLE_EXPANDED;
}

/**
 * Toggle on click: anywhere on a collapsed message expands it; on an expanded
 * one only the label strip collapses it, so selecting or clicking its text
 * still works. Handled in the capture phase and swallowed, so the page does not
 * also act on the click (e.g. open its edit mode).
 */
function onClick(e: MouseEvent): void {
  if (e.button !== 0) return;
  const bubble = (e.target as Element | null)?.closest?.(`[${ATTR}]`) as HTMLElement | null;
  if (!bubble) return;
  const collapsed = bubble.hasAttribute(COLLAPSED_ATTR);
  if (!collapsed) {
    if (e.clientY - bubble.getBoundingClientRect().top > HEADER_PX) return;
    if (String(window.getSelection() ?? '') !== '') return;
  }
  e.preventDefault();
  e.stopPropagation();
  const sig = signature(bubble);
  if (collapsed) expanded.add(sig); else expanded.delete(sig);
  setCollapsed(bubble, !collapsed);
}

/**
 * Start marking agent messages on this chat page; runs for the page's lifetime.
 * The provider's own style.css (provider.style) is added after the base CSS, so
 * it can override it for this site only.
 */
export function startAgentMarks(provider: ProviderInfo): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS + (provider.style ? `\n/* ${provider.id} plugin style.css */\n${provider.style}` : '');
    (document.head ?? document.documentElement).appendChild(style);
    document.addEventListener('click', onClick, true);
  }
  let timer: number | undefined;
  const schedule = () => {
    if (timer !== undefined) return; // at most one scan per delay window, even while a reply streams
    timer = window.setTimeout(() => {
      timer = undefined;
      try { scan(provider); } catch { /* a page change mid-scan; the next mutation retries */ }
    }, SCAN_DELAY_MS);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
  schedule();
}
