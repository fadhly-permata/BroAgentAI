import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

async function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "ba-workflow-ws-"));
  mkdirSync(join(ws, "sub"));
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-workflow-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  return { ws, s, call, ok };
}

test("workflow.plan normalizes bounded steps and rejects shell overrides", async () => {
  const { ok, call } = await fixture();
  const plan = await ok("workflow.plan", {
    steps: [
      { id: "check", command: "npm test", when: "success", retries: 1, retryDelayMs: 5, expect: { exitCode: 0 } },
      { id: "build", command: "npm run build", cwd: "sub" },
    ],
  });
  assert.match(plan.planId, /^[a-f0-9]{16}$/);
  assert.equal(plan.steps[0].when, "success");
  assert.equal(plan.steps[0].retries, 1);
  assert.deepEqual(plan.steps[0].expect, { exitCode: 0 });
  assert.equal(plan.steps[1].cwd, "sub");
  assert.deepEqual(plan.declaredCommands, ["npm test", "npm run build"]);
  assert.equal(plan.limits.maxAttempts, 16);

  const override = await call("workflow.plan", { steps: [{ id: "x", command: "echo hi" }], shell: "bash" });
  assert.equal(override.error?.code, -32602);
  const nestedOverride = await call("workflow.plan", { steps: [{ id: "x", command: "echo hi", shellPath: "/bin/bash" }] });
  assert.equal(nestedOverride.error?.code, -32602);
  const escape = await call("workflow.plan", { steps: [{ id: "x", command: "echo hi", cwd: "../escape" }] });
  assert.equal(escape.error?.code, -32026);
  const unknown = await call("workflow.run", { planId: "missing" });
  assert.equal(unknown.error?.code, -32602);
});

test("workflow.run records retries, conditional recovery, and validation feedback", async () => {
  const { ws, ok } = await fixture();
  writeFileSync(join(ws, "retry.txt"), "0");
  const flaky = "node -e \"const fs=require('fs');const p='retry.txt';const n=(fs.existsSync(p)?Number(fs.readFileSync(p,'utf8')):0)+1;fs.writeFileSync(p,String(n));process.stdout.write(String(n));process.exit(n<2?1:0)\"";
  const plan = await ok("workflow.plan", {
    steps: [
      { id: "boom", command: "node -e \"process.stdout.write('boom');process.exit(2)\"" },
      { id: "recover", command: flaky, when: "failure", retries: 1, retryDelayMs: 1, expect: { exitCode: 0 } },
    ],
  });

  const result = await ok("workflow.run", { planId: plan.planId, sessionId: "wf_session", taskId: "wf_task" });
  assert.equal(result.status, "recovered");
  assert.equal(result.sessionId, "wf_session");
  assert.equal(result.taskId, "wf_task");
  assert.deepEqual(result.summary, { total: 2, passed: 1, failed: 1, skipped: 0, retries: 1 });
  assert.equal(result.steps[0].status, "failed");
  assert.match(result.steps[0].attempts[0].failureReason ?? "", /^exit code /);
  assert.equal(result.steps[1].status, "passed");
  assert.equal(result.steps[1].attempts.length, 2);
  assert.equal(result.steps[1].attempts[0].passed, false);
  assert.equal(result.steps[1].attempts[1].passed, true);
  for (const step of result.steps) {
    for (const attempt of step.attempts) {
      assert.match(attempt.executionId, /^[A-Za-z0-9_-]{1,128}$/);
    }
  }
});

test("workflow.run validates expected output and skips conditional steps", async () => {
  const { ok } = await fixture();
  const plan = await ok("workflow.plan", {
    steps: [
      { id: "alpha", command: "node -e \"process.stdout.write('alpha')\"", expect: { stdoutContains: "missing" } },
      { id: "never", command: "node -e \"process.stdout.write('never')\"", when: "success", expect: { stdoutContains: "never" } },
    ],
  });
  const result = await ok("workflow.run", { planId: plan.planId });
  assert.equal(result.status, "failed");
  assert.deepEqual(result.summary, { total: 2, passed: 0, failed: 1, skipped: 1, retries: 0 });
  assert.equal(result.steps[0].status, "failed");
  assert.match(result.steps[0].attempts[0].failureReason ?? "", /stdout does not contain expected text/);
  assert.equal(result.steps[1].status, "skipped");
  assert.equal(result.steps[1].attempts.length, 0);
});
