/**
 * Workspace registry for the BrowserAgent bridge.
 *
 * Owns the host app config (`config.json`) that stores the workspace list, the
 * active workspace, and host settings. Writes are atomic (temp file + rename)
 * so a crash mid-write can never leave a truncated config behind.
 *
 * Every workspace path is stored as a realpath: symlinks are resolved once on
 * add so that duplicate detection and path confinement compare canonical paths.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

import { ErrorCode } from "./rpc.ts";
import type { AppConfig, WorkspaceInfo } from "./rpc.ts";

/** Environment variable that overrides the config directory (dev + tests). */
export const CONFIG_DIR_ENV = "BROWSERAGENT_CONFIG_DIR";

/** File name of the host app config inside the config directory. */
export const CONFIG_FILE_NAME = "config.json";

/** Default directories ignored by the explorer, in match order. */
export const DEFAULT_IGNORE: string[] = [
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
];

/** Maximum size of a readable file, in bytes (512 KB). */
export const DEFAULT_MAX_FILE_BYTES = 512 * 1024;

/** Raised when a workspace operation cannot be completed. */
export class WorkspaceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

/**
 * Resolve the host config directory for the current platform.
 *
 * `BROWSERAGENT_CONFIG_DIR` wins so tests and parallel dev sessions never
 * touch the real user profile.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONFIG_DIR_ENV];
  if (override && override.trim() !== "") return resolve(override.trim());

  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "BroAgentAI");
    case "darwin":
      return join(home, "Library", "Application Support", "BroAgentAI");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "browseragent");
  }
}

/**
 * Derive a stable workspace id from a canonical path.
 *
 * The id is a 16 hex-character prefix of the SHA-256 digest of the realpath,
 * which keeps ids short, collision-resistant, and independent of the display
 * name (the user may rename a workspace without changing its identity).
 */
export function workspaceId(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 16);
}

/**
 * Expand a user-supplied path and resolve it to an existing directory.
 *
 * Accepts `~` prefixes and relative paths. Returns the canonical realpath.
 * Throws {@link WorkspaceError} with `WORKSPACE_INVALID` when the path does not
 * exist, is not a directory, or cannot be read.
 */
export function validateWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new WorkspaceError(ErrorCode.WORKSPACE_INVALID, "workspace path must be a non-empty string");
  }

  let expanded = input.trim();
  if (expanded === "~" || expanded.startsWith("~/")) {
    expanded = join(homedir(), expanded.slice(1));
  }

  const absolute = resolve(expanded);

  let stat;
  try {
    stat = statSync(absolute);
  } catch {
    throw new WorkspaceError(ErrorCode.WORKSPACE_INVALID, `path does not exist: ${absolute}`);
  }

  if (!stat.isDirectory()) {
    throw new WorkspaceError(ErrorCode.WORKSPACE_INVALID, `path is not a directory: ${absolute}`);
  }

  try {
    return realpathSync(absolute);
  } catch {
    throw new WorkspaceError(ErrorCode.WORKSPACE_INVALID, `path could not be resolved: ${absolute}`);
  }
}

/** Options accepted by {@link WorkspaceStore}. */
export interface WorkspaceStoreOptions {
  /** Config directory override. Defaults to {@link resolveConfigDir}. */
  configDir?: string;
  /** Clock used for `lastOpenedAt` timestamps. Injectable for tests. */
  now?: () => Date;
}

/**
 * Persistent workspace registry backed by the host app config file.
 *
 * All mutating methods persist immediately, so the panel can rely on the
 * filesystem rather than on in-memory state that a crash would lose.
 */
export class WorkspaceStore {
  readonly #configDir: string;
  readonly #configPath: string;
  readonly #now: () => Date;
  #config: AppConfig;

  constructor(options: WorkspaceStoreOptions = {}) {
    this.#configDir = options.configDir ?? resolveConfigDir();
    this.#configPath = join(this.#configDir, CONFIG_FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#config = this.#load();
  }

  /** Absolute path of the config directory. */
  get configDir(): string {
    return this.#configDir;
  }

  /** Absolute path of the host app config file. */
  get configPath(): string {
    return this.#configPath;
  }

  /** All registered workspaces, most recently opened first. */
  list(): WorkspaceInfo[] {
    return [...this.#config.workspaces];
  }

  /** The active workspace, or `null` when none is selected. */
  active(): WorkspaceInfo | null {
    if (!this.#config.activeWorkspaceId) return null;
    return this.#config.workspaces.find((w) => w.id === this.#config.activeWorkspaceId) ?? null;
  }

  /** Look up a workspace by id. */
  get(id: string): WorkspaceInfo | null {
    return this.#config.workspaces.find((w) => w.id === id) ?? null;
  }

  /**
   * Register a workspace and make it active.
  
   * Adding an existing path is not an error: the entry is focused (its
   * `lastOpenedAt` is refreshed) and returned, which matches the panel's
   * "duplicate focuses the existing workspace" behaviour.
   */
  add(pathInput: string, name?: string): WorkspaceInfo {
    const realPath = validateWorkspacePath(pathInput);
    const id = workspaceId(realPath);
    const existing = this.#config.workspaces.find((w) => w.id === id);

    if (existing) {
      existing.lastOpenedAt = this.#now().toISOString();
      this.#config.activeWorkspaceId = id;
      this.#sort();
      this.#save();
      return { ...existing };
    }

    const entry: WorkspaceInfo = {
      id,
      name: name?.trim() || basenameOf(realPath),
      path: realPath,
      lastOpenedAt: this.#now().toISOString(),
    };

    this.#config.workspaces.push(entry);
    this.#config.activeWorkspaceId = id;
    this.#sort();
    this.#save();
    return { ...entry };
  }

  /**
   * Remove a workspace from the registry.
   *
   * Files on disk are never touched. Removing the active workspace activates
   * the most recently opened remaining workspace, or none when the list empties.
   */
  remove(id: string): { removed: WorkspaceInfo | null; activeWorkspaceId: string | null } {
    const index = this.#config.workspaces.findIndex((w) => w.id === id);
    if (index === -1) {
      throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, `unknown workspace id: ${id}`);
    }

    const [removed] = this.#config.workspaces.splice(index, 1);
    if (this.#config.activeWorkspaceId === id) {
      this.#config.activeWorkspaceId = this.#config.workspaces[0]?.id ?? null;
    }
    this.#save();
    return { removed: removed ? { ...removed } : null, activeWorkspaceId: this.#config.activeWorkspaceId };
  }

  /** Make a workspace active. Throws `WORKSPACE_NOT_FOUND` for unknown ids. */
  setActive(id: string): WorkspaceInfo {
    const entry = this.#config.workspaces.find((w) => w.id === id);
    if (!entry) {
      throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, `unknown workspace id: ${id}`);
    }
    entry.lastOpenedAt = this.#now().toISOString();
    this.#config.activeWorkspaceId = id;
    this.#sort();
    this.#save();
    return { ...entry };
  }

  /** Rename the display name of a workspace without touching its path. */
  rename(id: string, name: string): WorkspaceInfo {
    const entry = this.#config.workspaces.find((w) => w.id === id);
    if (!entry) {
      throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, `unknown workspace id: ${id}`);
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      throw new WorkspaceError(ErrorCode.WORKSPACE_INVALID, "workspace name must not be empty");
    }
    entry.name = trimmed;
    this.#save();
    return { ...entry };
  }

  /** Effective host settings. */
  settings(): AppConfig["settings"] {
    return { ...this.#config.settings, ignore: [...this.#config.settings.ignore] };
  }

  /** Replace the host ignore list. */
  setIgnore(patterns: string[]): string[] {
    this.#config.settings.ignore = patterns.map((p) => p.trim()).filter((p) => p !== "");
    this.#save();
    return [...this.#config.settings.ignore];
  }

  /** Read the config file, returning defaults when it is missing or unreadable. */
  #load(): AppConfig {
    const fallback: AppConfig = {
      version: 1,
      activeWorkspaceId: null,
      workspaces: [],
      settings: { ignore: [...DEFAULT_IGNORE], maxFileBytes: DEFAULT_MAX_FILE_BYTES },
    };

    if (!existsSync(this.#configPath)) return fallback;

    try {
      const raw = readFileSync(this.#configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppConfig>;
      return {
        version: 1,
        activeWorkspaceId: typeof parsed.activeWorkspaceId === "string" ? parsed.activeWorkspaceId : null,
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces.filter(isWorkspaceInfo) : [],
        settings: {
          ignore: Array.isArray(parsed.settings?.ignore) && parsed.settings.ignore.length > 0
            ? parsed.settings.ignore.filter((p): p is string => typeof p === "string")
            : [...DEFAULT_IGNORE],
          maxFileBytes: typeof parsed.settings?.maxFileBytes === "number" && parsed.settings.maxFileBytes > 0
            ? parsed.settings.maxFileBytes
            : DEFAULT_MAX_FILE_BYTES,
        },
      };
    } catch {
      // A corrupted config must never stop the host from starting: fall back to
      // defaults and let the user re-add workspaces from the panel.
      return fallback;
    }
  }

  /** Persist the config atomically (temp file + rename). */
  #save(): void {
    mkdirSync(this.#configDir, { recursive: true });
    const tempPath = `${this.#configPath}.${process.pid}.tmp`;
    try {
      writeFileSync(tempPath, `${JSON.stringify(this.#config, null, 2)}\n`, "utf8");
      renameSync(tempPath, this.#configPath);
    } catch (error) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best effort cleanup; the original error is the one worth reporting.
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new WorkspaceError(ErrorCode.INTERNAL_ERROR, `failed to save config: ${reason}`);
    }
  }

  /** Keep the workspace list ordered by most recently opened first. */
  #sort(): void {
    this.#config.workspaces.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }
}

/** Type guard for entries read from the config file. */
function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<WorkspaceInfo>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.path === "string" &&
    typeof entry.lastOpenedAt === "string"
  );
}

/** Last path segment of a normalized path, used as the default display name. */
function basenameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index === -1 ? normalized : normalized.slice(index + 1);
}
