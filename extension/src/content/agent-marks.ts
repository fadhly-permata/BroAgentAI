// Marks the chat messages the agent typed (operating prompt, tool results,
// format corrections) so they no longer look like the user's own messages.
//
// Detection is by text only: every agent message starts with a fixed marker
// (agentMessageKind). Nothing is stored, so the marks come back after a page
// reload and on virtualized lists that re-create message nodes. Styling only
// sets attributes and pseudo-elements on the page's own nodes - it never adds
// or removes children, which would upset the page's framework, and it never
// changes layout size, which virtualized lists measure.
import { agentMessageKind, PROMPT_HEADING, NOTE_TAG, type AgentMessage } from '../agent-parser.js';
import type { ProviderInfo } from '../providers/types.js';

const ATTR = 'data-ba-agent';
const LABEL_ATTR = 'data-ba-agent-label';
const STYLE_ID = 'ba-agent-style';
/** How far up from the marker text a message bubble may sit. */
const MAX_CLIMB = 8;
const SCAN_DELAY_MS = 300;

const CSS = `
[${ATTR}] {
  position: relative !important;
  background-color: rgba(0, 122, 204, 0.12) !important;
  box-shadow: inset 3px 0 0 #007acc !important;
  border-radius: 8px;
}
[${ATTR}]::after {
  content: attr(${LABEL_ATTR});
  /* Inside the top-right corner: bubbles often clip overflow, and every agent
     message starts with a short first line, so this corner is free. */
  position: absolute; top: 6px; right: 8px; z-index: 1;
  padding: 1px 7px;
  border-radius: 9px;
  background: #007acc; color: #ffffff;
  font: 600 10px/16px 'Segoe UI', system-ui, -apple-system, sans-serif;
  letter-spacing: 0.02em;
  white-space: nowrap;
  pointer-events: none;
}
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
  if (userMessage) return start.closest<HTMLElement>(userMessage);

  const marker = (textNode.data.trimStart().split('\n')[0] ?? '').slice(0, 40);
  const chain: HTMLElement[] = [];
  let el: HTMLElement | null = start;
  for (let depth = 0; el && el !== document.body && depth < MAX_CLIMB; depth++, el = el.parentElement) {
    const text = (el.textContent ?? '').trimStart();
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
    const bubble = bubbleFor(node, provider);
    if (!bubble || bubble.hasAttribute(ATTR)) continue;
    const msg = agentMessageKind(bubble.textContent ?? '');
    if (!msg) continue;
    const { kind, text } = label(msg);
    bubble.setAttribute(ATTR, kind);
    bubble.setAttribute(LABEL_ATTR, text);
    bubble.title = 'Sent automatically by BroAgentAI, not typed by you';
  }
}

/** Start marking agent messages on this chat page; runs for the page's lifetime. */
export function startAgentMarks(provider: ProviderInfo): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head ?? document.documentElement).appendChild(style);
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
