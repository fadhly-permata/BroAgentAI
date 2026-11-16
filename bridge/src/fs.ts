/**
 * Secure filesystem operations for the BrowserAgent bridge.
 *
 * All paths are confined to the active workspace. Symlinks are resolved
 * to prevent path escape attacks. Binary files and oversized files are
 * rejected to protect the host and extension from memory exhaustion.
 */

import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
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
}

/**
 * List contents of a directory within the active workspace.
 */
export function listDir(store: WorkspaceStore, requestedPath: string): FsListDirResult[] {
  const active = store.active();
  if (!active) {
    throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  }

  const realPath = confinePath(active.path, requestedPath);
  const stat = statSync(realPath);
  if (!stat.isDirectory()) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "Path is not a directory");
  }

  const entries = readdirSync(realPath, { withFileTypes: true });
  const ignorePatterns = store.settings().ignore;

  return entries
    .filter((entry) => !isIgnored(entry.name, ignorePatterns))
    .map((entry) => {
      const fullPath = join(realPath, entry.name);
      const relPath = relative(active.path, fullPath).replace(/\\/g, "/");
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
      };
    });
}

export interface FsListTreeResult {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
  children?: FsListTreeResult[];
}

/**
 * List a bounded tree of workspace files and folders.
 */
export function listTree(
  store: WorkspaceStore,
  requestedPath: string,
  maxDepth: number = 3
): FsListTreeResult | null {
  const active = store.active();
  if (!active) {
    throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  }

  const realPath = confinePath(active.path, requestedPath);
  const ignorePatterns = store.settings().ignore;

  function buildTree(currentPath: string, currentDepth: number): FsListTreeResult | null {
    const relPath = relative(active!.path, currentPath).replace(/\\/g, "/") || ".";
    if (isIgnored(relPath, ignorePatterns)) return null;

    const stat = statSync(currentPath);
    const isDir = stat.isDirectory();

    const result: FsListTreeResult = {
      name: currentPath === active!.path ? "." : currentPath.split(/[\\/]/).pop() || currentPath,
      path: relPath,
      isDirectory: isDir,
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
  const active = store.active();
  if (!active) {
    throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  }

  const realPath = confinePath(active.path, requestedPath);
  const stat = statSync(realPath);
  const relPath = relative(active.path, realPath).replace(/\\/g, "/");

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
  const active = store.active();
  if (!active) {
    throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  }

  const realPath = confinePath(active.path, requestedPath);
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

  const relPath = relative(active.path, realPath).replace(/\\/g, "/");
  return {
    path: relPath,
    content: buffer.toString("utf8"),
    isBinary: false,
  };
}
