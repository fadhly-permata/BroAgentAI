/**
 * Source-control operations for the BroAgentAI bridge.
 *
 * Every operation runs the system Git CLI inside the active workspace. The
 * extension never executes a binary itself; it only sends `git.*` RPCs.
 *
 * A workspace counts as a repository only when its root IS the repository
 * root. A workspace nested inside a parent repository is reported as "not a
 * repository" so no action can touch files outside the workspace.
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { confinePath } from "./fs.ts";
import { ErrorCode } from "./rpc.ts";
import { WorkspaceError } from "./workspace.ts";
import type { WorkspaceStore } from "./workspace.ts";

/** Maximum number of changed files returned by `git.status`. */
export const MAX_STATUS_FILES = 2000;
/** Maximum diff size returned by `git.diff`. */
export const MAX_DIFF_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

/** One changed path as reported by `git status`. */
export interface GitFileStatus {
  /** Path relative to the workspace root, forward slashes. */
  path: string;
  /** Original path for renames/copies. */
  origPath?: string;
  /** Index (staged) state: M A D R C T, or "." when unchanged. */
  index: string;
  /** Worktree (unstaged) state: M D T, "?" for untracked, or "." when unchanged. */
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitStatusResult {
  /** False when the Git CLI is not installed / not on PATH. */
  gitAvailable: boolean;
  /** True when the workspace root is a Git repository root. */
  isRepo: boolean;
  /** Human-readable reason when `isRepo` is false. */
  reason?: string;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** In-progress operation, if any. */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
  files: GitFileStatus[];
  truncated: boolean;
}

export interface ParsedStatus {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output.
 *
 * Records are NUL-separated. A rename/copy record ("2 ...") is followed by one
 * extra NUL-separated field holding the original path.
 */
export function parsePorcelainV2(output: string): ParsedStatus {
  const parsed: ParsedStatus = { branch: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [] };
  const records = output.split("\0");

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === "") continue;

    if (record.startsWith("# ")) {
      const [, key, ...rest] = record.split(" ");
      if (key === "branch.head") {
        parsed.detached = rest[0] === "(detached)";
        parsed.branch = parsed.detached ? null : rest.join(" ");
      } else if (key === "branch.upstream") {
        parsed.upstream = rest.join(" ");
      } else if (key === "branch.ab") {
        parsed.ahead = Math.abs(parseInt(rest[0] ?? "0", 10)) || 0;
        parsed.behind = Math.abs(parseInt(rest[1] ?? "0", 10)) || 0;
      }
      continue;
    }

    const kind = record[0];
    if (kind === "?") {
      parsed.files.push(fileStatus(record.slice(2), ".", "?", { untracked: true }));
    } else if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const xy = record.slice(2, 4);
      parsed.files.push(fileStatus(fieldsAfter(record, 8), xy[0], xy[1]));
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
      const xy = record.slice(2, 4);
      const entry = fileStatus(fieldsAfter(record, 9), xy[0], xy[1]);
      entry.origPath = records[++i];
      parsed.files.push(entry);
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const xy = record.slice(2, 4);
      parsed.files.push(fileStatus(fieldsAfter(record, 10), xy[0], xy[1], { conflicted: true }));
    }
    // "!" (ignored) records are not requested and are skipped.
  }

  return parsed;
}

/** Everything after the first `count` space-separated fields (paths may contain spaces). */
function fieldsAfter(record: string, count: number): string {
  let index = 0;
  for (let i = 0; i < count; i++) {
    index = record.indexOf(" ", index) + 1;
    if (index === 0) return "";
  }
  return record.slice(index);
}

function fileStatus(
  path: string,
  index: string,
  worktree: string,
  flags: { untracked?: boolean; conflicted?: boolean } = {}
): GitFileStatus {
  const untracked = flags.untracked === true;
  const conflicted = flags.conflicted === true;
  return {
    path,
    index,
    worktree,
    staged: !untracked && !conflicted && index !== ".",
    unstaged: !untracked && !conflicted && worktree !== ".",
    untracked,
    conflicted,
  };
}

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

class GitUnavailableError extends Error {}

/** Run git in `cwd`. Resolves for any exit code; rejects only if git cannot start. */
function runGit(cwd: string, args: string[]): Promise<GitRun> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "git",
      // Literal pathspecs: a file name is never interpreted as a glob/magic.
      ["-c", "core.quotepath=false", "--literal-pathspecs", ...args],
      {
        cwd,
        windowsHide: true,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0", // never hang waiting for credentials
          GIT_OPTIONAL_LOCKS: "0", // status must not block a concurrent git
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new GitUnavailableError("git executable not found on PATH"));
          return;
        }
        const exit = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
        resolvePromise({ code: exit, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

/** Run git and throw GIT_OPERATION_FAILED (with git's own message) on failure. */
async function git(cwd: string, args: string[]): Promise<string> {
  let run: GitRun;
  try {
    run = await runGit(cwd, args);
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      throw new WorkspaceError(ErrorCode.GIT_OPERATION_FAILED, "Git is not installed or not on PATH");
    }
    throw error;
  }
  if (run.code !== 0) {
    const detail = (run.stderr.trim() || run.stdout.trim() || `git ${args[0]} exited with code ${run.code}`).slice(0, 2000);
    throw new WorkspaceError(ErrorCode.GIT_OPERATION_FAILED, detail);
  }
  return run.stdout;
}

function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    let real = p;
    try { real = realpathSync(p); } catch { /* compare as given */ }
    real = resolve(real);
    return process.platform === "win32" ? real.toLowerCase() : real;
  };
  return normalize(a) === normalize(b);
}

function activePath(store: WorkspaceStore): string {
  const active = store.active();
  if (!active) throw new WorkspaceError(ErrorCode.WORKSPACE_NOT_FOUND, "No active workspace");
  return active.path;
}

type RepoProbe =
  | { gitAvailable: false; isRepo: false; reason: string }
  | { gitAvailable: true; isRepo: false; reason: string }
  | { gitAvailable: true; isRepo: true; gitDir: string };

async function probeRepo(root: string): Promise<RepoProbe> {
  let top: GitRun;
  try {
    top = await runGit(root, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    if (error instanceof GitUnavailableError) {
      return { gitAvailable: false, isRepo: false, reason: "Git is not installed or not on PATH" };
    }
    throw error;
  }
  if (top.code !== 0) {
    return { gitAvailable: true, isRepo: false, reason: "Workspace is not a Git repository" };
  }
  if (!samePath(top.stdout.trim(), root)) {
    return {
      gitAvailable: true,
      isRepo: false,
      reason: "Workspace is inside a parent Git repository; open the repository root as the workspace",
    };
  }
  const gitDirRaw = (await git(root, ["rev-parse", "--git-dir"])).trim();
  return { gitAvailable: true, isRepo: true, gitDir: isAbsolute(gitDirRaw) ? gitDirRaw : join(root, gitDirRaw) };
}

/** Resolve the active workspace and require it to be a repository root. */
async function requireRepo(store: WorkspaceStore): Promise<{ root: string; gitDir: string }> {
  const root = activePath(store);
  const probe = await probeRepo(root);
  if (!probe.isRepo) throw new WorkspaceError(ErrorCode.GIT_NOT_REPO, probe.reason);
  return { root, gitDir: probe.gitDir };
}

function detectOperation(gitDir: string): GitStatusResult["operation"] {
  if (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(join(gitDir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(gitDir, "REVERT_HEAD"))) return "revert";
  return null;
}

async function readStatus(root: string): Promise<ParsedStatus> {
  return parsePorcelainV2(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
}

/**
 * Validate caller-supplied paths: non-empty list of workspace-relative paths,
 * confined to the workspace, never the workspace root itself.
 */
function normalizePaths(root: string, paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "paths must be a non-empty array");
  }
  return paths.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "each path must be a non-empty string");
    }
    confinePath(root, value); // throws PATH_ESCAPE when it resolves outside the workspace
    const rel = relative(root, resolve(root, value)).replace(/\\/g, "/");
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "path must be inside the workspace and cannot be its root");
    }
    return rel;
  });
}

/** `git.status`: never throws for "no git" / "not a repo"; reports them as state. */
export async function gitStatus(store: WorkspaceStore): Promise<GitStatusResult> {
  const root = activePath(store);
  const empty: GitStatusResult = {
    gitAvailable: true, isRepo: false, branch: null, detached: false, upstream: null,
    ahead: 0, behind: 0, operation: null, files: [], truncated: false,
  };
  const probe = await probeRepo(root);
  if (!probe.isRepo) return { ...empty, gitAvailable: probe.gitAvailable, reason: probe.reason };

  const parsed = await readStatus(root);
  const truncated = parsed.files.length > MAX_STATUS_FILES;
  return {
    ...empty,
    isRepo: true,
    branch: parsed.branch,
    detached: parsed.detached,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    operation: detectOperation(probe.gitDir),
    files: truncated ? parsed.files.slice(0, MAX_STATUS_FILES) : parsed.files,
    truncated,
  };
}

export interface GitDiffResult {
  path: string;
  staged: boolean;
  diff: string;
  truncated: boolean;
}

/** `git.diff`: per-file diff, staged or unstaged. Untracked files diff against nothing. */
export async function gitDiff(store: WorkspaceStore, path: unknown, staged: unknown): Promise<GitDiffResult> {
  const { root } = await requireRepo(store);
  const [rel] = normalizePaths(root, [path]);
  const wantStaged = staged === true;

  let diff: string;
  if (wantStaged) {
    diff = await git(root, ["diff", "--cached", "--no-color", "--no-ext-diff", "--", rel]);
  } else {
    const tracked = (await runGit(root, ["ls-files", "--error-unmatch", "--", rel])).code === 0;
    if (tracked) {
      diff = await git(root, ["diff", "--no-color", "--no-ext-diff", "--", rel]);
    } else {
      // --no-index exits 1 when the files differ, which is the normal case here.
      const run = await runGit(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", rel]);
      if (run.code > 1) throw new WorkspaceError(ErrorCode.GIT_OPERATION_FAILED, run.stderr.trim().slice(0, 2000));
      diff = run.stdout;
    }
  }

  const truncated = Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES;
  return { path: rel, staged: wantStaged, diff: truncated ? diff.slice(0, MAX_DIFF_BYTES) : diff, truncated };
}

/** `git.stage`: add the given paths (including deletions) to the index. */
export async function gitStage(store: WorkspaceStore, paths: unknown): Promise<GitStatusResult> {
  const { root } = await requireRepo(store);
  await git(root, ["add", "-A", "--", ...normalizePaths(root, paths)]);
  return gitStatus(store);
}

/** `git.unstage`: remove the given paths from the index, keeping the worktree. */
export async function gitUnstage(store: WorkspaceStore, paths: unknown): Promise<GitStatusResult> {
  const { root } = await requireRepo(store);
  const rels = normalizePaths(root, paths);
  const hasHead = (await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
  if (hasHead) await git(root, ["restore", "--staged", "--", ...rels]);
  else await git(root, ["rm", "--cached", "-r", "--quiet", "--", ...rels]); // before the first commit
  return gitStatus(store);
}

/**
 * `git.discard`: throw away unstaged worktree changes. Tracked files are
 * restored from the index; untracked files are deleted. Staged content is kept.
 * The caller (UI) is responsible for asking the user to confirm.
 */
export async function gitDiscard(store: WorkspaceStore, paths: unknown): Promise<GitStatusResult> {
  const { root } = await requireRepo(store);
  const rels = normalizePaths(root, paths);
  const byPath = new Map((await readStatus(root)).files.map((file) => [file.path, file]));

  for (const rel of rels) {
    const entry = byPath.get(rel);
    if (!entry) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `no changes to discard for: ${rel}`);
    if (entry.conflicted) {
      throw new WorkspaceError(ErrorCode.GIT_CONFLICT, `cannot discard a conflicted file: ${rel}`);
    }
    if (entry.untracked) {
      const absolute = confinePath(root, rel);
      if (statSync(absolute).isDirectory()) {
        throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `refusing to delete a directory: ${rel}`);
      }
      rmSync(absolute);
    } else if (entry.unstaged) {
      await git(root, ["restore", "--worktree", "--", rel]);
    } else {
      throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `only staged changes exist for: ${rel}; unstage it first`);
    }
  }
  return gitStatus(store);
}

export interface GitCommitResult {
  hash: string;
  summary: string;
  status: GitStatusResult;
}

/** `git.commit`: commit the index. Requires a message and staged changes. */
export async function gitCommit(store: WorkspaceStore, message: unknown): Promise<GitCommitResult> {
  const { root } = await requireRepo(store);
  if (typeof message !== "string" || message.trim() === "") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "commit message must not be empty");
  }
  const status = await readStatus(root);
  if (status.files.some((file) => file.conflicted)) {
    throw new WorkspaceError(ErrorCode.GIT_CONFLICT, "resolve conflicts before committing");
  }
  if (!status.files.some((file) => file.staged)) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "nothing staged to commit");
  }
  await git(root, ["commit", "-m", message.trim()]);
  const hash = (await git(root, ["rev-parse", "--short", "HEAD"])).trim();
  return { hash, summary: message.trim().split("\n")[0], status: await gitStatus(store) };
}

export interface GitBranchesResult {
  current: string | null;
  detached: boolean;
  branches: { name: string; current: boolean; upstream: string | null }[];
}

/** `git.branches`: local branches. Before the first commit only the unborn branch is listed. */
export async function gitBranches(store: WorkspaceStore): Promise<GitBranchesResult> {
  const { root } = await requireRepo(store);
  const status = await readStatus(root);
  const out = await git(root, ["for-each-ref", "--format=%(refname:short)%09%(upstream:short)", "refs/heads"]);
  const branches = out.split("\n").filter((line) => line !== "").map((line) => {
    const [name, upstream] = line.split("\t");
    return { name, current: name === status.branch, upstream: upstream || null };
  });
  if (status.branch && !branches.some((branch) => branch.name === status.branch)) {
    branches.unshift({ name: status.branch, current: true, upstream: null }); // unborn branch
  }
  return { current: status.branch, detached: status.detached, branches };
}

async function requireBranchName(root: string, name: unknown): Promise<string> {
  if (typeof name !== "string" || name.trim() === "") {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "branch name must not be empty");
  }
  const trimmed = name.trim();
  if (trimmed.startsWith("-") || (await runGit(root, ["check-ref-format", "--branch", trimmed])).code !== 0) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `invalid branch name: ${trimmed}`);
  }
  return trimmed;
}

/** `git.createBranch`: create a branch at HEAD and switch to it (local changes carry over). */
export async function gitCreateBranch(store: WorkspaceStore, name: unknown): Promise<GitBranchesResult> {
  const { root } = await requireRepo(store);
  const branch = await requireBranchName(root, name);
  await git(root, ["switch", "-c", branch]);
  return gitBranches(store);
}

/** `git.checkout`: switch to an existing local branch. Blocked while tracked changes exist. */
export async function gitCheckout(store: WorkspaceStore, name: unknown): Promise<GitBranchesResult> {
  const { root } = await requireRepo(store);
  const branch = await requireBranchName(root, name);
  const status = await readStatus(root);
  if (status.files.some((file) => !file.untracked)) {
    throw new WorkspaceError(
      ErrorCode.GIT_CONFLICT,
      "working tree has uncommitted changes; commit or discard them before switching branches"
    );
  }
  if ((await runGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code !== 0) {
    throw new WorkspaceError(ErrorCode.INVALID_PARAMS, `unknown branch: ${branch}`);
  }
  await git(root, ["switch", branch]);
  return gitBranches(store);
}

/** `git.init`: turn a non-repository workspace into a repository. */
export async function gitInit(store: WorkspaceStore): Promise<GitStatusResult> {
  const root = activePath(store);
  const probe = await probeRepo(root);
  if (!probe.gitAvailable) throw new WorkspaceError(ErrorCode.GIT_OPERATION_FAILED, probe.reason);
  if (probe.isRepo) throw new WorkspaceError(ErrorCode.INVALID_PARAMS, "workspace is already a Git repository");
  if (probe.reason.includes("parent")) throw new WorkspaceError(ErrorCode.GIT_NOT_REPO, probe.reason);
  await git(root, ["init"]);
  return gitStatus(store);
}
