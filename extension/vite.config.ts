import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { crx } from "@crxjs/vite-plugin";
import baseManifest from "./manifest.json" with { type: "json" };
import { validatePluginManifest } from "./src/plugins/manifest.ts";

// Built-in web chat plugins: plugins/<id>/plugin.json. Their URL patterns are
// the ONLY source of host permissions and content-script matches, so adding a
// plugin folder updates the manifest without touching core code. An invalid
// plugin.json (or two plugins claiming the same pattern) fails the build.
const pluginsDir = fileURLToPath(new URL("./plugins", import.meta.url));
const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(pluginsDir, entry.name, "plugin.json")));
const problems: string[] = [];
const seen = new Map<string, string>();
for (const entry of pluginDirs) {
  const result = validatePluginManifest(JSON.parse(readFileSync(join(pluginsDir, entry.name, "plugin.json"), "utf8")));
  if (!result.ok) { problems.push(`plugins/${entry.name}: ${result.errors.join("; ")}`); continue; }
  if (result.plugin.id !== entry.name) problems.push(`plugins/${entry.name}: id "${result.plugin.id}" must match its folder name`);
  for (const key of ["script", "style", "icon"] as const) {
    const file = result.plugin[key];
    if (file && !existsSync(join(pluginsDir, entry.name, file))) problems.push(`plugins/${entry.name}: ${key} "${file}" does not exist`);
  }
  for (const pattern of result.plugin.matches) {
    const owner = seen.get(pattern);
    if (owner) problems.push(`plugins/${entry.name}: pattern ${pattern} is already claimed by ${owner}`);
    seen.set(pattern, entry.name);
  }
}
if (problems.length > 0) throw new Error("Invalid built-in web chat plugins:\n- " + problems.join("\n- "));
const matchPatterns = [...seen.keys()].sort();

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
