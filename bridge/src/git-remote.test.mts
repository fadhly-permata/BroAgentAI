import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const repoTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasGit ? false : "git not installed" }, fn);

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function identity(dir: string) {
  sh(dir, "config", "user.email", "test@example.com");
  sh(dir, "config", "user.name", "Test");
  sh(dir, "config", "commit.gpgsign", "false");
}

/**
 * A bare "origin", the workspace clone (`ws`) and a second clone (`other`)
 * used to create upstream commits. Both clones start at one shared commit.
 */
async function remoteFixture() {
  const base = mkdtempSync(join(tmpdir(), "ba-git-remote-"));
  const origin = join(base, "origin.git");
  sh(base, "init", "-q", "--bare", "-b", "main", origin);
  const seed = join(base, "seed");
  sh(base, "clone", "-q", origin, seed);
  identity(seed);
  writeFileSync(join(seed, "a.txt"), "base\n");
  sh(seed, "add", "-A");
  sh(seed, "commit", "-q", "-m", "base");
  sh(seed, "push", "-q", "-u", "origin", "main");

  const ws = join(base, "ws");
  const other = join(base, "other");
  sh(base, "clone", "-q", origin, ws);
  sh(base, "clone", "-q", origin, other);
  identity(ws);
  identity(other);

  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  /** Commit `content` to `file` in the other clone and push it upstream. */
  const upstreamCommit = (file: string, content: string, message: string) => {
    writeFileSync(join(other, file), content);
    sh(other, "add", "-A");
    sh(other, "commit", "-q", "-m", message);
    sh(other, "push", "-q");
  };
  const localCommit = (file: string, content: string, message: string) => {
    writeFileSync(join(ws, file), content);
    sh(ws, "add", "-A");
    sh(ws, "commit", "-q", "-m", message);
  };
  const read = (file: string) => readFileSync(join(ws, file), "utf8").replace(/\r\n/g, "\n");
  return { ws, other, origin, call, ok, upstreamCommit, localCommit, read };
}

repoTest("git.status lists remotes and upstream", async () => {
  const { ok } = await remoteFixture();
  const status = await ok("git.status");
  assert.deepEqual(status.remotes, ["origin"]);
  assert.equal(status.upstream, "origin/main");
  assert.equal((await ok("git.testRemote")).reachable, true);
});

repoTest("git.fetch updates behind without touching the working tree", async () => {
  const { ok, upstreamCommit, read } = await remoteFixture();
  upstreamCommit("a.txt", "upstream\n", "upstream change");
  const status = await ok("git.fetch");
  assert.equal(status.behind, 1);
  assert.equal(status.ahead, 0);
  assert.equal(read("a.txt"), "base\n");
});

repoTest("git.pull ff-only fast-forwards, and refuses a divergent history", async () => {
  const { ok, call, upstreamCommit, localCommit, read } = await remoteFixture();
  upstreamCommit("a.txt", "upstream\n", "upstream change");
  let status = await ok("git.pull", {});
  assert.equal(status.behind, 0);
  assert.equal(read("a.txt"), "upstream\n");

  upstreamCommit("b.txt", "b\n", "upstream adds b");
  localCommit("c.txt", "c\n", "local adds c");
  const refused = await call("git.pull", { mode: "ff-only" });
  assert.equal(refused.error?.code, -32018);
  status = await ok("git.status");
  assert.equal(status.operation, null); // nothing left half-done
  assert.equal((await call("git.pull", { mode: "force" })).error?.code, -32602);
});

repoTest("git.pull merge and rebase integrate non-conflicting divergence", async () => {
  for (const mode of ["merge", "rebase"]) {
    const { ok, upstreamCommit, localCommit, read } = await remoteFixture();
    upstreamCommit("b.txt", "b\n", "upstream adds b");
    localCommit("c.txt", "c\n", "local adds c");
    const status = await ok("git.pull", { mode });
    assert.equal(status.behind, 0, mode);
    assert.equal(status.operation, null, mode);
    assert.equal(read("b.txt"), "b\n", mode);
    assert.equal(read("c.txt"), "c\n", mode);
  }
});

repoTest("git.pull conflict is reported, left for the user, and git.abort restores", async () => {
  for (const mode of ["merge", "rebase"]) {
    const { ok, call, upstreamCommit, localCommit, read } = await remoteFixture();
    upstreamCommit("a.txt", "upstream\n", "upstream edits a");
    localCommit("a.txt", "local\n", "local edits a");

    const pulled = await call("git.pull", { mode });
    assert.equal(pulled.error?.code, -32017, mode);
    let status = await ok("git.status");
    assert.equal(status.operation, mode, mode);
    assert.ok(status.files.some((f: any) => f.path === "a.txt" && f.conflicted), mode);
    assert.equal((await call("git.pull", { mode })).error?.code, -32017, mode); // no second pull on top

    status = await ok("git.abort");
    assert.equal(status.operation, null, mode);
    assert.equal(status.files.length, 0, mode);
    assert.equal(read("a.txt"), "local\n", mode);
    assert.equal((await call("git.abort")).error?.code, -32602, mode);
  }
});

repoTest("git.push sends commits and publishes a new branch with an upstream", async () => {
  const { ws, origin, ok, localCommit } = await remoteFixture();
  localCommit("c.txt", "c\n", "local adds c");
  let status = await ok("git.status");
  assert.equal(status.ahead, 1);
  status = await ok("git.push");
  assert.equal(status.ahead, 0);
  assert.equal(sh(origin, "log", "-1", "--format=%s", "main").trim(), "local adds c");

  await ok("git.createBranch", { name: "feat/publish" });
  localCommit("d.txt", "d\n", "on feature");
  status = await ok("git.push");
  assert.equal(status.publishedTo, "origin/feat/publish");
  assert.equal(status.upstream, "origin/feat/publish");
  assert.equal(sh(origin, "log", "-1", "--format=%s", "feat/publish").trim(), "on feature");
  assert.equal(sh(ws, "rev-parse", "--abbrev-ref", "@{upstream}").trim(), "origin/feat/publish");
});

repoTest("git.push is rejected (not forced) when the remote has moved", async () => {
  const { origin, call, upstreamCommit, localCommit } = await remoteFixture();
  upstreamCommit("b.txt", "b\n", "upstream adds b");
  localCommit("c.txt", "c\n", "local adds c");
  const pushed = await call("git.push");
  assert.equal(pushed.error?.code, -32018);
  assert.equal(sh(origin, "log", "-1", "--format=%s", "main").trim(), "upstream adds b");
});

repoTest("remote operations fail clearly without a remote", async () => {
  const ws = mkdtempSync(join(tmpdir(), "ba-git-noremote-"));
  sh(ws, "init", "-q", "-b", "main");
  identity(ws);
  writeFileSync(join(ws, "a.txt"), "a\n");
  sh(ws, "add", "-A");
  sh(ws, "commit", "-q", "-m", "init");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-cfg-")) }) });
  await s.handle({ id: 1, method: "workspace.add", params: { path: ws } });
  assert.deepEqual(((await s.handle({ id: 2, method: "git.status", params: {} })).result as any).remotes, []);
  assert.equal((await s.handle({ id: 3, method: "git.push", params: {} })).error?.code, -32602);
  assert.equal((await s.handle({ id: 4, method: "git.testRemote", params: {} })).error?.code, -32602);
});
