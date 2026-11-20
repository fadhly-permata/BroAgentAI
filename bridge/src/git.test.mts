import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { parseGitLog, parseNameStatusZ, parsePorcelainV2 } from "./git.ts";

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const repoTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasGit ? false : "git not installed" }, fn);

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** A workspace that is a repo with one commit: a.txt, b.txt, dir/c.txt. */
async function repo() {
  const ws = mkdtempSync(join(tmpdir(), "ba-git-ws-"));
  sh(ws, "init", "-q", "-b", "main");
  sh(ws, "config", "user.email", "test@example.com");
  sh(ws, "config", "user.name", "Test");
  sh(ws, "config", "commit.gpgsign", "false");
  writeFileSync(join(ws, "a.txt"), "a1\n");
  writeFileSync(join(ws, "b.txt"), "b1\n");
  mkdirSync(join(ws, "dir"));
  writeFileSync(join(ws, "dir", "c.txt"), "c1\n");
  sh(ws, "add", "-A");
  sh(ws, "commit", "-q", "-m", "init");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = async (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  const file = (status: any, path: string) => status.files.find((f: any) => f.path === path);
  return { ws, call, ok, file };
}

test("parsePorcelainV2 reads branch headers and every record kind", () => {
  const out = [
    "# branch.oid 1234",
    "# branch.head feat/x",
    "# branch.upstream origin/feat/x",
    "# branch.ab +2 -1",
    "1 .M N... 100644 100644 100644 aaa bbb modified file.txt",
    "1 A. N... 000000 100644 100644 000 bbb added.txt",
    "1 MM N... 100644 100644 100644 aaa bbb both.txt",
    "2 R. N... 100644 100644 100644 aaa bbb R100 new name.txt",
    "old name.txt",
    "u UU N... 100644 100644 100644 100644 a b c conflict.txt",
    "? untracked dir/new.txt",
    "",
  ].join("\0");
  const parsed = parsePorcelainV2(out);
  assert.equal(parsed.branch, "feat/x");
  assert.equal(parsed.upstream, "origin/feat/x");
  assert.equal(parsed.ahead, 2);
  assert.equal(parsed.behind, 1);
  const by = Object.fromEntries(parsed.files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by).sort(), ["added.txt", "both.txt", "conflict.txt", "modified file.txt", "new name.txt", "untracked dir/new.txt"]);
  assert.equal(by["modified file.txt"].unstaged, true);
  assert.equal(by["modified file.txt"].staged, false);
  assert.equal(by["added.txt"].staged, true);
  assert.equal(by["both.txt"].staged && by["both.txt"].unstaged, true);
  assert.equal(by["new name.txt"].origPath, "old name.txt");
  assert.equal(by["new name.txt"].index, "R");
  assert.equal(by["conflict.txt"].conflicted, true);
  assert.equal(by["conflict.txt"].staged, false);
  assert.equal(by["untracked dir/new.txt"].untracked, true);
});

test("parsePorcelainV2 reports a detached HEAD", () => {
  const parsed = parsePorcelainV2("# branch.oid 1234\0# branch.head (detached)\0");
  assert.equal(parsed.detached, true);
  assert.equal(parsed.branch, null);
});

repoTest("git.status reports a non-repository workspace as state, not an error", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ba-git-plain-"));
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 1, method: "workspace.add", params: { path: ws } });
  const res = await s.handle({ id: 2, method: "git.status", params: {} });
  assert.equal(res.error, undefined);
  assert.equal((res.result as any).isRepo, false);
  assert.equal((res.result as any).gitAvailable, true);
  const stage = await s.handle({ id: 3, method: "git.stage", params: { paths: ["x"] } });
  assert.equal(stage.error?.code, -32015);
});

repoTest("git.status treats a workspace nested in a parent repo as not a repo", async () => {
  const { ws } = await repo();
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 1, method: "workspace.add", params: { path: join(ws, "dir") } });
  const res = await s.handle({ id: 2, method: "git.status", params: {} });
  assert.equal((res.result as any).isRepo, false);
  assert.match((res.result as any).reason, /parent/);
});

repoTest("git.status matches git for modified/added/deleted/renamed/untracked", async () => {
  const { ws, ok, file } = await repo();
  writeFileSync(join(ws, "a.txt"), "a2\n"); // modified, unstaged
  rmSync(join(ws, "b.txt")); // deleted, unstaged
  renameSync(join(ws, "dir", "c.txt"), join(ws, "dir", "renamed.txt"));
  sh(ws, "add", "-A", "dir"); // staged rename
  writeFileSync(join(ws, "new file.txt"), "n\n"); // untracked, space in name
  writeFileSync(join(ws, "added.txt"), "x\n");
  sh(ws, "add", "added.txt"); // staged add

  const status = await ok("git.status");
  assert.equal(status.isRepo, true);
  assert.equal(status.branch, "main");
  assert.equal(status.operation, null);
  assert.equal(file(status, "a.txt").worktree, "M");
  assert.equal(file(status, "a.txt").staged, false);
  assert.equal(file(status, "b.txt").worktree, "D");
  assert.equal(file(status, "dir/renamed.txt").index, "R");
  assert.equal(file(status, "dir/renamed.txt").origPath, "dir/c.txt");
  assert.equal(file(status, "new file.txt").untracked, true);
  assert.equal(file(status, "added.txt").index, "A");
  assert.equal(status.files.length, 5);
});

repoTest("git.stage / git.unstage move a file in and out of the index", async () => {
  const { ws, ok, file } = await repo();
  writeFileSync(join(ws, "a.txt"), "a2\n");
  writeFileSync(join(ws, "new file.txt"), "n\n");

  let status = await ok("git.stage", { paths: ["a.txt", "new file.txt"] });
  assert.equal(file(status, "a.txt").staged, true);
  assert.equal(file(status, "new file.txt").index, "A");

  status = await ok("git.unstage", { paths: ["a.txt", "new file.txt"] });
  assert.equal(file(status, "a.txt").staged, false);
  assert.equal(file(status, "a.txt").unstaged, true);
  assert.equal(file(status, "new file.txt").untracked, true);
});

repoTest("git.diff shows staged, unstaged and untracked changes", async () => {
  const { ws, ok } = await repo();
  writeFileSync(join(ws, "a.txt"), "a2\n");
  let diff = await ok("git.diff", { path: "a.txt" });
  assert.match(diff.diff, /^-a1$/m);
  assert.match(diff.diff, /^\+a2$/m);
  assert.equal((await ok("git.diff", { path: "a.txt", staged: true })).diff, "");

  await ok("git.stage", { paths: ["a.txt"] });
  assert.match((await ok("git.diff", { path: "a.txt", staged: true })).diff, /^\+a2$/m);
  assert.equal((await ok("git.diff", { path: "a.txt" })).diff, "");

  writeFileSync(join(ws, "fresh.txt"), "brand new\n");
  diff = await ok("git.diff", { path: "fresh.txt" });
  assert.match(diff.diff, /^\+brand new$/m);
  assert.equal(diff.truncated, false);
});

repoTest("git.commit requires a message and staged changes, then commits", async () => {
  const { ws, call, ok } = await repo();
  writeFileSync(join(ws, "a.txt"), "a2\n");

  assert.equal((await call("git.commit", { message: "nothing staged" })).error?.code, -32602);
  await ok("git.stage", { paths: ["a.txt"] });
  assert.equal((await call("git.commit", { message: "   " })).error?.code, -32602);

  const result = await ok("git.commit", { message: "feat: change a\n\nbody" });
  assert.match(result.hash, /^[0-9a-f]{7,}$/);
  assert.equal(result.summary, "feat: change a");
  assert.equal(result.status.files.length, 0);
  assert.equal(sh(ws, "log", "-1", "--format=%s").trim(), "feat: change a");
});

repoTest("git.discard restores tracked files, deletes untracked ones, never the root", async () => {
  const { ws, call, ok } = await repo();
  writeFileSync(join(ws, "a.txt"), "a2\n");
  writeFileSync(join(ws, "junk.txt"), "junk\n");

  const status = await ok("git.discard", { paths: ["a.txt", "junk.txt"] });
  assert.equal(status.files.length, 0);
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "a1\n");
  assert.equal(existsSync(join(ws, "junk.txt")), false);

  assert.equal((await call("git.discard", { paths: ["."] })).error?.code, -32602);
  assert.equal((await call("git.discard", { paths: [] })).error?.code, -32602);
  assert.equal((await call("git.discard", { paths: ["../outside.txt"] })).error?.code, -32001);
  assert.equal((await call("git.discard", { paths: ["b.txt"] })).error?.code, -32602); // unchanged file
  assert.equal(existsSync(join(ws, "b.txt")), true);
});

repoTest("git.discard keeps staged content and only drops worktree edits", async () => {
  const { ws, ok, file } = await repo();
  writeFileSync(join(ws, "a.txt"), "staged\n");
  await ok("git.stage", { paths: ["a.txt"] });
  writeFileSync(join(ws, "a.txt"), "worktree\n");
  const status = await ok("git.discard", { paths: ["a.txt"] });
  assert.equal(readFileSync(join(ws, "a.txt"), "utf8").replace(/\r\n/g, "\n"), "staged\n");
  assert.equal(file(status, "a.txt").staged, true);
  assert.equal(file(status, "a.txt").unstaged, false);
});

repoTest("branches: list, create, switch; dirty switch is blocked", async () => {
  const { ws, call, ok } = await repo();
  let branches = await ok("git.branches");
  assert.equal(branches.current, "main");
  assert.deepEqual(branches.branches.map((b: any) => b.name), ["main"]);

  branches = await ok("git.createBranch", { name: "feat/new" });
  assert.equal(branches.current, "feat/new");
  assert.deepEqual(branches.branches.map((b: any) => b.name).sort(), ["feat/new", "main"]);

  assert.equal((await call("git.createBranch", { name: "bad..name" })).error?.code, -32602);
  assert.equal((await call("git.createBranch", { name: "--force" })).error?.code, -32602);
  assert.equal((await call("git.checkout", { branch: "nope" })).error?.code, -32602);

  writeFileSync(join(ws, "a.txt"), "dirty\n");
  const blocked = await call("git.checkout", { branch: "main" });
  assert.equal(blocked.error?.code, -32017);
  assert.equal((await ok("git.branches")).current, "feat/new");

  await ok("git.discard", { paths: ["a.txt"] });
  writeFileSync(join(ws, "untracked.txt"), "does not block\n");
  assert.equal((await ok("git.checkout", { branch: "main" })).current, "main");
});

repoTest("git.init creates a repository with an unborn branch; first commit works", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ba-git-init-"));
  writeFileSync(join(ws, "readme.md"), "# hi\n");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 1, method: "workspace.add", params: { path: ws } });
  const init = await s.handle({ id: 2, method: "git.init", params: {} });
  assert.equal(init.error, undefined, init.error?.message);
  assert.equal((init.result as any).isRepo, true);
  assert.equal((init.result as any).files[0].untracked, true);
  assert.equal((await s.handle({ id: 3, method: "git.init", params: {} })).error?.code, -32602);

  const branches = (await s.handle({ id: 4, method: "git.branches", params: {} })).result as any;
  assert.equal(branches.branches.length, 1);
  assert.equal(branches.branches[0].current, true);

  // stage + unstage before any commit exists, then commit for real
  await s.handle({ id: 5, method: "git.stage", params: { paths: ["readme.md"] } });
  const unstaged = await s.handle({ id: 6, method: "git.unstage", params: { paths: ["readme.md"] } });
  assert.equal(unstaged.error, undefined, unstaged.error?.message);
  assert.equal((unstaged.result as any).files[0].untracked, true);
  sh(ws, "config", "user.email", "test@example.com");
  sh(ws, "config", "user.name", "Test");
  sh(ws, "config", "commit.gpgsign", "false");
  await s.handle({ id: 7, method: "git.stage", params: { paths: ["readme.md"] } });
  const commit = await s.handle({ id: 8, method: "git.commit", params: { message: "first" } });
  assert.equal(commit.error, undefined, commit.error?.message);
});

repoTest("git.status reports an in-progress merge with conflicts", async () => {
  const { ws, call, ok, file } = await repo();
  sh(ws, "switch", "-q", "-c", "other");
  writeFileSync(join(ws, "a.txt"), "other\n");
  sh(ws, "commit", "-q", "-am", "other");
  sh(ws, "switch", "-q", "main");
  writeFileSync(join(ws, "a.txt"), "main\n");
  sh(ws, "commit", "-q", "-am", "main");
  try { sh(ws, "merge", "-q", "other"); } catch { /* conflict expected */ }

  const status = await ok("git.status");
  assert.equal(status.operation, "merge");
  assert.equal(file(status, "a.txt").conflicted, true);
  assert.equal((await call("git.commit", { message: "x" })).error?.code, -32017);
  assert.equal((await call("git.discard", { paths: ["a.txt"] })).error?.code, -32017);
});

test("parseGitLog splits records, decorations and parents", () => {
  const rec = (...f: string[]) => f.join("\x00") + "\x1e";
  const out = rec("a".repeat(40), "aaaaaaa", "Ann", "ann@example.com", "2026-01-02T03:04:05+07:00", "feat: x, y", "HEAD -> main, origin/main, tag: v1", "b".repeat(40) + " " + "c".repeat(40))
    + "\n" + rec("b".repeat(40), "bbbbbbb", "Bob", "bob@example.com", "2026-01-01T00:00:00Z", "root", "", "") + "\n";
  const commits = parseGitLog(out);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].message, "feat: x, y");
  assert.deepEqual(commits[0].refs, ["HEAD -> main", "origin/main", "tag: v1"]);
  assert.deepEqual(commits[0].parents, ["b".repeat(40), "c".repeat(40)]);
  assert.deepEqual(commits[1].refs, []);
  assert.deepEqual(commits[1].parents, []);
});

repoTest("git.log returns history with refs; maxCount is validated", async () => {
  const { ws, ok, call } = await repo();
  writeFileSync(join(ws, "a.txt"), "a2\n");
  sh(ws, "commit", "-q", "-am", "second");
  const { commits } = await ok("git.log");
  assert.equal(commits.length, 2);
  assert.equal(commits[0].message, "second");
  assert.ok(commits[0].refs.includes("HEAD -> main"));
  assert.equal(commits[0].parents[0], commits[1].hash);
  assert.equal((await ok("git.log", { maxCount: 1 })).commits.length, 1);
  assert.ok((await call("git.log", { maxCount: 0 })).error);
});

repoTest("git.log on a repository without commits is empty", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ba-git-empty-"));
  sh(ws, "init", "-q", "-b", "main");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  const res = await s.handle({ id: 1, method: "git.log", params: {} });
  assert.equal(res.error, undefined, res.error?.message);
  assert.deepEqual((res.result as any).commits, []);
});

test("parseNameStatusZ handles renames and plain records", () => {
  const out = ["M", "a.txt", "R100", "old.txt", "new.txt", "A", "dir/c.txt", ""].join("\0");
  assert.deepEqual(parseNameStatusZ(out), [
    { path: "a.txt", status: "M" },
    { path: "new.txt", origPath: "old.txt", status: "R" },
    { path: "dir/c.txt", status: "A" },
  ]);
});

repoTest("git.commitFiles and git.commitDiff describe one commit", async () => {
  const { ws, ok, call } = await repo();
  const root = (await ok("git.log")).commits[0];
  const rootFiles = await ok("git.commitFiles", { hash: root.hash });
  assert.deepEqual(rootFiles.files.map((f: any) => f.path).sort(), ["a.txt", "b.txt", "dir/c.txt"]);
  assert.ok(rootFiles.files.every((f: any) => f.status === "A"));

  writeFileSync(join(ws, "a.txt"), "a2\n");
  rmSync(join(ws, "b.txt"));
  sh(ws, "commit", "-q", "-am", "edit");
  const head = (await ok("git.log")).commits[0];
  const files = await ok("git.commitFiles", { hash: head.shortHash });
  assert.deepEqual(files.files, [{ path: "a.txt", status: "M" }, { path: "b.txt", status: "D" }]);

  const diff = await ok("git.commitDiff", { hash: head.hash, path: "a.txt" });
  assert.match(diff.diff, /-a1\n\+a2/);
  const rootDiff = await ok("git.commitDiff", { hash: root.hash, path: "dir/c.txt" });
  assert.match(rootDiff.diff, /\+c1/);

  assert.ok((await call("git.commitFiles", { hash: "--all" })).error);
  assert.ok((await call("git.commitFiles", { hash: "deadbeef" })).error);
  assert.ok((await call("git.commitDiff", { hash: head.hash, path: "../outside.txt" })).error);
});
