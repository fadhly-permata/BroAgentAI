/**
 * RPC router for the BroAgentAI bridge.
 *
 * Maps wire methods to handlers and converts thrown errors into structured
 * {@link RpcResponse} envelopes. The router is transport-agnostic: it receives
 * a decoded request object and returns a response object, so it can be driven
 * by the Native Messaging loop or by a plain Node test client.
 */

import { ErrorCode } from "./rpc.ts";
import type { RpcRequest, RpcResponse } from "./rpc.ts";
import { WorkspaceError, WorkspaceStore, validateWorkspacePath } from "./workspace.ts";
import type { WorkspaceInfo } from "./rpc.ts";
import { listDir, listTree, statFile, readFile, readFileLines, writeFile, searchFiles } from "./fs.ts";
import { loadMergedConfig } from "./config.ts";
import { loadAllResources, loadRule, loadSkill } from "./resources.ts";
import { createLogger } from "./logger.ts";
import { openFolderDialog } from "./dialog.ts";
import { buildPrompt, callTool, checkTool, listTools } from "./agent.ts";
import { createFile, deletePath, makeDir, renamePath } from "./fs-ops.ts";
import { McpManager } from "./mcp.ts";
import { runShell } from "./shell.ts";
import { TerminalManager } from "./terminal.ts";
import type { EmitEvent } from "./terminal.ts";
import { WorkspaceWatcher } from "./watcher.ts";
import {
  gitAbort, gitBranches, gitCheckout, gitCommit, gitCreateBranch, gitDiff, gitDiscard, gitFetch, gitInit, gitPull, gitPush,
  gitStage, gitStatus, gitTestRemote, gitUnstage,
} from "./git.ts";
import { SessionStore } from "./session-store.ts";

/** Protocol version negotiated between extension and host. */
export const PROTOCOL_VERSION = 1;

/** Version of the bridge host, reported by `system.info`. */
export const HOST_VERSION = "0.1.0";

/** Host name used for the Native Messaging registration. */
export const HOST_NAME = "com.broagentai.host";

/** Logger for RPC request lifecycle events. */
const log = createLogger({ scope: "rpc" });

/** A single registered RPC handler. */
export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

/** Options accepted by {@link RpcServer}. */
export interface RpcServerOptions {
  /** Workspace registry used by the `workspace.*` methods. */
  store?: WorkspaceStore;
  /** Host version reported by `system.info`. */
  hostVersion?: string;
  /** Sink for bridge -> extension events (`term.output`, `mcp.status`, ...). */
  emit?: EmitEvent;
}

/**
 * Routes RPC requests to handlers.
 *
 * Every handler failure is normalized into an {@link RpcResponse} carrying a
 * stable error code, so the panel never has to interpret a thrown exception.
 */
export class RpcServer {
  readonly #store: WorkspaceStore;
  readonly #hostVersion: string;
  readonly #handlers = new Map<string, RpcHandler>();

  readonly #emit: EmitEvent;
  readonly #sessions: SessionStore;
  readonly #terminals: TerminalManager;
  readonly #mcp: McpManager;
  /** Only present when a sink is wired: tests build servers without events. */
  readonly #watcher: WorkspaceWatcher | null;

  constructor(options: RpcServerOptions = {}) {
    this.#store = options.store ?? new WorkspaceStore();
    this.#hostVersion = options.hostVersion ?? HOST_VERSION;
    this.#emit = options.emit ?? (() => {});
    this.#sessions = new SessionStore(this.#store.configDir);
    this.#terminals = new TerminalManager(this.#store, this.#emit);
    this.#mcp = new McpManager(this.#store, this.#emit);
    this.#watcher = options.emit ? new WorkspaceWatcher(this.#store, this.#emit) : null;
    this.#registerCoreHandlers();
    // Start following the workspace that is active at boot.
    this.#watcher?.restart();
  }

  /** Run a registered handler directly; throws instead of returning an error envelope. */
  async invoke(method: string, params: unknown): Promise<unknown> {
    const handler = this.#handlers.get(method);
    if (!handler) throw new WorkspaceError(ErrorCode.METHOD_NOT_FOUND, `unknown method: ${method}`);
    return handler(params);
  }

  /** The MCP manager (exposed for the tool catalog). */
  get mcp(): McpManager {
    return this.#mcp;
  }

  /** Release everything that outlives a request (terminals, child servers). */
  async shutdown(): Promise<void> {
    this.#watcher?.close();
    this.#terminals.closeAll();
    await this.#mcp.stopAll();
  }

  /** The workspace registry backing this server. */
  get store(): WorkspaceStore {
    return this.#store;
  }

  /** Names of every registered method, sorted alphabetically. */
  methods(): string[] {
    return [...this.#handlers.keys()].sort();
  }

  /** Register (or replace) a handler for a method name. */
  register(method: string, handler: RpcHandler): void {
    this.#handlers.set(method, handler);
  }

  /**
   * Handle one decoded request envelope.
   *
   * Never throws: unknown methods, invalid envelopes, and handler failures all
   * come back as an error response with the request id when one is available.
   */
  async handle(request: unknown): Promise<RpcResponse> {
    const id = extractId(request);

    if (!isRpcRequest(request)) {
      return {
        id: id ?? 0,
        error: {
          code: ErrorCode.INVALID_REQUEST,
          message: "request must be an object with numeric id and string method",
        },
      };
    }

    const handler = this.#handlers.get(request.method);
    if (!handler) {
      return {
        id: request.id,
        error: {
          code: ErrorCode.METHOD_NOT_FOUND,
          message: `unknown method: ${request.method}`,
          data: { available: this.methods() },
        },
      };
    }

    const startedAt = performance.now();
    log.info("rpc request", { fields: { id: request.id, method: request.method } });

    let response: RpcResponse;
    try {
      const result = await handler(request.params);
      response = { id: request.id, result };
    } catch (error) {
      response = { id: request.id, error: toRpcError(error) };
    }

    const durationMs = Math.round(performance.now() - startedAt);
    if (response.error) {
      log.warn("rpc method failed", {
        fields: {
          id: request.id,
          method: request.method,
          code: response.error.code,
          durationMs,
        },
      });
    } else {
      log.info("rpc method ok", {
        fields: { id: request.id, method: request.method, durationMs },
      });
    }
    return response;
  }

  /** Register the built-in handlers for system and workspace methods. */
  #registerCoreHandlers(): void {
    this.register("system.ping", () => ({
      hostVersion: this.#hostVersion,
      protocolVersion: PROTOCOL_VERSION,
      hostName: HOST_NAME,
    }));

    this.register("system.info", () => ({
      hostVersion: this.#hostVersion,
      protocolVersion: PROTOCOL_VERSION,
      hostName: HOST_NAME,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      configDir: this.#store.configDir,
      configPath: this.#store.configPath,
    }));

    this.register("workspace.list", () => ({
      workspaces: this.#store.list(),
      activeWorkspaceId: this.#store.active()?.id ?? null,
    }));

    this.register("workspace.add", (params) => {
      const { path, name } = readParams(params);
      const workspace = this.#store.add(path, name);
      // add() makes the workspace active, so the watcher follows it.
      this.#watcher?.restart();
      return { workspace, activeWorkspaceId: this.#store.active()?.id ?? null };
    });

    this.register("workspace.remove", (params) => {
      const { id } = readParams(params);
      const result = this.#store.remove(id);
      // Removing the active workspace changes what is watched.
      this.#watcher?.restart();
      return result;
    });

    this.register("workspace.setActive", (params) => {
      const { id } = readParams(params);
      const workspace = this.#store.setActive(id);
      this.#watcher?.restart();
      return { workspace, activeWorkspaceId: workspace.id };
    });

    this.register("workspace.rename", (params) => {
      const { id, name } = readParams(params);
      return { workspace: this.#store.rename(id, name) };
    });

    this.register("workspace.validate", (params) => {
      const { path } = readParams(params);
      // Throws WORKSPACE_INVALID when the path is missing, absent, or not a
      // directory; the router turns that into a structured error response.
      const resolved = validateWorkspacePath(path);
      return { valid: true, path: resolved };
    });

    this.register("workspace.settings", () => this.#store.settings());

    this.register("workspace.setIgnore", (params) => {
      const { patterns } = readParams(params);
      if (!Array.isArray(patterns) || !patterns.every((p) => typeof p === "string")) {
        throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "patterns must be an array of strings");
      }
      return { ignore: this.#store.setIgnore(patterns) };
    });

    // Shows the OS folder picker; the panel then calls workspace.add with the
    // result. Rejects (panel falls back to manual input) where unsupported.
    this.register("workspace.openFolderDialog", () => openFolderDialog());

    this.register("fs.listDir", (params) => {
      const { path, showIgnored } = readParams(params);
      return listDir(this.#store, path || ".", showIgnored === true);
    });

    this.register("fs.listTree", (params) => {
      const { path, maxDepth, showIgnored } = readParams(params);
      const depth = maxDepth ? parseInt(maxDepth, 10) : 3;
      return listTree(this.#store, path || ".", depth, showIgnored === true);
    });

    this.register("fs.createFile", (params) => createFile(this.#store, readParams(params).path));
    this.register("fs.mkdir", (params) => makeDir(this.#store, readParams(params).path));
    this.register("fs.rename", (params) => {
      const { from, to } = readParams(params);
      return renamePath(this.#store, from, to);
    });
    this.register("fs.delete", (params) => deletePath(this.#store, readParams(params).path));

    this.register("fs.stat", (params) => {
      const { path } = readParams(params);
      return statFile(this.#store, path);
    });

    this.register("fs.readFile", (params) => {
      const { path } = readParams(params);
      return readFile(this.#store, path);
    });

    this.register("fs.readFileLines", (params) => {
      const { path, startLine, endLine } = readParams(params);
      return readFileLines(this.#store, path, startLine, endLine);
    });

    this.register("fs.writeFile", (params) => {
      const { path, content, expectedMtime } = readParams(params);
      return writeFile(this.#store, path, content, expectedMtime);
    });

    this.register("fs.searchFiles", (params) => {
      const { path, query, caseSensitive, regex } = readParams(params);
      return searchFiles(this.#store, path || ".", query, caseSensitive, regex);
    });

    // Source control. All methods act on the active workspace; paths are
    // workspace-relative. See git.ts for the safety rules.
    this.register("git.status", () => gitStatus(this.#store));
    this.register("git.diff", (params) => {
      const { path, staged } = readParams(params);
      return gitDiff(this.#store, path, staged);
    });
    this.register("git.stage", (params) => gitStage(this.#store, readParams(params).paths));
    this.register("git.unstage", (params) => gitUnstage(this.#store, readParams(params).paths));
    this.register("git.discard", (params) => gitDiscard(this.#store, readParams(params).paths));
    this.register("git.commit", (params) => gitCommit(this.#store, readParams(params).message));
    this.register("git.branches", () => gitBranches(this.#store));
    this.register("git.createBranch", (params) => gitCreateBranch(this.#store, readParams(params).name));
    this.register("git.checkout", (params) => gitCheckout(this.#store, readParams(params).branch));
    this.register("git.init", () => gitInit(this.#store));
    this.register("git.fetch", () => gitFetch(this.#store));
    this.register("git.pull", (params) => gitPull(this.#store, readParams(params).mode));
    this.register("git.push", () => gitPush(this.#store));
    this.register("git.abort", () => gitAbort(this.#store));
    this.register("git.testRemote", (params) => gitTestRemote(this.#store, readParams(params).remote));

    // Terminal: a real PTY in the active workspace. Output arrives as events.
    this.register("term.create", (params) => {
      const { cols, rows } = readParams(params);
      return this.#terminals.create(cols, rows);
    });
    this.register("term.input", (params) => {
      const { sessionId, data } = readParams(params);
      return this.#terminals.input(sessionId, data);
    });
    this.register("term.resize", (params) => {
      const { sessionId, cols, rows } = readParams(params);
      return this.#terminals.resize(sessionId, cols, rows);
    });
    this.register("term.close", (params) => this.#terminals.close(readParams(params).sessionId));
    this.register("term.list", () => ({ sessions: this.#terminals.list() }));

    // MCP: the bridge is the MCP host. See mcp.ts for trust and safety rules.
    this.register("mcp.servers", () => this.#mcp.servers());
    this.register("mcp.tools", () => this.#mcp.tools());
    this.register("mcp.start", (params) => this.#mcp.start(readParams(params).server));
    this.register("mcp.stop", (params) => this.#mcp.stop(readParams(params).server));
    this.register("mcp.restart", (params) => this.#mcp.restart(readParams(params).server));
    this.register("mcp.callTool", (params) => {
      const p = readParams(params);
      return this.#mcp.callTool(p.server, p.tool, p.arguments);
    });
    this.register("workspace.trust", () => this.#mcp.trust());
    this.register("workspace.untrust", () => this.#mcp.untrust());

    // One-shot shell command for the agent. Not confined to the workspace; see shell.ts.
    this.register("shell.run", (params) => {
      const { command, cwd, timeoutMs } = readParams(params);
      return runShell(this.#store, command, cwd, timeoutMs);
    });

    // Agent: tool catalog, approval policy and operating prompt. See agent.ts.
    this.register("tools.list", () => listTools(this));
    this.register("agent.prompt", (params) => {
      const p = readParams(params ?? {});
      return buildPrompt(this, p.mode, p.handoff === true);
    });
    this.register("agent.check", (params) => {
      const p = readParams(params);
      return checkTool(this, p.command, p.params, p.mode);
    });
    this.register("agent.callTool", (params) => {
      const p = readParams(params);
      return callTool(this, p.command, p.params, p.mode, p.approved);
    });
    // Cross-context session resume (spec 8.1): persist a handoff snapshot by Session ID
    // so the same task can resume in another window/profile. See session-store.ts.
    this.register("session.save", (params) => {
      const p = readParams(params);
      return this.#sessions.save(p.id, p.snapshot);
    });
    this.register("session.load", (params) => {
      const p = readParams(params);
      return this.#sessions.load(p.id);
    });
    this.register("session.clear", (params) => {
      const p = readParams(params);
      return { cleared: this.#sessions.clear(p.id) };
    });
    this.register("session.list", () => ({ sessions: this.#sessions.list() }));

    this.register("config.get", () => {
      return loadMergedConfig(this.#store);
    });

    this.register("instructions.list", () => {
      const active = this.#store.active();
      if (!active) {
        throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
      }
      const resources = loadAllResources(this.#store);
      return {
        agents: resources.agents,
        instructions: resources.instructions,
      };
    });

    this.register("instructions.get", (params) => {
      const { path } = readParams(params);
      const active = this.#store.active();
      if (!active) {
        throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
      }
      
      // Check if it's AGENTS.md
      if (path === "AGENTS.md") {
        const resources = loadAllResources(this.#store);
        return resources.agents;
      }
      
      // Otherwise, treat it as a rule file
      return loadRule(active.path, path);
    });

    this.register("skills.list", () => {
      const resources = loadAllResources(this.#store);
      return { skills: resources.skills };
    });

    this.register("skills.get", (params) => {
      const { name } = readParams(params);
      const active = this.#store.active();
      if (!active) {
        throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
      }
      return loadSkill(active.path, name);
    });
  }
}

/** Type guard for a well-formed request envelope. */
function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<RpcRequest>;
  return typeof request.id === "number" && typeof request.method === "string";
}

/** Best-effort extraction of a request id from a possibly malformed envelope. */
function extractId(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === "number" ? id : undefined;
}

/** Read fields from a params object. */
function readParams(params: unknown): Record<string, any> {
  if (!params || typeof params !== "object") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "params must be an object");
  }
  return { ...(params as Record<string, any>) };
}

/** Convert any thrown value into a structured RPC error. */
function toRpcError(error: unknown): { code: ErrorCode; message: string; data?: unknown } {
  if (error instanceof WorkspaceError) {
    return { code: error.code, message: error.message };
  }

  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "number") {
      return { code: code as ErrorCode, message: error.message };
    }
    return { code: ErrorCode.INTERNAL_ERROR, message: error.message };
  }

  return { code: ErrorCode.INTERNAL_ERROR, message: String(error) };
}
