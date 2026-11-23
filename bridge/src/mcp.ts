/**
 * MCP client/host for the BroAgentAI bridge.
 *
 * Server definitions come from three layers (lowest to highest precedence):
 *   global  <configDir>/broagentai.json(c)          user-authored, trusted
 *   project <workspace>/broagentai.json(c)          committed, UNTRUSTED until reviewed
 *   local   <workspace>/broagentai.local.json(c)    user-authored, trusted
 *
 * A server defined (or overridden) by the project layer only starts after the
 * user trusted the workspace; trust is bound to a hash of the project servers'
 * security-relevant fields, so changing them revokes it. Nothing in a config
 * file can grant trust. Commands are argument arrays; no shell is involved.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { readJsoncFile } from "./jsonc.ts";
import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";
import type { EmitEvent } from "./terminal.ts";

export const MAX_SERVERS = 16;
export const MAX_TOOLS_PER_SERVER = 256;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const MAX_TOOL_TIMEOUT_MS = 120_000;
export const MAX_RESULT_BYTES = 512 * 1024;
export const MAX_CONCURRENT_CALLS = 4;
export const STARTUP_TIMEOUT_MS = 30_000;
const LOG_RING_BYTES = 64 * 1024;
const SERVER_ID = /^[a-zA-Z0-9_-]{1,40}$/;

export type McpRisk = "read" | "write" | "destructive";
export type McpOrigin = "global" | "project" | "local";
export type McpStatus = "untrusted" | "disabled" | "stopped" | "starting" | "ready" | "stopping" | "error";
const RISK_ORDER: McpRisk[] = ["read", "write", "destructive"];

export interface McpServerDef {
  id: string;
  origin: McpOrigin;
  type: "local" | "remote";
  command?: string[];
  cwd?: string;
  environment: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeoutMs: number;
  risk?: McpRisk;
  toolRisk: Record<string, McpRisk>;
}

export interface McpTool {
  /** Namespaced name: mcp.<serverId>.<toolName>. */
  name: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
  risk: McpRisk;
}

interface LoadedConfig {
  servers: McpServerDef[];
  warnings: string[];
  /** Hash of the project-originated servers' security-relevant fields. */
  projectHash: string;
}

function readLayer(dir: string, base: string, warnings: string[]): Record<string, unknown> {
  for (const ext of [".jsonc", ".json"]) {
    const file = join(dir, base + ext);
    if (!existsSync(file)) continue;
    try {
      const parsed = readJsoncFile(file) as { mcp?: unknown } | null;
      const mcp = parsed && typeof parsed === "object" ? parsed.mcp : undefined;
      if (mcp === undefined) return {};
      if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) {
        warnings.push(`${file}: "mcp" must be an object keyed by server id`);
        return {};
      }
      return mcp as Record<string, unknown>;
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      return {};
    }
  }
  return {};
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(value)) if (typeof v === "string") out[key] = v;
  return out;
}

function asRisk(value: unknown): McpRisk | undefined {
  return typeof value === "string" && (RISK_ORDER as string[]).includes(value) ? (value as McpRisk) : undefined;
}

function isLocalhost(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function parseServer(id: string, raw: unknown, origin: McpOrigin, baseDir: string, warnings: string[]): McpServerDef | null {
  const where = `mcp.${id} (${origin})`;
  if (!SERVER_ID.test(id)) { warnings.push(`${where}: invalid server id`); return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { warnings.push(`${where}: must be an object`); return null; }
  const r = raw as Record<string, unknown>;
  const toolRisk: Record<string, McpRisk> = {};
  if (r.toolRisk && typeof r.toolRisk === "object" && !Array.isArray(r.toolRisk)) {
    for (const [tool, value] of Object.entries(r.toolRisk)) {
      const risk = asRisk(value);
      if (risk) toolRisk[tool] = risk;
    }
  }
  const timeout = typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? r.timeoutMs : DEFAULT_TOOL_TIMEOUT_MS;
  const def: McpServerDef = {
    id, origin,
    type: r.type as "local" | "remote",
    environment: stringRecord(r.environment),
    headers: stringRecord(r.headers),
    enabled: r.enabled !== false,
    timeoutMs: Math.min(timeout, MAX_TOOL_TIMEOUT_MS),
    risk: asRisk(r.risk),
    toolRisk,
  };

  if (r.type === "local") {
    if (!Array.isArray(r.command) || r.command.length === 0 || !r.command.every((part) => typeof part === "string" && part !== "")) {
      warnings.push(`${where}: "command" must be a non-empty array of strings (no shell string)`);
      return null;
    }
    def.command = r.command as string[];
    if (typeof r.cwd === "string" && r.cwd !== "") def.cwd = isAbsolute(r.cwd) ? r.cwd : resolve(baseDir, r.cwd);
    else def.cwd = baseDir;
    return def;
  }
  if (r.type === "remote") {
    let url: URL;
    try { url = new URL(String(r.url)); } catch { warnings.push(`${where}: invalid "url"`); return null; }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalhost(url))) {
      warnings.push(`${where}: remote MCP requires https (http is allowed for localhost only)`);
      return null;
    }
    def.url = url.toString();
    return def;
  }
  warnings.push(`${where}: unknown type ${JSON.stringify(r.type)} (expected "local" or "remote")`);
  return null;
}

/** Security-relevant projection of a server: values of secrets are never included. */
function securityView(def: McpServerDef) {
  return {
    id: def.id, type: def.type, command: def.command ?? null, cwd: def.cwd ?? null, url: def.url ?? null,
    environmentKeys: Object.keys(def.environment).sort(), headerKeys: Object.keys(def.headers).sort(),
    risk: def.risk ?? null, toolRisk: Object.fromEntries(Object.entries(def.toolRisk).sort()),
  };
}

/** Load and merge the three config layers for a workspace. */
export function loadMcpConfig(configDir: string, workspacePath: string): LoadedConfig {
  const warnings: string[] = [];
  const layers: [McpOrigin, string, Record<string, unknown>][] = [
    ["global", configDir, readLayer(configDir, "broagentai", warnings)],
    ["project", workspacePath, readLayer(workspacePath, "broagentai", warnings)],
    ["local", workspacePath, readLayer(workspacePath, "broagentai.local", warnings)],
  ];

  const byId = new Map<string, McpServerDef>();
  const projectIds = new Set<string>();
  for (const [origin, baseDir, layer] of layers) {
    for (const [id, raw] of Object.entries(layer)) {
      if (origin === "project") projectIds.add(id);
      const def = parseServer(id, raw, origin, baseDir, warnings);
      if (!def) { byId.delete(id); continue; }
      // A server the project layer touched stays project-originated even when
      // a local file overrides it: local may tweak it but cannot launder trust.
      if (projectIds.has(id)) def.origin = "project";
      byId.set(id, def);
    }
  }

  let servers = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (servers.length > MAX_SERVERS) {
    warnings.push(`more than ${MAX_SERVERS} MCP servers configured; extra servers are ignored`);
    servers = servers.slice(0, MAX_SERVERS);
  }
  const projectView = servers.filter((s) => s.origin === "project").map(securityView);
  const projectHash = createHash("sha256").update(JSON.stringify(projectView)).digest("hex");
  return { servers, warnings, projectHash };
}

export function validateEnvRefs(values: Record<string, string>, label: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const missing = new Set<string>();
  const expanded: Record<string, string> = {};
  for (const [key, raw] of Object.entries(values)) {
    const result = expandEnvRefs(raw, env);
    for (const name of result.missing) missing.add(name);
    expanded[key] = result.value;
  }
  if (missing.size > 0) {
    throw new WorkspaceError(ErrorCode.CONFIG_INVALID, `${label} references unset environment variable(s): ${[...missing].sort().join(", ")}`);
  }
  return expanded;
}

/** Expand `${env:NAME}` references. Missing variables are reported, never printed. */
export function expandEnvRefs(value: string, env: NodeJS.ProcessEnv): { value: string; missing: string[] } {
  const missing: string[] = [];
  const expanded = value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const found = env[name];
    if (found === undefined) { missing.push(name); return ""; }
    return found;
  });
  return { value: expanded, missing };
}

/** Risk from MCP annotations, then config overrides that may only escalate. */
export function effectiveRisk(
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined,
  serverRisk: McpRisk | undefined,
  toolRisk: McpRisk | undefined
): McpRisk {
  let risk: McpRisk = annotations?.readOnlyHint === true ? "read" : annotations?.destructiveHint === true ? "destructive" : "write";
  for (const override of [serverRisk, toolRisk]) {
    if (override && RISK_ORDER.indexOf(override) > RISK_ORDER.indexOf(risk)) risk = override;
  }
  return risk;
}

interface Runtime {
  def: McpServerDef;
  /** JSON of securityView(def) at start time; a change stops the server. */
  fingerprint: string;
  status: McpStatus;
  client: any | null;
  tools: McpTool[];
  error: string | null;
  log: string;
  activeCalls: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new WorkspaceError(ErrorCode.TIMEOUT, `${what} timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

export class McpManager {
  readonly #store: WorkspaceStore;
  readonly #emit: EmitEvent;
  readonly #runtimes = new Map<string, Runtime>();
  #workspace: string | null = null;

  constructor(store: WorkspaceStore, emit: EmitEvent) {
    this.#store = store;
    this.#emit = emit;
  }

  get #trustPath(): string {
    return join(this.#store.configDir, "trust.json");
  }

  #readTrust(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.#trustPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  #writeTrust(trust: Record<string, string>): void {
    mkdirSync(this.#store.configDir, { recursive: true });
    writeFileSync(this.#trustPath, JSON.stringify(trust, null, 2) + "\n", "utf8");
  }

  #workspaceKey(path: string): string {
    try { return realpathSync(path); } catch { return path; }
  }

  /**
   * Re-read config for the active workspace and reconcile running servers:
   * anything whose definition changed, vanished, was disabled, lost trust, or
   * belongs to a previously active workspace is stopped.
   */
  async #sync(): Promise<{ config: LoadedConfig; trusted: boolean; workspace: string }> {
    const active = this.#store.active();
    if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
    const workspace = this.#workspaceKey(active.path);
    if (this.#workspace !== null && this.#workspace !== workspace) await this.stopAll();
    this.#workspace = workspace;

    const config = loadMcpConfig(this.#store.configDir, active.path);
    const trusted = this.#readTrust()[workspace] === config.projectHash;
    const defs = new Map(config.servers.map((def) => [def.id, def]));

    for (const [id, runtime] of [...this.#runtimes]) {
      const def = defs.get(id);
      const changed = !def || JSON.stringify(securityView(def)) !== runtime.fingerprint || !def.enabled;
      const untrusted = def?.origin === "project" && !trusted;
      if (changed || untrusted) {
        await this.#stopRuntime(runtime);
        this.#runtimes.delete(id);
      } else {
        runtime.def = def;
      }
    }
    return { config, trusted, workspace };
  }

  #statusOf(def: McpServerDef, trusted: boolean): McpStatus {
    const runtime = this.#runtimes.get(def.id);
    if (runtime) return runtime.status;
    if (!def.enabled) return "disabled";
    if (def.origin === "project" && !trusted) return "untrusted";
    return "stopped";
  }

  #notify(id: string, status: McpStatus): void {
    this.#emit("mcp.status", { server: id, status });
  }

  /** `mcp.servers`: configured servers with origin, trust, status and a secret-free review view. */
  async servers() {
    const { config, trusted } = await this.#sync();
    return {
      trusted,
      hasProjectServers: config.servers.some((s) => s.origin === "project"),
      warnings: config.warnings,
      servers: config.servers.map((def) => {
        const runtime = this.#runtimes.get(def.id);
        return {
          id: def.id,
          origin: def.origin,
          transport: def.type === "local" ? "stdio" : "http",
          enabled: def.enabled,
          trusted: def.origin !== "project" || trusted,
          status: this.#statusOf(def, trusted),
          toolCount: runtime?.tools.length ?? 0,
          error: runtime?.error ?? null,
          // Review data: exact command/cwd/url and KEY NAMES only, never values.
          command: def.command ?? null,
          cwd: def.cwd ?? null,
          url: def.url ?? null,
          environmentKeys: Object.keys(def.environment).sort(),
          headerKeys: Object.keys(def.headers).sort(),
          risk: def.risk ?? null,
        };
      }),
    };
  }

  /** `workspace.trust`: record trust for the current project MCP config. */
  async trust() {
    const { config, workspace } = await this.#sync();
    const trust = this.#readTrust();
    trust[workspace] = config.projectHash;
    this.#writeTrust(trust);
    return this.servers();
  }

  /** `workspace.untrust`: revoke trust and stop project servers. */
  async untrust() {
    const { workspace } = await this.#sync();
    const trust = this.#readTrust();
    delete trust[workspace];
    this.#writeTrust(trust);
    return this.servers(); // #sync inside stops the now-untrusted servers
  }

  async #requireDef(id: unknown): Promise<{ def: McpServerDef; trusted: boolean }> {
    const { config, trusted } = await this.#sync();
    const def = typeof id === "string" ? config.servers.find((s) => s.id === id) : undefined;
    if (!def) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown MCP server: ${String(id)}`);
    return { def, trusted };
  }

  /** `mcp.start`: connect to a server and load its tool list. */
  async start(id: unknown) {
    const { def, trusted } = await this.#requireDef(id);
    if (!def.enabled) throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `MCP server ${def.id} is disabled in config`);
    if (def.origin === "project" && !trusted) {
      throw new WorkspaceError(ErrorCode.MCP_UNTRUSTED, `MCP server ${def.id} is defined by the project; review and trust the workspace first`);
    }
    const existing = this.#runtimes.get(def.id);
    if (existing && (existing.status === "ready" || existing.status === "starting")) return this.servers();
    if (existing) { await this.#stopRuntime(existing); this.#runtimes.delete(def.id); }

    const runtime: Runtime = {
      def, fingerprint: JSON.stringify(securityView(def)), status: "starting",
      client: null, tools: [], error: null, log: "", activeCalls: 0,
    };
    this.#runtimes.set(def.id, runtime);
    this.#notify(def.id, "starting");

    try {
      await withTimeout(this.#connect(runtime), STARTUP_TIMEOUT_MS, `starting MCP server ${def.id}`);
      runtime.status = "ready";
      this.#notify(def.id, "ready");
    } catch (error) {
      runtime.error = this.#describe(error, runtime);
      await this.#closeClient(runtime);
      runtime.status = "error";
      this.#notify(def.id, "error");
      throw new WorkspaceError(
        error instanceof WorkspaceError ? error.code : ErrorCode.MCP_ERROR,
        `MCP server ${def.id} failed to start: ${runtime.error}`
      );
    }
    return this.servers();
  }

  #describe(error: unknown, runtime: Runtime): string {
    const message = error instanceof Error ? error.message : String(error);
    const tail = runtime.log.trim().split("\n").slice(-3).join(" | ");
    return (tail ? `${message} (server log: ${tail})` : message).slice(0, 1000);
  }

  async #connect(runtime: Runtime): Promise<void> {
    const { def } = runtime;
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "broagentai-bridge", version: "0.1.0" }, { capabilities: {} });
    runtime.client = client;

    if (def.type === "local") {
      const { StdioClientTransport, getDefaultEnvironment } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      const env: Record<string, string> = { ...getDefaultEnvironment() }; // minimal inherited environment
      Object.assign(env, validateEnvRefs(def.environment, `server ${def.id} environment`));
      const [command, ...args] = def.command!;
      const transport = new StdioClientTransport({ command, args, env, cwd: def.cwd, stderr: "pipe" });
      transport.stderr?.on("data", (chunk: Buffer) => {
        runtime.log = (runtime.log + chunk.toString("utf8")).slice(-LOG_RING_BYTES);
      });
      transport.onclose = () => this.#onTransportClosed(runtime);
      await client.connect(transport);
    } else {
      const headers: Record<string, string> = validateEnvRefs(def.headers, `server ${def.id} headers`);
      const url = new URL(def.url!);
      try {
        const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
        await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      } catch (httpError) {
        // Legacy servers only speak SSE; retry once with that transport.
        const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
        const sseClient = new Client({ name: "broagentai-bridge", version: "0.1.0" }, { capabilities: {} });
        try {
          await sseClient.connect(new SSEClientTransport(url, { requestInit: { headers } }));
          runtime.client = sseClient;
        } catch {
          throw httpError;
        }
      }
    }

    const listed = await runtime.client.listTools();
    const tools: any[] = Array.isArray(listed?.tools) ? listed.tools.slice(0, MAX_TOOLS_PER_SERVER) : [];
    runtime.tools = tools.map((tool) => ({
      name: `mcp.${def.id}.${tool.name}`,
      server: def.id,
      tool: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: tool.inputSchema ?? { type: "object" },
      risk: effectiveRisk(tool.annotations, def.risk, def.toolRisk[tool.name]),
    }));
  }

  #onTransportClosed(runtime: Runtime): void {
    if (this.#runtimes.get(runtime.def.id) !== runtime) return;
    if (runtime.status === "ready") {
      runtime.status = "error";
      runtime.error = "server process exited";
      runtime.tools = [];
      this.#notify(runtime.def.id, "error");
    }
  }

  async #closeClient(runtime: Runtime): Promise<void> {
    const client = runtime.client;
    runtime.client = null;
    if (!client) return;
    try { await withTimeout(client.close(), 5000, "closing MCP client"); } catch { /* best effort */ }
  }

  async #stopRuntime(runtime: Runtime): Promise<void> {
    if (runtime.status === "ready" || runtime.status === "starting") {
      runtime.status = "stopping";
      this.#notify(runtime.def.id, "stopping");
    }
    await this.#closeClient(runtime);
    runtime.tools = [];
    runtime.status = "stopped";
    this.#notify(runtime.def.id, "stopped");
  }

  /** `mcp.stop` */
  async stop(id: unknown) {
    const { def } = await this.#requireDef(id);
    const runtime = this.#runtimes.get(def.id);
    if (runtime) { await this.#stopRuntime(runtime); this.#runtimes.delete(def.id); }
    return this.servers();
  }

  /** `mcp.restart` */
  async restart(id: unknown) {
    await this.stop(id);
    return this.start(id);
  }

  /** `mcp.tools`: tools of every ready server. */
  async tools(): Promise<{ tools: McpTool[] }> {
    if (!this.#store.active()) return { tools: [] };
    await this.#sync();
    return { tools: [...this.#runtimes.values()].filter((r) => r.status === "ready").flatMap((r) => r.tools) };
  }

  /** Look up a ready tool by server + tool name (used for risk checks before a call). */
  async findTool(server: unknown, tool: unknown): Promise<McpTool> {
    await this.#sync();
    const runtime = typeof server === "string" ? this.#runtimes.get(server) : undefined;
    if (!runtime) {
      const { def, trusted } = await this.#requireDef(server);
      if (def.origin === "project" && !trusted) {
        throw new WorkspaceError(ErrorCode.MCP_UNTRUSTED, `MCP server ${def.id} is not trusted`);
      }
      throw new WorkspaceError(ErrorCode.MCP_NOT_READY, `MCP server ${def.id} is not running`);
    }
    if (runtime.status !== "ready") {
      throw new WorkspaceError(ErrorCode.MCP_NOT_READY, `MCP server ${runtime.def.id} is ${runtime.status}`);
    }
    const found = runtime.tools.find((t) => t.tool === tool);
    if (!found) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown tool ${String(tool)} on MCP server ${runtime.def.id}`);
    return found;
  }

  /** `mcp.callTool`: execute a tool with timeout, concurrency and result caps. */
  async callTool(server: unknown, tool: unknown, args: unknown) {
    const found = await this.findTool(server, tool);
    const runtime = this.#runtimes.get(found.server)!;
    if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "arguments must be an object");
    }
    if (runtime.activeCalls >= MAX_CONCURRENT_CALLS) {
      throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `too many concurrent calls to MCP server ${found.server}`);
    }

    runtime.activeCalls++;
    let result: any;
    try {
      const timeout = runtime.def.timeoutMs;
      result = await withTimeout(
        runtime.client.callTool({ name: found.tool, arguments: (args as Record<string, unknown>) ?? {} }, undefined, { timeout }),
        timeout + 500,
        `MCP tool ${found.name}`
      );
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/timed out|timeout/i.test(message)) throw new WorkspaceError(ErrorCode.TIMEOUT, `MCP tool ${found.name} timed out`);
      throw new WorkspaceError(ErrorCode.MCP_ERROR, `MCP tool ${found.name} failed: ${message.slice(0, 1000)}`);
    } finally {
      runtime.activeCalls--;
    }

    // Results are data for the model. Flatten text content and cap the size.
    const parts: any[] = Array.isArray(result?.content) ? result.content : [];
    let text = parts.map((part) => (part?.type === "text" ? String(part.text) : `[${part?.type ?? "unknown"} content omitted]`)).join("\n");
    let truncated = false;
    if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
      text = Buffer.from(text, "utf8").subarray(0, MAX_RESULT_BYTES).toString("utf8");
      truncated = true;
    }
    return { server: found.server, tool: found.tool, risk: found.risk, isError: result?.isError === true, text, truncated };
  }

  /** Stop every server (bridge shutdown or workspace switch). */
  async stopAll(): Promise<void> {
    const runtimes = [...this.#runtimes.values()];
    this.#runtimes.clear();
    await Promise.all(runtimes.map((runtime) => this.#stopRuntime(runtime)));
  }
}
