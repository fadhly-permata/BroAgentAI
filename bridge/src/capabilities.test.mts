import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearDependencyHistory,
  dependencyHistory,
  discoverCapabilities,
  installDependency,
  planDependency,
  recommendCapabilities,
} from "./capabilities.ts";
import { ErrorCode } from "./rpc.ts";
import type { ExecutionResult } from "./rpc.ts";
import type { WorkspaceStore } from "./workspace.ts";

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "ba-cap-"));
  const store = {
    active: () => ({
      id: "workspace-cap",
      name: "cap",
      path,
      lastOpenedAt: new Date().toISOString(),
    }),
  } as unknown as WorkspaceStore;
  return { path, store };
}

function execution(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    executionId: "exec-cap",
    shell: "test",
    shellFamily: "test",
    environment: "test",
    cwd: ".",
    exitCode: 0,
    terminationReason: "completed",
    stdout: "added 1 package",
    stderr: "",
    encoding: "utf8",
    timedOut: false,
    truncated: false,
    truncation: { stdout: false, stderr: false, stdoutBytes: 15, stderrBytes: 0, limitBytes: 262144 },
    timeoutMs: 60000,
    durationMs: 12,
    ...overrides,
  };
}

test("discoverCapabilities reports bounded capabilities without exposing project secrets", () => {
  const { path, store } = fixture();
  writeFileSync(join(path, "package.json"), JSON.stringify({
    scripts: { build: "echo token=hunter2secret", test: "npm test" },
  }));
  const probe = (file: string) => {
    if (file === "node") return "v24.13.1";
    if (file === "jq") return "jq-1.7.1";
    return null;
  };

  const report = discoverCapabilities(store, { probe });
  const names = report.capabilities.map((item) => item.name);
  assert.ok(names.includes("node"));
  assert.ok(names.includes("jq"));
  assert.ok(names.includes("script:build"));
  assert.ok(names.includes("rg"));
  assert.equal(report.capabilities.find((item) => item.name === "rg")?.status, "missing");
  assert.equal(report.environment.credentialsExposed, false);
  assert.ok(report.checked >= report.capabilities.length);
  assert.equal(JSON.stringify(report).includes("hunter2secret"), false);
});

test("recommendCapabilities prefers an existing capability over installation", () => {
  const { store } = fixture();
  const probe = (file: string) => file === "node" ? "v24" : null;
  const report = discoverCapabilities(store, { probe });
  const json = recommendCapabilities("json", store, { report });
  assert.deepEqual(json.existing, ["node"]);
  assert.equal(json.installAllowed, false);
  assert.ok(json.options.length > 0);
  assert.equal(json.policy.preferExisting, true);

  const python = recommendCapabilities("python", store, { report });
  assert.deepEqual(python.existing, []);
  assert.equal(python.installAllowed, true);
});

test("planDependency refuses installation while an existing capability is available", () => {
  const { store } = fixture();
  const probe = (file: string) => file === "node" ? "v24" : null;
  assert.throws(
    () => planDependency(store, { need: "json", scope: "temporary", reason: "JSON support needed" }, { probe }),
    (error: any) => error.code === ErrorCode.NOT_ALLOWED,
  );
});

test("dependency installation requires explicit approval and records observed side effects", async () => {
  const { path, store } = fixture();
  const probe = () => null;
  const plan = planDependency(store, {
    need: "json",
    package: "node-jq",
    scope: "temporary",
    reason: "JSON support needed",
  }, { probe });
  assert.equal(plan.explicitApprovalRequired, true);
  assert.match(plan.command, /npm install --no-save --package-lock=false node-jq/);
  assert.ok(plan.declaredSideEffects.includes("node_modules"));

  await assert.rejects(
    () => installDependency(store, { requestId: plan.requestId, approved: false }),
    (error: any) => error.code === ErrorCode.DEPENDENCY_APPROVAL_REQUIRED,
  );

  const result = await installDependency(store, { requestId: plan.requestId, approved: true }, {
    execute: async () => {
      writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: {} }));
      return execution();
    },
  });
  assert.equal(result.status, "installed");
  assert.equal(result.exitCode, 0);
  assert.ok(result.observedSideEffects.includes("package.json"));

  const history = dependencyHistory({});
  assert.equal(history.total, 1);
  assert.equal(history.entries[0]?.approved, true);
  assert.equal(history.entries[0]?.scope, "temporary");
  assert.deepEqual(history.entries[0]?.observedSideEffects, ["package.json"]);
  assert.equal(clearDependencyHistory({}).cleared, 1);
  assert.equal(dependencyHistory({}).total, 0);
});
