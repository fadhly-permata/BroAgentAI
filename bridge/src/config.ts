/**
 * Configuration loader and merger for BroAgentAI.
 *
 * Config precedence: Global < Project < Local
 * - Global: ~/.broagentai/config.json
 * - Project: <workspace>/broagentai.jsonc
 * - Local: <workspace>/.broagentai/config.json
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { normalizeCoAuthors } from "./co-authors.ts";
import { readJsoncFile } from "./jsonc.ts";
import type { WorkspaceStore } from "./workspace.ts";

/** Approval mode for tool execution. */
export type ApprovalMode = "auto" | "ask" | "deny";

export function normalizeApprovalMode(value: unknown, fallback: ApprovalMode = "ask"): ApprovalMode {
  if (value === "auto" || value === "ask" || value === "deny") return value;
  return fallback;
}

function normalizeToolOverrides(value: unknown): ToolApproval[] {
  if (!Array.isArray(value)) return [];
  const out: ToolApproval[] = [];
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== "object") continue;
    const tool = (entry as { tool?: unknown }).tool;
    if (typeof tool !== "string" || tool === "") continue;
    out.push({ tool, approval: normalizeApprovalMode((entry as { approval?: unknown }).approval) });
  }
  return out;
}

/** Risk class for tool categorization. */
export type RiskClass = "read" | "write" | "execute" | "network";

/** Tool-specific approval override. */
export interface ToolApproval {
  tool: string;
  approval: ApprovalMode;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ProjectScriptAllowlistEntry {
  manager: PackageManager;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface SkillRunAllowlistEntry {
  command: string[];
  cwd?: string;
  env?: string[];
  timeoutMs?: number;
}

/** Project-level configuration from broagentai.jsonc. */
export interface ProjectConfig {
  approval?: ApprovalMode;
  toolOverrides?: ToolApproval[];
  ignore?: string[];
  maxFileBytes?: number;
  /** Co-authored-by entries ("Name <email>") for commits; replaces the global list. */
  coAuthors?: string[];
  scripts?: Record<string, ProjectScriptAllowlistEntry>;
  skillRuns?: Record<string, SkillRunAllowlistEntry>;
  [key: string]: unknown;
}

/** Global configuration from ~/.broagentai/config.json. */
export interface GlobalConfig {
  defaultApproval?: ApprovalMode;
  defaultIgnore?: string[];
  defaultMaxFileBytes?: number;
  /** Co-authored-by entries ("Name <email>") added to every commit made through BroAgentAI. */
  coAuthors?: string[];
  scripts?: Record<string, ProjectScriptAllowlistEntry>;
  skillRuns?: Record<string, SkillRunAllowlistEntry>;
  [key: string]: unknown;
}

/** Local configuration from <workspace>/.broagentai/config.json. */
export interface LocalConfig {
  approval?: ApprovalMode;
  toolOverrides?: ToolApproval[];
  /** Co-authored-by entries; replaces the project/global list ([] turns them off here). */
  coAuthors?: string[];
  scripts?: Record<string, ProjectScriptAllowlistEntry>;
  skillRuns?: Record<string, SkillRunAllowlistEntry>;
  [key: string]: unknown;
}

/** Merged configuration with all layers applied. */
export interface MergedConfig {
  approval: ApprovalMode;
  approvalConfigured: boolean;
  toolOverrides: ToolApproval[];
  scripts: Record<string, ProjectScriptAllowlistEntry>;
  skillRuns: Record<string, SkillRunAllowlistEntry>;
  ignore: string[];
  maxFileBytes: number;
  /** Co-authored-by entries for commits; the most specific layer that sets coAuthors wins. */
  coAuthors: string[];
  sources: {
    global?: string;
    project?: string;
    local?: string;
  };
}

/**
 * Load global config from ~/.broagentai/config.json.
 */
export function loadGlobalConfig(): { config: GlobalConfig | null; path: string } {
  const configDir = join(homedir(), ".broagentai");
  const configPath = join(configDir, "config.json");

  if (!existsSync(configPath)) {
    return { config: null, path: configPath };
  }

  try {
    const text = readFileSync(configPath, "utf8");
    const config = JSON.parse(text) as GlobalConfig;
    return { config, path: configPath };
  } catch {
    return { config: null, path: configPath };
  }
}

/**
 * Load project config from <workspace>/broagentai.jsonc.
 */
export function loadProjectConfig(
  workspacePath: string
): { config: ProjectConfig | null; path: string } {
  const configPath = join(workspacePath, "broagentai.jsonc");

  if (!existsSync(configPath)) {
    return { config: null, path: configPath };
  }

  try {
    const config = readJsoncFile(configPath) as ProjectConfig;
    return { config, path: configPath };
  } catch {
    return { config: null, path: configPath };
  }
}

/**
 * Load local config from <workspace>/.broagentai/config.json.
 */
export function loadLocalConfig(
  workspacePath: string
): { config: LocalConfig | null; path: string } {
  const configPath = join(workspacePath, ".broagentai", "config.json");

  if (!existsSync(configPath)) {
    return { config: null, path: configPath };
  }

  try {
    const text = readFileSync(configPath, "utf8");
    const config = JSON.parse(text) as LocalConfig;
    return { config, path: configPath };
  } catch {
    return { config: null, path: configPath };
  }
}

/**
 * Merge configuration layers with precedence: Global < Project < Local.
 */
export function mergeConfig(
  global: GlobalConfig | null,
  project: ProjectConfig | null,
  local: LocalConfig | null,
  storeSettings: { ignore: string[]; maxFileBytes: number }
): MergedConfig {
  // Start with defaults from store settings
  const merged: MergedConfig = {
    approval: "ask",
    approvalConfigured: false,
    toolOverrides: [],
    scripts: {},
    skillRuns: {},
    ignore: [...storeSettings.ignore],
    maxFileBytes: storeSettings.maxFileBytes,
    coAuthors: [],
    sources: {},
  };

  // Apply global config
  if (global) {
    if (global.defaultApproval !== undefined) {
      merged.approval = normalizeApprovalMode(global.defaultApproval);
      merged.approvalConfigured = true;
    }
    if (global.scripts) {
      merged.scripts = { ...merged.scripts, ...global.scripts };
    }
    if (global.skillRuns) {
      merged.skillRuns = { ...merged.skillRuns, ...global.skillRuns };
    }
    if (global.defaultIgnore) {
      merged.ignore = [...new Set([...merged.ignore, ...global.defaultIgnore])];
    }
    if (global.defaultMaxFileBytes) {
      merged.maxFileBytes = global.defaultMaxFileBytes;
    }
    if (global.coAuthors !== undefined) {
      merged.coAuthors = normalizeCoAuthors(global.coAuthors);
    }
    merged.sources.global = "~/.broagentai/config.json";
  }

  // Apply project config (overrides global)
  if (project) {
    if (project.approval !== undefined) {
      merged.approval = normalizeApprovalMode(project.approval);
      merged.approvalConfigured = true;
    }
    if (project.toolOverrides !== undefined) {
      merged.toolOverrides = [...merged.toolOverrides, ...normalizeToolOverrides(project.toolOverrides)];
    }
    if (project.scripts) {
      merged.scripts = { ...merged.scripts, ...project.scripts };
    }
    if (project.skillRuns) {
      merged.skillRuns = { ...merged.skillRuns, ...project.skillRuns };
    }
    if (project.ignore) {
      merged.ignore = [...new Set([...merged.ignore, ...project.ignore])];
    }
    if (project.maxFileBytes) {
      merged.maxFileBytes = project.maxFileBytes;
    }
    if (project.coAuthors !== undefined) {
      merged.coAuthors = normalizeCoAuthors(project.coAuthors);
    }
    merged.sources.project = "<workspace>/broagentai.jsonc";
  }

  // Apply local config (overrides project)
  if (local) {
    if (local.approval !== undefined) {
      merged.approval = normalizeApprovalMode(local.approval);
      merged.approvalConfigured = true;
    }
    if (local.toolOverrides !== undefined) {
      merged.toolOverrides = [...normalizeToolOverrides(local.toolOverrides), ...merged.toolOverrides];
    }
    if (local.scripts) {
      merged.scripts = { ...merged.scripts, ...local.scripts };
    }
    if (local.skillRuns) {
      merged.skillRuns = { ...merged.skillRuns, ...local.skillRuns };
    }
    if (local.coAuthors !== undefined) {
      merged.coAuthors = normalizeCoAuthors(local.coAuthors);
    }
    merged.sources.local = "<workspace>/.broagentai/config.json";
  }

  return merged;
}

/**
 * Load and merge all configuration layers for the active workspace.
 */
export function loadMergedConfig(store: WorkspaceStore): MergedConfig {
  const active = store.active();
  if (!active) {
    throw new Error("No active workspace");
  }

  const { config: global } = loadGlobalConfig();
  const { config: project } = loadProjectConfig(active.path);
  const { config: local } = loadLocalConfig(active.path);
  const storeSettings = store.settings();

  const merged = mergeConfig(global, project, local, storeSettings);

  // Add actual paths to sources
  if (global) {
    merged.sources.global = join(homedir(), ".broagentai", "config.json");
  }
  if (project) {
    merged.sources.project = join(active.path, "broagentai.jsonc");
  }
  if (local) {
    merged.sources.local = join(active.path, ".broagentai", "config.json");
  }

  return merged;
}
