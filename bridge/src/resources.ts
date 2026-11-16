/**
 * Resource loader for BroAgentAI workspace resources.
 *
 * Discovers:
 * - AGENTS.md (project-level agent instructions)
 * - rules/ directory (per-file rule definitions)
 * - skills/ directory (skill definitions)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { WorkspaceStore } from "./workspace.ts";

/** A discovered resource with its path and content. */
export interface Resource {
  name: string;
  path: string;
  content: string;
  size: number;
}

/** Summary of a discovered resource (without content). */
export interface ResourceSummary {
  name: string;
  path: string;
  size: number;
}

/**
 * Load AGENTS.md from the workspace root if it exists.
 */
export function loadAgentsMd(workspacePath: string): Resource | null {
  const agentsPath = join(workspacePath, "AGENTS.md");

  if (!existsSync(agentsPath)) {
    return null;
  }

  try {
    const stat = statSync(agentsPath);
    if (!stat.isFile()) {
      return null;
    }

    const content = readFileSync(agentsPath, "utf8");
    return {
      name: "AGENTS.md",
      path: "AGENTS.md",
      content,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * List all rule files in the rules/ directory.
 */
export function listRules(workspacePath: string): ResourceSummary[] {
  const rulesDir = join(workspacePath, "rules");

  if (!existsSync(rulesDir)) {
    return [];
  }

  try {
    const stat = statSync(rulesDir);
    if (!stat.isDirectory()) {
      return [];
    }

    const entries = readdirSync(rulesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const fullPath = join(rulesDir, entry.name);
        const relPath = relative(workspacePath, fullPath).replace(/\\/g, "/");
        const fileStat = statSync(fullPath);
        return {
          name: entry.name,
          path: relPath,
          size: fileStat.size,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Load a specific rule file.
 */
export function loadRule(workspacePath: string, ruleName: string): Resource | null {
  const rulePath = join(workspacePath, "rules", ruleName);

  if (!existsSync(rulePath)) {
    return null;
  }

  try {
    const stat = statSync(rulePath);
    if (!stat.isFile()) {
      return null;
    }

    const content = readFileSync(rulePath, "utf8");
    const relPath = relative(workspacePath, rulePath).replace(/\\/g, "/");
    return {
      name: ruleName,
      path: relPath,
      content,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * List all skill files in the skills/ directory.
 */
export function listSkills(workspacePath: string): ResourceSummary[] {
  const skillsDir = join(workspacePath, "skills");

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    const stat = statSync(skillsDir);
    if (!stat.isDirectory()) {
      return [];
    }

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => {
        const fullPath = join(skillsDir, entry.name);
        const relPath = relative(workspacePath, fullPath).replace(/\\/g, "/");
        const fileStat = statSync(fullPath);
        return {
          name: entry.name,
          path: relPath,
          size: fileStat.size,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Load a specific skill file.
 */
export function loadSkill(workspacePath: string, skillName: string): Resource | null {
  const skillPath = join(workspacePath, "skills", skillName);

  if (!existsSync(skillPath)) {
    return null;
  }

  try {
    const stat = statSync(skillPath);
    if (!stat.isFile()) {
      return null;
    }

    const content = readFileSync(skillPath, "utf8");
    const relPath = relative(workspacePath, skillPath).replace(/\\/g, "/");
    return {
      name: skillName,
      path: relPath,
      content,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

/**
 * Get a summary of all available instructions (AGENTS.md + rules).
 */
export function listInstructions(workspacePath: string): ResourceSummary[] {
  const instructions: ResourceSummary[] = [];

  const agentsMd = loadAgentsMd(workspacePath);
  if (agentsMd) {
    instructions.push({
      name: agentsMd.name,
      path: agentsMd.path,
      size: agentsMd.size,
    });
  }

  const rules = listRules(workspacePath);
  instructions.push(...rules);

  return instructions;
}

/**
 * Load all resources for the active workspace.
 */
export function loadAllResources(store: WorkspaceStore): {
  agents: Resource | null;
  instructions: ResourceSummary[];
  skills: ResourceSummary[];
} {
  const active = store.active();
  if (!active) {
    throw new Error("No active workspace");
  }

  return {
    agents: loadAgentsMd(active.path),
    instructions: listInstructions(active.path),
    skills: listSkills(active.path),
  };
}
