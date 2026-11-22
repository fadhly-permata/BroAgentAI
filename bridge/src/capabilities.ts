import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";

import { redactSecrets } from "./context.ts";
import { confinePath } from "./fs.ts";
import { discoverEnvironment, refreshEnvironment } from "./environment.ts";
import { ErrorCode } from "./rpc.ts";
import type {
  CapabilityInfo,
  CapabilityKind,
  CapabilityRecommendation,
  CapabilityReport,
  DependencyHistory,
  DependencyInstallResult,
  DependencyManager,
  DependencyNeed,
  DependencyPlan,
  DependencyPolicy,
  DependencyScope,
  DependencySideEffect,
  EnvironmentInfo,
  ExecutionResult,
} from "./rpc.ts";
import { assertNoShellOverride, executionTag, runShell } from "./shell.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const MAX_CAPABILITIES = 24;
export const MAX_DEPENDENCY_HISTORY = 32;
export const MAX_DEPENDENCY_PLANS = 16;
export const MAX_INSTALL_TIMEOUT_MS = 5 * 60_000;

const PROBE_TIMEOUT_MS = 1500;
const MAX_VERSION_CHARS = 80;
const MAX_INSTALL_OUTPUT_CHARS = 4000;
const REQUEST_ID_RE = /^[a-f0-9]{16}$/;
const PACKAGE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const SCRIPT_RE = /^[A-Za-z0-9_:.-]{1,40}$/;

type Probe = (file: string) => string | null;

interface CatalogEntry {
  name: string;
  kind: CapabilityKind;
  files: string[];
  satisfies: DependencyNeed[];
}

interface OptionEntry {
  package: string;
  manager: DependencyManager;
  reason: string;
}

interface SnapshotEntry {
  path: string;
  exists: boolean;
  size: number;
  mtimeMs: number;
}

export interface DiscoverCapabilitiesOptions {
  refresh?: boolean;
  probe?: Probe;
}

export interface RecommendCapabilitiesOptions extends DiscoverCapabilitiesOptions {
  report?: CapabilityReport;
}

export interface PlanDependencyOptions extends DiscoverCapabilitiesOptions {}

export interface InstallDependencyOptions {
  execute?: (plan: DependencyPlan, params: Record<string, unknown>, store: WorkspaceStore) => Promise<ExecutionResult>;
}

const NEEDS: DependencyNeed[] = ["json", "search", "http", "git", "build", "python"];
const SCOPES: DependencyScope[] = ["temporary", "project", "global"];

const CAPABILITY_CATALOG: CatalogEntry[] = [
  { name: "node", kind: "runtime", files: ["node"], satisfies: ["json", "http", "build"] },
  { name: "npm", kind: "package-manager", files: ["npm", "npm.cmd"], satisfies: ["build"] },
  { name: "npx", kind: "package-manager", files: ["npx", "npx.cmd"], satisfies: ["build"] },
  { name: "python", kind: "runtime", files: ["python", "python3", "py"], satisfies: ["json", "http", "python"] },
  { name: "git", kind: "cli", files: ["git", "git.exe"], satisfies: ["git"] },
  { name: "jq", kind: "cli", files: ["jq", "jq.exe"], satisfies: ["json"] },
  { name: "rg", kind: "cli", files: ["rg", "rg.exe"], satisfies: ["search"] },
  { name: "grep", kind: "cli", files: ["grep"], satisfies: ["search"] },
  { name: "curl", kind: "cli", files: ["curl", "curl.exe"], satisfies: ["http"] },
  { name: "tar", kind: "cli", files: ["tar", "tar.exe"], satisfies: ["build"] },
  { name: "make", kind: "cli", files: ["make"], satisfies: ["build"] },
];

const DEPENDENCY_CATALOG: Record<DependencyNeed, OptionEntry[]> = {
  json: [{ package: "node-jq", manager: "npm", reason: "JSON querying when no runtime or jq is available." }],
  search: [{ package: "ripgrep", manager: "npm", reason: "Fast recursive search when no search utility is available." }],
  http: [{ package: "httpie", manager: "pip", reason: "HTTP requests when curl and runtime APIs are unavailable." }],
  git: [],
  build: [{ package: "esbuild", manager: "npm", reason: "Build and bundling when project scripts and runtimes are insufficient." }],
  python: [{ package: "requests", manager: "pip", reason: "HTTP helper when Python standard library is insufficient." }],
};

export const DEPENDENCY_POLICY: DependencyPolicy = {
  preferExisting: true,
  autoInstall: false,
  explicitApprovalForInstall: true,
  sideEffectsRecorded: true,
  order: ["shell-builtin", "runtime-api", "installed", "project", "temporary", "persistent"],
};

const WATCHED_PATHS = [
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "node_modules",
  ".broagentai-deps",
  "requirements.txt",
  "pyproject.toml",
];

const plans = new Map<string, DependencyPlan>();
const dependencyEvents: DependencySideEffect[] = [];
let capabilitiesCache: { key: string; report: CapabilityReport } | null = null;

function asParams(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "params must be an object");
  }
  return params as Record<string, unknown>;
}

function defaultProbe(file: string): string | null {
  const windows = process.platform === "win32";
  const command = windows ? process.env.ComSpec || "cmd.exe" : file;
  const args = windows ? ["/d", "/s", "/c", `"${file}" --version`] : ["--version"];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  const first = String(result.stdout || result.stderr || "available")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return (first ?? "available").slice(0, MAX_VERSION_CHARS);
}

function projectScripts(store: WorkspaceStore): CapabilityInfo[] {
  const active = store.active();
  if (!active) return [];
  try {
    const path = confinePath(active.path, "package.json");
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, "utf8");
    if (raw.length > 64 * 1024) return [];
    const scripts = JSON.parse(raw)?.scripts;
    if (!scripts || typeof scripts !== "object") return [];
    return Object.keys(scripts)
      .filter((name) => SCRIPT_RE.test(name))
      .slice(0, 8)
      .map((name) => ({
        name: `script:${name}`,
        kind: "project-script" as const,
        status: "available" as const,
        source: "project" as const,
        satisfies: ["build" as const],
      }));
  } catch {
    return [];
  }
}

function cacheKey(store: WorkspaceStore, environment: EnvironmentInfo): string {
  return JSON.stringify({
    platform: process.platform,
    workspace: store.active()?.path ?? "",
    environment,
  });
}

export function discoverCapabilities(store: WorkspaceStore, options: DiscoverCapabilitiesOptions = {}): CapabilityReport {
  const custom = options.probe !== undefined;
  const environment = options.refresh ? refreshEnvironment() : discoverEnvironment();
  const key = cacheKey(store, environment);
  if (!custom && !options.refresh && capabilitiesCache?.key === key) return capabilitiesCache.report;

  const probe = options.probe ?? defaultProbe;
  const environmentCapabilities: CapabilityInfo[] = CAPABILITY_CATALOG.map((entry) => {
    for (const file of entry.files) {
      const version = probe(file);
      if (version !== null) {
        return {
          name: entry.name,
          kind: entry.kind,
          status: "available",
          version,
          source: "environment",
          satisfies: entry.satisfies,
        };
      }
    }
    return {
      name: entry.name,
      kind: entry.kind,
      status: "missing",
      source: "environment",
      satisfies: entry.satisfies,
    };
  });
  const scripts = projectScripts(store);
  const checked = environmentCapabilities.length + scripts.length;
  const capabilities = [
    ...environmentCapabilities.filter((item) => item.status === "available"),
    ...scripts,
    ...environmentCapabilities.filter((item) => item.status === "missing"),
  ].slice(0, MAX_CAPABILITIES);

  const report: CapabilityReport = {
    generatedAt: new Date().toISOString(),
    environment,
    capabilities,
    checked,
    limit: MAX_CAPABILITIES,
    policy: DEPENDENCY_POLICY,
  };
  if (!custom) capabilitiesCache = { key, report };
  return report;
}

function parseNeed(value: unknown): DependencyNeed {
  if (typeof value !== "string" || !NEEDS.includes(value as DependencyNeed)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `need must be one of: ${NEEDS.join(", ")}`);
  }
  return value as DependencyNeed;
}

function parseScope(value: unknown): DependencyScope {
  if (typeof value !== "string" || !SCOPES.includes(value as DependencyScope)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `scope must be one of: ${SCOPES.join(", ")}`);
  }
  return value as DependencyScope;
}

function parsePackage(value: unknown): string {
  if (typeof value !== "string" || !PACKAGE_RE.test(value)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "package must be an allowlisted package name");
  }
  return value;
}

function parseReason(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 4 || value.length > 200) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "reason must be 4-200 characters");
  }
  return value.trim();
}

function parseRequestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID_RE.test(value)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "requestId is invalid");
  }
  return value;
}

export function recommendCapabilities(need: unknown, store: WorkspaceStore, options: RecommendCapabilitiesOptions = {}): CapabilityRecommendation {
  const parsed = parseNeed(need);
  const report = options.report ?? discoverCapabilities(store, options);
  const existing = report.capabilities
    .filter((item) => item.status === "available" && item.satisfies.includes(parsed))
    .map((item) => item.name);
  const catalog = DEPENDENCY_CATALOG[parsed].map((option) => ({ ...option }));
  return {
    need: parsed,
    existing,
    installAllowed: existing.length === 0 && catalog.length > 0,
    options: catalog,
    policy: DEPENDENCY_POLICY,
  };
}

function commandFor(manager: DependencyManager, packageName: string, scope: DependencyScope): string {
  if (manager === "npm") {
    if (scope === "temporary") return `npm install --no-save --package-lock=false ${packageName}`;
    if (scope === "project") return `npm install --save ${packageName}`;
    return `npm install -g ${packageName}`;
  }
  if (scope === "temporary") return `python -m pip install --target .broagentai-deps ${packageName}`;
  if (scope === "project") return `python -m pip install ${packageName}`;
  return `python -m pip install --user ${packageName}`;
}

function sideEffectsFor(manager: DependencyManager, scope: DependencyScope): string[] {
  if (manager === "npm") {
    if (scope === "temporary") return ["node_modules", "npm cache"];
    if (scope === "project") return ["package.json", "package-lock.json", "node_modules"];
    return ["global npm prefix"];
  }
  if (scope === "temporary") return [".broagentai-deps", "pip cache"];
  if (scope === "project") return ["active Python environment"];
  return ["user site-packages", "pip cache"];
}

export function planDependency(store: WorkspaceStore, params: unknown, options: PlanDependencyOptions = {}): DependencyPlan {
  const p = asParams(params);
  const need = parseNeed(p.need);
  const recommendation = recommendCapabilities(need, store, options);
  if (recommendation.existing.length > 0 && p.force !== true) {
    throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `existing capability already available: ${recommendation.existing.join(", ")}`);
  }
  if (recommendation.options.length === 0) {
    throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `no dependency option is available for ${need}`);
  }

  const selected = p.package === undefined
    ? recommendation.options[0]!
    : recommendation.options.find((option) => option.package === parsePackage(p.package));
  if (!selected) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "package is not available for this need");
  }
  const scope = parseScope(p.scope ?? "temporary");
  const reason = parseReason(p.reason);
  const command = commandFor(selected.manager, selected.package, scope);
  const requestId = createHash("sha256")
    .update(JSON.stringify([need, selected.package, selected.manager, scope, command, reason]))
    .digest("hex")
    .slice(0, 16);
  const plan: DependencyPlan = {
    requestId,
    need,
    package: selected.package,
    manager: selected.manager,
    scope,
    command,
    reason,
    declaredSideEffects: sideEffectsFor(selected.manager, scope),
    existingCapability: recommendation.existing[0] ?? null,
    explicitApprovalRequired: true,
  };
  plans.set(requestId, plan);
  while (plans.size > MAX_DEPENDENCY_PLANS) {
    const oldest = plans.keys().next().value;
    if (oldest === undefined) break;
    plans.delete(oldest);
  }
  return plan;
}

export function getDependencyPlan(requestId: unknown): DependencyPlan | null {
  if (typeof requestId !== "string") return null;
  return plans.get(requestId) ?? null;
}

function snapshotWorkspace(store: WorkspaceStore): SnapshotEntry[] {
  const active = store.active();
  if (!active) return [];
  return WATCHED_PATHS.map((path) => {
    try {
      const absolute = confinePath(active.path, path);
      if (!existsSync(absolute)) return { path, exists: false, size: 0, mtimeMs: 0 };
      const stat = statSync(absolute);
      return { path, exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return { path, exists: false, size: 0, mtimeMs: 0 };
    }
  });
}

function changedPaths(before: SnapshotEntry[], after: SnapshotEntry[]): string[] {
  const previous = new Map(before.map((entry) => [entry.path, entry]));
  return after
    .filter((entry) => {
      const old = previous.get(entry.path);
      if (!old) return true;
      return old.exists !== entry.exists || old.size !== entry.size || old.mtimeMs !== entry.mtimeMs;
    })
    .map((entry) => entry.path);
}

function clip(value: string): string {
  const redacted = redactSecrets(value);
  return redacted.length <= MAX_INSTALL_OUTPUT_CHARS ? redacted : redacted.slice(0, MAX_INSTALL_OUTPUT_CHARS) + "\n... (truncated)";
}

export async function installDependency(store: WorkspaceStore, params: unknown, options: InstallDependencyOptions = {}): Promise<DependencyInstallResult> {
  const p = asParams(params);
  assertNoShellOverride(p);
  const requestId = parseRequestId(p.requestId);
  const plan = plans.get(requestId);
  if (!plan) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "unknown dependency requestId");
  if (p.approved !== true) {
    throw new WorkspaceError(ErrorCode.DEPENDENCY_APPROVAL_REQUIRED, "dependency installation requires explicit approval");
  }
  if (!store.active()) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");

  const sessionId = executionTag(p.sessionId, "sessionId");
  const taskId = executionTag(p.taskId, "taskId");
  const before = snapshotWorkspace(store);
  const started = Date.now();
  let result: ExecutionResult | undefined;
  let error: string | undefined;
  try {
    const execute = options.execute ?? ((chosen: DependencyPlan, callParams: Record<string, unknown>) =>
      runShell(store, chosen.command, undefined, MAX_INSTALL_TIMEOUT_MS, callParams));
    result = await execute(plan, p, store);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const observedSideEffects = changedPaths(before, snapshotWorkspace(store));
  const status = !error && result?.exitCode === 0 ? "installed" : "failed";
  const sideEffectId = randomUUID();
  const entry: DependencySideEffect = {
    id: sideEffectId,
    requestId,
    need: plan.need,
    package: plan.package,
    manager: plan.manager,
    scope: plan.scope,
    command: clip(plan.command),
    status,
    exitCode: result?.exitCode ?? null,
    startedAt: new Date(started).toISOString(),
    durationMs: result?.durationMs ?? (Date.now() - started),
    declaredSideEffects: plan.declaredSideEffects,
    observedSideEffects,
    approved: true,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
  };
  dependencyEvents.push(entry);
  while (dependencyEvents.length > MAX_DEPENDENCY_HISTORY) dependencyEvents.shift();

  return {
    plan,
    executionId: result?.executionId ?? sideEffectId,
    status,
    exitCode: result?.exitCode ?? null,
    sideEffectId,
    declaredSideEffects: plan.declaredSideEffects,
    observedSideEffects,
    stdout: clip(result?.stdout ?? ""),
    stderr: clip(error ?? result?.stderr ?? ""),
    ...(error !== undefined ? { error: clip(error) } : {}),
  };
}

export function dependencyHistory(params: unknown = {}): DependencyHistory {
  const p = asParams(params);
  const limit = typeof p.limit === "number" && Number.isFinite(p.limit)
    ? Math.max(1, Math.min(Math.floor(p.limit), MAX_DEPENDENCY_HISTORY))
    : MAX_DEPENDENCY_HISTORY;
  const matching = dependencyEvents.filter((entry) =>
    (p.need === undefined || entry.need === p.need) &&
    (p.scope === undefined || entry.scope === p.scope));
  return {
    entries: matching.slice(-limit).reverse(),
    total: matching.length,
    limit: MAX_DEPENDENCY_HISTORY,
  };
}

export function clearDependencyHistory(params: unknown = {}): { cleared: number } {
  const p = asParams(params);
  const before = dependencyEvents.length;
  for (let index = dependencyEvents.length - 1; index >= 0; index--) {
    const entry = dependencyEvents[index]!;
    if ((p.need === undefined || entry.need === p.need) &&
        (p.scope === undefined || entry.scope === p.scope)) {
      dependencyEvents.splice(index, 1);
    }
  }
  return { cleared: before - dependencyEvents.length };
}
