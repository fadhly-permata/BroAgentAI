import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const argv = process.argv.slice(2);
const all = argv.includes("--all");
for (const arg of argv) {
  if (arg !== "--all") {
    console.error(`[host-binaries] unknown argument: ${arg}`);
    process.exit(2);
  }
}
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

if (all) {
  console.log("[host-binaries] CI matrix intent (each bundle is built on its own runner; no local cross-compilation):");
  for (const [runner, platform] of [["windows-latest", "win32"], ["macos-latest", "darwin"], ["ubuntu-latest", "linux"]]) {
    console.log(`  ${runner} -> broagentai-v${version}-${platform}-<runner-arch>.zip`);
  }
  process.exit(0);
}

console.log(`[host-binaries] verifying release bundle for ${process.platform}-${process.arch}...`);
execFileSync(process.execPath, [join(ROOT, "scripts", "release.mjs"), "--skip-build"], { cwd: ROOT, stdio: "inherit" });
const name = `broagentai-v${version}-${process.platform}-${process.arch}.zip`;
const artifact = join(ROOT, "release", name);
if (!existsSync(artifact)) {
  console.error(`[host-binaries] expected artifact was not produced: ${name}`);
  process.exit(1);
}
console.log(`[host-binaries] ${relative(ROOT, artifact)}`);
