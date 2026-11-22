import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { shellFor } from "./shell.ts";

const win = process.platform === "win32";

async function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "ba-shell-ws-"));
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "notes.txt"), "alpha\nneedle here\nomega\n");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-shell-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (params: unknown) => s.handle({ id: id++, method: "shell.run", params });
  const run = async (params: unknown) => {
    const res = await call(params);
    assert.equal(res.error, undefined, res.error?.message);
    return res.result as any;
  };
  return { ws, call, run };
}

test("shellFor picks the shell for the OS", () => {
  assert.equal(shellFor("win32").name, "powershell");
  assert.equal(shellFor("linux").name, "sh");
  assert.equal(shellFor("darwin").name, "sh");
  assert.deepEqual(shellFor("linux").args("ls -la"), ["-c", "ls -la"]);
  assert.equal(shellFor("win32").args("dir").at(-1)?.endsWith("dir"), true);
});

test("shell.run returns stdout, stderr and the exit code", async () => {
  const { run } = await fixture();
  const ok = await run({ command: win ? "Select-String -Path notes.txt -Pattern needle | ForEach-Object Line" : "grep needle notes.txt" });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), "needle here");
  assert.equal(ok.shell, win ? "powershell" : "sh");
  assert.equal(ok.shellFamily, win ? "powershell" : "sh");
  assert.equal(ok.encoding, "utf8");
  assert.equal(ok.terminationReason, "completed");
  assert.match(ok.executionId, /[-a-f0-9]{36}/);
  assert.deepEqual(ok.truncation, { stdout: false, stderr: false, stdoutBytes: Buffer.byteLength(ok.stdout), stderrBytes: 0, limitBytes: 256 * 1024 });

  const failed = await run({ command: win ? "[Console]::Error.WriteLine('bad'); exit 3" : "echo bad >&2; exit 3" });
  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /bad/);
  assert.equal(failed.timedOut, false);
});

test("shell.run starts in the workspace root, or a confined sub-directory", async () => {
  const { ws, run, call } = await fixture();
  const pwd = win ? "(Get-Location).Path" : "pwd";
  assert.equal(realpathSync((await run({ command: pwd })).stdout.trim()), realpathSync(ws));
  assert.equal(realpathSync((await run({ command: pwd, cwd: "sub" })).stdout.trim()), realpathSync(join(ws, "sub")));
  assert.equal((await call({ command: pwd, cwd: "../.." })).error?.code, -32026);
});

test("shell.run kills a command that exceeds its timeout", async () => {
  const { run } = await fixture();
  const started = Date.now();
  const res = await run({ command: win ? "Start-Sleep -Seconds 30" : "sleep 30", timeoutMs: 1500 });
  assert.equal(res.timedOut, true);
  assert.equal(res.exitCode, null);
  assert.equal(res.terminationReason, "timeout");
  assert.ok(Date.now() - started < 15000, "timeout did not stop the command");
});

test("shell.run caps output and validates input", async () => {
  const { run, call } = await fixture();
  const big = await run({ command: win ? "'x' * 400000" : "head -c 400000 /dev/zero | tr '\\0' x" });
  assert.equal(big.truncated, true);
  assert.equal(Buffer.byteLength(big.stdout), 256 * 1024);

  assert.equal((await call({ command: "" })).error?.code, -32602);
  assert.equal((await call({ command: ["ls"] })).error?.code, -32602);
  assert.equal((await call({ command: "x".repeat(9000) })).error?.code, -32602);
  assert.equal((await call({ command: "echo hi", shell: "cmd.exe" })).error?.code, -32602);
  assert.equal((await call({ command: "echo hi", executable: "/bin/bash" })).error?.code, -32602);
});

test("shell.run requires an active workspace", async () => {
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-shell-cfg-")) }) });
  assert.equal((await s.handle({ id: 1, method: "shell.run", params: { command: "echo hi" } })).error?.code, -32006);
});
