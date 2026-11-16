import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { effectiveRisk, expandEnvRefs, loadMcpConfig } from "./mcp.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));
const stdioServer = (extra: object = {}) => ({ type: "local", command: [process.execPath, FIXTURE], ...extra });

async function fixture(layers: { global?: object; project?: object; local?: object }) {
  const configDir = mkdtempSync(join(tmpdir(), "ba-mcp-cfg-"));
  const ws = mkdtempSync(join(tmpdir(), "ba-mcp-ws-"));
  const write = (dir: string, name: string, mcp: object | undefined) => {
    if (mcp) writeFileSync(join(dir, name), JSON.stringify({ version: 1, mcp }, null, 2));
  };
  write(configDir, "broagentai.json", layers.global);
  write(ws, "broagentai.json", layers.project);
  write(ws, "broagentai.local.json", layers.local);

  const events: { event: string; data: any }[] = [];
  const s = new RpcServer({ store: new WorkspaceStore({ configDir }), emit: (event, data) => events.push({ event, data }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  const server = async (name: string) => (await ok("mcp.servers")).servers.find((x: any) => x.id === name);
  return { s, ws, configDir, call, ok, server, events, write };
}

test("effectiveRisk maps annotations and only lets overrides escalate", () => {
  assert.equal(effectiveRisk({ readOnlyHint: true }, undefined, undefined), "read");
  assert.equal(effectiveRisk({ destructiveHint: true }, undefined, undefined), "destructive");
  assert.equal(effectiveRisk(undefined, undefined, undefined), "write");
  assert.equal(effectiveRisk({ readOnlyHint: true }, "write", undefined), "write");
  assert.equal(effectiveRisk({ readOnlyHint: true }, undefined, "destructive"), "destructive");
  assert.equal(effectiveRisk({ destructiveHint: true }, "read", "read"), "destructive"); // cannot downgrade
  assert.equal(effectiveRisk(undefined, "read", undefined), "write"); // cannot downgrade
});

test("expandEnvRefs expands ${env:NAME} and reports missing names", () => {
  assert.deepEqual(expandEnvRefs("Bearer ${env:TOK}", { TOK: "abc" }), { value: "Bearer abc", missing: [] });
  assert.deepEqual(expandEnvRefs("${env:NOPE}", {}), { value: "", missing: ["NOPE"] });
});

test("loadMcpConfig validates definitions and tracks origin", () => {
  const configDir = mkdtempSync(join(tmpdir(), "ba-mcp-cfg-"));
  const ws = mkdtempSync(join(tmpdir(), "ba-mcp-ws-"));
  writeFileSync(join(configDir, "broagentai.jsonc"), `{
    // comments are allowed
    "version": 1,
    "mcp": { "g": { "type": "local", "command": ["node", "x.js"] }, "shared": { "type": "local", "command": ["node", "g.js"] } }
  }`);
  writeFileSync(join(ws, "broagentai.json"), JSON.stringify({ mcp: {
    shared: { type: "local", command: ["node", "p.js"] },
    shellString: { type: "local", command: "node x.js" },
    plainHttp: { type: "remote", url: "http://example.com/mcp" },
    okRemote: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer ${env:T}" } },
    localhostHttp: { type: "remote", url: "http://127.0.0.1:9/mcp" },
    weird: { type: "pipe" },
    "bad id!": { type: "local", command: ["x"] },
  } }));
  writeFileSync(join(ws, "broagentai.local.json"), JSON.stringify({ mcp: { shared: { type: "local", command: ["node", "local.js"] }, mine: { type: "local", command: ["node", "m.js"] } } }));

  const { servers, warnings } = loadMcpConfig(configDir, ws);
  const by = Object.fromEntries(servers.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(by).sort(), ["g", "localhostHttp", "mine", "okRemote", "shared"]);
  assert.equal(by.g.origin, "global");
  assert.equal(by.mine.origin, "local");
  assert.equal(by.okRemote.origin, "project");
  // overridden by the project, then by local: still project-originated (no trust laundering)
  assert.equal(by.shared.origin, "project");
  assert.deepEqual(by.shared.command, ["node", "local.js"]);
  assert.equal(warnings.length, 4);
  assert.ok(warnings.some((w) => /no shell string/.test(w)));
  assert.ok(warnings.some((w) => /requires https/.test(w)));
});

test("global stdio server: start, list tools with risk, call, stop, restart", async () => {
  const { s, ok, call, server, events } = await fixture({ global: { fx: stdioServer({ environment: { FIXTURE_VALUE: "from-config" } }) } });
  try {
    assert.equal((await server("fx")).status, "stopped");
    assert.equal((await ok("mcp.tools")).tools.length, 0);
    assert.equal((await call("mcp.callTool", { server: "fx", tool: "echo", arguments: { text: "x" } })).error?.code, -32020);

    await ok("mcp.start", { server: "fx" });
    const info = await server("fx");
    assert.equal(info.status, "ready");
    assert.equal(info.toolCount, 7);
    assert.deepEqual(info.environmentKeys, ["FIXTURE_VALUE"]); // key names only
    assert.equal(JSON.stringify(info).includes("from-config"), false);

    const tools = (await ok("mcp.tools")).tools;
    const risk = Object.fromEntries(tools.map((t: any) => [t.name, t.risk]));
    assert.equal(risk["mcp.fx.echo"], "read");
    assert.equal(risk["mcp.fx.write_note"], "write");
    assert.equal(risk["mcp.fx.wipe"], "destructive");

    const echoed = await ok("mcp.callTool", { server: "fx", tool: "echo", arguments: { text: "hello" } });
    assert.equal(echoed.text, "echo: hello");
    assert.equal(echoed.risk, "read");
    assert.equal((await ok("mcp.callTool", { server: "fx", tool: "env_value" })).text, "value: from-config");

    const big = await ok("mcp.callTool", { server: "fx", tool: "big" });
    assert.equal(big.truncated, true);
    assert.equal(Buffer.byteLength(big.text), 512 * 1024);

    assert.equal((await call("mcp.callTool", { server: "fx", tool: "fail" })).error === undefined
      ? (await ok("mcp.callTool", { server: "fx", tool: "fail" })).isError : true, true);
    assert.equal((await call("mcp.callTool", { server: "fx", tool: "nope" })).error?.code, -32602);
    assert.equal((await call("mcp.callTool", { server: "nope", tool: "echo" })).error?.code, -32602);

    await ok("mcp.restart", { server: "fx" });
    assert.equal((await server("fx")).status, "ready");
    await ok("mcp.stop", { server: "fx" });
    assert.equal((await server("fx")).status, "stopped");
    assert.ok(events.some((e) => e.event === "mcp.status" && e.data.status === "ready"));
    assert.ok(events.some((e) => e.event === "mcp.status" && e.data.status === "stopped"));
  } finally {
    await s.shutdown();
  }
});

test("tool timeout is enforced and the server stays usable", async () => {
  const { s, ok, call } = await fixture({ global: { fx: stdioServer({ timeoutMs: 800 }) } });
  try {
    await ok("mcp.start", { server: "fx" });
    const slow = await call("mcp.callTool", { server: "fx", tool: "slow" });
    assert.equal(slow.error?.code, -32011);
    assert.equal((await ok("mcp.callTool", { server: "fx", tool: "echo", arguments: { text: "still up" } })).text, "echo: still up");
  } finally {
    await s.shutdown();
  }
});

test("a broken server reports an error and does not block others", async () => {
  const { s, ok, call, server } = await fixture({ global: {
    broken: { type: "local", command: [process.execPath, "-e", "console.error('boom'); process.exit(3)"] },
    fx: stdioServer(),
    off: stdioServer({ enabled: false }),
  } });
  try {
    const failed = await call("mcp.start", { server: "broken" });
    assert.equal(failed.error?.code, -32021);
    assert.equal((await server("broken")).status, "error");
    assert.equal((await call("mcp.start", { server: "off" })).error?.code, -32022);
    assert.equal((await server("off")).status, "disabled");
    await ok("mcp.start", { server: "fx" });
    assert.equal((await server("fx")).status, "ready");
  } finally {
    await s.shutdown();
  }
});

test("project servers need trust; config change revokes it and stops the server", async () => {
  const { s, ws, ok, call, server } = await fixture({ project: { proj: stdioServer() }, global: { glob: stdioServer() } });
  try {
    let listing = await ok("mcp.servers");
    assert.equal(listing.trusted, false);
    assert.equal((await server("proj")).status, "untrusted");
    assert.equal((await server("glob")).status, "stopped"); // global is user-authored
    assert.equal((await call("mcp.start", { server: "proj" })).error?.code, -32019);
    assert.equal((await call("mcp.callTool", { server: "proj", tool: "echo", arguments: { text: "x" } })).error?.code, -32019);

    listing = await ok("workspace.trust");
    assert.equal(listing.trusted, true);
    assert.equal((await server("proj")).status, "stopped"); // trust never auto-starts
    await ok("mcp.start", { server: "proj" });
    assert.equal((await server("proj")).status, "ready");

    // The project changes the command: trust is gone, the server is stopped.
    writeFileSync(join(ws, "broagentai.json"), JSON.stringify({ mcp: { proj: stdioServer({ environment: { NEW_KEY: "1" } }) } }));
    assert.equal((await server("proj")).status, "untrusted");
    assert.equal((await ok("mcp.tools")).tools.length, 0);
    assert.equal((await call("mcp.start", { server: "proj" })).error?.code, -32019);

    await ok("workspace.trust");
    await ok("mcp.start", { server: "proj" });
    await ok("workspace.untrust");
    assert.equal((await server("proj")).status, "untrusted");
  } finally {
    await s.shutdown();
  }
});

test("a project override of a global server does not inherit trust", async () => {
  const { s, ok, call, server } = await fixture({ global: { shared: stdioServer() }, project: { shared: stdioServer({ risk: "destructive" }) } });
  try {
    assert.equal((await server("shared")).origin, "project");
    assert.equal((await call("mcp.start", { server: "shared" })).error?.code, -32019);
    await ok("workspace.trust");
    await ok("mcp.start", { server: "shared" });
    const tools = (await ok("mcp.tools")).tools;
    assert.ok(tools.every((t: any) => t.risk === "destructive")); // server-level override escalates every tool
  } finally {
    await s.shutdown();
  }
});

function freePort(): Promise<number> {
  return new Promise((resolvePort) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const port = (srv.address() as any).port; srv.close(() => resolvePort(port)); });
  });
}

test("remote Streamable HTTP server with an env-referenced auth header", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE, "--http", String(port)], {
    env: { ...process.env, FIXTURE_REQUIRE_AUTH: "Bearer s3cret" }, stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => child.stdout.once("data", r));
  process.env.BA_TEST_MCP_TOKEN = "s3cret";
  const { s, ok, call, server } = await fixture({ global: {
    remote: { type: "remote", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${env:BA_TEST_MCP_TOKEN}" } },
    noToken: { type: "remote", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: "Bearer ${env:BA_TEST_UNSET_VAR}" } },
  } });
  try {
    await ok("mcp.start", { server: "remote" });
    const info = await server("remote");
    assert.equal(info.status, "ready");
    assert.equal(info.transport, "http");
    assert.deepEqual(info.headerKeys, ["Authorization"]);
    assert.equal(JSON.stringify(await ok("mcp.servers")).includes("s3cret"), false);
    assert.equal((await ok("mcp.callTool", { server: "remote", tool: "echo", arguments: { text: "over http" } })).text, "echo: over http");

    const missing = await call("mcp.start", { server: "noToken" });
    assert.equal(missing.error?.code, -32008);
    assert.match(missing.error!.message, /BA_TEST_UNSET_VAR/);
  } finally {
    delete process.env.BA_TEST_MCP_TOKEN;
    await s.shutdown();
    child.kill();
  }
});
