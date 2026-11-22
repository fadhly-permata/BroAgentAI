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
  SHELL_NOT_AVAILABLE: -32023,
  SHELL_START_FAILED: -32024,
  SHELL_UNSUPPORTED: -32025,
  SHELL_CWD_INVALID: -32026,
  SHELL_BUSY: -32027,
  DEPENDENCY_APPROVAL_REQUIRED: -32028,
  DEPENDENCY_INSTALL_FAILED: -32029,
} as const;

/** Union of every {@link ErrorCode} value. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

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

/** Protocol compatibility advertised by the host. */
export interface ProtocolInfo {
  version: number;
  supported: number[];
  deprecated: number[];
}

/** Deterministically detected shell; the only source of shell selection. */
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

/** Context bound into an approval so shell/cwd changes cannot reuse it. */
export interface ApprovalContext {
  command: string;
  shellFamily: string;
  environment: string;
  workspacePath: string;
  cwd: string;
  risk: string;
}

/** Per-stream output accounting for a one-shot execution. */
export interface ExecutionTruncation {
  stdout: boolean;
  stderr: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  limitBytes: number;
}

/** Stable result contract for `shell.run`, also usable by future executors. */
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

export type AdditionalShellId = "cmd" | "fish" | "nushell" | "wsl" | "git-bash";
export interface AdditionalShellEvaluation {
  id: AdditionalShellId;
  available: boolean;
  file: string | null;
  environment: string;
  status: "deferred";
  reason: string;
  requirements: string[];
}
export interface AdditionalShellPlan {
  generatedAt: string;
  enabled: false;
  policy: "evaluation-only";
  mvpGate: "B1.7-benchmark-and-MVP-matrix";
  environments: AdditionalShellEvaluation[];
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
