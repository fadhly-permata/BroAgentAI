import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

async function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "ba-fallback-ws-"));
  mkdirSync(join(ws, "sub"));
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-fallback-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (params: unknown) => s.handle({ id: id++, method: "shell.fallbackPlan", params });
  return { ws, s, call };
}

test("fallbackPlan keeps typed filesystem and Git primitives as the default", async () => {
  const { call } = await fixture();
  const fs = (await call({ domain: "fs", operation: "readFile" })).result as any;
  assert.equal(fs.status, "typed-primitive");
  assert.equal(fs.typedPrimitive, "fs.readFile");
  assert.equal(fs.shellCommand, null);
  assert.match(fs.reason, /remains the default/);

  const git = (await call({ domain: "git", operation: "status" })).result as any;
  assert.equal(git.status, "typed-primitive");
  assert.equal(git.typedPrimitive, "git.status");
  assert.equal(git.shellCommand, null);
  assert.equal(git.safety.typedPrimitiveRetained, true);
  assert.equal(git.safety.benchmarkGate, "block-native-tool-removal");
});

test("fallbackPlan proposes shell commands only for explicit long-tail operations", async () => {
  const { call, ws } = await fixture();
  const stash = (await call({ domain: "git", operation: "stash", cwd: "sub" })).result as any;
  assert.equal(stash.status, "shell-long-tail");
  assert.equal(stash.typedPrimitive, null);
  assert.equal(stash.shellCommand, "git stash push --include-untracked");
  assert.equal(stash.cwd, join(ws, "sub"));
  assert.equal(stash.safety.requiresApprovalIfWrite, true);

  const blame = (await call({ domain: "git", operation: "blame", path: "src/app.ts" })).result as any;
  assert.equal(blame.shellCommand, "git blame -- 'src/app.ts'");
  assert.equal(blame.safety.requiresApprovalIfWrite, false);

  const fs = (await call({ domain: "fs", operation: "largeTreeSearch" })).result as any;
  assert.equal(fs.status, "shell-long-tail");
  assert.equal(typeof fs.shellCommand, "string");
  assert.ok(fs.shellCommand.length > 0);
  assert.equal(fs.shellFamily, stash.shellFamily);
});

test("fallbackPlan validates domain, operation, cwd, and overrides", async () => {
  const { call } = await fixture();
  assert.equal((await call({ domain: "nope", operation: "stash" })).error?.code, -32602);
  assert.equal((await call({ domain: "git", operation: "nope" })).error?.code, -32602);
  assert.equal((await call({ domain: "git", operation: "stash", cwd: "../escape" })).error?.code, -32026);
  assert.equal((await call({ domain: "git", operation: "stash", shell: "bash" })).error?.code, -32602);
  assert.equal((await call({ domain: "git", operation: "cherryPick" })).error?.code, -32602);
});
