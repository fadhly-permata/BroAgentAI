import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import { assetName, compareVersions, extractZip, parseChecksums, safeZipPath } from "./update.mjs";

function fixtureZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(data, { level: 9 }) : data;
    const checksum = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((n, part) => n + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

test("compareVersions orders tags and versions", () => {
  assert.equal(compareVersions("0.1.0", "v0.1.0"), 0);
  assert.equal(compareVersions("0.1.0", "v0.2.0"), -1);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v2.0.0", "2.0.1"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0+build.7", "1.0.0"), 0);
});

test("parseChecksums reads GNU-style lines and lowercases hashes", () => {
  const hash = "a".repeat(64);
  const other = "B".repeat(64);
  const text = `${hash}  broagentai-v1.0.0-win32-x64.zip\r\n${other} *source.zip\n\n# comment\n`;
  const sums = parseChecksums(text);
  assert.equal(sums.size, 2);
  assert.equal(sums.get("broagentai-v1.0.0-win32-x64.zip"), hash);
  assert.equal(sums.get("source.zip"), other.toLowerCase());
});

test("parseChecksums rejects malformed lines", () => {
  assert.throws(() => parseChecksums("not-a-hash  file.zip"), /Invalid checksum line/);
});

test("safeZipPath normalizes benign entries", () => {
  assert.equal(safeZipPath("broagentai-v1.0.0/bridge/dist/index.js"), "broagentai-v1.0.0/bridge/dist/index.js");
  assert.equal(safeZipPath("a/./b.txt"), "a/b.txt");
});

test("safeZipPath rejects absolute and traversal entries", () => {
  for (const bad of ["../evil", "a/../../evil", "/etc/passwd", "C:/Windows/win.ini", "..\\evil", "a\\..\\evil", "\0bad"]) {
    assert.throws(() => safeZipPath(bad));
  }
});

test("assetName follows release.mjs naming", () => {
  assert.equal(assetName("0.1.0", "win32", "x64"), "broagentai-v0.1.0-win32-x64.zip");
  assert.equal(assetName("v1.2.3", "linux", "arm64"), "broagentai-v1.2.3-linux-arm64.zip");
});

test("extractZip reads stored and deflate entries with a stripped prefix", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "broagentai-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = fixtureZip([
    { name: "broagentai-v1.0.0/bridge/dist/index.js", data: "console.log(1)\n", method: 8 },
    { name: "broagentai-v1.0.0/scripts/start.sh", data: "#!/bin/sh\nexit 0\n", method: 0, mode: 0o100755 },
  ]);
  const files = extractZip(zip, dir, { stripComponents: 1 });
  assert.deepEqual(files.sort(), ["bridge/dist/index.js", "scripts/start.sh"]);
  assert.equal(readFileSync(join(dir, "bridge", "dist", "index.js"), "utf8"), "console.log(1)\n");
  assert.equal(readFileSync(join(dir, "scripts", "start.sh"), "utf8"), "#!/bin/sh\nexit 0\n");
});

test("extractZip rejects traversal entries", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "broagentai-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = fixtureZip([{ name: "../evil.txt", data: "x" }]);
  assert.throws(() => extractZip(zip, dir), /Unsafe zip path/);
});

test("extractZip verifies CRC32", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "broagentai-zip-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const zip = fixtureZip([{ name: "broagentai-v1.0.0/a.txt", data: "hello", crc: 0 }]);
  assert.throws(() => extractZip(zip, dir, { stripComponents: 1 }), /CRC mismatch/);
});
