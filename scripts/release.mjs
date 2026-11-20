// Build the release files for the current version, locally (no GitHub Releases / Actions).
// Usage:
//   node scripts/release.mjs [--skip-build]
//
// Output, in release/ (gitignored):
//   broagentai-v<version>-<platform>-<arch>.zip  ready-to-run bundle (built extension + bridge,
//                                                the bridge's runtime node_modules, installers)
//   broagentai-v<version>-source.zip             `git archive` of HEAD
//   SHA256SUMS.txt                               checksums of both zips
//
// The bundle contains node-pty (a native module), so it only runs on the platform
// and CPU it was built on. Checks before packaging: every package.json and the
// extension manifest share one version, CHANGELOG.md has a section for it and
// docs/releases/v<version>.md exists.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "release");
const skipBuild = process.argv.includes("--skip-build");

function fail(message) {
  console.error(`[release] ${message}`);
  process.exit(1);
}
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

// ---------------------------------------------------------------- preflight
const version = readJson("package.json").version;
const versioned = ["shared/package.json", "extension/package.json", "bridge/package.json", "extension/manifest.json"];
for (const rel of versioned) {
  const v = readJson(rel).version;
  if (v !== version) fail(`${rel} has version ${v}, root package.json has ${version}. Bump them together.`);
}
const tag = `v${version}`;
if (!new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"))) {
  fail(`CHANGELOG.md has no "## [${version}]" section.`);
}
const notes = join(ROOT, "docs", "releases", `${tag}.md`);
if (!existsSync(notes)) fail(`Release notes ${relative(ROOT, notes)} are missing.`);
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
if (dirty) console.warn("[release] warning: the working tree has uncommitted changes; the source zip only contains committed files.");

if (!skipBuild) execSync("npm run build", { cwd: ROOT, stdio: "inherit" }); // a plain string: npm is a .cmd on Windows
for (const rel of ["extension/dist/manifest.json", "bridge/dist/index.js"]) {
  if (!existsSync(join(ROOT, rel))) fail(`${rel} is missing. Run without --skip-build.`);
}

// ---------------------------------------------------------------- zip writer (stored + deflate, no deps)
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/** entries: [{ name, data: Buffer, mode? }] -> zip Buffer */
function zip(entries) {
  if (entries.length > 0xffff) fail(`too many files for a plain zip (${entries.length})`);
  const { time, day } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const deflated = deflateRawSync(entry.data, { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    const crc = crc32(entry.data);
    if (body.length > 0xfffffffe || offset > 0xfffffffe) fail("zip is too large (zip64 is not supported)");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix, so the mode below is honoured
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ---------------------------------------------------------------- bundle contents
const prefix = `broagentai-${tag}`;
const files = new Map(); // zip path (inside prefix) -> absolute source path
const SKIP = new Set([".git", ".github", ".bin"]);

function addFile(abs, zipPath) {
  files.set(zipPath.split(sep).join("/"), abs);
}
function addTree(absDir, zipDir, filter = () => true) {
  for (const entry of readdirSync(absDir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = join(absDir, entry.name);
    const zp = `${zipDir}/${entry.name}`;
    if (!filter(abs, entry)) continue;
    if (entry.isDirectory()) addTree(abs, zp, filter);
    else if (entry.isFile()) addFile(abs, zp);
  }
}

addTree(join(ROOT, "extension", "dist"), "extension/dist");
addTree(join(ROOT, "bridge", "dist"), "bridge/dist", (abs) => !abs.endsWith(".d.ts"));
for (const rel of ["bridge/package.json", "bridge/README.md", "scripts/native-host.mjs", "install.bat", "install.ps1", "install.sh", "README.md", "LICENSE", "CHANGELOG.md"]) {
  addFile(join(ROOT, rel), rel);
}
addFile(notes, "RELEASE_NOTES.md");

// The bridge's runtime dependency closure, resolved the way Node would from bridge/.
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return null;
  }
}
const copied = new Set();
function addPackage(name, fromDir, optional) {
  const pkgDir = resolvePackage(name, fromDir);
  if (!pkgDir) {
    if (optional) return;
    fail(`runtime dependency "${name}" (needed from ${relative(ROOT, fromDir) || "."}) is not installed. Run npm install.`);
  }
  if (copied.has(pkgDir)) return;
  copied.add(pkgDir);
  const rel = relative(ROOT, pkgDir);
  if (rel.startsWith("..")) fail(`dependency ${name} resolved outside the repo: ${pkgDir}`);
  // Nested node_modules are walked as their own packages, so only what is needed comes along.
  addTree(pkgDir, rel, (abs, entry) => !(entry.isDirectory() && entry.name === "node_modules"));
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) addPackage(dep, pkgDir, false);
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) addPackage(dep, pkgDir, true);
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) {
    addPackage(dep, pkgDir, pkg.peerDependenciesMeta?.[dep]?.optional ?? true);
  }
}
const bridgePkg = readJson("bridge/package.json");
for (const dep of Object.keys(bridgePkg.dependencies ?? {})) addPackage(dep, join(ROOT, "bridge"), false);

const bundlePackageJson = {
  name: "broagentai",
  version,
  private: true,
  description: "BroAgentAI (Browser Agent AI) release bundle",
  scripts: {
    "host:install": "node scripts/native-host.mjs install",
    "host:uninstall": "node scripts/native-host.mjs uninstall",
  },
  engines: { node: ">=22.6.0" },
};

// ---------------------------------------------------------------- write everything
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const platformTag = `${process.platform}-${process.arch}`;
const bundleName = `${prefix}-${platformTag}.zip`;
const entries = [...files.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([zp, abs]) => ({
    name: `${prefix}/${zp}`,
    data: readFileSync(abs),
    // Windows has no exec bit, so shell scripts are marked executable explicitly.
    mode: zp.endsWith(".sh") || statSync(abs).mode & 0o111 ? 0o100755 : 0o100644,
  }));
entries.push({ name: `${prefix}/package.json`, data: Buffer.from(JSON.stringify(bundlePackageJson, null, 2) + "\n") });
writeFileSync(join(OUT, bundleName), zip(entries));

const sourceName = `${prefix}-source.zip`;
execFileSync("git", ["archive", "--format=zip", `--prefix=${prefix}/`, "-o", join(OUT, sourceName), "HEAD"], { cwd: ROOT });

const sums = [bundleName, sourceName]
  .map((name) => `${createHash("sha256").update(readFileSync(join(OUT, name))).digest("hex")}  ${name}`)
  .join("\n") + "\n";
writeFileSync(join(OUT, "SHA256SUMS.txt"), sums);

const mb = (name) => (statSync(join(OUT, name)).size / 1024 / 1024).toFixed(1) + " MB";
console.log(`\n[release] ${tag} ready in ${relative(ROOT, OUT)}${sep}`);
console.log(`  ${bundleName}  (${entries.length} files, ${mb(bundleName)}, ${copied.size} runtime packages)`);
console.log(`  ${sourceName}  (${mb(sourceName)})`);
console.log("  SHA256SUMS.txt");
console.log(`\nNext: commit, then tag with "git tag -a ${tag} -m \\"BroAgentAI ${tag}\\"" and push the tag.`);
