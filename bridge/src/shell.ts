/**
 * One-shot shell commands for the agent (`shell.run`).
 *
 * Shell selection is deterministic and detection-only. No caller can pass a
 * shell, executable, or shell path; the terminal tab and `shell.run` share the
 * same detected shell source.
 */

import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";

import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import type { DetectedShellInfo, ExecutionResult } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
export const MAX_SHELL_OUTPUT_BYTES = 256 * 1024;
export const MAX_COMMAND_CHARS = 8 * 1024;

export const SHELL_OVERRIDE_KEYS = ["shell", "shellPath", "executable", "binary", "file"] as const;

export type ShellFamily = "powershell" | "sh";
export type ExecutionEnvironment = "native-windows" | "native-macos" | "native-linux" | "native-unknown";

export interface ShellInfo {
  name: ShellFamily;
  family: ShellFamily;
  environment: ExecutionEnvironment;
  file: string;
  args: (command: string) => string[];
}

function environmentFor(platform: NodeJS.Platform): ExecutionEnvironment {
  if (platform === "win32") return "native-windows";
  if (platform === "darwin") return "native-macos";
  if (platform === "linux") return "native-linux";
  return "native-unknown";
}

/** The shell used on this OS. Detection is the only shell source. */
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

/** Metadata shared by `system.info`, `shell.info`, approvals, and results. */
export function detectedShell(platform: NodeJS.Platform = process.platform): DetectedShellInfo {
  const shell = shellFor(platform);
  return {
    family: shell.family,
    environment: shell.environment,
    file: shell.file,
    platform,
    arch: process.arch,
  };
}

/** Interactive shell for the PTY terminal; same detection, no override. */
export function terminalShellFor(platform: NodeJS.Platform = process.platform): { family: ShellFamily; environment: ExecutionEnvironment; file: string; args: string[] } {
  const shell = shellFor(platform);
  return {
    family: shell.family,
    environment: shell.environment,
    file: shell.file,
    args: platform === "win32" ? ["-NoLogo", "-NoProfile"] : [],
  };
}

export function assertNoShellOverride(params: Record<string, unknown>): void {
  const found = SHELL_OVERRIDE_KEYS.find((key) => key in params && params[key] !== undefined);
  if (found) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `${found} is not allowed; shell selection is automatic`);
  }
}

/** Kill the process and everything it started. */
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

/** `shell.run`: run one command in the workspace and collect its output. */
export function runShell(store: WorkspaceStore, command: unknown, cwd: unknown, timeoutMs: unknown, rawParams: Record<string, unknown> = {}): Promise<ExecutionResult> {
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

  const shell = shellFor();
  const executionId = randomUUID();
  const started = Date.now();

  return new Promise<ExecutionResult>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(shell.file, shell.args(command), {
        cwd: workdir,
        env: process.env,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      reject(new WorkspaceError(spawnErrorCode(err), `failed to start ${shell.file}: ${err.message}`));
      return;
    }

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    const outputTruncated = { stdout: false, stderr: false };
    let timedOut = false;
    const collect = (name: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_SHELL_OUTPUT_BYTES - sizes[name];
      if (room <= 0) { outputTruncated[name] = true; return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) outputTruncated[name] = true;
      chunks[name].push(piece);
      sizes[name] += piece.length;
    };
    child.stdout!.on("data", collect("stdout"));
    child.stderr!.on("data", collect("stderr"));

    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeout);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new WorkspaceError(spawnErrorCode(error), `failed to run command: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const truncation = {
        stdout: outputTruncated.stdout,
        stderr: outputTruncated.stderr,
        stdoutBytes: sizes.stdout,
        stderrBytes: sizes.stderr,
        limitBytes: MAX_SHELL_OUTPUT_BYTES,
      };
      const terminationReason = timedOut ? "timeout" : signal ? "signal" : "completed";
      resolvePromise({
        executionId,
        shell: shell.family,
        shellFamily: shell.family,
        environment: shell.environment,
        cwd: workdir,
        exitCode: terminationReason === "completed" ? code : null,
        terminationReason,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        encoding: "utf8",
        timedOut,
        truncated: truncation.stdout || truncation.stderr,
        truncation,
        timeoutMs: timeout,
        durationMs: Date.now() - started,
      });
    });
  });
}
