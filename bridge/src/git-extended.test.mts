import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { ErrorCode } from "./rpc.ts";
import { parseBlamePorcelain, parseStashList, parseZeroDiff } from "./git.ts";

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const repoTest = (name: string, fn: () => Promise<void>) => test(name, { skip: hasGit ? false : "git not installed" }, fn);

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

async function repo() {
  const ws = mkdtempSync(join(tmpdir(), "ba-git-extra-"));
  sh(ws, "init", "-q", "-b", "main");
  sh(ws, "config", "user.email", "test@example.com");
  sh(ws, "config", "user.name", "Test");
  sh(ws, "config", "commit.gpgsign", "false");
  writeFileSync(join(ws, "a.txt"), "a1\n");
  writeFileSync(join(ws, "multi.txt"), "one\ntwo\nthree\n");
  sh(ws, "add", "-A");
  sh(ws, "commit", "-q", "-m", "init");
  const s = new RpcServer({ store: new WorkspaceStore({ configDir: mkdtempSync(join(tmpdir(), "ba-git-extra-cfg-")) }) });
  await s.handle({ id: 0, method: "workspace.add", params: { path: ws } });
  let id = 1;
  const call = (method: string, params: unknown = {}) => s.handle({ id: id++, method, params });
  const ok = async (method: string, params: unknown = {}) => {
    const res = await call(method, params);
    assert.equal(res.error, undefined, `${method} failed: ${res.error?.message}`);
    return res.result as any;
  };
  return { ws, call, ok };
}

test("parseBlamePorcelain and parseStashList read bounded porcelain output", () => {
  const hash = "a".repeat(40);
  const blamed = parseBlamePorcelain([
    `${hash} 1 1 1`,
    "author Test",
    "author-mail <test@example.com>",
    "author-time 1700000000",
    "summary init",
    "\ta1",
    "",
  ].join("\n"));
  assert.equal(blamed.length, 1);
  assert.equal(blamed[0].line, 1);
  assert.equal(blamed[0].hash, hash);
  assert.equal(blamed[0].author, "Test");
  assert.equal(blamed[0].authorEmail, "test@example.com");
  assert.equal(blamed[0].text, "a1");

  const stashes = parseStashList(`stash@{0}\0${hash}\0On main: wip\u00002026-01-01T00:00:00+00:00`);
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].branch, "main");
  assert.equal(stashes[0].message, "wip");

  const zero = parseZeroDiff([
    "diff --git a/f.txt b/f.txt",
    "index 111..222 100644",
    "--- a/f.txt",
    "+++ b/f.txt",
    "@@ -1 +1 @@",
    "-one",
    "+ONE",
    "@@ -3 +3 @@ tail",
    "-three",
    "+THREE",
    "",
  ].join("\n"));
  assert.equal(zero.groups.length, 2);
  assert.deepEqual(zero.groups[1].added, [3]);
});

repoTest("git.blame returns attributed lines for one file", async () => {
  const { ok } = await repo();
  const result = await ok("git.blame", { path: "a.txt" });
  assert.equal(result.path, "a.txt");
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].text, "a1");
  assert.equal(result.lines[0].author, "Test");
});

repoTest("git stash list/push/pop/drop requires explicit confirmation for destructive steps", async () => {
  const { ws, ok, call } = await repo();
  assert.deepEqual((await ok("git.stashList")).entries, []);

  writeFileSync(join(ws, "a.txt"), "changed\n");
  const pushed = await ok("git.stashPush", { message: "wip" });
  assert.equal(pushed.entries.length, 1);
  assert.equal(pushed.entries[0].message, "wip");
  assert.equal(readText(join(ws, "a.txt")), "a1\n");

  assert.equal((await call("git.stashPop", { index: 0 })).error?.code, ErrorCode.NOT_ALLOWED);
  const popped = await ok("git.stashPop", { index: 0, confirmed: true });
  assert.deepEqual(popped.entries, []);
  assert.equal(readText(join(ws, "a.txt")), "changed\n");

  writeFileSync(join(ws, "a.txt"), "changed again\n");
  await ok("git.stashPush", { message: "drop me" });
  assert.equal((await call("git.stashDrop", { index: 0 })).error?.code, ErrorCode.NOT_ALLOWED);
  const dropped = await ok("git.stashDrop", { index: 0, confirmed: true });
  assert.deepEqual(dropped.entries, []);
  assert.equal(readText(join(ws, "a.txt")), "a1\n");
});

repoTest("git.stageLines stages only the selected unstaged lines", async () => {
  const { ws, ok } = await repo();
  writeFileSync(join(ws, "multi.txt"), "ONE\ntwo\nTHREE\n");

  const staged = await ok("git.stageLines", { path: "multi.txt", lines: [3] });
  assert.deepEqual(staged.stagedLines, [3]);
  const cached = sh(ws, "diff", "--cached", "--", "multi.txt");
  assert.match(cached, /\+THREE/);
  assert.doesNotMatch(cached, /\+ONE/);
  const remaining = sh(ws, "diff", "--", "multi.txt");
  assert.match(remaining, /\+ONE/);
  assert.doesNotMatch(remaining, /\+THREE/);
});
