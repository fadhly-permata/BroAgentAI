import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { AGENT_MODES, approvalKey, decide, normalizeMode, writePreview } from "./agent.ts";
import type { ToolCategory } from "./agent.ts";

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

test("policy: reading is always automatic, everything else follows the mode", () => {
  assert.deepEqual(AGENT_MODES, ["read-only", "always-ask", "ask-once", "auto-approve"]);
  const changing: ToolCategory[] = ["write", "delete", "stage", "commit", "sync", "mcp-destructive", "execute"];
  for (const mode of AGENT_MODES) assert.equal(decide("read", mode), "auto", mode);
  for (const category of changing) {
    assert.equal(decide(category, "read-only"), "deny", category);
    assert.equal(decide(category, "always-ask"), "ask", category);
    assert.equal(decide(category, "ask-once"), "ask", category); // the panel remembers the answer
    assert.equal(decide(category, "auto-approve"), "auto", category);
  }
});

test("normalizeMode maps legacy names and never elevates an unknown value", () => {
  assert.equal(normalizeMode("auto-approve"), "auto-approve");
  assert.equal(normalizeMode("ask"), "always-ask");
  assert.equal(normalizeMode("auto-edit"), "ask-once");
  assert.equal(normalizeMode("full-auto"), "auto-approve");
  assert.equal(normalizeMode("god-mode"), "always-ask");
  assert.equal(normalizeMode(undefined), "always-ask");
  assert.equal(normalizeMode(3), "always-ask");
});

test("approvalKey: one key per tool, but one key per shell command line", () => {
  assert.equal(approvalKey("fs.writeFile", { path: "a.txt" }), "fs.writeFile");
  assert.equal(approvalKey("fs.writeFile", { path: "b.txt" }), "fs.writeFile");
  assert.equal(approvalKey("shell.run", { command: " npm test " }), "shell.run:npm test");
  assert.notEqual(approvalKey("shell.run", { command: "npm test" }), approvalKey("shell.run", { command: "rm -rf ." }));
});

test("writePreview shows only the changed region", () => {
  assert.equal(writePreview("a\nb\nc\n", "a\nb\nc\n"), "(no change)");
  assert.equal(writePreview("a\nb\nc", "a\nB\nc"), "@@ line 2 @@\n a\n-b\n+B\n c");
  assert.match(writePreview(null, "x\ny"), /^\(new file\)\n\+x\n\+y$/);
});

test("tools.list contains built-ins and agent.prompt embeds catalog, shell, instructions and skills", async () => {
  const { ok, ws } = await fixture();
  const { tools } = await ok("tools.list");
  assert.ok(tools.some((t: any) => t.name === "fs.readFile" && t.category === "read"));
  assert.ok(tools.some((t: any) => t.name === "git.push" && t.category === "sync"));
  assert.ok(tools.some((t: any) => t.name === "shell.run" && t.category === "execute"));
  assert.ok(!tools.some((t: any) => t.name.startsWith("term."))); // the interactive PTY is not an agent tool

  const { prompt, mode, toolCount } = await ok("agent.prompt", { mode: "ask-once" });
  assert.equal(mode, "ask-once");
  assert.equal(toolCount, tools.length);
  assert.ok(prompt.includes(ws));
  assert.ok(prompt.includes('{"command":"fs.readFile","params":{"path":"README.md"}}'));
  assert.ok(prompt.includes("Always answer in haiku."));
  assert.ok(prompt.includes("release-notes"));
  assert.ok(!prompt.includes("Do the thing.")); // skill bodies are read on demand
  assert.ok(prompt.includes("- shell.run"));
  assert.match(prompt, new RegExp(`- Shell: ${process.platform === "win32" ? "powershell" : "sh"}`));
  assert.match(prompt, /READY/);

  // A handoff prompt must not ask for READY: the AI continues the moved task.
  const moved = (await ok("agent.prompt", { mode: "ask-once", handoff: true })).prompt;
  assert.ok(!/single word READY/.test(moved));
  assert.match(moved, /Do NOT reply READY/);
});

test("agent.check reports decision, approval key, paths and a preview without executing", async () => {
  const { ok, call, ws } = await fixture();
  assert.equal((await ok("agent.check", { command: "fs.readFile", params: { path: "README.md" }, mode: "read-only" })).decision, "auto");

  const write = await ok("agent.check", { command: "fs.writeFile", params: { path: "README.md", content: "# Title\nline 2\nline three\n" }, mode: "always-ask" });
  assert.equal(write.decision, "ask");
  assert.equal(write.category, "write");
  assert.equal(write.approvalKey, "fs.writeFile");
  assert.deepEqual(write.paths, ["README.md"]);
  assert.match(write.preview, /-line two\n\+line 2/);
  assert.equal(readFileSync(join(ws, "README.md"), "utf8"), "# Title\nline two\nline three\n"); // untouched

  const shell = await ok("agent.check", { command: "shell.run", params: { command: "echo hi" }, mode: "ask-once" });
  assert.equal(shell.decision, "ask");
  assert.equal(shell.category, "execute");
  assert.equal(shell.approvalKey, "shell.run:echo hi");
  assert.equal(shell.preview, "$ echo hi"); // the card shows the exact command

  assert.equal((await ok("agent.check", { command: "fs.writeFile", params: { path: "new.txt", content: "x" }, mode: "read-only" })).decision, "deny");
  assert.equal((await ok("agent.check", { command: "shell.run", params: { command: "echo hi" }, mode: "read-only" })).decision, "deny");
  assert.equal((await ok("agent.check", { command: "git.push", params: {}, mode: "auto-approve" })).decision, "auto");
  assert.equal((await call("agent.check", { command: "fs.format", params: {}, mode: "always-ask" })).error?.code, -32601);
  assert.equal((await call("agent.check", { command: "workspace.remove", params: {}, mode: "auto-approve" })).error?.code, -32601); // not in the catalog
});

test("agent.callTool enforces the mode on the host", async () => {
  const { ok, call, ws } = await fixture();
  assert.match((await ok("agent.callTool", { command: "fs.readFile", params: { path: "README.md" }, mode: "read-only" })).text, /line two/);

  const write = { command: "fs.writeFile", params: { path: "out.txt", content: "hello" } };
  assert.equal((await call("agent.callTool", { ...write, mode: "read-only", approved: true })).error?.code, -32022); // approval cannot beat read-only
  for (const mode of ["always-ask", "ask-once"]) {
    assert.equal((await call("agent.callTool", { ...write, mode })).error?.code, -32022, mode);
    assert.equal((await call("agent.callTool", { ...write, mode, approved: "yes" })).error?.code, -32022, mode); // must be exactly true
  }
  assert.equal((await call("agent.callTool", { ...write, mode: "nonsense" })).error?.code, -32022); // unknown mode = always-ask
  assert.equal(existsSync(join(ws, "out.txt")), false);

  await ok("agent.callTool", { ...write, mode: "always-ask", approved: true });
  assert.equal(readFileSync(join(ws, "out.txt"), "utf8"), "hello");
  await ok("agent.callTool", { command: "fs.writeFile", params: { path: "auto.txt", content: "a" }, mode: "auto-approve" });
  assert.equal(existsSync(join(ws, "auto.txt")), true);

  // Mode does not loosen confinement of the file tools, or widen the catalog.
  assert.equal((await call("agent.callTool", { command: "fs.readFile", params: { path: "../../etc/passwd" }, mode: "auto-approve" })).error?.code, -32001);
  assert.equal((await call("agent.callTool", { command: "term.create", params: {}, mode: "auto-approve", approved: true })).error?.code, -32601);
});

test("shell.run through the agent: denied, asked, then executed with real output", async () => {
  const { ok, call, ws } = await fixture();
  const marker = process.platform === "win32" ? 'Write-Output "$(6*7)-shell"' : 'echo "$((6*7))-shell"';
  assert.equal((await call("agent.callTool", { command: "shell.run", params: { command: marker }, mode: "read-only", approved: true })).error?.code, -32022);
  assert.equal((await call("agent.callTool", { command: "shell.run", params: { command: marker }, mode: "ask-once" })).error?.code, -32022);

  const res = await ok("agent.callTool", { command: "shell.run", params: { command: marker }, mode: "always-ask", approved: true });
  const out = JSON.parse(res.text);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /42-shell/);
  assert.equal(out.timedOut, false);

  // It really runs in the workspace root, and writes land there.
  const touch = process.platform === "win32" ? "Set-Content -Path made-by-shell.txt -Value ok" : "echo ok > made-by-shell.txt";
  await ok("agent.callTool", { command: "shell.run", params: { command: touch }, mode: "auto-approve" });
  assert.equal(existsSync(join(ws, "made-by-shell.txt")), true);
});

test("large tool results are capped", async () => {
  const { ok, ws } = await fixture();
  writeFileSync(join(ws, "big.txt"), "y".repeat(200 * 1024));
  const res = await ok("agent.callTool", { command: "fs.readFile", params: { path: "big.txt" }, mode: "always-ask" });
  assert.equal(res.truncated, true);
  assert.equal(res.text.length, 48 * 1024);
});

test("MCP tools join the catalog and follow the same modes", async () => {
  const { s, ok, call } = await fixture({ fx: { type: "local", command: [process.execPath, FIXTURE] } });
  try {
    assert.equal((await call("agent.check", { command: "mcp.fx.echo", params: { text: "x" }, mode: "always-ask" })).error?.code, -32020); // not running
    await ok("mcp.start", { server: "fx" });
    const { tools } = await ok("tools.list");
    const cat = Object.fromEntries(tools.map((t: any) => [t.name, t.category]));
    assert.equal(cat["mcp.fx.echo"], "read");
    assert.equal(cat["mcp.fx.write_note"], "write");
    assert.equal(cat["mcp.fx.wipe"], "mcp-destructive");
    assert.ok((await ok("agent.prompt", {})).prompt.includes("mcp.fx.echo"));

    assert.match((await ok("agent.callTool", { command: "mcp.fx.echo", params: { text: "hi" }, mode: "read-only" })).text, /echo: hi/);
    assert.equal((await call("agent.callTool", { command: "mcp.fx.write_note", params: {}, mode: "read-only" })).error?.code, -32022);
    assert.equal((await call("agent.callTool", { command: "mcp.fx.wipe", params: {}, mode: "ask-once" })).error?.code, -32022);
    assert.equal((await ok("agent.check", { command: "mcp.fx.wipe", params: {}, mode: "ask-once" })).approvalKey, "mcp.fx.wipe");
    assert.match((await ok("agent.callTool", { command: "mcp.fx.wipe", params: {}, mode: "auto-approve" })).text, /wiped/);
  } finally {
    await s.shutdown();
  }
});
