import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { loadMergedConfig } from "./config.ts";
import type { PackageManager, ProjectScriptAllowlistEntry } from "./config.ts";
import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import type { ProjectScriptInfo } from "./rpc.ts";
import { assertNoShellOverride, detectShell, isPowerShellFamily, runShell } from "./shell.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const MAX_SCRIPTS = 32;
export const MAX_SCRIPT_NAME_CHARS = 64;
export const MAX_SCRIPT_ARGS = 8;
export const MAX_SCRIPT_ARG_CHARS = 64;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 120_000;
export const MAX_SCRIPT_TIMEOUT_MS = 5 * 60_000;

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,63}$/;
const SAFE_ARG = /^[A-Za-z0-9_.:@/=+,-][A-Za-z0-9_.:@/=+,-]{0,63}$/;
const MANAGERS: PackageManager[] = ["npm", "pnpm", "yarn", "bun"];

function assertNoCommandOverride(params: Record<string, unknown>): void {
  for (const key of ["command", "args", "env"]) {
    if (Object.hasOwn(params, key)) {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `${key} is not allowed; use the allowlisted script name only`);
    }
  }
}

function packageScripts(root: string): Record<string, string> {
  const file = join(root, "package.json");
  if (!existsSync(file)) {
    throw new WorkspaceError(ErrorCode.NOT_ALLOWED, "script.run requires a package.json in the active workspace root");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, "package.json is not valid JSON");
  }
  const scripts = (parsed as { scripts?: unknown } | null)?.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
    throw new WorkspaceError(ErrorCode.NOT_ALLOWED, "package.json has no scripts");
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

function validateEntry(name: string, entry: ProjectScriptAllowlistEntry): void {
  if (!SCRIPT_NAME.test(name)) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `invalid allowlisted script name: ${name}`);
  }
  if (!entry || typeof entry !== "object" || !MANAGERS.includes(entry.manager)) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `script ${name} must declare manager: npm, pnpm, yarn or bun`);
  }
  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.length > MAX_SCRIPT_ARGS) {
      throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `script ${name} has too many fixed arguments`);
    }
    for (const arg of entry.args) {
      if (typeof arg !== "string" || !SAFE_ARG.test(arg)) {
        throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `script ${name} has an unsafe fixed argument`);
      }
    }
  }
  if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1000 || entry.timeoutMs > MAX_SCRIPT_TIMEOUT_MS)) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `script ${name} timeoutMs must be between 1000 and ${MAX_SCRIPT_TIMEOUT_MS}`);
  }
}

export function listProjectScripts(store: WorkspaceStore): { scripts: ProjectScriptInfo[] } {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  const configured = loadMergedConfig(store).scripts;
  const names = Object.keys(configured).sort();
  if (names.length > MAX_SCRIPTS) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `too many allowlisted scripts (max ${MAX_SCRIPTS})`);
  }
  const declared = packageScripts(active.path);
  const scripts = names.map((name) => {
    const entry = configured[name];
    validateEntry(name, entry);
    if (!Object.hasOwn(declared, name)) {
      throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `allowlisted script ${name} is missing from package.json`);
    }
    const cwd = typeof entry.cwd === "string" && entry.cwd !== ""
      ? confinePath(active.path, entry.cwd)
      : active.path;
    return {
      name,
      manager: entry.manager,
      command: [entry.manager, "run", name, ...(entry.args ?? [])],
      body: declared[name],
      cwd,
      timeoutMs: entry.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS,
    };
  });
  return { scripts };
}

export function resolveProjectScript(store: WorkspaceStore, name: unknown): ProjectScriptInfo {
  if (typeof name !== "string" || !SCRIPT_NAME.test(name)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "name must be an allowlisted project script name");
  }
  const found = listProjectScripts(store).scripts.find((script) => script.name === name);
  if (!found) throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `script ${name} is not allowlisted`);
  return found;
}

export function quoteCommandArgv(argv: string[], family: string): string {
  if (isPowerShellFamily(family)) {
    return `& ${argv.map((part) => `'${part.replace(/'/g, "''")}'`).join(" ")}`;
  }
  return argv.map((part) => `'${part.replace(/'/g, `'\\''`)}'`).join(" ");
}

export async function runProjectScript(store: WorkspaceStore, params: Record<string, unknown>) {
  assertNoShellOverride(params);
  assertNoCommandOverride(params);
  const script = resolveProjectScript(store, params.name);
  const requested = params.timeoutMs;
  const timeoutMs = typeof requested === "number" && Number.isFinite(requested)
    ? Math.max(1000, Math.min(Math.floor(requested), script.timeoutMs))
    : script.timeoutMs;
  const shell = detectShell();
  const command = quoteCommandArgv(script.command, shell.family);
  const result = await runShell(
    store,
    command,
    script.cwd,
    timeoutMs,
    { sessionId: params.sessionId, taskId: params.taskId, executionId: params.executionId }
  );
  return { ...result, script: script.name, declaredCommand: script.command, declaredBody: script.body };
}
