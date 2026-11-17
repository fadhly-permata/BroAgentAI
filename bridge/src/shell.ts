/**
 * One-shot shell commands for the agent (`shell.run`).
 *
 * Unlike fs.* and git.*, a shell command CANNOT be confined to the workspace:
 * it runs with the user's own rights and can touch anything they can. The only
 * guards here are the working directory, a timeout and output caps. Whether a
 * command may run at all is decided by the approval mode (see agent.ts).
 *
 * This is not the interactive Terminal tab: there is no PTY and no stdin, so
 * a command that waits for input simply runs into the timeout.
 */

import { spawn, execFile } from "node:child_process";

import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000;
export const MAX_SHELL_TIMEOUT_MS = 10 * 60_000;
/** Each of stdout and stderr is capped at this many bytes. */
export const MAX_SHELL_OUTPUT_BYTES = 256 * 1024;
export const MAX_COMMAND_CHARS = 8 * 1024;

export interface ShellInfo {
  /** Short name shown to the AI so it writes commands for the right shell. */
  name: "powershell" | "sh";
  file: string;
  args: (command: string) => string[];
}

/** The shell used on this OS. */
export function shellFor(platform: NodeJS.Platform = process.platform): ShellInfo {
  if (platform === "win32") {
    return {
      name: "powershell",
      file: "powershell.exe",
      // UTF-8 output so non-ASCII text survives the pipe back to the bridge.
      args: (command) => [
        "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
      ],
    };
  }
  return { name: "sh", file: "/bin/sh", args: (command) => ["-c", command] };
}

export interface ShellResult {
  shell: string;
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
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

/** `shell.run`: run one command in the workspace and collect its output. */
export function runShell(store: WorkspaceStore, command: unknown, cwd: unknown, timeoutMs: unknown): Promise<ShellResult> {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  if (typeof command !== "string" || command.trim() === "") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "command must be a non-empty string");
  }
  if (command.length > MAX_COMMAND_CHARS) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `command exceeds ${MAX_COMMAND_CHARS} characters`);
  }
  // The starting directory stays inside the workspace; the command itself is not confined.
  const workdir = cwd === undefined || cwd === null || cwd === "" ? active.path : confinePath(active.path, String(cwd));
  const timeout = typeof timeoutMs === "number" && timeoutMs > 0
    ? Math.min(Math.floor(timeoutMs), MAX_SHELL_TIMEOUT_MS)
    : DEFAULT_SHELL_TIMEOUT_MS;

  const shell = shellFor();
  const started = Date.now();

  return new Promise<ShellResult>((resolvePromise, reject) => {
    let child;
    try {
      child = spawn(shell.file, shell.args(command), {
        cwd: workdir,
        env: process.env,
        windowsHide: true,
        detached: process.platform !== "win32", // own process group, so the whole tree can be killed
        stdio: ["ignore", "pipe", "pipe"], // no stdin: a prompt cannot hang forever, it hits the timeout
      });
    } catch (error) {
      reject(new WorkspaceError(ErrorCode.INTERNAL_ERROR, `failed to start ${shell.file}: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }

    const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const sizes = { stdout: 0, stderr: 0 };
    let truncated = false;
    let timedOut = false;
    const collect = (name: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = MAX_SHELL_OUTPUT_BYTES - sizes[name];
      if (room <= 0) { truncated = true; return; }
      const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (piece.length < chunk.length) truncated = true;
      chunks[name].push(piece);
      sizes[name] += piece.length;
    };
    child.stdout!.on("data", collect("stdout"));
    child.stderr!.on("data", collect("stderr"));

    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeout);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new WorkspaceError(ErrorCode.INTERNAL_ERROR, `failed to run command: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        shell: shell.name,
        cwd: workdir,
        exitCode: timedOut ? null : code,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        timedOut,
        truncated,
        durationMs: Date.now() - started,
      });
    });
  });
}
