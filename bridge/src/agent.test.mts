import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { decide, normalizeMode, writePreview } from "./agent.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-fixture-server.mjs", import.meta.url));

async function fixture(globalMcp?: object) {
  const configDir = mkdtempSync(join(tmpdir(), "ba-agent-cfg-"));
  if (globalMcp) writeFileSync(join(configDir, "broagentai.json"), JSON.stringify({ mcp: globalMcp }));
  const ws = mkdtempSync(join(tmpdir(), "ba-agent-ws-"));
  writeFileSync(join(ws, "README.md"), "# Title\nline two\nline three\n");
  writeFileSync(join(ws, "AGENTS.md"), "Always answer in haiku.\n");
  mkdirSync(join(ws, ".broagentai", "skills", "release-notes"), { recursive: true });
  writeFileSync(join(ws, ".broagentai", "skills", "release-notes", "SKILL.md"), "# Release notes\nDo the thing.\n");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  return { s, ws, call, ok };
}

test("policy table matches the approval-mode spec", () => {
  assert.equal(decide("read", "read-only"), "auto");
  assert.equal(decide("write", "read-only"), "deny");
  assert.equal(decide("write", "ask"), "ask");
  assert.equal(decide("write", "auto-edit"), "auto");
  assert.equal(decide("delete", "auto-edit"), "ask");
  assert.equal(decide("delete", "full-auto"), "auto");
  assert.equal(decide("commit", "auto-edit"), "ask");
  assert.equal(decide("commit", "full-auto"), "auto");
  assert.equal(decide("stage", "auto-edit"), "auto");
  for (const mode of ["ask", "auto-edit", "full-auto"] as const) assert.equal(decide("sync", mode), "ask"); // push/pull never automatic
  assert.equal(decide("sync", "read-only"), "deny");
  assert.equal(decide("mcp-destructive", "full-auto"), "ask");
  assert.equal(normalizeMode("full-auto"), "full-auto");
  assert.equal(normalizeMode("god-mode"), "ask"); // unknown never elevates
  assert.equal(normalizeMode(undefined), "ask");
});

test("writePreview shows only the changed region", () => {
  assert.equal(writePreview("a\nb\nc\n", "a\nb\nc\n"), "(no change)");
  assert.equal(writePreview("a\nb\nc", "a\nB\nc"), "@@ line 2 @@\n a\n-b\n+B\n c");
  assert.match(writePreview(null, "x\ny"), /^\(new file\)\n\+x\n\+y$/);
});

test("tools.list contains built-ins and agent.prompt embeds catalog, instructions and skills", async () => {
  const { ok, ws } = await fixture();
  const { tools } = await ok("tools.list");
  assert.ok(tools.some((t: any) => t.name === "fs.readFile" && t.category === "read"));
  assert.ok(tools.some((t: any) => t.name === "git.push" && t.category === "sync"));
  assert.ok(!tools.some((t: any) => t.name.startsWith("term."))); // the PTY is not an agent tool

  const { prompt, mode, toolCount } = await ok("agent.prompt", { mode: "auto-edit" });
  assert.equal(mode, "auto-edit");
  assert.equal(toolCount, tools.length);
  assert.ok(prompt.includes(ws));
  assert.ok(prompt.includes('{"command":"fs.readFile","params":{"path":"README.md"}}'));
  assert.ok(prompt.includes("Always answer in haiku."));
  assert.ok(prompt.includes("release-notes"));
  assert.ok(!prompt.includes("Do the thing.")); // skill bodies are read on demand
  assert.ok(prompt.includes("- fs.writeFile"));
  assert.match(prompt, /READY/);
});

test("agent.check reports decision, paths and a diff preview without executing", async () => {
  const { ok, call, ws } = await fixture();
  const read = await ok("agent.check", { command: "fs.readFile", params: { path: "README.md" }, mode: "read-only" });
  assert.equal(read.decision, "auto");

  const write = await ok("agent.check", { command: "fs.writeFile", params: { path: "README.md", content: "# Title\nline 2\nline three\n" }, mode: "ask" });
  assert.equal(write.decision, "ask");
  assert.equal(write.category, "write");
  assert.deepEqual(write.paths, ["README.md"]);
  assert.match(write.preview, /-line two\n\+line 2/);
  assert.equal(readFileSync(join(ws, "README.md"), "utf8"), "# Title\nline two\nline three\n"); // untouched

  assert.equal((await ok("agent.check", { command: "fs.writeFile", params: { path: "new.txt", content: "x" }, mode: "read-only" })).decision, "deny");
  assert.equal((await call("agent.check", { command: "fs.format", params: {}, mode: "ask" })).error?.code, -32601);
  assert.equal((await call("agent.check", { command: "workspace.remove", params: {}, mode: "full-auto" })).error?.code, -32601); // not in the catalog
});

test("agent.callTool enforces the mode on the host", async () => {
  const { ok, call, ws } = await fixture();
  const read = await ok("agent.callTool", { command: "fs.readFile", params: { path: "README.md" }, mode: "read-only" });
  assert.match(read.text, /line two/);

  const write = { command: "fs.writeFile", params: { path: "out.txt", content: "hello" } };
  assert.equal((await call("agent.callTool", { ...write, mode: "read-only", approved: true })).error?.code, -32022); // approval cannot beat read-only
  assert.equal((await call("agent.callTool", { ...write, mode: "ask" })).error?.code, -32022);
  assert.equal((await call("agent.callTool", { ...write, mode: "ask", approved: "yes" })).error?.code, -32022); // must be exactly true
  assert.equal(existsSync(join(ws, "out.txt")), false);

  await ok("agent.callTool", { ...write, mode: "ask", approved: true });
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "hello");
  await ok("agent.callTool", { command: "fs.writeFile", params: { path: "auto.txt", content: "a" }, mode: "auto-edit" });
  assert.equal(existsSync(join(ws, "auto.txt")), true);

  assert.equal((await call("agent.callTool", { command: "git.push", params: {}, mode: "full-auto" })).error?.code, -32022); // sync always asks
  assert.equal((await call("agent.callTool", { command: "fs.readFile", params: { path: "../../etc/passwd" }, mode: "full-auto" })).error?.code, -32001);
  assert.equal((await call("agent.callTool", { command: "term.create", params: {}, mode: "full-auto", approved: true })).error?.code, -32601);
});

test("large tool results are capped", async () => {
  const { ok, ws } = await fixture();
  writeFileSync(join(ws, "big.txt"), "y".repeat(200 * 1024));
  const res = await ok("agent.callTool", { command: "fs.readFile", params: { path: "big.txt" }, mode: "ask" });
  assert.equal(res.truncated, true);
  assert.equal(res.text.length, 48 * 1024);
});

test("MCP tools join the catalog and follow risk-based approval", async () => {
  const { s, ok, call } = await fixture({ fx: { type: "local", command: [process.execPath, FIXTURE] } });
  try {
    assert.equal((await call("agent.check", { command: "mcp.fx.echo", params: { text: "x" }, mode: "ask" })).error?.code, -32020); // not running
    await ok("mcp.start", { server: "fx" });
    const { tools } = await ok("tools.list");
    const cat = Object.fromEntries(tools.map((t: any) => [t.name, t.category]));
    assert.equal(cat["mcp.fx.echo"], "read");
    assert.equal(cat["mcp.fx.write_note"], "write");
    assert.equal(cat["mcp.fx.wipe"], "mcp-destructive");
    assert.ok((await ok("agent.prompt", {})).prompt.includes("mcp.fx.echo"));

    assert.match((await ok("agent.callTool", { command: "mcp.fx.echo", params: { text: "hi" }, mode: "read-only" })).text, /echo: hi/);
    assert.equal((await call("agent.callTool", { command: "mcp.fx.write_note", params: {}, mode: "read-only" })).error?.code, -32022);
    assert.equal((await call("agent.callTool", { command: "mcp.fx.wipe", params: {}, mode: "full-auto" })).error?.code, -32022);
    assert.match((await ok("agent.callTool", { command: "mcp.fx.wipe", params: {}, mode: "full-auto", approved: true })).text, /wiped/);
  } finally {
    await s.shutdown();
  }
});
