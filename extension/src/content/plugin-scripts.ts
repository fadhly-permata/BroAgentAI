// Built-in plugin scripts (extension/plugins/<id>/plugin.js), bundled into the
// relay. Each one calls BroAgentAI.registerPlugin(id, hooks), so plugin-global.ts
// must be evaluated first (relay.ts imports it before this module). Every
// built-in script registers on every chat page; the relay only runs the hooks
// of the plugin that matches the page.
import.meta.glob('../../plugins/*/plugin.js', { eager: true });
