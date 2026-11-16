import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

async function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "ba-fsops-ws-"));
  writeFileSync(join(ws, "a.txt"), "a");
  mkdirSync(join(ws, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(ws, "node_modules", "pkg", "index.js"), "x");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-fsops-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  return { ws, call };
}

test("fs.createFile and fs.mkdir create, never overwrite", async () => {
  const { ws, call } = await fixture();
  assert.equal((await call("fs.createFile", { path: "src/deep/new.ts" })).error, undefined);
  assert.equal(readFileSync(join(ws, "src", "deep", "new.ts"), "utf8"), "");
  assert.equal((await call("fs.createFile", { path: "a.txt" })).error?.code, -32602);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8"), "a");
  assert.equal((await call("fs.mkdir", { path: "docs/api" })).error, undefined);
  assert.equal(existsSync(join(ws, "docs", "api")), true);
  assert.equal((await call("fs.mkdir", { path: "docs" })).error?.code, -32602);
});

test("fs.rename moves without overwriting", async () => {
  const { ws, call } = await fixture();
  writeFileSync(join(ws, "b.txt"), "b");
  assert.equal((await call("fs.rename", { from: "a.txt", to: "b.txt" })).error?.code, -32602);
  assert.equal(readFileSync(join(ws, "b.txt"), "utf8"), "b");
  assert.deepEqual((await call("fs.rename", { from: "a.txt", to: "moved/c.txt" })).result, { from: "a.txt", to: "moved/c.txt" });
  assert.equal(existsSync(join(ws, "a.txt")), false);
  assert.equal(readFileSync(join(ws, "moved", "c.txt"), "utf8"), "a");
  assert.equal((await call("fs.rename", { from: "nope.txt", to: "x.txt" })).error?.code, -32002);
});

test("fs.delete removes a file or an empty directory only", async () => {
  const { ws, call } = await fixture();
  mkdirSync(join(ws, "empty"));
  assert.equal((await call("fs.delete", { path: "node_modules" })).error?.code, -32022); // not empty
  assert.equal(existsSync(join(ws, "node_modules", "pkg", "index.js")), true);
  assert.equal((await call("fs.delete", { path: "empty" })).error, undefined);
  assert.equal((await call("fs.delete", { path: "a.txt" })).error, undefined);
  assert.equal(existsSync(join(ws, "a.txt")), false);
  assert.equal((await call("fs.delete", { path: "a.txt" })).error?.code, -32002);
});

test("structural ops reject the workspace root and escapes", async () => {
  const { ws, call } = await fixture();
  for (const method of ["fs.delete", "fs.mkdir", "fs.createFile"]) {
    assert.equal((await call(method, { path: "." })).error?.code, -32602, method);
    assert.equal((await call(method, { path: "../outside" })).error?.code, -32001, method);
    assert.equal((await call(method, { path: "" })).error?.code, -32602, method);
  }
  assert.equal((await call("fs.rename", { from: "a.txt", to: "../stolen.txt" })).error?.code, -32001);
  assert.equal(existsSync(join(ws, "a.txt")), true);
});

test("showIgnored lists ignored entries and flags them; workspace.setIgnore updates the list", async () => {
  const { call } = await fixture();
  const names = (r: any) => (r.result as any[]).map((e) => e.name).sort();
  assert.deepEqual(names(await call("fs.listDir", { path: "." })), ["a.txt"]);
  const all = await call("fs.listDir", { path: ".", showIgnored: true });
  assert.deepEqual(names(all), ["a.txt", "node_modules"]);
  assert.equal((all.result as any[]).find((e) => e.name === "node_modules").isIgnored, true);
  const tree = (await call("fs.listTree", { path: ".", maxDepth: 1, showIgnored: true })).result as any;
  assert.equal(tree.children.find((c: any) => c.name === "node_modules").isIgnored, true);

  assert.deepEqual(((await call("workspace.setIgnore", { patterns: ["a.txt", "  "] })).result as any).ignore, ["a.txt"]);
  assert.deepEqual(names(await call("fs.listDir", { path: "." })), ["node_modules"]);
  assert.equal((await call("workspace.setIgnore", { patterns: "node_modules" })).error?.code, -32602);
});
