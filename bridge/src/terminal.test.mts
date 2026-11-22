import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { terminalShellFor } from "./shell.ts";
import { WorkspaceStore } from "./workspace.ts";

let hasPty = true;
try { await import("node-pty"); } catch { hasPty = false; }
const ptyTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasPty ? false : "node-pty not available" }, fn);

async function fixture() {
  const events: { event: string; data: any }[] = [];
  const s = new RpcServer({
    store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-term-cfg-")) }),
    emit: (event, data) => events.push({ event, data }),
  });
  const ws = mkdtempSync(join(tmpdir(), "ba-term-ws-"));
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const output = (sessionId: string) =>
    events.filter((e) => e.event === "term.output" && e.data.sessionId === sessionId).map((e) => e.data.data).join("");
  const until = async (fn: () => boolean, timeout = 15000) => {
    const deadline = Date.now() + timeout;
    while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  return { s, ws, call, events, output, until };
}

ptyTest("term.create runs a real shell in the workspace and streams output", async () => {
  const { s, ws, call, events, output, until } = await fixture();
  try {
    const created = await call("term.create", { cols: 100, rows: 30 });
    assert.equal(created.error, undefined, created.error?.message);
    const { sessionId, cwd } = created.result as any;
    assert.equal(realpathSync(cwd), realpathSync(ws));

    // The marker is computed by the shell, so it can only appear in real output, not in the echo of the input.
    const command = process.platform === "win32" ? "Write-Output \"$(6*7)-marker\"\r" : "echo $((6*7))-marker\r";
    assert.equal((await call("term.input", { sessionId, data: command })).error, undefined);
    assert.ok(await until(() => output(sessionId).includes("42-marker")), "shell output not received: " + output(sessionId).slice(-300));

    assert.equal((await call("term.resize", { sessionId, cols: 120, rows: 40 })).error, undefined);
    assert.equal(((await call("term.list")).result as any).sessions.length, 1);

    assert.equal((await call("term.close", { sessionId })).error, undefined);
    assert.ok(await until(() => events.some((e) => e.event === "term.exit" && e.data.sessionId === sessionId)), "no term.exit");
    assert.equal(((await call("term.list")).result as any).sessions.length, 0);
    assert.equal((await call("term.input", { sessionId, data: "x" })).error?.code, -32602);
  } finally {
    await s.shutdown();
  }
});

ptyTest("terminal limits and validation", async () => {
  const { s, call } = await fixture();
  try {
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push(((await call("term.create")).result as any).sessionId);
    assert.equal((await call("term.create")).error?.code, -32022);
    assert.equal((await call("term.input", { sessionId: ids[0], data: 42 })).error?.code, -32602);
    assert.equal((await call("term.input", { sessionId: ids[0], data: "x".repeat(70 * 1024) })).error?.code, -32602);
    assert.equal((await call("term.input", { sessionId: "nope", data: "x" })).error?.code, -32602);
  } finally {
    await s.shutdown();
  }
});

test("term.create requires an active workspace", async () => {
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-term-cfg-")) }) });
  assert.equal((await s.handle({ id: 1, method: "term.create", params: {} })).error?.code, -32006);
});

test("terminal shell is detection-only and rejects overrides", async () => {
  const detected = terminalShellFor();
  assert.equal(detected.file, process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  assert.equal(detected.family, process.platform === "win32" ? "powershell" : "sh");

  const { s, call } = await fixture();
  try {
    assert.equal((await call("term.create", { shell: "/bin/bash" })).error?.code, -32602);
    assert.equal((await call("term.create", { executable: "pwsh" })).error?.code, -32602);
  } finally {
    await s.shutdown();
  }
});
