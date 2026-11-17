// Provider plugin contract. A provider is DATA (provider.json): URL patterns
// plus DOM selectors. The shared DOM adapter interprets the selectors, so a
// provider can never run its own code or reach files, Git or MCP.

export interface ProviderSelectors {
  /** Prompt input: a <textarea>/<input> or a contenteditable element. */
  composer: string;
  /** Send button. Empty = submit with the Enter key. */
  submit?: string;
  /** One element per assistant reply, in document order. */
  assistantMessage: string;
  /** Present while the AI is still generating (e.g. a Stop button). Empty = detect by text stability. */
  generating?: string;
  /**
   * Attribute (on the message element or an ancestor) holding a number that
   * grows with each new message. Needed on pages that virtualize the message
   * list: old messages leave and re-enter the DOM while scrolling, so "the last
   * assistant element" is not always the newest reply.
   */
  messageKeyAttr?: string;
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
