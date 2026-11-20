// Exposes BroAgentAI.registerPlugin to plugin.js files. Lives in the content
// script's isolated world, so the chat page itself never sees it. relay.ts
// imports this module BEFORE plugin-scripts.ts, which evaluates the plugin files.
import { registerPlugin } from '../plugins/hooks.js';

declare global {
  // eslint-disable-next-line no-var
  var BroAgentAI: { registerPlugin: typeof registerPlugin };
}

globalThis.BroAgentAI = { registerPlugin };
