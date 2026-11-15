export const PROTOCOL_VERSION = 1;
export const HOST_NAME = "com.browseragent.host";

export const MAX_HOST_TO_EXTENSION_BYTES = 1_000_000;
export const MAX_EXTENSION_TO_HOST_BYTES = 64 * 1024 * 1024;
export const MAX_WORKSPACES = 50;
export const MAX_FILE_BYTES = 512 * 1024;
export const MAX_SEARCH_RESULTS = 500;
export const MAX_TREE_ENTRIES = 2_000;
export const MAX_GIT_CHANGES = 2_000;
export const MAX_DIFF_BYTES = 512 * 1024;

export type Platform = "win32" | "darwin" | "linux";
export type LogLevel = "error" | "warn" | "info" | "debug";

export const HOST_STATUSES = [
  "unknown",
  "connecting",
  "ready",
  "offline",
  "outdated",
  "error",
] as const;

export type HostStatus = (typeof HOST_STATUSES)[number];

export interface Workspace {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}

export interface HostSettings {
  ignore: string[];
  maxFileBytes: number;
  maxSearchResults: number;
  logLevel: LogLevel;
}

export const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  "target",
] as const;

export const DEFAULT_HOST_SETTINGS: HostSettings = {
  ignore: [...DEFAULT_IGNORE],
  maxFileBytes: MAX_FILE_BYTES,
  maxSearchResults: MAX_SEARCH_RESULTS,
  logLevel: "info",
};

export interface HostConfig {
  version: 1;
  activeWorkspaceId: string | null;
  workspaces: Workspace[];
  settings: HostSettings;
}

export function createDefaultHostConfig(): HostConfig {
  return {
    version: 1,
    activeWorkspaceId: null,
    workspaces: [],
    settings: {
      ...DEFAULT_HOST_SETTINGS,
      ignore: [...DEFAULT_IGNORE],
    },
  };
}

export interface HostInfo {
  hostVersion: string;
  protocolVersion: number;
  platform: Platform;
  configPath: string;
  logPath: string;
  extensionOrigin?: string;
}

export const RPC_METHODS = [
  "system.ping",
  "system.info",
  "system.shutdown",
  "workspace.list",
  "workspace.add",
  "workspace.remove",
  "workspace.setActive",
  "workspace.validate",
  "fs.listDir",
  "fs.listTree",
  "fs.stat",
  "fs.readFile",
  "fs.readFileLines",
  "fs.writeFile",
  "fs.createFile",
  "fs.createDirectory",
  "fs.rename",
  "fs.copy",
  "fs.delete",
  "fs.search",
  "fs.find",
  "fs.applyPatch",
  "git.status",
  "git.diff",
  "git.stage",
  "git.unstage",
  "git.discard",
  "git.commit",
  "git.branches",
  "git.createBranch",
  "git.switchBranch",
  "git.fetch",
  "git.pull",
  "git.push",
  "git.abort",
  "git.remotes",
  "git.testRemote",
  "watch.start",
  "watch.stop",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

const RPC_METHOD_SET: ReadonlySet<string> = new Set(RPC_METHODS);

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === "string" && RPC_METHOD_SET.has(value);
}

export const RPC_ERROR_CODES = [
  "BAD_REQUEST",
  "METHOD_NOT_FOUND",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_NOT_ACTIVE",
  "PATH_ESCAPE",
  "PATH_NOT_FOUND",
  "NOT_A_FILE",
  "NOT_A_DIRECTORY",
  "FILE_TOO_LARGE",
  "BINARY_FILE",
  "MTIME_CONFLICT",
  "GIT_NOT_REPO",
  "GIT_AUTH_FAILED",
  "GIT_CONFLICT",
  "GIT_OPERATION_FAILED",
  "TIMEOUT",
  "NOT_ALLOWED",
  "INTERNAL",
] as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number];

export interface RpcError {
  code: RpcErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface RpcRequest<P = unknown> {
  v: typeof PROTOCOL_VERSION;
  id: number;
  method: RpcMethod;
  params?: P;
}

export type RpcResponse<T = unknown> =
  | {
      v: typeof PROTOCOL_VERSION;
      id: number;
      ok: true;
      result: T;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      id: number;
      ok: false;
      error: RpcError;
    };

export type RpcEvent =
  | {
      v: typeof PROTOCOL_VERSION;
      event: "host.ready";
      data: HostInfo;
    }
  | {
      v: typeof PROTOCOL_VERSION;
      event: "fs.changed";
      data: {
        workspaceId: string;
        paths: string[];
        kind: "create" | "update" | "delete";
      };
    }
  | {
      v: typeof PROTOCOL_VERSION;
      event: "git.changed";
      data: { workspaceId: string };
    }
  | {
      v: typeof PROTOCOL_VERSION;
      event: "host.error";
      data: { message: string; code?: string };
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!isRecord(value)) return false;
  if (value.v !== PROTOCOL_VERSION) return false;
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return false;
  if (!isRpcMethod(value.method)) return false;
  if (value.params !== undefined && !isRecord(value.params)) return false;
  return true;
}

export function isRpcResponse(value: unknown): value is RpcResponse {
  if (!isRecord(value)) return false;
  if (value.v !== PROTOCOL_VERSION) return false;
  if (typeof value.id !== "number") return false;
  if (value.ok === true) return "result" in value;
  if (value.ok === false) return isRecord(value.error);
  return false;
}

export function isRpcEvent(value: unknown): value is RpcEvent {
  if (!isRecord(value)) return false;
  if (value.v !== PROTOCOL_VERSION) return false;
  return typeof value.event === "string" && "data" in value;
}

export type RiskClass = "read" | "write" | "destructive" | "git" | "sync";

const RISK_BY_METHOD: Record<RpcMethod, RiskClass> = {
  "system.ping": "read",
  "system.info": "read",
  "system.shutdown": "destructive",
  "workspace.list": "read",
  "workspace.add": "write",
  "workspace.remove": "write",
  "workspace.setActive": "write",
  "workspace.validate": "read",
  "fs.listDir": "read",
  "fs.listTree": "read",
  "fs.stat": "read",
  "fs.readFile": "read",
  "fs.readFileLines": "read",
  "fs.writeFile": "write",
  "fs.createFile": "write",
  "fs.createDirectory": "write",
  "fs.rename": "write",
  "fs.copy": "write",
  "fs.delete": "destructive",
  "fs.search": "read",
  "fs.find": "read",
  "fs.applyPatch": "write",
  "git.status": "read",
  "git.diff": "read",
  "git.stage": "git",
  "git.unstage": "git",
  "git.discard": "destructive",
  "git.commit": "git",
  "git.branches": "read",
  "git.createBranch": "git",
  "git.switchBranch": "git",
  "git.fetch": "sync",
  "git.pull": "sync",
  "git.push": "sync",
  "git.abort": "destructive",
  "git.remotes": "read",
  "git.testRemote": "read",
  "watch.start": "read",
  "watch.stop": "read",
};

export function riskForMethod(method: RpcMethod): RiskClass {
  return RISK_BY_METHOD[method];
}

export function isMutatingMethod(method: RpcMethod): boolean {
  const risk = RISK_BY_METHOD[method];
  return risk !== "read";
}

export const APPROVAL_MODES = ["read-only", "ask", "auto-edit", "full-auto"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const PROVIDER_IDS = [
  "deepseek",
  "gemini",
  "qwen",
  "chatgpt",
  "claude",
  "grok",
  "kimi",
  "glm",
  "meta",
  "mistral",
  "ptero",
  "arena",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface WorkspaceListResult {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
}

export interface WorkspaceAddParams {
  path: string;
  name?: string;
}

export interface WorkspaceAddResult {
  workspace: Workspace;
  activeWorkspaceId: string;
  created: boolean;
}

export interface WorkspaceRemoveParams {
  id: string;
}

export interface WorkspaceSetActiveParams {
  id: string;
}

export interface WorkspaceValidateParams {
  path: string;
}

export interface WorkspaceValidation {
  input: string;
  path: string | null;
  exists: boolean;
  isDirectory: boolean;
  isGitRepo: boolean;
  error?: string;
}

export interface SystemPingResult {
  ok: true;
  hostVersion: string;
  protocolVersion: number;
  uptimeMs: number;
}
