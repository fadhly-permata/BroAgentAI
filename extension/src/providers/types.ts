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
  /** Number of assistant messages currently on the page. */
  count: number;
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
