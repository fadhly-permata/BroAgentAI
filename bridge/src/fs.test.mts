import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

function server() {
  const dir = mkdtempSync(join(tmpdir(), "ba-rpc-fs-"));
  return new RpcServer({ store: new WorkspaceStore({ configDir: dir }) });
}

test("fs.listDir returns directory contents", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-fs-"));
  mkdirSync(join(wsDir, "subdir"));
  writeFileSync(join(wsDir, "file.txt"), "hello");
  mkdirSync(join(wsDir, ".git")); // .git is in DEFAULT_IGNORE

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "fs.listDir", params: { path: "." } });

  assert.ok(res.result);
  const entries = res.result as any[];
  assert.equal(entries.length, 2); // subdir and file.txt (.git is ignored)
  assert.ok(entries.some((e) => e.name === "subdir" && e.isDirectory));
  assert.ok(entries.some((e) => e.name === "file.txt" && !e.isDirectory));
});

test("fs.listTree respects maxDepth", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-tree-"));
  mkdirSync(join(wsDir, "a"));
  mkdirSync(join(wsDir, "a", "b"));
  writeFileSync(join(wsDir, "a", "b", "c.txt"), "deep");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "fs.listTree", params: { path: ".", maxDepth: "1" } });

  assert.ok(res.result);
  const tree = res.result as any;
  assert.ok(tree.children);
  assert.equal(tree.children.length, 1); // only 'a'
  assert.equal(tree.children[0].children, undefined); // depth 1 reached, no children
});

test("fs.stat returns file info", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-stat-"));
  writeFileSync(join(wsDir, "test.txt"), "content");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "fs.stat", params: { path: "test.txt" } });

  assert.ok(res.result);
  const stat = res.result as any;
  assert.equal(stat.path, "test.txt");
  assert.equal(stat.isDirectory, false);
  assert.equal(stat.size, 7);
  assert.equal(stat.isBinary, false);
});

test("fs.readFile reads UTF-8 content", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-read-"));
  writeFileSync(join(wsDir, "hello.txt"), "Hello World");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "fs.readFile", params: { path: "hello.txt" } });

  assert.ok(res.result);
  const file = res.result as any;
  assert.equal(file.content, "Hello World");
  assert.equal(file.isBinary, false);
});

test("fs.readFile rejects binary files", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-binary-"));
  const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00]); // PNG header with null byte
  writeFileSync(join(wsDir, "image.png"), buffer);

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "fs.readFile", params: { path: "image.png" } });

  assert.equal(res.error?.code, -32004); // BINARY_FILE
});

test("fs operations reject path escape", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-escape-"));
  const outsideDir = mkdtempSync(join(tmpdir(), "ba-outside-"));
  writeFileSync(join(outsideDir, "secret.txt"), "secret");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "fs.readFile", params: { path: "../../secret.txt" } });

  assert.equal(res.error?.code, -32001); // PATH_ESCAPE
});

test("fs operations require active workspace", async () => {
  const s = server();
  const res = await s.handle({ id: 1, method: "fs.listDir", params: { path: "." } });

  assert.equal(res.error?.code, -32006); // WORKSPACE_NOT_FOUND
});
