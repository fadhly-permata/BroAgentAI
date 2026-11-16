import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.json" with { type: "json" };

export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    rollupOptions: {
      // editor.html is opened via chrome.tabs.create, not referenced by the
      // manifest, so it must be listed here or it is missing from dist.
      input: { editor: "src/editor.html" },
    },
  },
});
