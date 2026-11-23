import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const IS_WINDOWS = process.platform === "win32";
const rawArgs = process.argv.slice(2);
const forceCli = rawArgs.includes("--cli");
const forceGui = rawArgs.includes("--gui");
const forwarded = rawArgs.filter((arg) => arg !== "--cli" && arg !== "--gui");

function usage() {
  console.log([
    "BroAgentAI GUI installer dispatcher",
    "",
    "Usage: node scripts/install-gui.mjs [--gui|--cli] [installer options]",
    "",
    "--gui             try the GUI wrapper even if detection says otherwise",
    "--cli             skip the GUI wrapper and call the console installer",
    "--browser a,b     pre-select browsers (chrome,chromium,edge,brave,firefox)",
    "--uninstall       remove native host registrations",
    "--rebuild         rebuild the extension and bridge",
    "--portable-node   force the portable Node.js download",
    "--yes             accept prompts on POSIX installers",
  ].join("\n"));
}

if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
  usage();
  process.exit(0);
}

function childEnv() {
  const env = { ...process.env };
  const nodeDir = dirname(process.execPath);
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!parts.includes(nodeDir)) env.PATH = [nodeDir, ...parts].join(delimiter);
  return env;
}

function commandExists(name) {
  const probe = IS_WINDOWS
    ? spawnSync("where.exe", [name], { stdio: "ignore" })
    : spawnSync("sh", ["-c", `command -v ${name}`], { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

function hasGui() {
  if (IS_WINDOWS) return true;
  if (process.platform === "darwin") return commandExists("osascript") || commandExists("zenity");
  return commandExists("zenity") && Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

function toPowerShellArgs(list) {
  const out = [];
  for (const arg of list) {
    if (arg === "--uninstall" || arg === "-Uninstall") out.push("-Uninstall");
    else if (arg === "--rebuild") out.push("-Rebuild");
    else if (arg === "--portable-node") out.push("-PortableNode");
    else if (arg === "--yes" || arg === "-y") continue;
    else if (arg === "--browser") out.push("-Browser");
    else if (arg.startsWith("--browser=")) out.push("-Browser", arg.slice("--browser=".length));
    else out.push(arg);
  }
  return out;
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", env: childEnv() });
  if (result.error) {
    console.error(`[install-gui] ${result.error.message}`);
    return null;
  }
  return result.status ?? 1;
}

function runWindowsScript(script, args) {
  return run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args]);
}

let status;

if (IS_WINDOWS) {
  const gui = join(ROOT, "install-gui.ps1");
  const cli = join(ROOT, "install.ps1");
  if (!forceCli && existsSync(gui) && (forceGui || commandExists("powershell.exe"))) {
    console.log("[install-gui] Windows GUI wizard");
    status = runWindowsScript(gui, toPowerShellArgs(forwarded));
    if (status === null || status === 3) status = undefined;
  }
  if (status === undefined) {
    console.log("[install-gui] Windows console installer");
    if (!existsSync(cli)) {
      console.error(`[install-gui] ${cli} tidak ditemukan.`);
      status = 1;
    } else {
      status = runWindowsScript(cli, toPowerShellArgs(forwarded));
    }
  }
} else {
  const gui = join(ROOT, "install-gui.sh");
  const cli = join(ROOT, "install.sh");
  if (!forceCli && existsSync(gui) && (forceGui || hasGui())) {
    console.log("[install-gui] POSIX GUI wrapper");
    status = run("bash", [gui, ...forwarded]);
    if (status === null || status === 3) status = undefined;
  }
  if (status === undefined) {
    console.log("[install-gui] POSIX console installer");
    if (!existsSync(cli)) {
      console.error(`[install-gui] ${cli} tidak ditemukan.`);
      status = 1;
    } else {
      status = run("bash", [cli, ...forwarded]);
    }
  }
}

process.exit(status === null ? 1 : status);
