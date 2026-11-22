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
import { ErrorCode } from "./rpc.ts";
import type { DetectedShellInfo, ExecutionResult, ExecutionTruncation, ShellOutput, ShellStatus } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
export const MAX_SHELL_OUTPUT_BYTES = 256 * 1024;
export const MAX_COMMAND_CHARS = 8 * 1024;
export const MAX_SHELL_CONCURRENCY = 2;
export const MAX_SHELL_ARCHIVE = 16;

export const SHELL_OVERRIDE_KEYS = ["shell", "shellPath", "executable", "binary", "file"] as const;

export type ShellFamily = "powershell" | "bash" | "zsh" | "sh";
export type ExecutionEnvironment = "native-windows" | "native-macos" | "native-linux" | "native-unknown";
export type TerminationReason = ExecutionResult["terminationReason"];

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
  token: string;
  cancelFile: string;
  cancel: (reason: TerminationReason) => void;
}

interface ArchivedOutput {
  executionId: string;
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
  if (family === "powershell") {
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
    { family: "powershell", file: "pwsh.exe", priority: 1 },
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
  throw new WorkspaceError(ErrorCode.SHELL_NOT_AVAILABLE, `no supported shell available for ${platform}`);
}

export function refreshShell(): ShellInfo {
  return detectShell({ refresh: true });
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
    args: shell.family === "powershell" ? ["-NoLogo", "-NoProfile"] : [],
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

function spawnErrorCode(error: NodeJS.ErrnoException): ErrorCode {
  if (error.code === "ENOENT") return ErrorCode.SHELL_NOT_AVAILABLE;
  return ErrorCode.SHELL_START_FAILED;
}

const activeExecutions = new Map<string, ActiveExecution>();
const outputArchive = new Map<string, ArchivedOutput>();

function archiveOutput(result: ExecutionResult): void {
  outputArchive.set(result.executionId, {
    executionId: result.executionId,
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
  onStart?: (info: { executionId: string; shell: string; cwd: string }) => void,
): Promise<ExecutionResult> {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  assertNoShellOverride(rawParams);
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
      throw new WorkspaceError(ErrorCode.SHELL_CWD_INVALID, error.message);
    }
    throw error;
  }
  if (!existsSync(workdir) || !statSync(workdir).isDirectory()) {
    throw new WorkspaceError(ErrorCode.SHELL_CWD_INVALID, "cwd must be an existing directory inside the workspace");
  }

  const timeout = typeof timeoutMs === "number" && timeoutMs > 0
    ? Math.min(Math.floor(timeoutMs), MAX_SHELL_TIMEOUT_MS)
    : DEFAULT_SHELL_TIMEOUT_MS;

  const shell = detectShell();
  const executionId = requestedExecutionId(rawParams.executionId);
  if (activeExecutions.size >= MAX_SHELL_CONCURRENCY) {
    throw new WorkspaceError(ErrorCode.SHELL_BUSY, `shell concurrency limit reached (${MAX_SHELL_CONCURRENCY})`);
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
    onStart?.({ executionId, shell: shell.family, cwd: workdir });

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
      const err = error as NodeJS.ErrnoException;
      activeExecutions.delete(executionId);
      rmSync(cancelFile, { force: true });
      reject(new WorkspaceError(spawnErrorCode(err), `failed to start ${shell.file}: ${err.message}`));
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
      reject(error);
    };

    running.on("error", (error) => {
      settleFail(new WorkspaceError(spawnErrorCode(error), `failed to run command: ${error.message}`));
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
          settleFail(new WorkspaceError(ErrorCode.SHELL_UNSUPPORTED, "Windows Job Objects are unavailable; shell execution refused"));
          return;
        }
        if (parsed.status === "error") {
          settleFail(new WorkspaceError(ErrorCode.SHELL_START_FAILED, stderr.trim() || "Windows Job Object wrapper failed"));
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
      archiveOutput(result);
      resolvePromise(result);
    });
  });
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
  const entry = outputArchive.get(id);
  if (!entry) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown execution: ${id || "(missing)"}`);
  const name = stream === "stderr" ? "stderr" : stream === "stdout" || stream === undefined ? "stdout" : null;
  if (!name) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "stream must be stdout or stderr");
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

export function shellStatus(): ShellStatus {
  return {
    maxConcurrency: MAX_SHELL_CONCURRENCY,
    active: [...activeExecutions.keys()],
    archived: outputArchive.size,
  };
}

export async function shutdownShells(): Promise<void> {
  for (const entry of [...activeExecutions.values()]) entry.cancel("cancelled");
  await new Promise((resolve) => setTimeout(resolve, 25));
}
