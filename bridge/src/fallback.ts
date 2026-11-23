import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import type { FallbackPlan, FallbackSafety } from "./rpc.ts";
import { assertNoShellOverride, detectedShell, isPowerShellFamily, MAX_COMMAND_CHARS } from "./shell.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const FALLBACK_DOMAINS = ["fs", "git"] as const;
export const BENCHMARK_GATE = "block-native-tool-removal";

const TYPED_FS: Record<string, string> = {
  listDir: "fs.listDir",
  listTree: "fs.listTree",
  stat: "fs.stat",
  readFile: "fs.readFile",
  readFileLines: "fs.readFileLines",
  searchFiles: "fs.searchFiles",
  writeFile: "fs.writeFile",
  createFile: "fs.createFile",
  mkdir: "fs.mkdir",
  rename: "fs.rename",
  delete: "fs.delete",
};

const TYPED_GIT: Record<string, string> = {
  status: "git.status",
  diff: "git.diff",
  branches: "git.branches",
  stage: "git.stage",
  unstage: "git.unstage",
  discard: "git.discard",
  commit: "git.commit",
  createBranch: "git.createBranch",
  checkout: "git.checkout",
  init: "git.init",
  fetch: "git.fetch",
  pull: "git.pull",
  push: "git.push",
  abort: "git.abort",
  testRemote: "git.testRemote",
  log: "git.log",
  commitFiles: "git.commitFiles",
  commitDiff: "git.commitDiff",
};

interface FallbackTemplate {
  write: boolean;
  command: (family: string, params: Record<string, unknown>) => string;
}

function invalid(message: string): never {
  throw new WorkspaceError(ErrorCode.INVALID_PARAMS, message);
}

function textParam(params: Record<string, unknown>, key: string, pattern: RegExp): string {
  const value = params[key];
  if (typeof value !== "string" || !pattern.test(value)) invalid(`${key} must match ${pattern.source}`);
  return value;
}

function powershell(value: string): string {
  return value.replace(/'/g, "''");
}

const LONG_TAIL_FS: Record<string, FallbackTemplate> = {
  bulkRename: {
    write: true,
    command: (family) => isPowerShellFamily(family)
      ? "Get-ChildItem -File | Rename-Item -NewName { $_.Name -replace 'old','new' }"
      : "for f in *; do [ -f \"$f\" ] && mv -- \"$f\" \"${f/old/new}\"; done",
  },
  bulkCopy: {
    write: true,
    command: (family) => isPowerShellFamily(family)
      ? "Get-ChildItem -File | Copy-Item -Destination backup"
      : "cp -R -- src backup",
  },
  jsonTransform: {
    write: true,
    command: (family) => isPowerShellFamily(family)
      ? "Get-Content -Raw data.json | ConvertFrom-Json | ConvertTo-Json | Set-Content data.json"
      : "node -e \"const fs=require('fs');const p='data.json';fs.writeFileSync(p,JSON.stringify(JSON.parse(fs.readFileSync(p,'utf8')),null,2))\"",
  },
  crossFileEdit: {
    write: true,
    command: (family) => isPowerShellFamily(family)
      ? "Get-ChildItem -Recurse -File -Filter *.ts | ForEach-Object { (Get-Content $_.FullName) -replace 'old','new' | Set-Content $_.FullName }"
      : "rg -l 'old' -g '*.ts' | xargs sed -i 's/old/new/g'",
  },
  largeTreeSearch: {
    write: false,
    command: (family) => isPowerShellFamily(family)
      ? "Get-ChildItem -Recurse -File | Select-String -Pattern 'needle'"
      : "rg -n 'needle' .",
  },
};

const LONG_TAIL_GIT: Record<string, FallbackTemplate> = {
  stash: { write: true, command: () => "git stash push --include-untracked" },
  tag: { write: false, command: () => "git tag --list" },
  worktree: { write: false, command: () => "git worktree list" },
  reflog: { write: false, command: () => "git reflog -n 20" },
  blame: {
    write: false,
    command: (family, params) => `git blame -- '${isPowerShellFamily(family) ? powershell(textParam(params, "path", /^[A-Za-z0-9._/\\ -]{1,200}$/)) : textParam(params, "path", /^[A-Za-z0-9._/\\ -]{1,200}$/)}'`,
  },
  bisect: { write: true, command: () => "git bisect start" },
  rebaseContinue: { write: true, command: () => "git rebase --continue" },
  cherryPick: {
    write: true,
    command: (_family, params) => `git cherry-pick ${textParam(params, "commit", /^[A-Za-z0-9._-]{1,64}$/)}`,
  },
};

function asParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) invalid("params must be an object");
  return params as Record<string, unknown>;
}

export function fallbackPlan(store: WorkspaceStore, params: unknown): FallbackPlan {
  const p = asParams(params);
  assertNoShellOverride(p);
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  if (p.domain !== "fs" && p.domain !== "git") invalid("domain must be fs or git");
  if (typeof p.operation !== "string" || p.operation.trim() === "") invalid("operation must be a non-empty string");

  let cwd = active.path;
  if (p.cwd !== undefined) {
    if (typeof p.cwd !== "string" || p.cwd.trim() === "") invalid("cwd must be a non-empty string");
    try {
      cwd = confinePath(active.path, p.cwd);
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === ErrorCode.PATH_ESCAPE) {
        throw new WorkspaceError(ErrorCode.SHELL_CWD_INVALID, error.message);
      }
      throw error;
    }
  }

  const shell = detectedShell();
  const typed = p.domain === "fs" ? TYPED_FS[p.operation] : TYPED_GIT[p.operation];
  const safety: FallbackSafety = {
    confinedCwd: true,
    noShellOverride: true,
    requiresApprovalIfWrite: false,
    typedPrimitiveRetained: true,
    benchmarkGate: BENCHMARK_GATE,
  };
  if (typed) {
    return {
      domain: p.domain,
      operation: p.operation,
      status: "typed-primitive",
      typedPrimitive: typed,
      shellCommand: null,
      shellFamily: shell.family,
      environment: shell.environment,
      cwd,
      reason: `${typed} remains the default; shell replacement is blocked by ${BENCHMARK_GATE}`,
      safety,
    };
  }

  const template = p.domain === "fs" ? LONG_TAIL_FS[p.operation] : LONG_TAIL_GIT[p.operation];
  if (!template) invalid(`unknown ${p.domain} operation: ${p.operation}`);
  const command = template.command(shell.family, p);
  if (command.trim() === "" || command.length > MAX_COMMAND_CHARS) invalid("generated shell command is invalid");
  return {
    domain: p.domain,
    operation: p.operation,
    status: "shell-long-tail",
    typedPrimitive: null,
    shellCommand: command,
    shellFamily: shell.family,
    environment: shell.environment,
    cwd,
    reason: `No typed primitive covers ${p.operation}; use shell.run only for this long-tail operation`,
    safety: { ...safety, requiresApprovalIfWrite: template.write },
  };
}
