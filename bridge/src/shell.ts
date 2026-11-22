/**
 * One-shot shell commands for the agent (`shell.run`).
 *
 * Shell selection is deterministic and detection-only. No caller can pass a
 * shell, executable, or shell path; the terminal tab and `shell.run` share the
 * same detected shell source.
 */

import { spawn, execFileSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactSecrets } from "./context.ts";
import { confinePath } from "./fs.ts";
import { ErrorCode, isShellErrorCode } from "./rpc.ts";
import type { AdditionalShellEvaluation, AdditionalShellId, AdditionalShellPlan, BackgroundExecution, DetectedShellInfo, ExecutionHistoryEntry, ExecutionResult, ExecutionTruncation, ShellFallbackInfo, ShellErrorCode, ShellHistory, ShellInfoReport, ShellOutput, ShellStatus } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
export const MAX_SHELL_OUTPUT_BYTES = 256 * 1024;
export const MAX_COMMAND_CHARS = 8 * 1024;
export const MAX_SHELL_CONCURRENCY = 2;
export const MAX_SHELL_ARCHIVE = 16;
export const MAX_EXECUTION_HISTORY = 32;
export const MAX_BACKGROUND_SESSIONS = 4;

export const SHELL_OVERRIDE_KEYS = ["shell", "shellPath", "executable", "binary", "file"] as const;

const EXECUTION_TAG_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function executionTag(value: unknown, label: "sessionId" | "taskId"): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !EXECUTION_TAG_RE.test(value)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `${label} must be 1-64 chars of [A-Za-z0-9_-]`);
  }
  return value;
}

export function shellFailure(code: ShellErrorCode, message: string): WorkspaceError {
  return new WorkspaceError(code, message);
}

export function normalizeShellError(error: unknown, message: string): WorkspaceError {
  if (error instanceof WorkspaceError && isShellErrorCode(error.code)) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return shellFailure(ErrorCode.SHELL_NOT_AVAILABLE, message);
  if (code === "ENOTDIR") return shellFailure(ErrorCode.SHELL_CWD_INVALID, message);
  return shellFailure(ErrorCode.SHELL_START_FAILED, message);
}

export type ShellFamily = "pwsh" | "powershell" | "bash" | "zsh" | "sh";
export type ExecutionEnvironment = "native-windows" | "native-macos" | "native-linux" | "native-unknown";
export type TerminationReason = ExecutionResult["terminationReason"];

export function isPowerShellFamily(family: string): boolean {
  return family === "pwsh" || family === "powershell";
}

export interface ShellInfo {
  name: ShellFamily;
  family: ShellFamily;
  environment: ExecutionEnvironment;
  file: string;
  args: (command: string) => string[];
}

interface ShellCandidate {
  family: ShellFamily;
  file: string;
  priority: number;
}

interface DetectOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  probe?: (file: string) => string | boolean | null | undefined;
  refresh?: boolean;
}

interface ActiveExecution {
  executionId: string;
  sessionId?: string;
  taskId?: string;
  command: string;
  token: string;
  cancelFile: string;
  cancel: (reason: TerminationReason) => void;
}

interface BackgroundRun {
  handle: BackgroundExecution;
  chunks: { stdout: Buffer[]; stderr: Buffer[] };
  sizes: { stdout: number; stderr: number };
  truncated: { stdout: boolean; stderr: boolean };
}

interface ArchivedOutput {
  executionId: string;
  sessionId?: string;
  taskId?: string;
  stdout: string;
  stderr: string;
  truncation: ExecutionTruncation;
}

function environmentFor(platform: NodeJS.Platform): ExecutionEnvironment {
  if (platform === "win32") return "native-windows";
  if (platform === "darwin") return "native-macos";
  if (platform === "linux") return "native-linux";
  return "native-unknown";
}

function encodePowerShell(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function shellArgs(family: ShellFamily, command: string): string[] {
  if (isPowerShellFamily(family)) {
    return [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      encodePowerShell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`),
    ];
  }
  return ["-c", command];
}

export function shellFor(platform: NodeJS.Platform = process.platform): ShellInfo {
  const family: ShellFamily = platform === "win32" ? "powershell" : "sh";
  if (platform === "win32") {
    return {
      name: family,
      family,
      environment: environmentFor(platform),
      file: "powershell.exe",
      args: (command) => [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
      ],
    };
  }
  return {
    name: family,
    family,
    environment: environmentFor(platform),
    file: "/bin/sh",
    args: (command) => ["-c", command],
  };
}

const SHELL_REGISTRY: Record<ExecutionEnvironment, ShellCandidate[]> = {
  "native-windows": [
    { family: "pwsh", file: "pwsh.exe", priority: 1 },
    { family: "powershell", file: "powershell.exe", priority: 2 },
  ],
  "native-macos": [
    { family: "zsh", file: "/bin/zsh", priority: 1 },
    { family: "bash", file: "/bin/bash", priority: 2 },
    { family: "sh", file: "/bin/sh", priority: 3 },
  ],
  "native-linux": [
    { family: "bash", file: "/bin/bash", priority: 1 },
    { family: "sh", file: "/bin/sh", priority: 2 },
  ],
  "native-unknown": [
    { family: "sh", file: "/bin/sh", priority: 1 },
  ],
};

function candidateInfo(candidate: ShellCandidate, platform: NodeJS.Platform): ShellInfo {
  return {
    name: candidate.family,
    family: candidate.family,
    environment: environmentFor(platform),
    file: candidate.file,
    args: (command) => shellArgs(candidate.family, command),
  };
}

function resolveCommand(file: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | boolean {
  if (file.includes("/") || file.includes("\\")) return existsSync(file) ? file : false;
  const tool = platform === "win32" ? "where" : "which";
  try {
    const output = execFileSync(tool, [file], { env, encoding: "utf8", windowsHide: true });
    const resolved = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    return resolved ?? false;
  } catch {
    return false;
  }
}

let shellCache: ShellInfo | null = null;

export function detectShell(options: DetectOptions = {}): ShellInfo {
  const custom = options.platform !== undefined || options.env !== undefined || options.probe !== undefined;
  if (!custom && !options.refresh && shellCache) return shellCache;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? ((file: string) => resolveCommand(file, env, platform));
  const candidates = [...SHELL_REGISTRY[environmentFor(platform)]].sort((a, b) => a.priority - b.priority);
  for (const candidate of candidates) {
    const resolved = probe(candidate.file);
    if (resolved) {
      const info = candidateInfo({ ...candidate, file: typeof resolved === "string" ? resolved : candidate.file }, platform);
      if (!custom) shellCache = info;
      return info;
    }
  }
  throw shellFailure(ErrorCode.SHELL_NOT_AVAILABLE, `no supported shell available for ${platform}`);
}

export function refreshShell(): ShellInfo {
  return detectShell({ refresh: true });
}

const versionCache = new Map<string, string>();

function shellVersion(shell: ShellInfo): string {
  const cached = versionCache.get(shell.file);
  if (cached) return cached;
  const args = isPowerShellFamily(shell.family)
    ? shell.args("$PSVersionTable.PSVersion.ToString()")
    : shell.family === "bash"
      ? shell.args('printf "%s" "$BASH_VERSION"')
      : shell.family === "zsh"
        ? shell.args('printf "%s" "$ZSH_VERSION"')
        : ["--version"];
  let version = "unknown";
  try {
    const output = execFileSync(shell.file, args, {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    version = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "unknown";
  } catch {
    version = "unknown";
  }
  versionCache.set(shell.file, version);
  return version;
}

function shellFallbacks(shell: ShellInfo): ShellFallbackInfo[] {
  const platform = process.platform;
  const candidates = [...SHELL_REGISTRY[environmentFor(platform)]].sort((a, b) => a.priority - b.priority);
  const fallbacks: ShellFallbackInfo[] = [];
  for (const candidate of candidates) {
    const resolved = resolveCommand(candidate.file, process.env, platform);
    if (!resolved) continue;
    const file = typeof resolved === "string" ? resolved : candidate.file;
    if (file !== shell.file) fallbacks.push({ family: candidate.family, file });
  }
  return fallbacks;
}

interface AdditionalShellCandidate {
  id: AdditionalShellId;
  files: string[];
  environments: ExecutionEnvironment[];
  requirements: string[];
}

const ADDITIONAL_SHELL_REGISTRY: AdditionalShellCandidate[] = [
  {
    id: "cmd",
    files: ["cmd.exe"],
    environments: ["native-windows"],
    requirements: [
      "separate quoting, exit-code and encoding fixtures",
      "separate Windows process-tree and cancellation wrapper",
    ],
  },
  {
    id: "wsl",
    files: ["wsl.exe"],
    environments: ["native-windows"],
    requirements: [
      "distribution selection and Windows-to-Linux path translation",
      "separate encoding, cancellation and cleanup fixtures",
    ],
  },
  {
    id: "git-bash",
    files: ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"],
    environments: ["native-windows"],
    requirements: [
      "MSYS path translation and executable resolution",
      "separate quoting, encoding and cleanup fixtures",
    ],
  },
  {
    id: "fish",
    files: ["fish"],
    environments: ["native-macos", "native-linux"],
    requirements: [
      "separate quoting and exit-code fixtures",
      "separate process-group cleanup and encoding fixtures",
    ],
  },
  {
    id: "nushell",
    files: ["nu"],
    environments: ["native-macos", "native-linux"],
    requirements: [
      "separate structured-quoting and exit-code fixtures",
      "separate process-group cleanup and encoding fixtures",
    ],
  },
];

export function additionalShellPlan(options: DetectOptions = {}): AdditionalShellPlan {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const probe = options.probe ?? ((file: string) => resolveCommand(file, env, platform));
  const environment = environmentFor(platform);
  const candidates = ADDITIONAL_SHELL_REGISTRY.filter((candidate) => candidate.environments.includes(environment));
  const evaluated: AdditionalShellEvaluation[] = candidates.map((candidate) => {
    let file: string | null = null;
    for (const candidateFile of candidate.files) {
      let resolved: string | boolean | null | undefined = false;
      try {
        resolved = probe(candidateFile);
      } catch {
        resolved = false;
      }
      if (resolved) {
        file = typeof resolved === "string" ? resolved : candidateFile;
        break;
      }
    }
    return {
      id: candidate.id,
      available: file !== null,
      file,
      environment,
      status: "deferred",
      reason: "MVP matrix must pass on every target platform before execution is enabled",
      requirements: candidate.requirements,
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    enabled: false,
    policy: "evaluation-only",
    mvpGate: "B1.7-benchmark-and-MVP-matrix",
    environments: evaluated,
  };
}

export function shellInfoReport(): ShellInfoReport {
  const shell = refreshShell();
  return {
    ...detectedShell(),
    version: shellVersion(shell),
    encoding: "utf8",
    fallbacks: shellFallbacks(shell),
  };
}

/** Metadata shared by `system.info`, `shell.info`, approvals, and results. */
export function detectedShell(options: DetectOptions = {}): DetectedShellInfo {
  const shell = detectShell(options);
  return {
    family: shell.family,
    environment: shell.environment,
    file: shell.file,
    platform: options.platform ?? process.platform,
    arch: process.arch,
  };
}

/** Interactive shell for the PTY terminal; same detection, no override. */
export function terminalShellFor(options: DetectOptions = {}): { family: ShellFamily; environment: ExecutionEnvironment; file: string; args: string[] } {
  const shell = detectShell(options);
  return {
    family: shell.family,
    environment: shell.environment,
    file: shell.file,
    args: isPowerShellFamily(shell.family) ? ["-NoLogo", "-NoProfile"] : [],
  };
}

export function assertNoShellOverride(params: Record<string, unknown>): void {
  const found = SHELL_OVERRIDE_KEYS.find((key) => key in params && params[key] !== undefined);
  if (found) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `${found} is not allowed; shell selection is automatic`);
  }
}

function windowsJobScript(token: string): string {
  return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BaJobObject {
  [DllImport("kernel32.dll")] public static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
  [DllImport("kernel32.dll")] public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject);
}
'@
$job = [BaJobObject]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
  [Console]::Out.WriteLine('__BA_${token}__:UNAVAILABLE:null')
  exit 2
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $env:BROAGENTAI_SHELL_FILE
$psi.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + $env:BROAGENTAI_SHELL_ENCODED
$psi.WorkingDirectory = $env:BROAGENTAI_SHELL_CWD
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$p = New-Object System.Diagnostics.Process
$p.StartInfo = $psi
$assigned = $false
$started = $false
try {
  [void]$p.Start()
  $started = $true
  $assigned = [BaJobObject]::AssignProcessToJobObject($job, $p.Handle)
  if (-not $assigned) { throw 'Job Object assignment failed' }
  $outTask = $p.StandardOutput.ReadToEndAsync()
  $errTask = $p.StandardError.ReadToEndAsync()
  $cancelFile = $env:BROAGENTAI_CANCEL_FILE
  $cancelled = $false
  while (-not $p.HasExited) {
    if (Test-Path -LiteralPath $cancelFile) {
      $cancelled = $true
      [void][BaJobObject]::TerminateJobObject($job, 1)
      break
    }
    Start-Sleep -Milliseconds 25
  }
  $p.WaitForExit()
  [Console]::Out.Write($outTask.Result)
  [Console]::Error.Write($errTask.Result)
  if ($cancelled) { [Console]::Out.WriteLine('__BA_${token}__:cancelled:null') } else { [Console]::Out.WriteLine('__BA_${token}__:completed:' + $p.ExitCode) }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  [Console]::Out.WriteLine('__BA_${token}__:error:null')
} finally {
  if (-not $assigned -and $started) { try { if (-not $p.HasExited) { $p.Kill() } } catch {} }
  [void][BaJobObject]::CloseHandle($job)
}
exit 0
`;
}

interface WindowsMarker {
  stdout: string;
  status: "cancelled" | "completed" | "error" | "unavailable" | "missing";
  exitCode: number | null;
}

function parseWindowsMarker(text: string, token: string): WindowsMarker {
  const pattern = new RegExp(`__BA_${token}__:([A-Za-z]+):(-?\\d+|null)\\r?\\n?`, "g");
  const matches = [...text.matchAll(pattern)];
  const last = matches.at(-1);
  if (!last) return { stdout: text, status: "missing", exitCode: null };
  const raw = last[1] ?? "missing";
  const status = (raw === "cancelled" || raw === "completed" || raw === "error" || raw === "UNAVAILABLE" ? raw.toLowerCase() : "missing") as WindowsMarker["status"];
  const rawExit = last[2];
  const exitCode = rawExit && rawExit !== "null" ? Number(rawExit) : null;
  return { stdout: text.replace(pattern, ""), status: status === "unavailable" ? "unavailable" : status, exitCode };
}

function requestedExecutionId(value: unknown): string {
  if (value === undefined || value === null) return randomUUID();
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "executionId must be a short alphanumeric, dash or underscore string");
  }
  if (activeExecutions.has(value)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `executionId is already running: ${value}`);
  }
  return value;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
  }
}

const activeExecutions = new Map<string, ActiveExecution>();
const outputArchive = new Map<string, ArchivedOutput>();
const executionHistory: ExecutionHistoryEntry[] = [];
const backgroundRuns = new Map<string, BackgroundRun>();

function snapshotBackground(run: BackgroundRun): BackgroundExecution {
  return { ...run.handle };
}

function backgroundStatus(result: ExecutionResult): BackgroundExecution["status"] {
  if (result.terminationReason === "timeout") return "timeout";
  if (result.terminationReason === "cancelled") return "cancelled";
  if (result.exitCode === 0) return "completed";
  return "failed";
}

function recordExecutionHistory(entry: ExecutionHistoryEntry): void {
  executionHistory.push(entry);
  while (executionHistory.length > MAX_EXECUTION_HISTORY) executionHistory.shift();
}

function archiveOutput(result: ExecutionResult): void {
  outputArchive.set(result.executionId, {
    executionId: result.executionId,
    sessionId: result.sessionId,
    taskId: result.taskId,
    stdout: redactSecrets(result.stdout),
    stderr: redactSecrets(result.stderr),
    truncation: result.truncation,
  });
  while (outputArchive.size > MAX_SHELL_ARCHIVE) {
    const oldest = outputArchive.keys().next().value;
    if (oldest === undefined) break;
    outputArchive.delete(oldest);
  }
}

/** `shell.run`: run one command in the workspace and collect its output. */
export async function runShell(
  store: WorkspaceStore,
  command: unknown,
  cwd: unknown,
  timeoutMs: unknown,
  rawParams: Record<string, unknown> = {},
  onStart?: (info: { executionId: string; shell: string; environment: string; cwd: string; sessionId?: string; taskId?: string }) => void,
  onChunk?: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): Promise<ExecutionResult> {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  assertNoShellOverride(rawParams);
  const sessionId = executionTag(rawParams.sessionId, "sessionId");
  const taskId = executionTag(rawParams.taskId, "taskId");
  if (typeof command !== "string" || command.trim() === "") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "command must be a non-empty string");
  }
  if (command.length > MAX_COMMAND_CHARS) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `command exceeds ${MAX_COMMAND_CHARS} characters`);
  }

  let workdir: string;
  try {
    workdir = cwd === undefined || cwd === null || cwd === "" ? active.path : confinePath(active.path, String(cwd));
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === ErrorCode.PATH_ESCAPE) {
      throw shellFailure(ErrorCode.SHELL_CWD_INVALID, error.message);
    }
    throw error;
  }
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    throw shellFailure(ErrorCode.SHELL_CWD_INVALID, "cwd must be an existing directory inside the workspace");
  }

  const timeout = typeof timeoutMs === "number" && timeoutMs > 0
    ? Math.min(Math.floor(timeoutMs), MAX_SHELL_TIMEOUT_MS)
    : DEFAULT_SHELL_TIMEOUT_MS;

  const shell = detectShell();
  const executionId = requestedExecutionId(rawParams.executionId);
  if (activeExecutions.size >= MAX_SHELL_CONCURRENCY) {
    throw shellFailure(ErrorCode.SHELL_BUSY, `shell concurrency limit reached (${MAX_SHELL_CONCURRENCY})`);
  }
  const token = randomUUID().replace(/-/g, "");
  const isWindows = process.platform === "win32";
  const cancelFile = join(tmpdir(), `broagentai-cancel-${token}`);
  const started = Date.now();

  return new Promise<ExecutionResult>((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let settled = false;
    let reason: TerminationReason = "completed";
    let fallback: ReturnType<typeof setTimeout> | undefined;

    const activeEntry: ActiveExecution = {
      executionId,
      sessionId,
      taskId,
      command,
      token,
      cancelFile,
      cancel: (next) => {
        if (settled) return;
        reason = next;
        if (isWindows) {
          try { writeFileSync(cancelFile, "1"); } catch {}
        } else if (child?.pid) {
          killTree(child.pid);
        }
        if (isWindows && !fallback) {
          fallback = setTimeout(() => { if (child?.pid) killTree(child.pid); }, 2000);
        }
      },
    };
    activeExecutions.set(executionId, activeEntry);
    onStart?.({ executionId, shell: shell.family, environment: shell.environment, cwd: workdir, sessionId, taskId });

    try {
      if (isWindows) {
        child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodePowerShell(windowsJobScript(token))], {
          cwd: workdir,
          env: {
            ...process.env,
            BROAGENTAI_SHELL_FILE: shell.file,
            BROAGENTAI_SHELL_ENCODED: encodePowerShell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`),
            BROAGENTAI_SHELL_CWD: workdir,
            BROAGENTAI_CANCEL_FILE: cancelFile,
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        child = spawn(shell.file, shellArgs(shell.family, command), {
          cwd: workdir,
          env: process.env,
          windowsHide: true,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
    } catch (error) {
      activeExecutions.delete(executionId);
      rmSync(cancelFile, { force: true });
      recordExecutionHistory({
        executionId, sessionId, taskId,
        command: redactSecrets(command),
        shell: shell.family,
        cwd: workdir,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        exitCode: null,
        terminationReason: "error",
        timedOut: false,
        truncated: false,
        stdoutBytes: 0,
        stderrBytes: 0,
      });
      reject(normalizeShellError(error, `failed to start ${shell.file}: ${(error as Error).message}`));
      return;
    }

    const running = child;

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const outputTruncated = { stdout: false, stderr: false };
    const collect = (name: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_SHELL_OUTPUT_BYTES - sizes[name];
      if (room <= 0) { outputTruncated[name] = true; return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) outputTruncated[name] = true;
      chunks[name].push(piece);
      sizes[name] += piece.length;
      onChunk?.(name, piece);
    };
    running.stdout!.on("data", collect("stdout"));
    running.stderr!.on("data", collect("stderr"));

    const timer = setTimeout(() => activeEntry.cancel("timeout"), timeout);

    const settleFail = (error: WorkspaceError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      activeExecutions.delete(executionId);
      rmSync(cancelFile, { force: true });
      recordExecutionHistory({
        executionId, sessionId, taskId,
        command: redactSecrets(command),
        shell: shell.family,
        cwd: workdir,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        exitCode: null,
        terminationReason: "error",
        timedOut: false,
        truncated: false,
        stdoutBytes: sizes.stdout,
        stderrBytes: sizes.stderr,
      });
      reject(error);
    };

    running.on("error", (error) => {
      settleFail(normalizeShellError(error, `failed to run command: ${error.message}`));
    });

    running.on("close", (code, signal) => {
      if (settled) return;
      clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      activeExecutions.delete(executionId);
      rmSync(cancelFile, { force: true });

      let stdout = Buffer.concat(chunks.stdout).toString("utf8");
      const stderr = Buffer.concat(chunks.stderr).toString("utf8");
      let exitCode: number | null = code;
      let finalReason: TerminationReason = reason !== "completed" ? reason : signal ? "signal" : "completed";

      if (isWindows) {
        const parsed = parseWindowsMarker(stdout, token);
        stdout = parsed.stdout;
        if (parsed.status === "unavailable") {
          settleFail(shellFailure(ErrorCode.SHELL_UNSUPPORTED, "Windows Job Objects are unavailable; shell execution refused"));
          return;
        }
        if (parsed.status === "error") {
          settleFail(shellFailure(ErrorCode.SHELL_START_FAILED, stderr.trim() || "Windows Job Object wrapper failed"));
          return;
        }
        if (parsed.status === "cancelled") finalReason = "cancelled";
        if (parsed.status === "completed" && parsed.exitCode !== null) exitCode = parsed.exitCode;
      }

      if (reason === "timeout") finalReason = "timeout";
      else if (reason === "cancelled") finalReason = "cancelled";

      sizes.stdout = Buffer.byteLength(stdout, "utf8");

      const truncation = {
        stdout: outputTruncated.stdout,
        stderr: outputTruncated.stderr,
        stdoutBytes: sizes.stdout,
        stderrBytes: sizes.stderr,
        limitBytes: MAX_SHELL_OUTPUT_BYTES,
      };
      const result: ExecutionResult = {
        executionId,
        sessionId,
        taskId,
        shell: shell.family,
        shellFamily: shell.family,
        environment: shell.environment,
        cwd: workdir,
        exitCode: finalReason === "completed" ? exitCode : null,
        terminationReason: finalReason,
        stdout,
        stderr,
        encoding: "utf8",
        timedOut: finalReason === "timeout",
        truncated: truncation.stdout || truncation.stderr,
        truncation,
        timeoutMs: timeout,
        durationMs: Date.now() - started,
      };
      settled = true;
      recordExecutionHistory({
        executionId,
        sessionId,
        taskId,
        command: redactSecrets(command),
        shell: shell.family,
        cwd: workdir,
        startedAt: new Date(started).toISOString(),
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        terminationReason: result.terminationReason,
        timedOut: result.timedOut,
        truncated: result.truncated,
        stdoutBytes: sizes.stdout,
        stderrBytes: sizes.stderr,
      });
      archiveOutput(result);
      resolvePromise(result);
    });
  });
}

export async function startShellBackground(
  store: WorkspaceStore,
  command: unknown,
  cwd: unknown,
  timeoutMs: unknown,
  rawParams: Record<string, unknown> = {},
  onEvent?: (event: "shell.started" | "shell.completed", payload: BackgroundExecution) => void,
): Promise<BackgroundExecution> {
  assertNoShellOverride(rawParams);
  while (backgroundRuns.size >= MAX_BACKGROUND_SESSIONS) {
    const oldest = [...backgroundRuns.entries()].find(([, run]) => run.handle.status !== "running");
    if (!oldest) throw shellFailure(ErrorCode.SHELL_BUSY, `background session limit reached (${MAX_BACKGROUND_SESSIONS})`);
    backgroundRuns.delete(oldest[0]);
  }

  let run: BackgroundRun | undefined;
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0
    ? Math.min(Math.floor(timeoutMs), MAX_SHELL_TIMEOUT_MS)
    : DEFAULT_SHELL_TIMEOUT_MS;
  const promise = runShell(store, command, cwd, timeoutMs, rawParams, (info) => {
    const handle: BackgroundExecution = {
      executionId: info.executionId,
      ...(info.sessionId !== undefined ? { sessionId: info.sessionId } : {}),
      ...(info.taskId !== undefined ? { taskId: info.taskId } : {}),
      command: redactSecrets(String(command)),
      status: "running",
      shellFamily: info.shell,
      environment: info.environment,
      cwd: info.cwd,
      startedAt: new Date().toISOString(),
      timeoutMs: timeout,
    };
    run = {
      handle,
      chunks: { stdout: [], stderr: [] },
      sizes: { stdout: 0, stderr: 0 },
      truncated: { stdout: false, stderr: false },
    };
    backgroundRuns.set(handle.executionId, run);
    onEvent?.("shell.started", snapshotBackground(run));
  }, (stream, chunk) => {
    if (!run) return;
    const room = MAX_SHELL_OUTPUT_BYTES - run.sizes[stream];
    if (room <= 0) { run.truncated[stream] = true; return; }
    const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
    if (piece.length < chunk.length) run.truncated[stream] = true;
    run.chunks[stream].push(piece);
    run.sizes[stream] += piece.length;
  });

  const active = run;
  if (!active) {
    await promise;
    throw shellFailure(ErrorCode.SHELL_START_FAILED, "background execution did not start");
  }

  const finish = (result: ExecutionResult) => {
    active.handle = {
      ...active.handle,
      status: backgroundStatus(result),
      result,
    };
    onEvent?.("shell.completed", snapshotBackground(active));
  };
  promise.then(finish, (error) => {
    active.handle = {
      ...active.handle,
      status: "failed",
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    };
    onEvent?.("shell.completed", snapshotBackground(active));
  });
  return snapshotBackground(active);
}

export function shellPoll(executionId: unknown): BackgroundExecution {
  const id = typeof executionId === "string" ? executionId : "";
  const run = backgroundRuns.get(id);
  if (!run) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown background execution: ${id || "(missing)"}`);
  return snapshotBackground(run);
}

export function cancelShell(executionId: unknown): { executionId: string; cancelled: true } {
  const id = typeof executionId === "string" ? executionId : "";
  const entry = activeExecutions.get(id);
  if (!entry) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `no active execution: ${id || "(missing)"}`);
  entry.cancel("cancelled");
  return { executionId: id, cancelled: true };
}

export function shellOutput(executionId: unknown, stream: unknown = "stdout", offsetBytes: unknown = 0): ShellOutput {
  const id = typeof executionId === "string" ? executionId : "";
  const name = stream === "stderr" ? "stderr" : stream === "stdout" || stream === undefined ? "stdout" : null;
  if (!name) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "stream must be stdout or stderr");
  const background = backgroundRuns.get(id);
  if (background?.handle.status === "running") {
    const text = redactSecrets(Buffer.concat(background.chunks[name]).toString("utf8"));
    const totalBytes = Buffer.byteLength(text, "utf8");
    const offset = typeof offsetBytes === "number" && Number.isFinite(offsetBytes)
      ? Math.max(0, Math.min(Math.floor(offsetBytes), totalBytes))
      : 0;
    const data = Buffer.from(text, "utf8").subarray(offset).toString("utf8");
    return {
      executionId: id,
      stream: name,
      offsetBytes: offset,
      nextOffsetBytes: totalBytes,
      data,
      truncated: background.truncated[name],
      totalBytes,
    };
  }
  const entry = outputArchive.get(id);
  if (!entry) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown execution: ${id || "(missing)"}`);
  const text = entry[name];
  const totalBytes = Buffer.byteLength(text, "utf8");
  const offset = typeof offsetBytes === "number" && Number.isFinite(offsetBytes)
    ? Math.max(0, Math.min(Math.floor(offsetBytes), totalBytes))
    : 0;
  const data = Buffer.from(text, "utf8").subarray(offset).toString("utf8");
  return {
    executionId: id,
    stream: name,
    offsetBytes: offset,
    nextOffsetBytes: totalBytes,
    data,
    truncated: entry.truncation[name],
    totalBytes,
  };
}

export function shellHistory(params: Record<string, unknown> = {}): ShellHistory {
  const sessionId = executionTag(params.sessionId, "sessionId");
  const taskId = executionTag(params.taskId, "taskId");
  const limit = typeof params.limit === "number" && Number.isFinite(params.limit)
    ? Math.max(1, Math.min(Math.floor(params.limit), MAX_EXECUTION_HISTORY))
    : MAX_EXECUTION_HISTORY;
  const matching = executionHistory.filter((entry) =>
    (sessionId === undefined || entry.sessionId === sessionId) &&
    (taskId === undefined || entry.taskId === taskId));
  return {
    entries: matching.slice(-limit).reverse(),
    total: matching.length,
    limit: MAX_EXECUTION_HISTORY,
  };
}

export function clearShellHistory(params: Record<string, unknown> = {}): { cleared: number } {
  const sessionId = executionTag(params.sessionId, "sessionId");
  const taskId = executionTag(params.taskId, "taskId");
  const before = executionHistory.length;
  for (let index = executionHistory.length - 1; index >= 0; index--) {
    const entry = executionHistory[index]!;
    if ((sessionId === undefined || entry.sessionId === sessionId) &&
        (taskId === undefined || entry.taskId === taskId)) {
      executionHistory.splice(index, 1);
    }
  }
  return { cleared: before - executionHistory.length };
}

export function shellStatus(): ShellStatus {
  return {
    maxConcurrency: MAX_SHELL_CONCURRENCY,
    active: [...activeExecutions.keys()],
    archived: outputArchive.size,
    historyCount: executionHistory.length,
    background: [...backgroundRuns.keys()],
  };
}

export async function shutdownShells(): Promise<void> {
  for (const entry of [...activeExecutions.values()]) entry.cancel("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 25));
  for (const run of backgroundRuns.values()) {
    if (run.handle.status === "running") {
      run.handle = { ...run.handle, status: "cancelled", error: "bridge shutdown" };
    }
  }
}
