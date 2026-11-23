import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { ErrorCode } from "./rpc.ts";

test("root registry switches active roots and resolves @rootId paths without escaping", async () => {
  const configDir = mkdtempSync(join(tmpdir(), "ba-multi-cfg-"));
  const first = mkdtempSync(join(tmpdir(), "ba-multi-first-"));
  const second = mkdtempSync(join(tmpdir(), "ba-multi-second-"));
  writeFileSync(join(first, "first.txt"), "first\n");
  writeFileSync(join(second, "second.txt"), "second\n");

  const store = new WorkspaceStore({ configDir });
  const s = new RpcServer({ store });
  let id = 0;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };

  const addedFirst = await ok("workspace.add", { path: first, name: "first" });
  const addedSecond = await ok("workspace.add", { path: second, name: "second" });
  const firstId = addedFirst.workspace.id;
  const secondId = addedSecond.workspace.id;
  const roots = await ok("root.list");
  assert.equal(roots.roots.length, 2);
  assert.equal(roots.activeRootId, secondId);
  assert.equal(roots.roots.every((root: any) => root.rootId === root.id), true);
  assert.equal(roots.roots.find((root: any) => root.id === firstId).active, false);

  const listed = await ok("fs.listDir", { path: `@${firstId}:.` });
  assert.equal(listed.some((entry: any) => entry.path === `@${firstId}:first.txt`), true);

  const resolved = await ok("root.resolve", { path: `@${firstId}:first.txt` });
  assert.equal(resolved.rootId, firstId);
  assert.equal(resolved.rootPath, first);
  assert.equal(resolved.path, join(first, "first.txt"));

  const escape = await call("root.resolve", { path: `@${firstId}:${join(tmpdir(), "outside.txt")}` });
  assert.equal(escape.error?.code, ErrorCode.PATH_ESCAPE);
  assert.equal((await call("root.resolve", { path: "@missing:file.txt" })).error?.code, ErrorCode.WORKSPACE_NOT_FOUND);

  const focused = await ok("root.setActive", { rootId: firstId });
  assert.equal(focused.activeRootId, firstId);
  const activeListed = await ok("fs.listDir", { path: "." });
  assert.equal(activeListed.some((entry: any) => entry.path === "first.txt"), true);

  const removed = await ok("root.remove", { rootId: secondId });
  assert.equal(removed.activeWorkspaceId, firstId);
  assert.equal((await ok("root.list")).roots.length, 1);
});
