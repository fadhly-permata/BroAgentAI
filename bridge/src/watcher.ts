/**
 * Filesystem watcher for the active workspace.
 *
 * The bridge owns the file system, so it is the only side that can tell the
 * panel "something changed on disk". This module turns raw `fs.watch` noise
 * into two debounced events:
 *
 *  - `fs.changed`  `{ workspaceId, paths, kind }` - user files changed
 *  - `git.changed` `{ workspaceId, paths }`      - something that moves Git
 *                                                 state (`.git/index`, `HEAD`,
 *                                                 refs, ...) changed
 *
 * Anything else inside `.git` is dropped: objects and logs churn constantly
 * and would only cause pointless refreshes. Build output and dependency
 * directories (`DEFAULT_IGNORE`) are dropped too.
 *
 * `fs.watch(..., { recursive: true })` is a Windows/macOS feature. Where it
 * is unavailable the watcher degrades to a no-op with a warning instead of
 * breaking the host.
 */

import { existsSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join, relative, resolve } from "node:path";

import { createLogger } from "./logger.ts";
import type { EmitEvent } from "./terminal.ts";
import { DEFAULT_IGNORE } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

const log = createLogger({ scope: "watcher" });

/** Quiet period before a batch of raw events is reported, in milliseconds. */
export const DEBOUNCE_MS = 150;

/** Upper bound on paths carried by one event; the rest are coalesced. */
export const MAX_BATCH_PATHS = 200;

/** Directory names never watched, taken from the explorer's ignore list. */
const IGNORED_DIRS = new Set(DEFAULT_IGNORE.filter((name) => name !== ".git"));

/** Files inside `.git` that actually mean "Git state moved". */
const GIT_STATE_FILES = new Set([
  ".git/index",
  ".git/HEAD",
  ".git/ORIG_HEAD",
  ".git/MERGE_HEAD",
  ".git/REBASE_HEAD",
  ".git/CHERRY_PICK_HEAD",
  ".git/REVERT_HEAD",
  ".git/packed-refs",
]);

/** `delete` when every path in the batch is gone, `update` otherwise. */
export type ChangeKind = "create" | "update" | "delete";

export interface FsChangedEvent {
  workspaceId: string;
  paths: string[];
  kind: ChangeKind;
}

export interface GitChangedEvent {
  workspaceId: string;
  paths: string[];
}

/** Normalize a watch callback filename to a workspace-relative POSIX path. */
function toRelativePath(root: string, filename: string): string | null {
  const absolute = resolve(root, filename);
  const rel = relative(root, absolute).split("\\").join("/");
  if (rel === "" || rel === ".." || rel.startsWith("../")) return null;
  return rel;
}

/** True when a relative path lives under an ignored dependency/build directory. */
function isIgnoredDir(rel: string): boolean {
  const segments = rel.split("/");
  // The last segment is the file itself; only directories count.
  for (let i = 0; i < segments.length - 1; i++) {
    if (IGNORED_DIRS.has(segments[i])) return true;
  }
  return false;
}

/** True when the path is Git state worth a `git.changed` event. */
function isGitState(rel: string): boolean {
  return GIT_STATE_FILES.has(rel) || rel.startsWith(".git/refs/");
}

/** True when the path is inside `.git` but not interesting (objects, logs, ...). */
function isNoisyGitPath(rel: string): boolean {
  return (rel === ".git" || rel.startsWith(".git/")) && !isGitState(rel);
}

/**
 * Watches the active workspace and emits debounced change events.
 *
 * Call {@link restart} after the active workspace changes and {@link close}
 * on shutdown. The class never throws from the watch callback: a broken watch
 * is logged and disabled so the RPC host keeps serving.
 */
export class WorkspaceWatcher {
  readonly #store: WorkspaceStore;
  readonly #emit: EmitEvent;

  #watcher: FSWatcher | null = null;
  #root: string | null = null;
  #workspaceId: string | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  /** Paths collected since the last flush, split by event kind. */
  #fsPaths = new Set<string>();
  #gitPaths = new Set<string>();
  /** Paths seen gone since the last flush, used to pick the batch kind. */
  #deleted = new Set<string>();

  constructor(store: WorkspaceStore, emit: EmitEvent) {
    this.#store = store;
    this.#emit = emit;
  }

  /** (Re)attach to the currently active workspace. Safe to call repeatedly. */
  restart(): void {
    this.close();
    const active = this.#store.active();
    if (!active) return;

    try {
      this.#watcher = watch(active.path, { recursive: true }, (eventType, filename) => {
        this.#onRaw(eventType, filename);
      });
    } catch (error) {
      // Recursive watching is unavailable (Linux) or the directory vanished.
      log.warn("cannot watch workspace; auto-refresh disabled", {
        fields: { reason: error instanceof Error ? error.message : String(error) },
      });
      this.#watcher = null;
      return;
    }

    this.#watcher.on("error", (error: Error) => {
      log.warn("workspace watch failed; auto-refresh disabled", { fields: { reason: error.message } });
      this.close();
    });

    this.#root = active.path;
    this.#workspaceId = active.id;
    log.info("watching workspace");
  }

  /** Stop watching and drop any pending batch. */
  close(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#fsPaths.clear();
    this.#gitPaths.clear();
    this.#deleted.clear();
    if (this.#watcher) {
      try { this.#watcher.close(); } catch { /* already gone */ }
      this.#watcher = null;
    }
    this.#root = null;
    this.#workspaceId = null;
  }

  /** Queue one raw `fs.watch` notification and arm the debounce timer. */
  #onRaw(eventType: string, filename: string | Buffer | null): void {
    if (!this.#root || !this.#workspaceId) return;
    if (!filename) return;

    const rel = toRelativePath(this.#root, filename.toString());
    if (!rel || isNoisyGitPath(rel) || isIgnoredDir(rel)) return;

    if (isGitState(rel)) {
      this.#gitPaths.add(rel);
    } else {
      this.#fsPaths.add(rel);
      // A rename for a path that no longer exists is a deletion.
      if (eventType === "rename" && !existsSync(join(this.#root, rel))) this.#deleted.add(rel);
    }

    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#flush(), DEBOUNCE_MS);
  }

  /** Emit one batch per event kind, then reset. */
  #flush(): void {
    this.#timer = null;
    const workspaceId = this.#workspaceId;
    if (!workspaceId) return;

    if (this.#fsPaths.size > 0) {
      const paths = [...this.#fsPaths].slice(0, MAX_BATCH_PATHS);
      const kind: ChangeKind = paths.every((path) => this.#deleted.has(path)) ? "delete" : "update";
      const event: FsChangedEvent = { workspaceId, paths, kind };
      this.#safeEmit("fs.changed", event);
    }

    if (this.#gitPaths.size > 0) {
      const event: GitChangedEvent = { workspaceId, paths: [...this.#gitPaths].slice(0, MAX_BATCH_PATHS) };
      this.#safeEmit("git.changed", event);
    }

    this.#fsPaths.clear();
    this.#gitPaths.clear();
    this.#deleted.clear();
  }

  /** Emitting is best effort: a closed stdout must not crash the watcher. */
  #safeEmit(event: string, data: unknown): void {
    try {
      this.#emit(event, data);
    } catch (error) {
      log.warn("failed to emit change event", {
        fields: { event, reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }
}
