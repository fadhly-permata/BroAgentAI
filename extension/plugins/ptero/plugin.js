// Ptero web chat plugin hooks. See specs/09-WEBCHAT-PLUGINS.md §3.3.
BroAgentAI.registerPlugin('ptero', {
  // Runs before the operating prompt is typed (session start or a switch to Ptero).
  async prepare(api) {
    // Welcome dialog shown on a first visit; it covers the composer.
    api.click('button', { text: /Everything fine/i });
    // In "Smart (Auto)" Ptero's own server-side agent grabs fs.readFile & co.
    // and fails ("Invalid or missing repo"); in "Quick Answer" the model writes
    // the fenced JSON commands that BroAgentAI runs.
    api.setSelect('#chat-mode-select', 'quick');
    await api.sleep(150);
  },
});
