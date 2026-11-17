// MAIN-world helper, injected next to the relay on provider pages. The relay
// runs in an isolated world and cannot see the page's own JavaScript objects;
// some pages (Qwen) render code in an editor that only draws the lines on
// screen, so the full reply exists only as markdown in the page's React props.
//
// Protocol: the relay dispatches PAGE_SOURCE_EVENT on an element; DOM events
// cross worlds synchronously, so by the time dispatchEvent returns this
// listener has put the markdown into PAGE_SOURCE_ATTR (or left it absent).
// Read-only: it never calls page code, only reads props React already holds.
// Self-contained on purpose (IIFE build, no imports): the constants mirror
// providers/reply-text.ts.
const EVENT = 'broagentai:page-source';
const ATTR = 'data-broagentai-source';
/** Prop names that hold markdown in common React markdown renderers. */
const NAMES = ['content', 'markdown', 'source', 'children', 'text', 'value'];
const MAX_UP = 4;

interface Fiber { memoizedProps?: unknown; return?: Fiber | null }

function sourceOf(el: Element): string | null {
  const key = Object.keys(el).find((name) => name.startsWith('__reactFiber$'));
  let fiber = key ? (el as unknown as Record<string, Fiber>)[key] : null;
  for (let depth = 0; fiber && depth <= MAX_UP; depth++, fiber = fiber.return ?? null) {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== 'object') continue;
    for (const name of NAMES) {
      const value = (props as Record<string, unknown>)[name];
      if (typeof value === 'string' && value.trim() !== '') return value;
    }
  }
  return null;
}

document.addEventListener(EVENT, (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  try {
    const source = sourceOf(target);
    if (source !== null) target.setAttribute(ATTR, source);
  } catch {
    // Page internals changed: the relay falls back to the rendered DOM.
  }
}, true);
