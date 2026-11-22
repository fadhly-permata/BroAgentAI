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
  GIT_NOT_REPO = -32015,
  GIT_AUTH_FAILED = -32016,
  GIT_CONFLICT = -32017,
  GIT_OPERATION_FAILED = -32018,
  MCP_UNTRUSTED = -32019,
  MCP_NOT_READY = -32020,
  MCP_ERROR = -32021,
  NOT_ALLOWED = -32022,
  SHELL_NOT_AVAILABLE = -32023,
  SHELL_START_FAILED = -32024,
  SHELL_UNSUPPORTED = -32025,
  SHELL_CWD_INVALID = -32026,
  SHELL_BUSY = -32027,
  DEPENDENCY_APPROVAL_REQUIRED = -32028,
  DEPENDENCY_INSTALL_FAILED = -32029,
}

export const SHELL_ERROR_CODES = [
  ErrorCode.SHELL_NOT_AVAILABLE,
  ErrorCode.SHELL_START_FAILED,
  ErrorCode.SHELL_UNSUPPORTED,
  ErrorCode.SHELL_CWD_INVALID,
  ErrorCode.SHELL_BUSY,
] as const;

export type ShellErrorCode = (typeof SHELL_ERROR_CODES)[number];

export function isShellErrorCode(code: number): code is ShellErrorCode {
  return (SHELL_ERROR_CODES as readonly number[]).includes(code);
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

// ============================================================================
// Protocol v2
// ============================================================================

export const PROTOCOL_VERSION_V2 = 2;
export const SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;
export const DEPRECATED_PROTOCOL_VERSIONS = [1] as const;

export interface ProtocolInfo {
  version: number;
  supported: number[];
  deprecated: number[];
}

export interface DetectedShellInfo {
  family: string;
  environment: string;
  file: string;
  platform: string;
  arch: string;
}

export interface ShellFallbackInfo {
  family: string;
  file: string;
}

export interface ShellInfoReport extends DetectedShellInfo {
  version: string;
  encoding: "utf8";
  fallbacks: ShellFallbackInfo[];
}

export interface EnvironmentInfo {
  pathSource: "PATH" | "Path" | "none";
  pathOrigin: "inherited" | "none";
  pathEntryCount: number;
  pathEntryKinds: {
    absolute: number;
    relative: number;
    missing: number;
  };
  profilePolicy: "no-profile";
  shellProfilesLoaded: false;
  credentialKeysDetected: number;
  credentialsExposed: false;
}

export interface ApprovalContext {
  command: string;
  shellFamily: string;
  environment: string;
  workspacePath: string;
  cwd: string;
  risk: string;
}

export interface ExecutionTruncation {
  stdout: boolean;
  stderr: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  limitBytes: number;
}

export interface ExecutionResult {
  executionId: string;
  sessionId?: string;
  taskId?: string;
  shell: string;
  shellFamily: string;
  environment: string;
  cwd: string;
  exitCode: number | null;
  terminationReason: "completed" | "timeout" | "cancelled" | "signal" | "error";
  stdout: string;
  stderr: string;
  encoding: "utf8";
  timedOut: boolean;
  truncated: boolean;
  truncation: ExecutionTruncation;
  timeoutMs: number;
  durationMs: number;
}

export interface ExecutionHistoryEntry {
  executionId: string;
  sessionId?: string;
  taskId?: string;
  command: string;
  shell: string;
  cwd: string;
  startedAt: string;
  durationMs: number;
  exitCode: number | null;
  terminationReason: ExecutionResult["terminationReason"];
  timedOut: boolean;
  truncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
}

export interface ShellHistory {
  entries: ExecutionHistoryEntry[];
  total: number;
  limit: number;
}

export interface ShellOutput {
  executionId: string;
  stream: "stdout" | "stderr";
  offsetBytes: number;
  nextOffsetBytes: number;
  data: string;
  truncated: boolean;
  totalBytes: number;
}

export interface ShellStatus {
  maxConcurrency: number;
  active: string[];
  archived: number;
  historyCount: number;
  background: string[];
}

export interface BackgroundExecution {
  executionId: string;
  sessionId?: string;
  taskId?: string;
  command: string;
  status: "running" | "completed" | "failed" | "cancelled" | "timeout";
  shellFamily: string;
  environment: string;
  cwd: string;
  startedAt: string;
  timeoutMs: number;
  result?: ExecutionResult;
  error?: string;
}

export type ShellStartResult = BackgroundExecution;
export type ShellPollResult = BackgroundExecution;

export type WorkflowWhen = "always" | "success" | "failure";
export interface WorkflowExpectation {
  exitCode?: number;
  stdoutContains?: string;
  stderrContains?: string;
  notStdoutContains?: string;
  notStderrContains?: string;
}
export interface WorkflowStepInput {
  id: string;
  command: string;
  cwd?: string;
  timeoutMs?: number;
  when?: WorkflowWhen;
  retries?: number;
  retryDelayMs?: number;
  expect?: WorkflowExpectation;
}
export interface WorkflowStep extends WorkflowStepInput {
  when: WorkflowWhen;
  retries: number;
  retryDelayMs: number;
}
export interface WorkflowLimits {
  maxSteps: number;
  maxRetries: number;
  maxAttempts: number;
  maxRetryDelayMs: number;
}
export interface WorkflowPlan {
  planId: string;
  steps: WorkflowStep[];
  declaredCommands: string[];
  limits: WorkflowLimits;
}
export interface WorkflowAttempt {
  executionId: string;
  exitCode: number | null;
  terminationReason: ExecutionResult["terminationReason"];
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  passed: boolean;
  failureReason?: string;
}
export interface WorkflowStepResult {
  id: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  when: WorkflowWhen;
  attempts: WorkflowAttempt[];
}
export interface WorkflowRunResult {
  runId: string;
  planId: string;
  status: "completed" | "recovered" | "failed";
  sessionId?: string;
  taskId?: string;
  startedAt: string;
  durationMs: number;
  summary: { total: number; passed: number; failed: number; skipped: number; retries: number };
  steps: WorkflowStepResult[];
}

export type FallbackDomain = "fs" | "git";
export interface FallbackSafety {
  confinedCwd: true;
  noShellOverride: true;
  requiresApprovalIfWrite: boolean;
  typedPrimitiveRetained: true;
  benchmarkGate: "block-native-tool-removal";
}
export interface FallbackPlan {
  domain: FallbackDomain;
  operation: string;
  status: "typed-primitive" | "shell-long-tail";
  typedPrimitive: string | null;
  shellCommand: string | null;
  shellFamily: string;
  environment: string;
  cwd: string;
  reason: string;
  safety: FallbackSafety;
}

export type CapabilityKind = "runtime" | "cli" | "package-manager" | "project-script" | "package";
export type CapabilityStatus = "available" | "missing";
export type DependencyNeed = "json" | "search" | "http" | "git" | "build" | "python";
export type DependencyScope = "temporary" | "project" | "global";
export type DependencyManager = "npm" | "pip";

export interface CapabilityInfo {
  name: string;
  kind: CapabilityKind;
  status: CapabilityStatus;
  version?: string;
  source: "environment" | "project";
  satisfies: DependencyNeed[];
}

export interface DependencyPolicy {
  preferExisting: true;
  autoInstall: false;
  explicitApprovalForInstall: true;
  sideEffectsRecorded: true;
  order: string[];
}

export interface CapabilityReport {
  generatedAt: string;
  environment: EnvironmentInfo;
  capabilities: CapabilityInfo[];
  checked: number;
  limit: number;
  policy: DependencyPolicy;
}

export interface CapabilityRecommendation {
  need: DependencyNeed;
  existing: string[];
  installAllowed: boolean;
  options: Array<{ package: string; manager: DependencyManager; reason: string }>;
  policy: DependencyPolicy;
}

export interface DependencyPlan {
  requestId: string;
  need: DependencyNeed;
  package: string;
  manager: DependencyManager;
  scope: DependencyScope;
  command: string;
  reason: string;
  declaredSideEffects: string[];
  existingCapability: string | null;
  explicitApprovalRequired: true;
}

export interface DependencySideEffect {
  id: string;
  requestId: string;
  need: DependencyNeed;
  package: string;
  manager: DependencyManager;
  scope: DependencyScope;
  command: string;
  status: "installed" | "failed";
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
  declaredSideEffects: string[];
  observedSideEffects: string[];
  approved: true;
  sessionId?: string;
  taskId?: string;
}

export interface DependencyHistory {
  entries: DependencySideEffect[];
  total: number;
  limit: number;
}

export interface DependencyInstallResult {
  plan: DependencyPlan;
  executionId: string;
  status: "installed" | "failed";
  exitCode: number | null;
  sideEffectId: string;
  declaredSideEffects: string[];
  observedSideEffects: string[];
  stdout: string;
  stderr: string;
  error?: string;
}
