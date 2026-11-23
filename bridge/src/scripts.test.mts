import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { ErrorCode } from "./rpc.ts";
import { listProjectScripts, quoteCommandArgv } from "./scripts.ts";

async function fixture(config: object) {
  const configDir = mkdtempSync(join(tmpdir(), "ba-scripts-cfg-"));
  const ws = mkdtempSync(join(tmpdir(), "ba-scripts-ws-"));
  writeFileSync(join(ws, "package.json"), JSON.stringify({
    scripts: { emit: `node -e "require('fs').writeFileSync('out.txt','ok')"` },
  }));
  writeFileSync(join(ws, "broagentai.jsonc"), JSON.stringify(config));
  const store = new WorkspaceStore({ configDir });
  const s = new RpcServer({ store });
  const added = await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  assert.equal(added.error, undefined, added.error?.message);
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  return { ws, store, call, ok };
}

test("script.list exposes only allowlisted package.json scripts with fixed command arrays", async () => {
  const { store, ok } = await fixture({ scripts: { emit: { manager: "npm", args: ["--silent"], timeoutMs: 10000 } } });
  const data = await ok("script.list");
  assert.deepEqual(data.scripts.map((script: any) => script.name), ["emit"]);
  assert.deepEqual(data.scripts[0].command, ["npm", "run", "emit", "--silent"]);
  assert.equal(data.scripts[0].timeoutMs, 10000);
  assert.equal(data.scripts[0].cwd, store.active()?.path);
  assert.equal(listProjectScripts(store).scripts[0].name, "emit");
});

test("script.run rejects names that are not allowlisted or not valid", async () => {
  const { call } = await fixture({ scripts: { emit: { manager: "npm" } } });
  assert.equal((await call("script.run", { name: "evil" })).error?.code, ErrorCode.NOT_ALLOWED);
  assert.equal((await call("script.run", { name: "../evil" })).error?.code, ErrorCode.INVALID_PARAMS);
  assert.equal((await call("script.run", { name: "emit", command: "npm run emit" })).error?.code, ErrorCode.INVALID_PARAMS);
  assert.equal((await call("script.run", { name: "emit", args: ["--silent"] })).error?.code, ErrorCode.INVALID_PARAMS);
  assert.equal((await call("script.run", { name: "emit", env: { A: "b" } })).error?.code, ErrorCode.INVALID_PARAMS);
});

test("script.list rejects an allowlist entry missing from package.json", async () => {
  const { call } = await fixture({ scripts: { missing: { manager: "npm" } } });
  assert.ok((await call("script.list")).error);
});

test("script.run executes the declared command and records it in the result", async () => {
  const { ws, ok } = await fixture({ scripts: { emit: { manager: "npm", args: ["--silent"], timeoutMs: 30000 } } });
  const result = await ok("script.run", { name: "emit", executionId: "script_emit_1" });
  assert.equal(result.script, "emit");
  assert.deepEqual(result.declaredCommand, ["npm", "run", "emit", "--silent"]);
  assert.equal(existsSync(join(ws, "out.txt")), true);
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "ok");
});

test("quoteCommandArgv quotes each argv element for the detected shell family", () => {
  assert.equal(quoteCommandArgv(["npm", "run", "a b"], "sh"), "'npm' 'run' 'a b'");
  assert.equal(quoteCommandArgv(["npm", "run", "a'b"], "powershell"), "& 'npm' 'run' 'a''b'");
});
