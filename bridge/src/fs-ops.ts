/**
 * Structural filesystem operations (create, rename, delete) for the bridge.
 *
 * Same confinement as fs.ts: every path is resolved inside the active
 * workspace, and the workspace root itself can never be the target.
 * Nothing overwrites silently, and directory deletion is non-recursive.
 */

import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

function target(store: WorkspaceStore, requestedPath: unknown): { root: string; absolute: string; rel: string } {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  if (typeof requestedPath !== "string" || requestedPath.trim() === "") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "path must be a non-empty string");
  }
  const absolute = confinePath(active.path, requestedPath.trim());
  const rel = relative(confinePath(active.path, "."), absolute).replace(/\\/g, "/");
  if (rel === "" || rel.startsWith("..")) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "path cannot be the workspace root");
  }
  return { root: active.path, absolute, rel };
}

/** `fs.createFile`: create an empty file; fails if anything already exists there. */
export function createFile(store: WorkspaceStore, requestedPath: unknown): { path: string } {
  const { absolute, rel } = target(store, requestedPath);
  if (existsSync(absolute)) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `already exists: ${rel}`);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, "", { encoding: "utf8", flag: "wx" });
  return { path: rel };
}

/** `fs.mkdir`: create a directory (and missing parents); fails if it already exists. */
export function makeDir(store: WorkspaceStore, requestedPath: unknown): { path: string } {
  const { absolute, rel } = target(store, requestedPath);
  if (existsSync(absolute)) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `already exists: ${rel}`);
  mkdirSync(absolute, { recursive: true });
  return { path: rel };
}

/** `fs.rename`: move/rename inside the workspace; never overwrites. */
export function renamePath(store: WorkspaceStore, from: unknown, to: unknown): { from: string; to: string } {
  const source = target(store, from);
  const dest = target(store, to);
  if (!existsSync(source.absolute)) throw new WorkspaceError(ErrorCode.FILE_NOT_FOUND, `not found: ${source.rel}`);
  if (existsSync(dest.absolute)) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `already exists: ${dest.rel}`);
  mkdirSync(dirname(dest.absolute), { recursive: true });
  renameSync(source.absolute, dest.absolute);
  return { from: source.rel, to: dest.rel };
}

/** `fs.delete`: delete one file or one EMPTY directory. */
export function deletePath(store: WorkspaceStore, requestedPath: unknown): { path: string } {
  const { absolute, rel } = target(store, requestedPath);
  if (!existsSync(absolute)) throw new WorkspaceError(ErrorCode.FILE_NOT_FOUND, `not found: ${rel}`);
  if (statSync(absolute).isDirectory()) {
    if (readdirSync(absolute).length > 0) {
      throw new WorkspaceError(ErrorCode.NOT_ALLOWED, `directory is not empty: ${rel} (delete its contents first)`);
    }
    rmdirSync(absolute);
  } else {
    rmSync(absolute);
  }
  return { path: rel };
}
