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

/** Risk class for tool categorization. */
export type RiskClass = "read" | "write" | "execute" | "network";

/** Tool-specific approval override. */
export interface ToolApproval {
  tool: string;
  approval: ApprovalMode;
}

/** Project-level configuration from broagentai.jsonc. */
export interface ProjectConfig {
  approval?: ApprovalMode;
  toolOverrides?: ToolApproval[];
  ignore?: string[];
  maxFileBytes?: number;
  /** Co-authored-by entries ("Name <email>") for commits; replaces the global list. */
  coAuthors?: string[];
  [key: string]: unknown;
}

/** Global configuration from ~/.broagentai/config.json. */
export interface GlobalConfig {
  defaultApproval?: ApprovalMode;
  defaultIgnore?: string[];
  defaultMaxFileBytes?: number;
  /** Co-authored-by entries ("Name <email>") added to every commit made through BroAgentAI. */
  coAuthors?: string[];
  [key: string]: unknown;
}

/** Local configuration from <workspace>/.broagentai/config.json. */
export interface LocalConfig {
  approval?: ApprovalMode;
  toolOverrides?: ToolApproval[];
  /** Co-authored-by entries; replaces the project/global list ([] turns them off here). */
  coAuthors?: string[];
  [key: string]: unknown;
}

/** Merged configuration with all layers applied. */
export interface MergedConfig {
  approval: ApprovalMode;
  toolOverrides: ToolApproval[];
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
    toolOverrides: [],
    ignore: [...storeSettings.ignore],
    maxFileBytes: storeSettings.maxFileBytes,
    coAuthors: [],
    sources: {},
  };

  // Apply global config
  if (global) {
    if (global.defaultApproval) {
      merged.approval = global.defaultApproval;
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
    if (project.approval) {
      merged.approval = project.approval;
    }
    if (project.toolOverrides) {
      merged.toolOverrides = [...merged.toolOverrides, ...project.toolOverrides];
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
    if (local.approval) {
      merged.approval = local.approval;
    }
    if (local.toolOverrides) {
      // Local overrides take precedence, so we prepend them
      merged.toolOverrides = [...local.toolOverrides, ...merged.toolOverrides];
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
