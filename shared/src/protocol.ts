// Shared protocol types for BroAgentAI extension <-> bridge communication

// ============================================================================
// RPC Envelope
// ============================================================================

/**
 * RPC request envelope sent from extension to bridge
 */
export interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

/**
 * RPC response envelope sent from bridge to extension
 */
export interface RpcResponse {
  id: number;
  result?: unknown;
  error?: RpcError;
}

/**
 * RPC error structure
 */
export interface RpcError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

/**
 * Combined envelope type (used for framing)
 */
export type RpcEnvelope = RpcRequest | RpcResponse;

// ============================================================================
// Error Codes
// ============================================================================

export enum ErrorCode {
  // Standard JSON-RPC errors
  PARSE_ERROR = -32700,
  INVALID_REQUEST = -32600,
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,

  // Custom BroAgentAI errors
  PATH_ESCAPE = -32001,
  FILE_NOT_FOUND = -32002,
  FILE_TOO_LARGE = -32003,
  BINARY_FILE = -32004,
  MTIME_CONFLICT = -32005,
  WORKSPACE_NOT_FOUND = -32006,
  WORKSPACE_INVALID = -32007,
  CONFIG_INVALID = -32008,
  PERMISSION_DENIED = -32009,
  OPERATION_CANCELLED = -32010,
  TIMEOUT = -32011,
}

// ============================================================================
// Risk Classification
// ============================================================================

/**
 * Risk class for tool operations (used for approval modes)
 */
export enum RiskClass {
  /** Read-only operations (safe, no approval needed) */
  READ = "read",
  /** Write operations (may need approval depending on mode) */
  WRITE = "write",
  /** Destructive operations (always need approval in non-auto modes) */
  DESTRUCTIVE = "destructive",
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Approval mode for agent operations
 */
export enum ApprovalMode {
  /** All write/destructive operations require approval */
  READ_ONLY = "read-only",
  /** Ask for approval on each operation */
  ASK = "ask",
  /** Auto-approve write operations, ask for destructive */
  AUTO_EDIT = "auto-edit",
  /** Auto-approve all operations (dangerous) */
  AUTO_ALL = "auto-all",
}

/**
 * Global configuration (stored in BROAGENTAI_CONFIG_DIR)
 */
export interface GlobalConfig {
  /** Default approval mode */
  approvalMode?: ApprovalMode;
  /** Default ignore patterns */
  ignorePatterns?: string[];
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
  /** Provider configurations */
  providers?: Record<string, ProviderConfig>;
}

/**
 * Project-level configuration (broagentai.jsonc in workspace root)
 */
export interface ProjectConfig {
  /** Project-specific approval mode override */
  approvalMode?: ApprovalMode;
  /** Project-specific ignore patterns */
  ignorePatterns?: string[];
  /** Project-specific MCP servers */
  mcpServers?: Record<string, McpServerConfig>;
  /** Project-specific provider overrides */
  providers?: Record<string, ProviderConfig>;
  /** Project instructions (AGENTS.md content reference) */
  instructions?: string;
}

// ============================================================================
// MCP Types
// ============================================================================

/**
 * MCP server configuration
 */
export interface McpServerConfig {
  /** Transport type */
  transport: "stdio" | "http" | "sse";
  /** Command to run (for stdio) */
  command?: string;
  /** Command arguments (for stdio) */
  args?: string[];
  /** Working directory (for stdio) */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** URL endpoint (for http/sse) */
  url?: string;
  /** Risk overrides for specific tools */
  riskOverrides?: Record<string, RiskClass>;
}

/**
 * MCP tool definition
 */
export interface McpTool {
  /** Tool name (namespaced: mcp.<server>.<tool>) */
  name: string;
  /** Tool description */
  description: string;
  /** JSON schema for input parameters */
  inputSchema: unknown;
  /** Risk classification */
  riskClass: RiskClass;
  /** Source server name */
  serverName: string;
}

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Provider plugin configuration
 */
export interface ProviderConfig {
  /** Provider display name */
  name: string;
  /** Provider type/identifier */
  type: string;
  /** Provider-specific settings */
  settings?: Record<string, unknown>;
}

/**
 * Provider manifest (provider.json in provider folder)
 */
export interface ProviderManifest {
  /** Provider unique identifier */
  id: string;
  /** Provider display name */
  name: string;
  /** Provider version */
  version: string;
  /** Provider description */
  description?: string;
  /** Required host permissions */
  hostPermissions?: string[];
  /** Content scripts to inject */
  contentScripts?: ContentScript[];
}

/**
 * Content script definition for provider
 */
export interface ContentScript {
  /** URL patterns to match */
  matches: string[];
  /** JavaScript files to inject */
  js?: string[];
  /** CSS files to inject */
  css?: string[];
  /** Execution world */
  world?: "ISOLATED" | "MAIN";
}

// ============================================================================
// Workspace Types
// ============================================================================

/**
 * Workspace metadata
 */
export interface WorkspaceInfo {
  /** Workspace name (folder name) */
  name: string;
  /** Absolute path to workspace root */
  path: string;
  /** Whether workspace is a git repository */
  isGitRepository: boolean;
  /** Last accessed timestamp */
  lastAccessed?: number;
}

/**
 * File system entry
 */
export interface FsEntry {
  /** Entry name */
  name: string;
  /** Relative path from workspace root */
  path: string;
  /** Entry type */
  type: "file" | "directory" | "symlink";
  /** File size in bytes (for files) */
  size?: number;
  /** Last modified timestamp */
  mtime?: number;
  /** Whether entry is ignored */
  ignored?: boolean;
  /** Whether entry is binary (for files) */
  binary?: boolean;
}
