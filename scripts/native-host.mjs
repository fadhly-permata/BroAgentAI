// Install / uninstall the com.browseragent.host native-messaging manifest.
// Usage:
//   node scripts/native-host.mjs install --extension-id <id> [--browser chrome|chromium|firefox] [--dry-run]
//   node scripts/native-host.mjs uninstall [--browser chrome|chromium|firefox]
// Extension id: pass --extension-id, set BROWSERAGENT_EXTENSION_ID, or
// put it in extension/dist/manifest.json (key: "key" is NOT the id; use the
// id Chrome assigns after loading the unpacked extension).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.browseragent.host";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BRIDGE_ENTRY = join(ROOT, "bridge", "dist", "index.js");

function usage() {
  console.error("Usage: node scripts/native-host.mjs install --extension-id <id> [--browser chrome|chromium|firefox] [--dry-run]");
  console.error("       node scripts/native-host.mjs uninstall [--browser chrome|chromium|firefox]");
  process.exitCode = 2;
}

function parseArgs(argv) {
  const out = { browser: "chrome", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--browser") out.browser = argv[++i];
    else if (a === "--extension-id") out.extensionId = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--host-path") out.hostPath = argv[++i];
    else usage();
  }
  return out;
}

function hostDir(browser) {
  const home = homedir();
  const p = process.platform;
  if (p === "darwin") {
    if (browser === "firefox") return join(home, "Library", "Application Support", "Mozilla", "NativeMessagingHosts");
    if (browser === "chromium") return join(home, "Library", "Application Support", "Chromium", "NativeMessagingHosts");
    return join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts");
  }
  if (p === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    if (browser === "firefox") return join(base, "Mozilla", "NativeMessagingHosts");
    if (browser === "chromium") return join(base, "Chromium", "NativeMessagingHosts");
    return join(base, "Google", "Chrome", "NativeMessagingHosts");
  }
  // linux and others
  if (browser === "firefox") return join(home, ".mozilla", "native-messaging-hosts");
  if (browser === "chromium") return join(home, ".config", "chromium", "NativeMessagingHosts");
  return join(home, ".config", "google-chrome", "NativeMessagingHosts");
}

function manifest({ browser, extensionId, hostPath }) {
  const m = {
    name: HOST_NAME,
    description: "BrowserAgent native messaging host (local bridge)",
    path: hostPath ?? process.execPath,
    type: "stdio",
  };
  if (!hostPath) m.args = [BRIDGE_ENTRY];
  if (browser === "firefox") m.allowed_extensions = [extensionId];
  else m.allowed_origins = [`chrome-extension://${extensionId}/`];
  return m;
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== "install" && cmd !== "uninstall") usage();
const opts = parseArgs(rest);
if (!["chrome", "chromium", "firefox"].includes(opts.browser)) { console.error(`Unknown browser: ${opts.browser}`); process.exitCode = 2; }
const dir = hostDir(opts.browser);
const file = join(dir, `${HOST_NAME}.json`);

if (cmd === "uninstall") {
  if (opts.dryRun) console.log(`Would remove ${file}`);
  else { rmSync(file, { force: true }); console.log(`Removed ${file}`); }
  process.exit(0);
}

const extensionId = opts.extensionId ?? process.env.BROWSERAGENT_EXTENSION_ID;
if (!extensionId) {
  console.error("Missing extension id: pass --extension-id <id> or set BROWSERAGENT_EXTENSION_ID.");
  console.error("Find it on chrome://extensions after loading the unpacked extension.");
  process.exitCode = 2;
  process.exit(2);
}
const content = JSON.stringify(manifest({ browser: opts.browser, extensionId, hostPath: opts.hostPath }), null, 2) + "\n";
if (opts.dryRun) { console.log(`Would write ${file}:\n${content}`); process.exit(0); }
mkdirSync(dir, { recursive: true });
writeFileSync(file, content);
console.log(`Wrote ${file}`);
if (process.platform === "win32") {
  console.log("Windows also needs a registry entry pointing at this file:");
  console.log(`  reg add "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}" /ve /t REG_SZ /d "${file}" /f`);
}
