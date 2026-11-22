import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { detectShell, shellFor } from "./shell.ts";

const win = process.platform === "win32";

async function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "ba-shell-ws-"));
  mkdirSync(join(ws, "sub"));
  writeFileSync(join(ws, "notes.txt"), "alpha\nneedle here\nomega\n");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-shell-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const request = (method: string, params?: unknown) => s.handle({ id: id++, method, params });
  const call = (params: unknown) => request("shell.run", params);
  const run = async (params: unknown) => {
    const res = await call(params);
    assert.equal(res.error, undefined, res.error?.message);
    return res.result as any;
  };
  return { ws, s, request, call, run };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("shellFor keeps the fallback shell for the OS", () => {
  assert.equal(shellFor("win32").name, "powershell");
  assert.equal(shellFor("linux").name, "sh");
  assert.equal(shellFor("darwin").name, "sh");
  assert.deepEqual(shellFor("linux").args("ls -la"), ["-c", "ls -la"]);
  assert.equal(shellFor("win32").args("dir").at(-1)?.endsWith("dir"), true);
});

test("detectShell uses deterministic priority, caches, and reports missing shells", () => {
  const linux = detectShell({ platform: "linux", probe: (file) => file === "/bin/bash" });
  assert.equal(linux.family, "bash");
  assert.equal(linux.file, "/bin/bash");
  assert.equal(linux.environment, "native-linux");

  const mac = detectShell({ platform: "darwin", probe: (file) => file === "/bin/zsh" });
  assert.equal(mac.family, "zsh");

  const windows = detectShell({ platform: "win32", probe: (file) => file === "powershell.exe" });
  assert.equal(windows.family, "powershell");
  assert.equal(windows.file, "powershell.exe");

  assert.throws(
    () => detectShell({ platform: "linux", probe: () => false }),
    (error: any) => error?.code === -32023,
  );
  assert.equal(detectShell().file.length > 0, true);
});

test("shell.run returns stdout, stderr and the exit code", async () => {
  const { run } = await fixture();
  const ok = await run({ command: win ? "Select-String -Path notes.txt -Pattern needle | ForEach-Object Line" : "grep needle notes.txt" });
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), "needle here");
  assert.equal(win ? ok.shell === "powershell" : ["bash", "zsh", "sh"].includes(ok.shell), true);
  assert.equal(ok.shellFamily, ok.shell);
  assert.equal(ok.encoding, "utf8");
  assert.equal(ok.terminationReason, "completed");
  assert.match(ok.executionId, /^[-A-Za-z0-9_]{1,128}$/);
  assert.deepEqual(ok.truncation, { stdout: false, stderr: false, stdoutBytes: Buffer.byteLength(ok.stdout), stderrBytes: 0, limitBytes: 256 * 1024 });

  const failed = await run({ command: win ? "[Console]::Error.WriteLine('bad'); exit 3" : "echo bad >&2; exit 3" });
  assert.equal(failed.exitCode, 3);
  assert.match(failed.stderr, /bad/);
  assert.equal(failed.timedOut, false);
});

test("shell.run handles quoting and non-ASCII output", async () => {
  const { run } = await fixture();
  const res = await run({ command: win ? `$word = "héllo world"; Write-Output $word` : `printf '%s\n' "héllo world"` });
  assert.equal(res.stdout.trim(), "héllo world");
  assert.equal(res.exitCode, 0);
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

test("shell.run cancels a stable executionId", async () => {
  const { request, run } = await fixture();
  const executionId = "cancel_me_1";
  const pending = run({ command: win ? "Start-Sleep -Seconds 20; 'done'" : "sleep 20; echo done", executionId, timeoutMs: 10000 });
  await waitFor(async () => {
    const status = await request("shell.status", {});
    return (status.result as any)?.active?.includes(executionId) === true;
  });
  const cancelled = await request("shell.cancel", { executionId });
  assert.equal(cancelled.error, undefined, cancelled.error?.message);
  const res = await pending;
  assert.equal(res.executionId, executionId);
  assert.equal(res.terminationReason, "cancelled");
  assert.equal(res.exitCode, null);
  assert.equal(res.timedOut, false);
});

test("shell.run rejects work beyond the concurrency limit", async () => {
  const { request, run } = await fixture();
  const ids = ["busy_a_1", "busy_b_1"];
  const pending = ids.map((executionId) => run({
    command: win ? "Start-Sleep -Seconds 8" : "sleep 8",
    executionId,
    timeoutMs: 12000,
  }));
  await waitFor(async () => {
    const status = await request("shell.status", {});
    return (status.result as any)?.active?.length >= 2;
  });
  const excess = await request("shell.run", { command: win ? "'x'" : "echo x", executionId: "busy_c_1" });
  assert.equal(excess.error?.code, -32027);
  for (const executionId of ids) await request("shell.cancel", { executionId });
  for (const result of await Promise.all(pending)) assert.equal(result.terminationReason, "cancelled");
});

test("shell.output exposes bounded continuation from the redacted archive", async () => {
  const { request, run } = await fixture();
  const res = await run({ command: win ? "Write-Output 'alpha'; [Console]::Error.WriteLine('beta')" : "echo alpha; echo beta >&2" });
  const stdout = await request("shell.output", { executionId: res.executionId, stream: "stdout", offsetBytes: 0 });
  const stderr = await request("shell.output", { executionId: res.executionId, stream: "stderr", offsetBytes: 0 });
  assert.equal(stdout.error, undefined, stdout.error?.message);
  assert.equal((stdout.result as any).data.trim(), "alpha");
  assert.equal((stderr.result as any).data.trim(), "beta");

  const secret = await run({ command: win ? "Write-Output 'token=hunter2secret'" : "echo token=hunter2secret" });
  const redacted = await request("shell.output", { executionId: secret.executionId, stream: "stdout" });
  assert.doesNotMatch((redacted.result as any).data, /hunter2secret/);
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

test("shell.run kills detached children on POSIX", { skip: win }, async () => {
  const { run } = await fixture();
  const res = await run({ command: "sleep 30 & echo $!; wait", timeoutMs: 1000 });
  const pid = Number(res.stdout.trim());
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0));
});

test("shell.run requires an active workspace", async () => {
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-shell-cfg-")) }) });
  assert.equal((await s.handle({ id: 1, method: "shell.run", params: { command: "echo hi" } })).error?.code, -32006);
});
