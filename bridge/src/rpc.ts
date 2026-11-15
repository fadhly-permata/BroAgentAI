/**
 * RPC envelope, error codes, and host config types for the bridge.
 *
 * These mirror `shared/src/protocol.ts`. The bridge keeps a local copy for M0
 * because TypeScript's `rootDir` rule forbids importing files outside
 * `bridge/src`; sharing the package boundary is a documented follow-up.
 */

/** RPC request envelope sent from the extension to the bridge. */
export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

/** RPC response envelope sent from the bridge to the extension. */
export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError;
}

/** Structured RPC error. */
export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

/**
 * Stable, surface-safe error codes aligned with shared/src/protocol.ts.
 *
 * Declared as a frozen const map instead of a TypeScript `enum` so the file
 * stays loadable by Node's type-stripping loader (`--experimental-strip-types`),
 * which rejects non-erasable syntax such as enums, namespaces, and parameter
 * properties. The companion type alias keeps `ErrorCode.X` usable as a value
 * and `ErrorCode` usable as a type.
 */
export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  PATH_ESCAPE: -32001,
  FILE_NOT_FOUND: -32002,
  FILE_TOO_LARGE: -32003,
  BINARY_FILE: -32004,
  MTIME_CONFLICT: -32005,
  WORKSPACE_NOT_FOUND: -32006,
  WORKSPACE_INVALID: -32007,
  CONFIG_INVALID: -32008,
  PERMISSION_DENIED: -32009,
  OPERATION_CANCELLED: -32010,
  TIMEOUT: -32011,
  GIT_NOT_REPO: -32015,
  GIT_AUTH_FAILED: -32016,
  GIT_CONFLICT: -32017,
  GIT_OPERATION_FAILED: -32018,
  MCP_UNTRUSTED: -32019,
  MCP_NOT_READY: -32020,
  MCP_ERROR: -32021,
  NOT_ALLOWED: -32022,
} as const;

/** Union of every {@link ErrorCode} value. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** A registered workspace as persisted in the host app config. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: string;
}

/** Host app config (workspace list + host settings). */
export interface AppConfig {
  version: 1;
  activeWorkspaceId: string | null;
  workspaces: WorkspaceInfo[];
  settings: {
    ignore: string[];
    maxFileBytes: number;
  };
}
