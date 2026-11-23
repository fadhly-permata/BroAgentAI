import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { loadMergedConfig } from "./config.ts";
import type { SkillRunAllowlistEntry } from "./config.ts";
import { redactSecrets } from "./context.ts";
import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import type { SkillRunInfo, SkillRunResult } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const MAX_SKILL_RUNS = 16;
export const MAX_SKILL_COMMAND_PARTS = 16;
export const MAX_SKILL_PART_CHARS = 256;
export const MAX_SKILL_ENV_KEYS = 16;
export const MAX_SKILL_TIMEOUT_MS = 120_000;
export const DEFAULT_SKILL_TIMEOUT_MS = 30_000;
export const MAX_SKILL_OUTPUT_BYTES = 256 * 1024;
export const MAX_SKILL_HISTORY = 24;

const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_META = /[;&|`<>]/;

function assertNoCommandOverride(params: Record<string, unknown>): void {
  for (const key of ["command", "args", "env"]) {
    if (Object.hasOwn(params, key)) {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `${key} is not allowed; use the allowlisted skill name only`);
    }
  }
}

export interface SkillRunHistoryEntry {
  executionId: string;
  name: string;
  command: string[];
  cwd: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  approved: true;
}

const history: SkillRunHistoryEntry[] = [];

function validateEntry(name: string, entry: SkillRunAllowlistEntry): SkillRunInfo {
  if (!SKILL_NAME.test(name)) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `invalid skill run name: ${name}`);
  }
  if (!entry || typeof entry !== "object") {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run ${name} must be an object`);
  }
  if (!Array.isArray(entry.command) || entry.command.length === 0 || entry.command.length > MAX_SKILL_COMMAND_PARTS) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run ${name} needs a bounded command array`);
  }
  for (const part of entry.command) {
    if (typeof part !== "string" || part === "" || part.length > MAX_SKILL_PART_CHARS || /[\0\r\n]/.test(part) || SHELL_META.test(part)) {
      throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run ${name} has an invalid command part`);
    }
  }
  if (entry.env !== undefined) {
    if (!Array.isArray(entry.env) || entry.env.length > MAX_SKILL_ENV_KEYS) {
      throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run ${name} has too many env keys`);
    }
    for (const key of entry.env) {
      if (typeof key !== "string" || !ENV_KEY.test(key)) {
        throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run ${name} has an invalid env key`);
      }
    }
  }
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1000 || entry.timeoutMs > MAX_SKILL_TIMEOUT_MS)) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run ${name} timeoutMs must be between 1000 and ${MAX_SKILL_TIMEOUT_MS}`);
  }
  return {
    name,
    command: [...entry.command],
    cwd: typeof entry.cwd === "string" && entry.cwd !== "" ? entry.cwd : ".",
    envKeys: [...(entry.env ?? [])].sort(),
    timeoutMs: entry.timeoutMs ?? DEFAULT_SKILL_TIMEOUT_MS,
  };
}

export function listSkillRuns(store: WorkspaceStore): { skills: SkillRunInfo[] } {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  const configured = loadMergedConfig(store).skillRuns;
  const names = Object.keys(configured).sort();
  if (names.length > MAX_SKILL_RUNS) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `too many skill runs configured (max ${MAX_SKILL_RUNS})`);
  }
  return {
    skills: names.map((name) => {
      const info = validateEntry(name, configured[name]);
      return { ...info, cwd: confinePath(active.path, info.cwd) };
    }),
  };
}

export function resolveSkillRun(store: WorkspaceStore, name: unknown): SkillRunInfo {
  if (typeof name !== "string" || !SKILL_NAME.test(name)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "name must be an allowlisted skill run name");
  }
  const found = listSkillRuns(store).skills.find((skill) => skill.name === name);
  if (!found) throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `skill run ${name} is not allowlisted`);
  return found;
}

function restrictedEnv(keys: string[]): NodeJS.ProcessEnv {
  const inherited = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined) {
      throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `skill run environment variable is unset: ${key}`);
    }
    env[key] = value;
  }
  return env;
}

export async function runSkillScript(store: WorkspaceStore, params: Record<string, unknown>): Promise<SkillRunResult> {
  assertNoCommandOverride(params);
  if (params.approved !== true) {
    throw new WorkspaceError(ErrorCode.NOT_ALLOWED, "skill.run requires explicit user approval");
  }
  const skill = resolveSkillRun(store, params.name);
  const env = restrictedEnv(skill.envKeys);
  const command = skill.command;
  const reportedCommand = command.map((part) => redactSecrets(part));
  const executionId = randomUUID();
  const startedAt = new Date().toISOString();
  const started = Date.now();

  return new Promise<SkillRunResult>((resolvePromise, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: skill.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const truncated = { stdout: false, stderr: false };
    let timedOut = false;
    let settled = false;

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_SKILL_OUTPUT_BYTES - sizes[stream];
      if (room <= 0) { truncated[stream] = true; return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated[stream] = true;
      chunks[stream].push(piece);
      sizes[stream] += piece.length;
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, skill.timeoutMs);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = redactSecrets(Buffer.concat(chunks.stdout).toString("utf8"));
      const stderr = redactSecrets(Buffer.concat(chunks.stderr).toString("utf8"));
      const result: SkillRunResult = {
        executionId,
        name: skill.name,
        command: reportedCommand,
        cwd: skill.cwd,
        exitCode: timedOut ? null : exitCode,
        stdout,
        stderr,
        timedOut,
        truncated: truncated.stdout || truncated.stderr,
        timeoutMs: skill.timeoutMs,
        durationMs: Date.now() - started,
      };
      history.push({
        executionId,
        name: skill.name,
        command: reportedCommand,
        cwd: skill.cwd,
        startedAt,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        timedOut,
        truncated: result.truncated,
        approved: true,
      });
      while (history.length > MAX_SKILL_HISTORY) history.shift();
      resolvePromise(result);
    };

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new WorkspaceError(ErrorCode.SHELL_START_FAILED, `failed to start skill run: ${error.message}`));
    });
    child.on("close", (code) => finish(code));
  });
}

export function skillRunHistory(): { entries: SkillRunHistoryEntry[]; total: number; limit: number } {
  return { entries: history.map((entry) => ({ ...entry, command: [...entry.command] })), total: history.length, limit: MAX_SKILL_HISTORY };
}

export function clearSkillRunHistory(): { cleared: number } {
  const cleared = history.length;
  history.length = 0;
  return { cleared };
}
