import { defineConfig } from "vite";

// Second build of the content-script relay as ONE self-contained IIFE file,
// for the sites of user-installed web chat plugins (src/plugins/sync.ts
// registers it with chrome.scripting.registerContentScripts). The manifest's
// relay goes through a CRXJS loader that imports chunks which are only
// web-accessible on built-in plugin sites, so it cannot run elsewhere.
// Runs after the main build and writes into the same dist/ folder.
export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: "src/content/relay.ts",
      formats: ["iife"],
      name: "BroAgentAIRelay",
      fileName: () => "src/content/relay-dynamic.js",
    },
  },
});
