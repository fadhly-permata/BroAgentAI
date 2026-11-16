import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

function server() {
  const dir = mkdtempSync(join(tmpdir(), "ba-rpc-"));
  return new RpcServer({ store: new WorkspaceStore({ configDir: dir }) });
}

test("system.ping returns host + protocol version", async () => {
  const s = server();
  const res = await s.handle({ id: 1, method: "system.ping" });
  assert.equal(res.id, 1);
  assert.equal((res.result as any).protocolVersion, 1);
  assert.equal((res.result as any).hostName, "com.broagentai.host");
});

test("system.info reports platform and config paths", async () => {
  const s = server();
  const res = await s.handle({ id: 2, method: "system.info" });
  const info = res.result as any;
  assert.equal(info.platform, process.platform);
  assert.equal(typeof info.pid, "number");
  assert.ok(info.configPath.endsWith("config.json"));
});

test("unknown method returns METHOD_NOT_FOUND with available methods", async () => {
  const s = server();
  const res = await s.handle({ id: 3, method: "nope.nope" });
  assert.equal(res.error?.code, -32601);
  assert.ok((res.error?.data as any).available.includes("system.ping"));
});

test("malformed envelope returns INVALID_REQUEST", async () => {
  const s = server();
  const res = await s.handle({ method: "system.ping" });
  assert.equal(res.error?.code, -32600);
});

test("workspace.add/list/setActive/remove round-trip", async () => {
  const s = server();
  const dir = mkdtempSync(join(tmpdir(), "ba-ws-"));
  const added = await s.handle({ id: 1, method: "workspace.add", params: { path: dir } });
  const ws = (added.result as any).workspace;
  assert.equal(ws.path, dir);
  const listed = await s.handle({ id: 2, method: "workspace.list" });
  assert.equal((listed.result as any).workspaces.length, 1);
  assert.equal((listed.result as any).activeWorkspaceId, ws.id);
  const removed = await s.handle({ id: 3, method: "workspace.remove", params: { id: ws.id } });
  assert.equal((removed.result as any).removed.id, ws.id);
});

test("workspace.add duplicate focuses existing entry", async () => {
  const s = server();
  const dir = mkdtempSync(join(tmpdir(), "ba-ws-dup-"));
  const a = await s.handle({ id: 1, method: "workspace.add", params: { path: dir } });
  const b = await s.handle({ id: 2, method: "workspace.add", params: { path: dir } });
  assert.equal((a.result as any).workspace.id, (b.result as any).workspace.id);
  const listed = await s.handle({ id: 3, method: "workspace.list" });
  assert.equal((listed.result as any).workspaces.length, 1);
});

test("workspace.add invalid path returns WORKSPACE_INVALID", async () => {
  const s = server();
  const res = await s.handle({ id: 1, method: "workspace.add", params: { path: "/definitely/not/here/ba" } });
  assert.equal(res.error?.code, -32007);
});
