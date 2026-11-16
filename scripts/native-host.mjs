// Install / uninstall the com.broagentai.host native-messaging manifest.
// Usage:
//   node scripts/native-host.mjs install [--extension-id <id>] [--browser chrome|chromium|edge|firefox]
//                                        [--manifest-dir <dir>] [--launcher <file>] [--env KEY=VALUE]... [--dry-run]
//   node scripts/native-host.mjs uninstall [--browser ...] [--manifest-dir <dir>] [--launcher <file>]
//
// Extension id: --extension-id, or BROAGENTAI_EXTENSION_ID, or (default) the id
// Chromium derives for the unpacked extension loaded from extension/dist.
//
// Windows specifics handled here:
//   - the manifest cannot carry arguments, so a small .cmd launcher runs
//     `node bridge/dist/index.js`. It lives OUTSIDE bridge/dist because the
//     bridge build cleans that folder.
//   - browsers find the manifest through an HKCU registry key, which is added
//     on install and removed on uninstall.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST_NAME = "com.broagentai.host";
const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const BRIDGE_ENTRY = join(ROOT, "bridge", "dist", "index.js");
const EXTENSION_DIST = join(ROOT, "extension", "dist");
const BROWSERS = ["chrome", "chromium", "edge", "firefox"];
const IS_WINDOWS = process.platform === "win32";

const REGISTRY_ROOT = {
  chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts",
  chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts",
  edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts",
  firefox: "HKCU\\Software\\Mozilla\\NativeMessagingHosts",
};

function fail(message) {
  console.error(message);
  process.exit(2);
}

function usage() {
  fail(
    "Usage: node scripts/native-host.mjs install [--extension-id <id>] [--browser chrome|chromium|edge|firefox] [--manifest-dir <dir>] [--launcher <file>] [--env KEY=VALUE] [--dry-run]\n" +
    "       node scripts/native-host.mjs uninstall [--browser chrome|chromium|edge|firefox] [--manifest-dir <dir>] [--launcher <file>]"
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

function hostDir(browser) {
  const home = homedir();
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    if (browser === "firefox") return join(base, "Mozilla", "NativeMessagingHosts");
    if (browser === "chromium") return join(base, "Chromium", "NativeMessagingHosts");
    if (browser === "edge") return join(base, "Microsoft Edge", "NativeMessagingHosts");
    return join(base, "Google", "Chrome", "NativeMessagingHosts");
  }
  if (IS_WINDOWS) {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    if (browser === "firefox") return join(base, "Mozilla", "NativeMessagingHosts");
    if (browser === "chromium") return join(base, "Chromium", "NativeMessagingHosts");
    if (browser === "edge") return join(base, "Microsoft", "Edge", "NativeMessagingHosts");
    return join(base, "Google", "Chrome", "NativeMessagingHosts");
  }
  if (browser === "firefox") return join(home, ".mozilla", "native-messaging-hosts");
  if (browser === "chromium") return join(home, ".config", "chromium", "NativeMessagingHosts");
  if (browser === "edge") return join(home, ".config", "microsoft-edge", "NativeMessagingHosts");
  return join(home, ".config", "google-chrome", "NativeMessagingHosts");
}

function launcherContent(env) {
  if (IS_WINDOWS) {
    const sets = Object.entries(env).map(([key, value]) => `set "${key}=${value}"`);
    return ["@echo off", ...sets, `"${process.execPath}" "${BRIDGE_ENTRY}" %*`, ""].join("\r\n");
  }
  const exports = Object.entries(env).map(([key, value]) => `export ${key}='${value.replace(/'/g, "'\\''")}'`);
  return ["#!/bin/sh", ...exports, `exec "${process.execPath}" "${BRIDGE_ENTRY}" "$@"`, ""].join("\n");
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
    if (opts.dryRun) { console.log(`Would remove ${file} and ${launcher}`); return; }
    rmSync(file, { force: true });
    rmSync(launcher, { force: true });
    console.log(`Removed ${file}`);
    console.log(`Removed ${launcher}`);
    if (IS_WINDOWS) {
      try { reg(["delete", registryKey, "/f"]); console.log(`Removed registry key ${registryKey}`); }
      catch { /* key was not present */ }
    }
    return;
  }

  const extensionId = opts.extensionId ?? process.env.BROAGENTAI_EXTENSION_ID ?? unpackedExtensionId(EXTENSION_DIST);
  if (!/^[a-p]{32}$/.test(extensionId) && opts.browser !== "firefox") fail(`Invalid extension id: ${extensionId}`);
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
