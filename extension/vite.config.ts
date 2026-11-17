import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import baseManifest from "./manifest.json" with { type: "json" };

// Provider plugins are data files: src/providers/<id>/provider.json. Their URL
// patterns are the ONLY source of host permissions and content-script matches,
// so adding a provider folder updates the manifest without touching core code.
const providersDir = fileURLToPath(new URL("./src/providers", import.meta.url));
const matchPatterns = readdirSync(providersDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(providersDir, entry.name, "provider.json")))
  .flatMap((entry) => JSON.parse(readFileSync(join(providersDir, entry.name, "provider.json"), "utf8")).matchPatterns as string[])
  .sort();

const manifest = {
  ...baseManifest,
  host_permissions: matchPatterns,
  content_scripts: [
    { matches: matchPatterns, js: ["src/content/relay.ts"], run_at: "document_idle" },
    // Reads a reply's markdown from the page's own objects for the relay; see the file header.
    { matches: matchPatterns, js: ["src/content/page-source.iife.ts"], run_at: "document_idle", world: "MAIN" as const },
  ],
};

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
