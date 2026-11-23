import { createHash, randomUUID } from "node:crypto";

import { redactSecrets } from "./context.ts";
import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import type { ExecutionResult, WorkflowAttempt, WorkflowExpectation, WorkflowPlan, WorkflowRunResult, WorkflowStep, WorkflowStepResult, WorkflowWhen } from "./rpc.ts";
import { assertNoShellOverride, executionTag, MAX_COMMAND_CHARS, MAX_SHELL_TIMEOUT_MS, runShell } from "./shell.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const MAX_WORKFLOW_STEPS = 8;
export const MAX_WORKFLOW_RETRIES = 3;
export const MAX_WORKFLOW_ATTEMPTS = 16;
export const MAX_WORKFLOW_RETRY_DELAY_MS = 1000;
export const MAX_WORKFLOW_PLANS = 16;
const MAX_WORKFLOW_OUTPUT_CHARS = 2000;

const plans = new Map<string, WorkflowPlan>();
const STEP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WHEN_VALUES: WorkflowWhen[] = ["always", "success", "failure"];

function invalid(message: string): never {
  throw new WorkspaceError(ErrorCode.INVALID_PARAMS, message);
}

function asParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) invalid("params must be an object");
  return params as Record<string, unknown>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clip(text: string): string {
  return text.length <= MAX_WORKFLOW_OUTPUT_CHARS ? text : text.slice(0, MAX_WORKFLOW_OUTPUT_CHARS) + "\n[workflow output truncated]";
}

function normalizeExpectation(value: unknown): WorkflowExpectation | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) invalid("expect must be an object");
  const raw = value as Record<string, unknown>;
  const expectation: WorkflowExpectation = {};
  if (raw.exitCode !== undefined) {
    if (typeof raw.exitCode !== "number" || !Number.isInteger(raw.exitCode) || raw.exitCode < -255 || raw.exitCode > 255) {
      invalid("expect.exitCode must be an integer between -255 and 255");
    }
    expectation.exitCode = raw.exitCode;
  }
  for (const key of ["stdoutContains", "stderrContains", "notStdoutContains", "notStderrContains"] as const) {
    const text = raw[key];
    if (text === undefined) continue;
    if (typeof text !== "string") invalid(`expect.${key} must be a string`);
    expectation[key] = text;
  }
  return Object.keys(expectation).length > 0 ? expectation : undefined;
}

function normalizeStep(value: unknown, index: number): WorkflowStep {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`steps[${index}] must be an object`);
  const raw = value as Record<string, unknown>;
  assertNoShellOverride(raw);
  if (typeof raw.id !== "string" || !STEP_ID_RE.test(raw.id)) invalid(`steps[${index}].id must be 1-64 chars of [A-Za-z0-9_-]`);
  if (typeof raw.command !== "string" || raw.command.trim() === "") invalid(`steps[${index}].command must be a non-empty string`);
  if (raw.command.length > MAX_COMMAND_CHARS) invalid(`steps[${index}].command exceeds ${MAX_COMMAND_CHARS} characters`);

  const when = raw.when ?? "always";
  if (typeof when !== "string" || !WHEN_VALUES.includes(when as WorkflowWhen)) invalid(`steps[${index}].when must be always, success or failure`);
  const retries = raw.retries ?? 0;
  if (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0 || retries > MAX_WORKFLOW_RETRIES) {
    invalid(`steps[${index}].retries must be 0-${MAX_WORKFLOW_RETRIES}`);
  }
  const retryDelayMs = raw.retryDelayMs ?? 0;
  if (typeof retryDelayMs !== "number" || !Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > MAX_WORKFLOW_RETRY_DELAY_MS) {
    invalid(`steps[${index}].retryDelayMs must be 0-${MAX_WORKFLOW_RETRY_DELAY_MS}`);
  }

  const step: WorkflowStep = { id: raw.id, command: raw.command, when: when as WorkflowWhen, retries, retryDelayMs };
  if (raw.cwd !== undefined) {
    if (typeof raw.cwd !== "string" || raw.cwd.trim() === "") invalid(`steps[${index}].cwd must be a non-empty string`);
    step.cwd = raw.cwd;
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== "number" || raw.timeoutMs <= 0) invalid(`steps[${index}].timeoutMs must be a positive number`);
    step.timeoutMs = Math.min(Math.floor(raw.timeoutMs), MAX_SHELL_TIMEOUT_MS);
  }
  const expect = normalizeExpectation(raw.expect);
  if (expect) step.expect = expect;
  return step;
}

function shouldRun(when: WorkflowWhen, previous: WorkflowStepResult["status"] | undefined): boolean {
  if (when === "success") return previous === undefined || previous === "passed";
  if (when === "failure") return previous === "failed";
  return true;
}

function evaluate(result: ExecutionResult, expect: WorkflowExpectation | undefined): string | undefined {
  if (result.terminationReason !== "completed") return `termination: ${result.terminationReason}`;
  if (!expect) return result.exitCode === 0 ? undefined : `exit code ${result.exitCode}`;
  const failures: string[] = [];
  if (expect.exitCode !== undefined && result.exitCode !== expect.exitCode) failures.push(`exit code ${result.exitCode} != ${expect.exitCode}`);
  if (expect.stdoutContains !== undefined && !result.stdout.includes(expect.stdoutContains)) failures.push("stdout does not contain expected text");
  if (expect.stderrContains !== undefined && !result.stderr.includes(expect.stderrContains)) failures.push("stderr does not contain expected text");
  if (expect.notStdoutContains !== undefined && result.stdout.includes(expect.notStdoutContains)) failures.push("stdout contains forbidden text");
  if (expect.notStderrContains !== undefined && result.stderr.includes(expect.notStderrContains)) failures.push("stderr contains forbidden text");
  return failures.length > 0 ? failures.join("; ") : undefined;
}

export function planWorkflow(store: WorkspaceStore, params: unknown): WorkflowPlan {
  const p = asParams(params);
  assertNoShellOverride(p);
  if (!store.active()) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  if (!Array.isArray(p.steps) || p.steps.length === 0) invalid("steps must be a non-empty array");
  if (p.steps.length > MAX_WORKFLOW_STEPS) invalid(`steps cannot exceed ${MAX_WORKFLOW_STEPS}`);

  const steps = p.steps.map(normalizeStep);
  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id)) invalid(`duplicate step id: ${step.id}`);
    ids.add(step.id);
    if (step.cwd !== undefined) {
      try {
        confinePath(store.active()!.path, step.cwd);
      } catch (error) {
        if (error instanceof WorkspaceError && error.code === ErrorCode.PATH_ESCAPE) {
          throw new WorkspaceError(ErrorCode.SHELL_CWD_INVALID, error.message);
        }
        throw error;
      }
    }
  }
  const attempts = steps.reduce((total, step) => total + step.retries + 1, 0);
  if (attempts > MAX_WORKFLOW_ATTEMPTS) invalid(`workflow cannot exceed ${MAX_WORKFLOW_ATTEMPTS} total attempts`);

  const planId = createHash("sha256").update(JSON.stringify(steps)).digest("hex").slice(0, 16);
  const plan: WorkflowPlan = {
    planId,
    steps,
    declaredCommands: steps.map((step) => step.command),
    limits: {
      maxSteps: MAX_WORKFLOW_STEPS,
      maxRetries: MAX_WORKFLOW_RETRIES,
      maxAttempts: MAX_WORKFLOW_ATTEMPTS,
      maxRetryDelayMs: MAX_WORKFLOW_RETRY_DELAY_MS,
    },
  };
  plans.set(planId, plan);
  while (plans.size > MAX_WORKFLOW_PLANS) {
    const oldest = plans.keys().next().value;
    if (oldest === undefined) break;
    plans.delete(oldest);
  }
  return plan;
}

export function getWorkflowPlan(planId: unknown): WorkflowPlan | null {
  if (typeof planId !== "string") return null;
  return plans.get(planId) ?? null;
}

export async function runWorkflow(
  store: WorkspaceStore,
  params: unknown,
  emit: (event: string, payload: unknown) => void = () => {},
): Promise<WorkflowRunResult> {
  const p = asParams(params);
  assertNoShellOverride(p);
  if (typeof p.planId !== "string" || p.planId.trim() === "") invalid("planId must be a non-empty string");
  const plan = plans.get(p.planId);
  if (!plan) invalid("unknown workflow planId");
  const sessionId = executionTag(p.sessionId, "sessionId");
  const taskId = executionTag(p.taskId, "taskId");
  const runId = randomUUID();
  const started = Date.now();
  const results: WorkflowStepResult[] = [];
  let previous: WorkflowStepResult["status"] | undefined;
  let unresolvedFailures = 0;
  let hadFailure = false;

  for (const step of plan.steps) {
    if (!shouldRun(step.when, previous)) {
      results.push({ id: step.id, command: step.command, status: "skipped", when: step.when, attempts: [] });
      continue;
    }
    const attempts: WorkflowAttempt[] = [];
    let passed = false;
    for (let attempt = 1; attempt <= step.retries + 1; attempt++) {
      const executionId = `${runId.slice(0, 8)}-${step.id}-${attempt}`.slice(0, 128);
      const result = await runShell(
        store,
        step.command,
        step.cwd,
        step.timeoutMs,
        { sessionId, taskId, executionId },
        (info) => emit("shell.started", info),
      );
      const failureReason = evaluate(result, step.expect);
      attempts.push({
        executionId,
        exitCode: result.exitCode,
        terminationReason: result.terminationReason,
        timedOut: result.timedOut,
        truncated: result.truncated,
        stdout: clip(redactSecrets(result.stdout)),
        stderr: clip(redactSecrets(result.stderr)),
        passed: failureReason === undefined,
        ...(failureReason === undefined ? {} : { failureReason }),
      });
      if (failureReason === undefined) {
        passed = true;
        break;
      }
      if (attempt <= step.retries && step.retryDelayMs > 0) await sleep(step.retryDelayMs);
    }
    if (passed) {
      if (step.when === "failure" && unresolvedFailures > 0) unresolvedFailures--;
    } else {
      hadFailure = true;
      unresolvedFailures++;
    }
    previous = passed ? "passed" : "failed";
    results.push({
      id: step.id,
      command: step.command,
      status: passed ? "passed" : "failed",
      when: step.when,
      attempts,
    });
  }

  const summary = {
    total: results.length,
    passed: results.filter((step) => step.status === "passed").length,
    failed: results.filter((step) => step.status === "failed").length,
    skipped: results.filter((step) => step.status === "skipped").length,
    retries: results.reduce((total, step) => total + Math.max(0, step.attempts.length - 1), 0),
  };
  return {
    runId,
    planId: plan.planId,
    status: unresolvedFailures > 0 ? "failed" : hadFailure ? "recovered" : "completed",
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(taskId === undefined ? {} : { taskId }),
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    summary,
    steps: results,
  };
}
