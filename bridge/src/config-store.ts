import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_WORKSPACES,
  createDefaultHostConfig,
  isRecord,
  type HostConfig,
  type HostSettings,
  type LogLevel,
  type Workspace,
  type WorkspaceAddResult,
  type WorkspaceListResult,
  type WorkspaceValidation,
} from "@browseragent/shared";
import type { Logger } from "./logger.js";
import { RpcFailure } from "./rpc-error.js";

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set(["error", "warn", "info", "debug"]);

export class ConfigStore {
  private readonly configPath: string;
  private readonly logger?: Logger;
  private cached: HostConfig | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(configPath: string, logger?: Logger) {
    this.configPath = configPath;
    this.logger = logger;
  }

  get path(): string {
    return this.configPath;
  }

  async listWorkspaces(): Promise<WorkspaceListResult> {
    const config = await this.getConfig();
    return {
      workspaces: sortWorkspaces(config.workspaces),
      activeWorkspaceId: config.activeWorkspaceId,
    };
  }

  async getActiveWorkspace(): Promise<Workspace | null> {
    const config = await this.getConfig();
    if (!config.activeWorkspaceId) return null;
    return config.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ?? null;
  }

  async addWorkspace(inputPath: string, name?: string): Promise<WorkspaceAddResult> {
    return this.enqueue(async () => {
      const config = await this.getConfig();
      const validation = await this.validateWorkspacePath(inputPath);

      if (!validation.exists) {
        throw new RpcFailure("PATH_NOT_FOUND", validation.error ?? "Workspace path does not exist");
      }
      if (!validation.isDirectory || !validation.path) {
        throw new RpcFailure("NOT_A_DIRECTORY", "Workspace path must be a directory");
      }

      const displayName = normalizeName(name, validation.path);
      const now = new Date().toISOString();
      const existing = config.workspaces.find((workspace) => samePath(workspace.path, validation.path as string));

      if (existing) {
        existing.lastOpenedAt = now;
        if (name !== undefined) existing.name = displayName;
        config.activeWorkspaceId = existing.id;
        await this.persist(config);
        return { workspace: existing, activeWorkspaceId: existing.id, created: false };
      }

      if (config.workspaces.length >= MAX_WORKSPACES) {
        throw new RpcFailure("BAD_REQUEST", `Workspace limit reached (${MAX_WORKSPACES})`);
      }

      const workspace: Workspace = {
        id: workspaceIdFor(validation.path),
        name: displayName,
        path: validation.path,
        lastOpenedAt: now,
      };

      config.workspaces.push(workspace);
      config.activeWorkspaceId = workspace.id;
      await this.persist(config);

      return { workspace, activeWorkspaceId: workspace.id, created: true };
    });
  }

  async removeWorkspace(id: string): Promise<WorkspaceListResult> {
    return this.enqueue(async () => {
      const config = await this.getConfig();
      const index = config.workspaces.findIndex((workspace) => workspace.id === id);

      if (index === -1) {
        throw new RpcFailure("WORKSPACE_NOT_FOUND", "Workspace not found");
      }

      config.workspaces.splice(index, 1);

      if (config.activeWorkspaceId === id) {
        const next = sortWorkspaces(config.workspaces)[0];
        config.activeWorkspaceId = next?.id ?? null;
      }

      await this.persist(config);
      return {
        workspaces: sortWorkspaces(config.workspaces),
        activeWorkspaceId: config.activeWorkspaceId,
      };
    });
  }

  async setActiveWorkspace(id: string): Promise<WorkspaceListResult> {
    return this.enqueue(async () => {
      const config = await this.getConfig();
      const workspace = config.workspaces.find((entry) => entry.id === id);

      if (!workspace) {
        throw new RpcFailure("WORKSPACE_NOT_FOUND", "Workspace not found");
      }

      workspace.lastOpenedAt = new Date().toISOString();
      config.activeWorkspaceId = workspace.id;
      await this.persist(config);

      return {
        workspaces: sortWorkspaces(config.workspaces),
        activeWorkspaceId: config.activeWorkspaceId,
      };
    });
  }

  async validateWorkspacePath(inputPath: string): Promise<WorkspaceValidation> {
    const input = inputPath.trim();
    const expanded = expandHome(input);

    if (expanded.length === 0) {
      return invalidValidation(inputPath, "Path is required");
    }

    if (!path.isAbsolute(expanded)) {
      return invalidValidation(inputPath, "Path must be absolute");
    }

    const resolved = path.resolve(expanded);

    try {
      const realPath = await fs.realpath(resolved);
      const stats = await fs.stat(realPath);

      return {
        input: inputPath,
        path: realPath,
        exists: true,
        isDirectory: stats.isDirectory(),
        isGitRepo: await pathExists(path.join(realPath, ".git")),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const message =
        code === "EACCES" || code === "EPERM"
          ? "Permission denied"
          : code === "ENOENT"
            ? "Path does not exist"
            : "Unable to read path";

      return {
        input: inputPath,
        path: null,
        exists: false,
        isDirectory: false,
        isGitRepo: false,
        error: message,
      };
    }
  }

  private async getConfig(): Promise<HostConfig> {
    if (this.cached) return this.cached;

    let raw: string;
    try {
      raw = await fs.readFile(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cached = createDefaultHostConfig();
        return this.cached;
      }
      throw new RpcFailure("INTERNAL", "Unable to read host config");
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed) || parsed.version !== 1) {
        throw new Error("Unsupported config version");
      }
      this.cached = normalizeConfig(parsed);
      return this.cached;
    } catch (error) {
      this.logger?.error("Host config is invalid; starting with defaults", error);
      await this.backupCorruptConfig();
      this.cached = createDefaultHostConfig();
      await this.persist(this.cached);
      return this.cached;
    }
  }

  private async persist(config: HostConfig): Promise<void> {
    const directory = path.dirname(this.configPath);
    const temporaryPath = `${this.configPath}.${process.pid}.tmp`;
    const payload = `${JSON.stringify(config, null, 2)}\n`;

    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(temporaryPath, payload, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryPath, this.configPath);

    this.cached = config;
  }

  private async backupCorruptConfig(): Promise<void> {
    try {
      const backupPath = `${this.configPath}.corrupt-${Date.now()}`;
      await fs.copyFile(this.configPath, backupPath);
      this.logger?.warn("Backed up invalid host config", { backupPath });
    } catch {
      return;
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function normalizeConfig(raw: Record<string, unknown>): HostConfig {
  const defaults = createDefaultHostConfig();
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces
        .filter(isWorkspace)
        .slice(0, MAX_WORKSPACES)
        .filter(
          (workspace, index, entries) =>
            entries.findIndex((entry) => samePath(entry.path, workspace.path)) === index,
        )
    : [];

  const requestedActive =
    typeof raw.activeWorkspaceId === "string" ? raw.activeWorkspaceId : null;
  const activeWorkspaceId = workspaces.some((workspace) => workspace.id === requestedActive)
    ? requestedActive
    : null;

  return {
    version: 1,
    activeWorkspaceId,
    workspaces,
    settings: normalizeSettings(raw.settings, defaults.settings),
  };
}

function normalizeSettings(value: unknown, defaults: HostSettings): HostSettings {
  if (!isRecord(value)) return defaults;

  const ignore = Array.isArray(value.ignore)
    ? value.ignore.filter((entry): entry is string => typeof entry === "string")
    : defaults.ignore;

  const logLevel =
    typeof value.logLevel === "string" && VALID_LOG_LEVELS.has(value.logLevel)
      ? (value.logLevel as LogLevel)
      : defaults.logLevel;

  return {
    ignore: ignore.length > 0 ? ignore : defaults.ignore,
    maxFileBytes:
      typeof value.maxFileBytes === "number" && value.maxFileBytes > 0
        ? value.maxFileBytes
        : defaults.maxFileBytes,
    maxSearchResults:
      typeof value.maxSearchResults === "number" && value.maxSearchResults > 0
        ? value.maxSearchResults
        : defaults.maxSearchResults,
    logLevel,
  };
}

function isWorkspace(value: unknown): value is Workspace {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.path === "string" &&
    path.isAbsolute(value.path) &&
    typeof value.lastOpenedAt === "string" &&
    !Number.isNaN(Date.parse(value.lastOpenedAt))
  );
}

function sortWorkspaces(workspaces: Workspace[]): Workspace[] {
  return [...workspaces].sort((left, right) => {
    const byDate = Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt);
    return byDate !== 0 ? byDate : left.name.localeCompare(right.name);
  });
}

function workspaceIdFor(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 16);
}

function normalizeName(name: string | undefined, realPath: string): string {
  const candidate = name?.trim();
  if (!candidate) {
    return path.basename(realPath) || realPath;
  }
  if (candidate.length > 80) {
    throw new RpcFailure("BAD_REQUEST", "Workspace name must be 80 characters or fewer");
  }
  if (/[\u0000-\u001f]/.test(candidate)) {
    throw new RpcFailure("BAD_REQUEST", "Workspace name contains control characters");
  }
  return candidate;
}

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function invalidValidation(input: string, error: string): WorkspaceValidation {
  return {
    input,
    path: null,
    exists: false,
    isDirectory: false,
    isGitRepo: false,
    error,
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
