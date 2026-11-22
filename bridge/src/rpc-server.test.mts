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
  assert.equal((res.result as any).protocolVersion, 2);
  assert.deepEqual((res.result as any).protocol.supported, [1, 2]);
  assert.deepEqual((res.result as any).protocol.deprecated, [1]);
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

test("shell.info reports shell metadata and read-only status", async () => {
  const s = server();
  const res = await s.handle({ id: 3, method: "shell.info" });
  const info = res.result as any;
  assert.equal(typeof info.family, "string");
  assert.equal(typeof info.version, "string");
  assert.equal(info.encoding, "utf8");
  assert.ok(Array.isArray(info.fallbacks));
  assert.equal(typeof info.maxConcurrency, "number");
  assert.equal(typeof info.notSandbox, "string");
});

test("environment info and refresh stay redacted", async () => {
  const s = server();
  const info = (await s.handle({ id: 4, method: "environment.info" })).result as any;
  assert.equal(info.credentialsExposed, false);
  assert.equal(typeof info.credentialKeysDetected, "number");
  assert.equal(typeof info.pathEntryCount, "number");
  assert.equal(info.profilePolicy, "no-profile");
  const refreshed = (await s.handle({ id: 5, method: "environment.refresh" })).result as any;
  assert.equal(refreshed.credentialsExposed, false);
  assert.equal(typeof refreshed.pathEntryCount, "number");
});

test("capability and dependency methods expose policy without installing silently", async () => {
  const s = server();
  const report = (await s.handle({ id: 6, method: "capabilities.discover", params: {} })).result as any;
  assert.equal(report.policy.preferExisting, true);
  assert.equal(report.policy.autoInstall, false);
  assert.equal(report.policy.explicitApprovalForInstall, true);
  assert.ok(Array.isArray(report.capabilities));

  const planned = await s.handle({
    id: 7,
    method: "dependency.plan",
    params: { need: "json", scope: "temporary", reason: "JSON support needed", force: true },
  });
  assert.equal(planned.error, undefined, planned.error?.message);
  const requestId = (planned.result as any).requestId;
  assert.equal(typeof requestId, "string");

  const denied = await s.handle({
    id: 8,
    method: "dependency.install",
    params: { requestId, approved: false },
  });
  assert.equal(denied.error?.code, -32028);

  const history = (await s.handle({ id: 9, method: "dependency.history", params: {} })).result as any;
  assert.equal(history.total, 0);
});

test("typed filesystem and Git RPC methods remain registered alongside shell fallbacks", () => {
  const methods = server().methods();
  const required = [
    "fs.listDir", "fs.listTree", "fs.stat", "fs.readFile", "fs.readFileLines", "fs.searchFiles",
    "fs.writeFile", "fs.createFile", "fs.mkdir", "fs.rename", "fs.delete",
    "git.status", "git.diff", "git.branches", "git.stage", "git.unstage", "git.discard",
    "git.commit", "git.createBranch", "git.checkout", "git.fetch", "git.pull", "git.push",
    "shell.run", "shell.fallbackPlan",
  ];
  for (const method of required) assert.ok(methods.includes(method), method);
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

test("workspace.openFolderDialog rejects with a structured error when disabled", async () => {
  const s = server();
  const previous = process.env.BROAGENTAI_DISABLE_DIALOG;
  process.env.BROAGENTAI_DISABLE_DIALOG = "1";
  try {
    const res = await s.handle({ id: 9, method: "workspace.openFolderDialog", params: {} });
    assert.equal(res.error?.code, -32603);
    assert.equal(res.result, undefined);
  } finally {
    if (previous === undefined) delete process.env.BROAGENTAI_DISABLE_DIALOG;
    else process.env.BROAGENTAI_DISABLE_DIALOG = previous;
  }
});
