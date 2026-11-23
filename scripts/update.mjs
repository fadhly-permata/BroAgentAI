import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { crc32, inflateRawSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const DEFAULT_REPO = "fadhly-permata/BroAgentAI";
const CHECKSUMS = "SHA256SUMS.txt";
const HOST_NAME = "com.broagentai.host";
const BROWSERS = ["chrome", "chromium", "edge", "brave", "firefox"];

export function compareVersions(a, b) {
  const parse = (value) => {
    const raw = String(value).trim().replace(/^v/i, "");
    const withoutBuild = raw.split("+")[0];
    const dash = withoutBuild.indexOf("-");
    const core = dash === -1 ? withoutBuild : withoutBuild.slice(0, dash);
    const pre = dash === -1 ? "" : withoutBuild.slice(dash + 1);
    const numbers = core.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
    return { numbers, pre };
  };
  const left = parse(a);
  const right = parse(b);
  const count = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < count; i++) {
    const l = left.numbers[i] ?? 0;
    const r = right.numbers[i] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  const lparts = left.pre.split(".");
  const rparts = right.pre.split(".");
  for (let i = 0; i < Math.max(lparts.length, rparts.length); i++) {
    const l = lparts[i];
    const r = rparts[i];
    if (l === undefined && r === undefined) continue;
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    const ln = /^\d+$/.test(l);
    const rn = /^\d+$/.test(r);
    if (ln && rn) {
      const diff = Number(l) - Number(r);
      if (diff) return diff > 0 ? 1 : -1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (l !== r) {
      return l > r ? 1 : -1;
    }
  }
  return 0;
}

export function parseChecksums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([0-9a-fA-F]{64})[ \t]+([* ]?)(.+)$/.exec(trimmed);
    if (!match) throw new Error(`Invalid checksum line: ${line}`);
    const name = match[3].trim();
    if (!name) throw new Error(`Invalid checksum line: ${line}`);
    sums.set(name, match[1].toLowerCase());
  }
  return sums;
}

export function safeZipPath(name) {
  if (typeof name !== "string" || !name) throw new Error("Empty zip path");
  if (name.includes("\0")) throw new Error("Unsafe zip path: NUL byte");
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) throw new Error(`Unsafe zip path: ${name}`);
  const parts = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") throw new Error(`Unsafe zip path: ${name}`);
    parts.push(part);
  }
  if (!parts.length) throw new Error(`Unsafe zip path: ${name}`);
  return parts.join("/");
}

export function assetName(version, platformTag = process.platform, arch = process.arch) {
  return `broagentai-v${String(version).trim().replace(/^v/i, "")}-${platformTag}-${arch}.zip`;
}

function ensureRange(buffer, offset, length, label) {
  if (offset < 0 || length < 0 || offset + length > buffer.length) throw new Error(`Truncated ${label}`);
}

function isInside(root, target) {
  const rel = relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function findEocd(zip) {
  if (zip.length < 22) throw new Error("Not a zip archive");
  const min = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= min; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error("Zip end record not found");
}

function readCentralDirectory(zip, eocd) {
  const count = zip.readUInt16LE(eocd + 10);
  const size = zip.readUInt32LE(eocd + 12);
  const offset = zip.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("Zip64 is not supported");
  ensureRange(zip, offset, size, "central directory");
  if (offset + size > eocd) throw new Error("Invalid central directory offset");
  const entries = [];
  let pos = offset;
  for (let i = 0; i < count; i++) {
    ensureRange(zip, pos, 46, "central directory entry");
    if (zip.readUInt32LE(pos) !== 0x02014b50) throw new Error("Invalid central directory entry");
    const nameLen = zip.readUInt16LE(pos + 28);
    const extraLen = zip.readUInt16LE(pos + 30);
    const commentLen = zip.readUInt16LE(pos + 32);
    ensureRange(zip, pos + 46, nameLen + extraLen + commentLen, "central directory entry");
    const name = zip.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    entries.push({
      name,
      method: zip.readUInt16LE(pos + 10),
      crc: zip.readUInt32LE(pos + 16),
      compressedSize: zip.readUInt32LE(pos + 20),
      uncompressedSize: zip.readUInt32LE(pos + 24),
      externalAttributes: zip.readUInt32LE(pos + 38),
      localOffset: zip.readUInt32LE(pos + 42),
      isDirectory: name.endsWith("/"),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntryData(zip, entry) {
  const offset = entry.localOffset;
  ensureRange(zip, offset, 30, "local header");
  if (zip.readUInt32LE(offset) !== 0x04034b50) throw new Error(`Invalid local header for ${entry.name}`);
  const method = zip.readUInt16LE(offset + 8);
  const nameLen = zip.readUInt16LE(offset + 26);
  const extraLen = zip.readUInt16LE(offset + 28);
  const localName = zip.subarray(offset + 30, offset + 30 + nameLen).toString("utf8");
  if (method !== entry.method || localName !== entry.name) throw new Error(`Mismatched local header for ${entry.name}`);
  const start = offset + 30 + nameLen + extraLen;
  ensureRange(zip, start, entry.compressedSize, "zip entry data");
  if (entry.compressedSize === 0xffffffff || entry.uncompressedSize === 0xffffffff) throw new Error("Zip64 is not supported");
  const packed = zip.subarray(start, start + entry.compressedSize);
  let content;
  if (entry.method === 0) content = Buffer.from(packed);
  else if (entry.method === 8) content = inflateRawSync(packed);
  else throw new Error(`Unsupported zip method ${entry.method} for ${entry.name}`);
  if (content.length !== entry.uncompressedSize) throw new Error(`Wrong uncompressed size for ${entry.name}`);
  if (crc32(content) !== entry.crc) throw new Error(`CRC mismatch for ${entry.name}`);
  return content;
}

export function extractZip(buffer, destination, { stripComponents = 0 } = {}) {
  const zip = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (!Number.isInteger(stripComponents) || stripComponents < 0) throw new Error("Invalid stripComponents");
  const eocd = findEocd(zip);
  const entries = readCentralDirectory(zip, eocd);
  const root = resolve(destination);
  mkdirSync(root, { recursive: true });
  const written = [];
  for (const entry of entries) {
    const parts = safeZipPath(entry.name).split("/").slice(stripComponents);
    if (!parts.length) continue;
    const target = resolve(root, ...parts);
    if (!isInside(root, target)) throw new Error(`Refusing to extract outside the target directory: ${entry.name}`);
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    const mode = (entry.externalAttributes >>> 16) & 0xffff;
    if ((mode & 0o170000) === 0o120000) throw new Error(`Symlink entry is not allowed: ${entry.name}`);
    const content = readEntryData(zip, entry);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    if (process.platform !== "win32" && mode & 0o111) chmodSync(target, 0o755);
    written.push(parts.join("/"));
  }
  return written;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

function backupAndCopy(staging, root, protectedScript) {
  const backupRoot = mkdtempSync(join(tmpdir(), "broagentai-backup-"));
  const created = [];
  const replaced = [];
  const rollback = () => {
    for (const dest of created) rmSync(dest, { force: true });
    for (const item of replaced) {
      mkdirSync(dirname(item.dest), { recursive: true });
      copyFileSync(item.backup, item.dest);
      if (process.platform !== "win32") chmodSync(item.dest, item.mode);
    }
    rmSync(backupRoot, { recursive: true, force: true });
  };
  try {
    let count = 0;
    for (const rel of listFiles(staging)) {
      const parts = rel.split("/");
      const source = resolve(staging, ...parts);
      const dest = resolve(root, ...parts);
      if (!isInside(root, dest)) throw new Error(`Refusing to write outside the install root: ${rel}`);
      if (dest === protectedScript) continue;
      if (existsSync(dest) && !statSync(dest).isFile()) throw new Error(`Cannot replace non-file path: ${rel}`);
      if (existsSync(dest)) {
        const backup = join(backupRoot, ...parts);
        mkdirSync(dirname(backup), { recursive: true });
        copyFileSync(dest, backup);
        replaced.push({ dest, backup, mode: statSync(dest).mode & 0o777 });
      } else {
        created.push(dest);
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(source, dest);
      if (process.platform !== "win32" && statSync(source).mode & 0o111) chmodSync(dest, 0o755);
      count++;
    }
    return { count, rollback };
  } catch (error) {
    rollback();
    throw error;
  }
}

function hostManifestPath(browser) {
  const home = homedir();
  let dir;
  if (process.platform === "darwin") {
    const base = join(home, "Library", "Application Support");
    if (browser === "firefox") dir = join(base, "Mozilla", "NativeMessagingHosts");
    else if (browser === "chromium") dir = join(base, "Chromium", "NativeMessagingHosts");
    else if (browser === "edge") dir = join(base, "Microsoft Edge", "NativeMessagingHosts");
    else if (browser === "brave") dir = join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
    else dir = join(base, "Google", "Chrome", "NativeMessagingHosts");
  } else if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    if (browser === "firefox") dir = join(base, "Mozilla", "NativeMessagingHosts");
    else if (browser === "chromium") dir = join(base, "Chromium", "NativeMessagingHosts");
    else if (browser === "edge") dir = join(base, "Microsoft", "Edge", "NativeMessagingHosts");
    else if (browser === "brave") dir = join(base, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
    else dir = join(base, "Google", "Chrome", "NativeMessagingHosts");
  } else if (browser === "firefox") {
    dir = join(home, ".mozilla", "native-messaging-hosts");
  } else {
    const config = process.env.XDG_CONFIG_HOME || join(home, ".config");
    if (browser === "chromium") dir = join(config, "chromium", "NativeMessagingHosts");
    else if (browser === "edge") dir = join(config, "microsoft-edge", "NativeMessagingHosts");
    else if (browser === "brave") dir = join(config, "BraveSoftware", "Brave-Browser", "NativeMessagingHosts");
    else dir = join(config, "google-chrome", "NativeMessagingHosts");
  }
  return join(dir, `${HOST_NAME}.json`);
}

function configuredBrowsers() {
  const override = process.env.BROAGENTAI_BROWSERS;
  if (!override) {
    const found = BROWSERS.filter((browser) => existsSync(hostManifestPath(browser)));
    return found.length ? found : ["chrome"];
  }
  const list = override.split(/[\s,]+/).filter(Boolean);
  for (const browser of list) if (!BROWSERS.includes(browser)) throw new Error(`Unknown browser: ${browser}`);
  return [...new Set(list)];
}

function reRegisterHost() {
  const script = join(ROOT, "scripts", "native-host.mjs");
  if (!existsSync(script)) throw new Error("scripts/native-host.mjs is missing; cannot re-register the native host");
  const browsers = configuredBrowsers();
  for (const browser of browsers) {
    execFileSync(process.execPath, [script, "install", "--browser", browser], { cwd: ROOT, stdio: "inherit" });
  }
  return browsers;
}

async function fetchJson(url, token) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "broagentai-updater" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${url}`);
  return response.json();
}

async function download(url, file, token) {
  const headers = { Accept: "application/octet-stream", "User-Agent": "broagentai-updater" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(file, buffer);
  return buffer;
}

function printUsage() {
  console.log("Usage: node scripts/update.mjs [--check-only] [--yes]");
  console.log("  --check-only  report whether a newer release exists, without downloading");
  console.log("  --yes         skip the confirmation prompt");
  console.log(`  BROAGENTAI_REPO selects the GitHub repository (default ${DEFAULT_REPO})`);
}

async function main() {
  const argv = process.argv.slice(2);
  for (const arg of argv) {
    if (!["--check-only", "--yes", "-y", "--help", "-h"].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  const checkOnly = argv.includes("--check-only");
  const yes = argv.includes("--yes") || argv.includes("-y");
  const repo = process.env.BROAGENTAI_REPO || DEFAULT_REPO;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`Invalid BROAGENTAI_REPO: ${repo}`);
  const token = process.env.BROAGENTAI_TOKEN || process.env.GITHUB_TOKEN;
  const currentVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`, token);
  if (!release?.tag_name || !Array.isArray(release.assets)) throw new Error("Latest release response is missing tag_name or assets");
  const latestTag = release.tag_name;
  console.log(`[update] current ${currentVersion}, latest ${latestTag}`);
  if (compareVersions(currentVersion, latestTag) >= 0) {
    console.log("[update] already up to date.");
    return;
  }
  if (checkOnly) {
    console.log(`[update] update available: ${latestTag}`);
    return;
  }
  if (!yes) {
    if (!process.stdin.isTTY) throw new Error("No terminal is attached; rerun with --yes to confirm the update.");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`[update] Update to ${latestTag}? [y/N] `);
    rl.close();
    if (!/^(y|yes)$/i.test(answer.trim())) {
      console.log("[update] cancelled.");
      return;
    }
  }
  const name = assetName(latestTag, process.platform, process.arch);
  const bundle = release.assets.find((asset) => asset.name === name);
  const sums = release.assets.find((asset) => asset.name === CHECKSUMS);
  if (!bundle?.browser_download_url) throw new Error(`Release ${latestTag} has no asset ${name}`);
  if (!sums?.browser_download_url) throw new Error(`Release ${latestTag} has no ${CHECKSUMS}`);
  const work = mkdtempSync(join(tmpdir(), "broagentai-update-"));
  try {
    console.log(`[update] downloading ${name}...`);
    const zipBuffer = await download(bundle.browser_download_url, join(work, name), token);
    const sumsBuffer = await download(sums.browser_download_url, join(work, CHECKSUMS), token);
    const checksums = parseChecksums(sumsBuffer.toString("utf8"));
    const expected = checksums.get(name);
    if (!expected) throw new Error(`${CHECKSUMS} has no entry for ${name}`);
    const actual = createHash("sha256").update(zipBuffer).digest("hex");
    if (actual !== expected) throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
    console.log("[update] checksum verified.");
    const staging = join(work, "new");
    const written = extractZip(zipBuffer, staging, { stripComponents: 1 });
    if (!written.includes("package.json")) throw new Error("Release bundle is missing package.json");
    const stagedVersion = JSON.parse(readFileSync(join(staging, "package.json"), "utf8")).version;
    const expectedVersion = String(latestTag).replace(/^v/i, "");
    if (stagedVersion !== expectedVersion) throw new Error(`Release bundle version ${stagedVersion} does not match ${latestTag}`);
    const transaction = backupAndCopy(staging, ROOT, SCRIPT_PATH);
    console.log(`[update] installed ${transaction.count} files.`);
    try {
      const browsers = reRegisterHost();
      console.log(`[update] re-registered com.broagentai.host for ${browsers.join(", ")}`);
    } catch (error) {
      transaction.rollback();
      console.log("[update] restored the previous install after host registration failed.");
      throw error;
    }
    console.log(`[update] updated to ${latestTag}. Reload the extension in the browser.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    console.error(`[update] ${error.message}`);
    process.exitCode = 1;
  });
}
