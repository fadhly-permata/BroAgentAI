// Install / uninstall the com.broagentai.host native-messaging manifest.
// Usage:
//   node scripts/native-host.mjs install [--extension-id <id>] [--browser chrome|chromium|edge|brave|firefox]
//                                        [--manifest-dir <dir>] [--launcher <file>] [--env KEY=VALUE]... [--dry-run]
//   node scripts/native-host.mjs uninstall [--browser ...] [--manifest-dir <dir>] [--launcher <file>] [--dry-run]
//
// Extension id: --extension-id, or BROAGENTAI_EXTENSION_ID, or (default) the id
// Chromium derives for the unpacked extension loaded from extension/dist.
//
// The manifest cannot carry arguments, so a small launcher runs
// `node bridge/dist/index.js` with the absolute path of the Node.js that runs
// this script (browsers start hosts with a minimal PATH). The launcher lives
// OUTSIDE bridge/dist because the bridge build cleans that folder. One launcher
// serves every browser, so uninstall keeps it while another browser uses it.
//   - Windows: bridge/broagentai-host.cmd. Browsers find the manifest through
//     an HKCU registry key, which is added on install and removed on uninstall.
//   - Linux / macOS: bridge/broagentai-host.sh (mode 0755). Browsers find the
//     manifest by its place in their per-user NativeMessagingHosts folder.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.broagentai.host";
const FIREFOX_EXTENSION_ID = "broagentai@local";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BRIDGE_ENTRY = join(ROOT, "bridge", "dist", "index.js");
const EXTENSION_DIST = join(ROOT, "extension", "dist");
const BROWSERS = ["chrome", "chromium", "edge", "brave", "firefox"];
const IS_WINDOWS = process.platform === "win32";

const REGISTRY_ROOT = {
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  brave: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts",
  firefox: "HKCU\\Software\\Mozilla\\NativeMessagingHosts",
};

function fail(message) {
  console.error(message);
  process.exit(2);
}

function usage() {
  fail(
    "Usage: node scripts/native-host.mjs install [--extension-id <id>] [--browser chrome|chromium|edge|brave|firefox] [--manifest-dir <dir>] [--launcher <file>] [--env KEY=VALUE] [--dry-run]\n" +
    "       node scripts/native-host.mjs uninstall [--browser chrome|chromium|edge|brave|firefox] [--manifest-dir <dir>] [--launcher <file>] [--dry-run]"
  );
}

function parseArgs(argv) {
  const out = { browser: "chrome", dryRun: false, env: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--browser") out.browser = argv[++i];
    else if (a === "--extension-id") out.extensionId = argv[++i];
    else if (a === "--manifest-dir") out.manifestDir = argv[++i];
    else if (a === "--launcher") out.launcher = argv[++i];
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--env") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) usage();
      out.env[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else usage();
  }
  return out;
}

/**
 * Id Chromium assigns to an unpacked extension: SHA-256 of the absolute path
 * (UTF-16LE on Windows, UTF-8 elsewhere), first 32 hex digits mapped to a-p.
 */
export function unpackedExtensionId(absolutePath) {
  const bytes = Buffer.from(absolutePath, IS_WINDOWS ? "utf16le" : "utf8");
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

/**
 * Per-user folder the host manifest goes to. On Linux and macOS the browser
 * finds it there; on Windows the registry key points at it.
 */
function hostDir(browser) {
  const home = homedir();
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    if (browser === "firefox") return join(base, "Mozilla", "NativeMessagingHosts");
    if (browser === "chromium") return join(base, "Chromium", "NativeMessagingHosts");
    if (browser === "edge") return join(base, "Microsoft Edge", "NativeMessagingHosts");
    if (browser === "brave") return join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
    return join(base, "Google", "Chrome", "NativeMessagingHosts");
  }
  if (IS_WINDOWS) {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    if (browser === "firefox") return join(base, "Mozilla", "NativeMessagingHosts");
    if (browser === "chromium") return join(base, "Chromium", "NativeMessagingHosts");
    if (browser === "edge") return join(base, "Microsoft", "Edge", "NativeMessagingHosts");
    if (browser === "brave") return join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
    return join(base, "Google", "Chrome", "NativeMessagingHosts");
  }
  // Linux: Chromium-based browsers keep their profile under $XDG_CONFIG_HOME
  // (default ~/.config) and read per-user hosts from a folder next to it.
  if (browser === "firefox") return join(home, ".mozilla", "native-messaging-hosts");
  const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
  if (browser === "chromium") return join(config, "chromium", "NativeMessagingHosts");
  if (browser === "edge") return join(config, "microsoft-edge", "NativeMessagingHosts");
  if (browser === "brave") return join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
  return join(config, "google-chrome", "NativeMessagingHosts");
}

/** Quote one word for POSIX sh: everything inside single quotes is literal. */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function launcherContent(env) {
  if (IS_WINDOWS) {
    const sets = Object.entries(env).map(([key, value]) => `set "${key}=${value}"`);
    return ["@echo off", ...sets, `"${process.execPath}" "${BRIDGE_ENTRY}" %*`, ""].join("\r\n");
  }
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail(`Invalid environment variable name: ${key}`);
  }
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shQuote(value)}`);
  return ["#!/bin/sh", ...exports, `exec ${shQuote(process.execPath)} ${shQuote(BRIDGE_ENTRY)} "$@"`, ""].join("\n");
}

/** Browsers other than `except` whose default manifest still points at `launcher`. */
function otherUsers(launcher, except) {
  return BROWSERS.filter((browser) => {
    if (browser === except) return false;
    try {
      const m = JSON.parse(readFileSync(join(hostDir(browser), `${HOST_NAME}.json`), "utf8"));
      return typeof m.path === "string" && resolve(m.path) === launcher;
    } catch {
      return false; // no manifest for that browser
    }
  });
}

function manifest({ browser, extensionId, launcher }) {
  const m = {
    name: HOST_NAME,
    description: "BroAgentAI native messaging host (local bridge)",
    path: launcher,
    type: "stdio",
  };
  if (browser === "firefox") m.allowed_extensions = [extensionId];
  else m.allowed_origins = [`chrome-extension://${extensionId}/`];
  return m;
}

function reg(args) {
  execFileSync("reg", args, { stdio: "ignore" });
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "install" && cmd !== "uninstall") usage();
  const opts = parseArgs(rest);
  if (!BROWSERS.includes(opts.browser)) fail(`Unknown browser: ${opts.browser}`);

  const dir = resolve(opts.manifestDir ?? hostDir(opts.browser));
  const file = join(dir, `${HOST_NAME}.json`);
  const launcher = resolve(opts.launcher ?? join(ROOT, "bridge", IS_WINDOWS ? "broagentai-host.cmd" : "broagentai-host.sh"));
  const registryKey = `${REGISTRY_ROOT[opts.browser]}\\${HOST_NAME}`;

  if (cmd === "uninstall") {
    // One launcher serves every browser: keep it while another browser still uses it.
    const users = otherUsers(launcher, opts.browser);
    const kept = users.length > 0 ? `${launcher} (still used by ${users.join(", ")})` : null;
    if (opts.dryRun) {
      console.log(`Would remove ${file}`);
      console.log(kept ? `Would keep ${kept}` : `Would remove ${launcher}`);
      if (IS_WINDOWS) console.log(`Would remove registry key ${registryKey}`);
      return;
    }
    rmSync(file, { force: true });
    console.log(`Removed ${file}`);
    if (kept) console.log(`Kept ${kept}`);
    else {
      rmSync(launcher, { force: true });
      console.log(`Removed ${launcher}`);
    }
    if (IS_WINDOWS) {
      try { reg(["delete", registryKey, "/f"]); console.log(`Removed registry key ${registryKey}`); }
      catch { /* key was not present */ }
    }
    return;
  }

  const extensionId = opts.extensionId ?? process.env.BROAGENTAI_EXTENSION_ID ?? (opts.browser === "firefox" ? FIREFOX_EXTENSION_ID : unpackedExtensionId(EXTENSION_DIST));
  if (opts.browser === "firefox") {
    if (!/^[a-z0-9.@-]+$/.test(extensionId)) fail(`Invalid Firefox add-on id: ${extensionId}`);
  } else if (!/^[a-p]{32}$/.test(extensionId)) fail(`Invalid extension id: ${extensionId}`);
  if (!existsSync(BRIDGE_ENTRY)) fail(`Bridge is not built: ${BRIDGE_ENTRY} is missing. Run "npm run build" first.`);

  const manifestText = JSON.stringify(manifest({ browser: opts.browser, extensionId, launcher }), null, 2) + "\n";
  const launcherText = launcherContent(opts.env);
  if (opts.dryRun) {
    console.log(`Would write ${launcher}:\n${launcherText}`);
    console.log(`Would write ${file}:\n${manifestText}`);
    if (IS_WINDOWS) console.log(`Would set registry key ${registryKey}`);
    return;
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(launcher, launcherText);
  if (!IS_WINDOWS) chmodSync(launcher, 0o755);
  writeFileSync(file, manifestText); // no BOM: browsers reject a manifest that starts with one
  console.log(`Wrote ${launcher}`);
  console.log(`Wrote ${file}`);
  if (IS_WINDOWS) {
    reg(["add", registryKey, "/ve", "/t", "REG_SZ", "/d", file, "/f"]);
    console.log(`Set registry key ${registryKey}`);
  }
  console.log(`Extension id: ${extensionId}`);
  if (!opts.extensionId && !process.env.BROAGENTAI_EXTENSION_ID) {
    console.log(`  (derived from ${EXTENSION_DIST}; load the unpacked extension from exactly that folder)`);
  }
  console.log("Reload the extension in the browser to reconnect.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
