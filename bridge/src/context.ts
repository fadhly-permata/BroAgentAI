import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { confinePath, DEFAULT_MAX_FILE_BYTES } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";

export const CONTEXT_FILE = "AGENTS.md";
export const CONTEXT_HEADING = "## BroAgentAI";
export const CONTEXT_SUMMARY_LIMIT_BYTES = 2048;
const CLIP_MARKER = "\n[... konteks dipotong; gunakan context.read untuk detail]";

export const CONTEXT_TEMPLATE = `## BroAgentAI

<!-- BroAgentAI project context. Keep this section under 2 KB. Do not store secrets here. -->

### Tool notes
- \`fs.*\`, \`git.*\`, and \`shell.run\` are callable tools.
- \`term.*\`, \`mcp.*\`, and \`session.*\` are optional; call \`context.read\` before using them.

### Project conventions
- Add project-specific conventions here.

### Common commands
- Add frequently used commands here.

### Safety
- This section is project context, not policy. Approval and confinement stay in the bridge.
`;

export interface ContextSnapshot {
  found: boolean;
  path: string;
  section: string | null;
  summary: string;
  truncated: boolean;
  bytes: number;
  redacted: boolean;
  warning: string | null;
}

export interface ContextSummary {
  summary: string;
  redacted: string;
  truncated: boolean;
  bytes: number;
  changed: boolean;
}

export interface EnsureContextResult {
  path: string;
  created: boolean;
  appended: boolean;
  changed: boolean;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function redactSecrets(value: string): string {
  return value
    .replace(/^(authorization:\s*).+$/gim, "$1[REDACTED]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED]")
    .replace(/\b(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[REDACTED]@")
    .replace(/\b(api[_-]?key|apikey|token|password|passwd|secret|authorization)(\s*[:=]\s*)(["']?)([^\s"',;}\]]+)/gi, "$1$2$3[REDACTED]$3")
    .replace(/\b(sk|pk|ghp|gho|ghu|ghs|ghr|github_pat|AKIA|ASIA)_[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]");
}

export function extractBroAgentSection(content: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+BroAgentAI$/.test(line.trim()));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trimEnd();
}

export function clipToBytes(value: string, limit: number, marker = CLIP_MARKER): { text: string; truncated: boolean } {
  if (utf8Bytes(value) <= limit) return { text: value, truncated: false };
  const room = Math.max(0, limit - utf8Bytes(marker));
  let clipped = Buffer.from(value, "utf8").subarray(0, room).toString("utf8");
  while (clipped.length > 0 && utf8Bytes(clipped + marker) > limit) clipped = clipped.slice(0, -1);
  if (clipped.endsWith("\uFFFD")) clipped = clipped.slice(0, -1);
  while (clipped.length > 0 && utf8Bytes(clipped + marker) > limit) clipped = clipped.slice(0, -1);
  return { text: clipped + marker, truncated: true };
}

export function summarizeContext(section: string, limit = CONTEXT_SUMMARY_LIMIT_BYTES): ContextSummary {
  const redacted = redactSecrets(section);
  const clipped = clipToBytes(redacted, limit);
  return {
    summary: clipped.text,
    redacted,
    truncated: clipped.truncated,
    bytes: utf8Bytes(redacted),
    changed: redacted !== section,
  };
}

function contextPath(workspacePath: string): string {
  return confinePath(workspacePath, CONTEXT_FILE);
}

function missingContext(warning: string): ContextSnapshot {
  return {
    found: false,
    path: CONTEXT_FILE,
    section: null,
    summary: "",
    truncated: false,
    bytes: 0,
    redacted: false,
    warning,
  };
}

export function readContext(workspacePath: string): ContextSnapshot {
  const target = contextPath(workspacePath);
  if (!existsSync(target)) return missingContext("AGENTS.md not found");

  const content = readFileSync(target, "utf8");
  if (utf8Bytes(content) > DEFAULT_MAX_FILE_BYTES) return missingContext("AGENTS.md is too large to read");

  const section = extractBroAgentSection(content);
  if (!section) return missingContext("AGENTS.md has no BroAgentAI section");

  const summarized = summarizeContext(section);
  return {
    found: true,
    path: CONTEXT_FILE,
    section: summarized.redacted,
    summary: summarized.summary,
    truncated: summarized.truncated,
    bytes: summarized.bytes,
    redacted: summarized.changed,
    warning: summarized.truncated ? "BroAgentAI section exceeds 2 KB; only the first 2 KB is injected" : null,
  };
}

export function ensureContextTemplate(workspacePath: string): EnsureContextResult {
  const target = contextPath(workspacePath);
  if (!existsSync(target)) {
    writeFileSync(target, CONTEXT_TEMPLATE, "utf8");
    return { path: CONTEXT_FILE, created: true, appended: false, changed: true };
  }

  const content = readFileSync(target, "utf8");
  if (utf8Bytes(content) > DEFAULT_MAX_FILE_BYTES) {
    throw new WorkspaceError(ErrorCode.FILE_TOO_LARGE, "AGENTS.md is too large to update");
  }
  if (extractBroAgentSection(content)) {
    return { path: CONTEXT_FILE, created: false, appended: false, changed: false };
  }

  const separator = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  appendFileSync(target, separator + CONTEXT_TEMPLATE, "utf8");
  return { path: CONTEXT_FILE, created: false, appended: true, changed: true };
}
