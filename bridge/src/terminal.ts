/**
 * Real PTY terminals for the BroAgentAI bridge (ConPTY on Windows via node-pty).
 *
 * A session runs the user's shell in the active workspace root. Output is
 * streamed to the extension as `term.output` events; `term.exit` fires once
 * when the shell ends. Sessions never outlive the bridge process.
 */

import { ErrorCode } from "./rpc.ts";
import { assertNoShellOverride, terminalShellFor } from "./shell.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

/** Maximum concurrent terminal sessions. */
export const MAX_TERMINALS = 4;
/** Maximum bytes accepted by one `term.input` call. */
export const MAX_INPUT_BYTES = 64 * 1024;
/** Output is coalesced for this long before an event is emitted. */
const FLUSH_INTERVAL_MS = 16;
/** One event never carries more than this many characters. */
const MAX_EVENT_CHARS = 64 * 1024;

export type EmitEvent = (event: string, data: unknown) => void;

interface PtyProcess {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pid: number;
}

interface Session {
  id: string;
  pty: PtyProcess;
  cwd: string;
  shell: string;
  shellFamily: string;
  environment: string;
  pending: string;
  timer: NodeJS.Timeout | null;
  exited: boolean;
}

export interface TerminalInfo {
  sessionId: string;
  cwd: string;
  shell: string;
  shellFamily: string;
  environment: string;
}

function clampDimension(value: unknown, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(500, Math.max(2, n));
}

export class TerminalManager {
  readonly #store: WorkspaceStore;
  readonly #emit: EmitEvent;
  readonly #sessions = new Map<string, Session>();
  #nextId = 1;

  constructor(store: WorkspaceStore, emit: EmitEvent) {
    this.#store = store;
    this.#emit = emit;
  }

  /** Start the detected shell in the active workspace root. */
  async create(cols?: unknown, rows?: unknown, params: Record<string, unknown> = {}): Promise<TerminalInfo> {
    assertNoShellOverride(params);
    const active = this.#store.active();
    if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
    if (this.#sessions.size >= MAX_TERMINALS) {
      throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `terminal limit reached (${MAX_TERMINALS}); close one first`);
    }

    // Loaded lazily: a missing native module must not stop the bridge from starting.
    let spawn: (file: string, args: string[], options: Record<string, unknown>) => PtyProcess;
    try {
      const mod: any = await import("node-pty");
      spawn = (mod.spawn ?? mod.default?.spawn) as typeof spawn;
    } catch (error) {
      throw new WorkspaceError(
        ErrorCode.INTERNAL_ERROR,
        `terminal backend (node-pty) is not available: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const shell = terminalShellFor();
    let pty: PtyProcess;
    try {
      pty = spawn(shell.file, shell.args, {
        name: "xterm-256color",
        cols: clampDimension(cols, 80),
        rows: clampDimension(rows, 24),
        cwd: active.path,
        env: process.env,
      });
    } catch (error) {
      throw new WorkspaceError(
        ErrorCode.INTERNAL_ERROR,
        `failed to start shell ${shell.file}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const session: Session = {
      id: `t${this.#nextId++}`, pty, cwd: active.path, shell: shell.file, shellFamily: shell.family, environment: shell.environment, pending: "", timer: null, exited: false,
    };
    this.#sessions.set(session.id, session);

    pty.onData((data) => {
      session.pending += data;
      if (!session.timer) session.timer = setTimeout(() => this.#flush(session), FLUSH_INTERVAL_MS);
    });
    pty.onExit(({ exitCode }) => {
      session.exited = true;
      this.#flush(session);
      this.#sessions.delete(session.id);
      this.#emit("term.exit", { sessionId: session.id, exitCode });
    });

    return { sessionId: session.id, cwd: session.cwd, shell: session.shell, shellFamily: session.shellFamily, environment: session.environment };
  }

  #flush(session: Session): void {
    if (session.timer) { clearTimeout(session.timer); session.timer = null; }
    while (session.pending.length > 0) {
      const chunk = session.pending.slice(0, MAX_EVENT_CHARS);
      session.pending = session.pending.slice(MAX_EVENT_CHARS);
      this.#emit("term.output", { sessionId: session.id, data: chunk });
    }
  }

  #require(sessionId: unknown): Session {
    const session = typeof sessionId === "string" ? this.#sessions.get(sessionId) : undefined;
    if (!session) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown terminal session: ${String(sessionId)}`);
    return session;
  }

  /** Write keystrokes / text to the shell. */
  input(sessionId: unknown, data: unknown): { ok: true } {
    const session = this.#require(sessionId);
    if (typeof data !== "string") throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "data must be a string");
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_BYTES) {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `input exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    session.pty.write(data);
    return { ok: true };
  }

  resize(sessionId: unknown, cols: unknown, rows: unknown): { ok: true } {
    const session = this.#require(sessionId);
    session.pty.resize(clampDimension(cols, 80), clampDimension(rows, 24));
    return { ok: true };
  }

  /** Kill the shell. `term.exit` is emitted when it is gone. */
  close(sessionId: unknown): { ok: true } {
    const session = this.#require(sessionId);
    try { session.pty.kill(); } catch { /* already dead */ }
    return { ok: true };
  }

  list(): TerminalInfo[] {
    return [...this.#sessions.values()].map((s) => ({
      sessionId: s.id,
      cwd: s.cwd,
      shell: s.shell,
      shellFamily: s.shellFamily,
      environment: s.environment,
    }));
  }

  /** Kill every session (bridge shutdown). */
  closeAll(): void {
    for (const session of this.#sessions.values()) {
      try { session.pty.kill(); } catch { /* already dead */ }
    }
  }
}
