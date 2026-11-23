/**
 * Secure filesystem operations for the BroAgentAI bridge.
 *
 * All paths are confined to the active workspace. Symlinks are resolved
 * to prevent path escape attacks. Binary files and oversized files are
 * rejected to protect the host and extension from memory exhaustion.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ErrorCode } from "./rpc.ts";
import { WorkspaceError, displayRootPath, resolveRootPath } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

export const DEFAULT_MAX_FILE_BYTES = 512 * 1024; // 512 KB

/**
 * Check if a buffer contains null bytes, indicating a binary file.
 */
export function checkIsBinary(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 512);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * Check if a path segment matches any ignore pattern.
 */
export function isIgnored(requestedPath: string, ignorePatterns: string[]): boolean {
  const segments = requestedPath.replace(/\\/g, "/").split("/");
  for (const pattern of ignorePatterns) {
    if (segments.includes(pattern)) return true;
  }
  return false;
}

/**
 * Resolve a requested path and ensure it is strictly confined within the workspace.
 * Resolves symlinks to prevent path escape attacks.
 */
export function confinePath(workspacePath: string, requestedPath: string): string {
  const realWorkspace = realpathSync(workspacePath);
  const absoluteRequested = resolve(workspacePath, requestedPath);

  // Find the nearest existing parent to resolve symlinks safely
  let checkPath = absoluteRequested;
  while (!existsSync(checkPath)) {
    const parent = dirname(checkPath);
    if (parent === checkPath) break; // Reached root
    checkPath = parent;
  }

  if (existsSync(checkPath)) {
    const realCheckPath = realpathSync(checkPath);
    if (
      !realCheckPath.startsWith(realWorkspace + sep) &&
      realCheckPath !== realWorkspace
    ) {
      throw new WorkspaceError(
        ErrorCode.PATH_ESCAPE,
        "Path escape detected in parent directory"
      );
    }
  }

  // If the requested path itself exists, verify it too (in case it's a symlink)
  if (existsSync(absoluteRequested)) {
    const finalRealPath = realpathSync(absoluteRequested);
    if (
      !finalRealPath.startsWith(realWorkspace + sep) &&
      finalRealPath !== realWorkspace
    ) {
      throw new WorkspaceError(ErrorCode.PATH_ESCAPE, "Path escape detected");
    }
    return finalRealPath;
  }

  // If it doesn't exist, return the normalized absolute path (parent is already verified)
  return absoluteRequested;
}

export interface FsListDirResult {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  /** Set when the entry matches an ignore pattern (only listed with showIgnored). */
  isIgnored?: boolean;
}

/**
 * List contents of a directory within the active workspace.
 */
export function listDir(store: WorkspaceStore, requestedPath: string, showIgnored: boolean = false): FsListDirResult[] {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;

  const realPath = confinePath(active.path, resolved.relativePath);
  const stat = statSync(realPath);
  if (!stat.isDirectory()) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "Path is not a directory");
  }

  const entries = readdirSync(realPath, { withFileTypes: true });
  const ignorePatterns = store.settings().ignore;

  return entries
    .filter((entry) => showIgnored || !isIgnored(entry.name, ignorePatterns))
    .map((entry) => {
      const fullPath = join(realPath, entry.name);
      const relPath = displayRootPath(active, relative(active.path, fullPath).replace(/\\/g, "/"), store.active()?.id ?? null);
      let size: number | undefined;
      if (!entry.isDirectory()) {
        try {
          size = statSync(fullPath).size;
        } catch {
          // Ignore stat errors for individual files
        }
      }
      return {
        name: entry.name,
        path: relPath,
        isDirectory: entry.isDirectory(),
        size,
        ...(isIgnored(entry.name, ignorePatterns) ? { isIgnored: true } : {}),
      };
    });
}

export interface FsListTreeResult {
  name: string;
  path: string;
  isDirectory: boolean;
  isIgnored?: boolean;
  size?: number;
  children?: FsListTreeResult[];
}

/**
 * List a bounded tree of workspace files and folders.
 */
export function listTree(
  store: WorkspaceStore,
  requestedPath: string,
  maxDepth: number = 3,
  showIgnored: boolean = false
): FsListTreeResult | null {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;
  const activeId = store.active()?.id ?? null;

  const realPath = confinePath(active.path, resolved.relativePath);
  const ignorePatterns = store.settings().ignore;

  function buildTree(currentPath: string, currentDepth: number): FsListTreeResult | null {
    const relPath = displayRootPath(active!, relative(active!.path, currentPath).replace(/\\/g, "/") || ".", activeId);
    const ignored = isIgnored(relPath, ignorePatterns);
    if (ignored && !showIgnored) return null;

    const stat = statSync(currentPath);
    const isDir = stat.isDirectory();

    const result: FsListTreeResult = {
      name: currentPath === active!.path ? "." : currentPath.split(/[\\/]/).pop() || currentPath,
      path: relPath,
      isDirectory: isDir,
      ...(ignored ? { isIgnored: true } : {}),
    };

    if (!isDir) {
      result.size = stat.size;
      return result;
    }

    if (currentDepth >= maxDepth) {
      return result; // Don't read children if max depth reached
    }

    try {
      const entries = readdirSync(currentPath, { withFileTypes: true });
      result.children = entries
        .map((entry) => buildTree(join(currentPath, entry.name), currentDepth + 1))
        .filter((child): child is FsListTreeResult => child !== null);
    } catch {
      result.children = [];
    }

    return result;
  }

  return buildTree(realPath, 0);
}

export interface FsStatResult {
  path: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  isBinary?: boolean;
}

/**
 * Get file stats, including binary detection.
 */
export function statFile(store: WorkspaceStore, requestedPath: string): FsStatResult {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;

  const realPath = confinePath(active.path, resolved.relativePath);
  const stat = statSync(realPath);
  const relPath = displayRootPath(active, relative(active.path, realPath).replace(/\\/g, "/"), store.active()?.id ?? null);

  let isBinaryFile = false;
  if (!stat.isDirectory()) {
    if (stat.size > 0 && stat.size <= DEFAULT_MAX_FILE_BYTES) {
      const buffer = readFileSync(realPath);
      isBinaryFile = checkIsBinary(buffer);
    } else if (stat.size > DEFAULT_MAX_FILE_BYTES) {
      isBinaryFile = true; // Treat large files as binary for safety
    }
  }

  return {
    path: relPath,
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtime: stat.mtimeMs,
    isBinary: isBinaryFile,
  };
}

export interface FsReadFileResult {
  path: string;
  content: string;
  isBinary: boolean;
}

/**
 * Read a UTF-8 text file within the active workspace.
 */
export function readFile(store: WorkspaceStore, requestedPath: string): FsReadFileResult {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;

  const realPath = confinePath(active.path, resolved.relativePath);
  const stat = statSync(realPath);

  if (stat.isDirectory()) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "Cannot read a directory");
  }

  if (stat.size > DEFAULT_MAX_FILE_BYTES) {
    throw new WorkspaceError(
      ErrorCode.FILE_TOO_LARGE,
      `File exceeds max size of ${DEFAULT_MAX_FILE_BYTES} bytes`
    );
  }

  const buffer = readFileSync(realPath);
  if (checkIsBinary(buffer)) {
    throw new WorkspaceError(ErrorCode.BINARY_FILE, "File appears to be binary");
  }

  const relPath = displayRootPath(active, relative(active.path, realPath).replace(/\\/g, "/"), store.active()?.id ?? null);
  return {
    path: relPath,
    content: buffer.toString("utf8"),
    isBinary: false,
  };
}

export interface FsReadFileLinesResult {
  path: string;
  content: string;
  isBinary: boolean;
  totalLines: number;
  mtime: number;
}

/**
 * Read a bounded line range from a workspace file.
 */
export function readFileLines(
  store: WorkspaceStore,
  requestedPath: string,
  startLine?: number,
  endLine?: number
): FsReadFileLinesResult {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;

  const realPath = confinePath(active.path, resolved.relativePath);
  const stat = statSync(realPath);

  if (stat.isDirectory()) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "Cannot read a directory");
  }

  if (stat.size > DEFAULT_MAX_FILE_BYTES) {
    throw new WorkspaceError(
      ErrorCode.FILE_TOO_LARGE,
      `File exceeds max size of ${DEFAULT_MAX_FILE_BYTES} bytes`
    );
  }

  const buffer = readFileSync(realPath);
  if (checkIsBinary(buffer)) {
    throw new WorkspaceError(ErrorCode.BINARY_FILE, "File appears to be binary");
  }

  const content = buffer.toString("utf8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  let start = startLine !== undefined ? Math.max(0, startLine) : 0;
  let end = endLine !== undefined && endLine >= 0 ? Math.min(totalLines, endLine + 1) : totalLines;

  const slicedContent = lines.slice(start, end).join("\n");
  const relPath = displayRootPath(active, relative(active.path, realPath).replace(/\\/g, "/"), store.active()?.id ?? null);

  return {
    path: relPath,
    content: slicedContent,
    isBinary: false,
    totalLines,
    mtime: stat.mtimeMs,
  };
}

export interface FsWriteFileResult {
  path: string;
  mtime: number;
}

/**
 * Write or replace a UTF-8 text file inside the workspace, with optional MTIME_CONFLICT detection.
 */
export function writeFile(
  store: WorkspaceStore,
  requestedPath: string,
  content: string,
  expectedMtime?: number
): FsWriteFileResult {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;

  const realPath = confinePath(active.path, resolved.relativePath);

  // Check for MTIME_CONFLICT if file exists and expectedMtime is provided
  if (expectedMtime !== undefined && existsSync(realPath)) {
    const currentStat = statSync(realPath);
    if (currentStat.mtimeMs !== expectedMtime) {
      throw new WorkspaceError(
        ErrorCode.MTIME_CONFLICT,
        "File has been modified externally since it was opened"
      );
    }
  }

  // Ensure parent directory exists
  const parentDir = dirname(realPath);
  if (!existsSync(parentDir)) {
    mkdirSync(parentDir, { recursive: true });
  }

  writeFileSync(realPath, content, "utf8");

  const newStat = statSync(realPath);
  const relPath = displayRootPath(active, relative(active.path, realPath).replace(/\\/g, "/"), store.active()?.id ?? null);

  return {
    path: relPath,
    mtime: newStat.mtimeMs,
  };
}

export interface FsSearchFilesResult {
  file: string;
  line: number;
  text: string;
}

/**
 * Search text in workspace files.
 */
export function searchFiles(
  store: WorkspaceStore,
  requestedPath: string,
  query: string,
  caseSensitive?: boolean,
  regex?: boolean
): FsSearchFilesResult[] {
  const resolved = resolveRootPath(store, requestedPath);
  const active = resolved.root;
  const activeId = store.active()?.id ?? null;

  const activePath = active.path;
  const realPath = confinePath(activePath, resolved.relativePath);
  const ignorePatterns = store.settings().ignore;
  const results: FsSearchFilesResult[] = [];

  if (typeof query !== "string" || query === "") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "query must be a non-empty string");
  }

  // No "g" flag: a global regex keeps lastIndex between .test() calls, which
  // silently skips matches on consecutive lines.
  const flags = caseSensitive ? "" : "i";
  let searchRegex: RegExp;
  try {
    searchRegex = regex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (error) {
    throw new WorkspaceError(
      ErrorCode.INVALID_PARAMS,
      `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  function searchDirectory(dirPath: string) {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (isIgnored(entry.name, ignorePatterns)) continue;

      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        searchDirectory(fullPath);
      } else {
        try {
          const stat = statSync(fullPath);
          if (stat.size > 0 && stat.size <= DEFAULT_MAX_FILE_BYTES) {
            const buffer = readFileSync(fullPath);
            if (!checkIsBinary(buffer)) {
              const content = buffer.toString("utf8");
              const lines = content.split("\n");
              lines.forEach((line, index) => {
                if (searchRegex.test(line)) {
                  const relPath = displayRootPath(active, relative(activePath, fullPath).replace(/\\/g, "/"), activeId);
                  results.push({
                    file: relPath,
                    line: index + 1,
                    text: line.trim(),
                  });
                }
              });
            }
          }
        } catch {
          // Ignore files that cannot be read
        }
      }
    }
  }

  searchDirectory(realPath);
  return results;
}
