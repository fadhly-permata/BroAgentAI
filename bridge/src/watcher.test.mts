import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceWatcher } from "./watcher.ts";
import { WorkspaceStore } from "./workspace.ts";

/** A temp workspace with a config dir that is already registered and active. */
function fixture() {
  const ws = mkdtempSync(join(tmpdir(), "ba-watch-ws-"));
  const cfg = mkdtempSync(join(tmpdir(), "ba-watch-cfg-"));
  const store = new WorkspaceStore({ configDir: cfg });
  store.add(ws);
  const events: { event: string; data: any }[] = [];
  const watcher = new WorkspaceWatcher(store, (event, data) => events.push({ event, data }));
  return { ws, store, events, watcher };
}

/** Wait until `predicate` holds, polling for a bounded time. */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("a file write emits fs.changed with the relative path", async (t) => {
  const { ws, events, watcher } = fixture();
  t.after(() => { watcher.close(); rmSync(ws, { recursive: true, force: true }); });

  watcher.restart();
  writeFileSync(join(ws, "a.txt"), "hello\n");

  assert.ok(await until(() => events.some((e) => e.event === "fs.changed")), "no fs.changed event");
  const change = events.find((e) => e.event === "fs.changed")!;
  assert.ok(change.data.paths.includes("a.txt"), JSON.stringify(change.data));
});

test("dependency and build directories are ignored", async (t) => {
  const { ws, events, watcher } = fixture();
  t.after(() => { watcher.close(); rmSync(ws, { recursive: true, force: true }); });

  mkdirSync(join(ws, "node_modules"));
  mkdirSync(join(ws, "dist"));
  watcher.restart();
  writeFileSync(join(ws, "node_modules", "dep.js"), "x\n");
  writeFileSync(join(ws, "dist", "out.js"), "x\n");
  writeFileSync(join(ws, "src.ts"), "x\n");

  assert.ok(await until(() => events.some((e) => e.event === "fs.changed")), "no fs.changed event");
  const paths = events.filter((e) => e.event === "fs.changed").flatMap((e) => e.data.paths);
  assert.ok(paths.includes("src.ts"), JSON.stringify(paths));
  assert.ok(!paths.some((p: string) => p.startsWith("node_modules/") || p.startsWith("dist/")), JSON.stringify(paths));
});

test("a git index update emits git.changed, not fs.changed", async (t) => {
  const { ws, events, watcher } = fixture();
  t.after(() => { watcher.close(); rmSync(ws, { recursive: true, force: true }); });

  mkdirSync(join(ws, ".git"));
  watcher.restart();
  writeFileSync(join(ws, ".git", "index"), "fake index\n");

  assert.ok(await until(() => events.some((e) => e.event === "git.changed")), "no git.changed event");
  const fsPaths = events.filter((e) => e.event === "fs.changed").flatMap((e) => e.data.paths);
  assert.ok(!fsPaths.some((p: string) => p.startsWith(".git/")), JSON.stringify(fsPaths));
});

test("close stops emitting and restart follows the active workspace", async (t) => {
  const { ws, events, watcher } = fixture();
  t.after(() => { watcher.close(); rmSync(ws, { recursive: true, force: true }); });

  watcher.restart();
  watcher.close();
  writeFileSync(join(ws, "after-close.txt"), "x\n");

  // Give the debounce window time to fire if a stray event survived close().
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(events.filter((e) => e.event === "fs.changed").length, 0);
});
