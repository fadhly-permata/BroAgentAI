/**
 * Configuration loader and merger for BrowserAgent.
 *
 * Config precedence: Global < Project < Local
 * - Global: ~/.browseragent/config.json
 * - Project: <workspace>/browseragent.jsonc
 * - Local: <workspace>/.browseragent/config.json
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

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

/** Project-level configuration from browseragent.jsonc. */
export interface ProjectConfig {
  approval?: ApprovalMode;
  toolOverrides?: ToolApproval[];
  ignore?: string[];
  maxFileBytes?: number;
  [key: string]: unknown;
}

/** Global configuration from ~/.browseragent/config.json. */
export interface GlobalConfig {
  defaultApproval?: ApprovalMode;
  defaultIgnore?: string[];
  defaultMaxFileBytes?: number;
  [key: string]: unknown;
}

/** Local configuration from <workspace>/.browseragent/config.json. */
export interface LocalConfig {
  approval?: ApprovalMode;
  toolOverrides?: ToolApproval[];
  [key: string]: unknown;
}

/** Merged configuration with all layers applied. */
export interface MergedConfig {
  approval: ApprovalMode;
  toolOverrides: ToolApproval[];
  ignore: string[];
  maxFileBytes: number;
  sources: {
    global?: string;
    project?: string;
    local?: string;
  };
}

/**
 * Load global config from ~/.browseragent/config.json.
 */
export function loadGlobalConfig(): { config: GlobalConfig | null; path: string } {
  const configDir = join(homedir(), ".browseragent");
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
 * Load project config from <workspace>/browseragent.jsonc.
 */
export function loadProjectConfig(
  workspacePath: string
): { config: ProjectConfig | null; path: string } {
  const configPath = join(workspacePath, "browseragent.jsonc");

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
 * Load local config from <workspace>/.browseragent/config.json.
 */
export function loadLocalConfig(
  workspacePath: string
): { config: LocalConfig | null; path: string } {
  const configPath = join(workspacePath, ".browseragent", "config.json");

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
    merged.sources.global = "~/.browseragent/config.json";
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
    merged.sources.project = "<workspace>/browseragent.jsonc";
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
    merged.sources.local = "<workspace>/.browseragent/config.json";
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
    merged.sources.global = join(homedir(), ".browseragent", "config.json");
  }
  if (project) {
    merged.sources.project = join(active.path, "browseragent.jsonc");
  }
  if (local) {
    merged.sources.local = join(active.path, ".browseragent", "config.json");
  }

  return merged;
}
