// TuskSearch AI web chat plugin hooks. See specs/09-WEBCHAT-PLUGINS.md §3.3.
BroAgentAI.registerPlugin('tusksearch', {
  // Runs before the operating prompt is typed (session start or a switch to TuskSearch).
  async prepare(api) {
    // The composer toggles between "Search" and "Central AI" and keeps the same
    // textarea; in Search mode a prompt becomes a web search, not a chat turn.
    // Only the inactive button is clicked, so an already-active Central AI stays.
    if (api.click('.search-mode-button:not(.active)', { text: /Central AI/i })) await api.sleep(150);
  },
});
