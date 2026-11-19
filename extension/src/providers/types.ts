// Provider contract. A provider comes from a web chat plugin's plugin.json
// (extension/plugins/<id>/, see src/plugins/manifest.ts): URL patterns plus DOM
// selectors. The shared DOM adapter interprets the selectors, so a provider can
// never reach files, Git or MCP.

export interface ProviderSelectors {
  /** Prompt input: a <textarea>/<input> or a contenteditable element. */
  composer: string;
  /** Send button. Empty = submit with the Enter key. */
  submit?: string;
  /** One element per assistant reply, in document order. */
  assistantMessage: string;
  /**
   * One element per user message (the bubble). Optional: without it the
   * agent-message highlighter finds the bubble from the text itself.
   */
  userMessage?: string;
  /** Present while the AI is still generating (e.g. a Stop button). Empty = detect by text stability. */
  generating?: string;
  /**
   * Attribute (on the message element or an ancestor) holding a number that
   * grows with each new message. Needed on pages that virtualize the message
   * list: old messages leave and re-enter the DOM while scrolling, so "the last
   * assistant element" is not always the newest reply.
   */
  messageKeyAttr?: string;
  /**
   * One element per code line, inside a reply's <pre>. For pages that render
   * code in an editor widget (language label, toolbar, line-number gutter):
   * the code is rebuilt from these lines instead of the block's whole text.
   */
  codeLine?: string;
  /**
   * One element per code block inside a reply, for pages whose code blocks are
   * not a <pre> (e.g. an editor widget that draws only the lines on screen).
   * Each block's code is read from the page's React props through the
   * MAIN-world helper first, then from codeLine lines, then from its
   * code/pre text. Default: the reply's <pre> elements.
   */
  codeBlock?: string;
  /**
   * Element(s) inside a reply whose React props hold the reply's markdown
   * (read by the MAIN-world helper content/page-source.iife.ts). Preferred
   * over the rendered DOM when set and readable: it has every code line, even
   * ones an editor widget has not drawn.
   */
  markdownSource?: string;
  /**
   * Elements inside a reply that are page chrome, not what the model wrote
   * (suggestion chips, code block headers). Their text is cut from the reply
   * text; code blocks are still read from <pre>.
   */
  exclude?: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description?: string;
  homepage: string;
  /** Chrome match patterns, e.g. https://chat.example.com/* */
  matchPatterns: string[];
  /**
   * "ready": selectors verified against the live site.
   * "experimental": selectors are best-effort and may need adjusting.
   */
  status: 'ready' | 'experimental';
  selectors: ProviderSelectors;
  /** Plugin version (semver) and author, from plugin.json. */
  version?: string;
  author?: string;
  /** URL of the plugin's icon, when it ships one. */
  icon?: string;
  /** Text of the plugin's style.css: how BroAgentAI's marks look on this site. */
  style?: string;
}

export interface ProviderReply {
  /** Number of assistant messages currently in the DOM (not the conversation length on virtualized pages). */
  count: number;
  /** Ordering key of the latest message when the provider exposes one, else null. */
  key: number | null;
  /** Visible text of the latest assistant message. */
  text: string;
  /** Contents of code blocks inside the latest message, in order. */
  codeBlocks: string[];
}

export interface ProviderHealth {
  ok: boolean;
  provider: string;
  composer: boolean;
  messages: number;
}
