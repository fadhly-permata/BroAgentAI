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
import { TerminalManager } from "./terminal.ts";
import type { EmitEvent } from "./terminal.ts";
import {
  gitAbort, gitBranches, gitCheckout, gitCommit, gitCreateBranch, gitDiff, gitDiscard, gitFetch, gitInit, gitPull, gitPush,
  gitStage, gitStatus, gitTestRemote, gitUnstage,
} from "./git.ts";

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
  readonly #terminals: TerminalManager;

  constructor(options: RpcServerOptions = {}) {
    this.#store = options.store ?? new WorkspaceStore();
    this.#hostVersion = options.hostVersion ?? HOST_VERSION;
    this.#emit = options.emit ?? (() => {});
    this.#terminals = new TerminalManager(this.#store, this.#emit);
    this.#registerCoreHandlers();
  }

  /** Release everything that outlives a request (terminals, child servers). */
  async shutdown(): Promise<void> {
    this.#terminals.closeAll();
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
      return { workspace, activeWorkspaceId: this.#store.active()?.id ?? null };
    });

    this.register("workspace.remove", (params) => {
      const { id } = readParams(params);
      return this.#store.remove(id);
    });

    this.register("workspace.setActive", (params) => {
      const { id } = readParams(params);
      const workspace = this.#store.setActive(id);
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

    // Shows the OS folder picker; the panel then calls workspace.add with the
    // result. Rejects (panel falls back to manual input) where unsupported.
    this.register("workspace.openFolderDialog", () => openFolderDialog());

    this.register("fs.listDir", (params) => {
      const { path } = readParams(params);
      return listDir(this.#store, path || ".");
    });

    this.register("fs.listTree", (params) => {
      const { path, maxDepth } = readParams(params);
      const depth = maxDepth ? parseInt(maxDepth, 10) : 3;
      return listTree(this.#store, path || ".", depth);
    });

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
