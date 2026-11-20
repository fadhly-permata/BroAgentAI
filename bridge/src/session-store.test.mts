import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { SessionStore, validateSessionId } from "./session-store.ts";
import { WorkspaceStore } from "./workspace.ts";

function snapshot(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    createdAt: "2026-01-02T03:04:05.000Z",
    provider: "Claude",
    totalCalls: 4,
    lastSent: "hi",
    lastReplyText: "working",
    logs: [{ time: "10:00", tool: "fs.readFile", category: "read", decision: "auto", status: "ok", ms: 3 }],
    ...over,
  };
}

function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), "ba-sess-cfg-"));
  const server = new RpcServer({ store: new WorkspaceStore({ configDir }) });
  const call = async (method: string, params: unknown = {}) => {
    const res = await server.handle({ id: 1, method, params });
    if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
    return res.result as any;
  };
  return { configDir, server, call, cleanup: () => rmSync(configDir, { recursive: true, force: true }) };
}

test("save then load returns the normalized snapshot", async () => {
  const { call, cleanup } = fixture();
  try {
    const summary = await call("session.save", { id: "task-1", snapshot: snapshot() });
    assert.equal(summary.id, "task-1");
    assert.equal(summary.provider, "Claude");
    const loaded = await call("session.load", { id: "task-1" });
    assert.equal(loaded.id, "task-1");
    assert.equal(loaded.version, 1);
    assert.equal(loaded.logs.length, 1);
  } finally {
    cleanup();
  }
});

test("load of a missing session is null; clear reports whether it removed one", async () => {
  const { call, cleanup } = fixture();
  try {
    assert.equal(await call("session.load", { id: "nope" }), null);
    assert.deepEqual(await call("session.clear", { id: "nope" }), { cleared: false });
    await call("session.save", { id: "gone", snapshot: snapshot() });
    assert.deepEqual(await call("session.clear", { id: "gone" }), { cleared: true });
    assert.equal(await call("session.load", { id: "gone" }), null);
  } finally {
    cleanup();
  }
});

test("session IDs are restricted so a caller cannot escape the sessions folder", async () => {
  const { call, cleanup } = fixture();
  try {
    for (const bad of ["../evil", "a/b", "", "x".repeat(65), "a b"]) {
      assert.throws(() => validateSessionId(bad));
      await assert.rejects(call("session.save", { id: bad, snapshot: snapshot() }));
    }
  } finally {
    cleanup();
  }
});

test("an invalid snapshot is rejected on save", async () => {
  const { call, cleanup } = fixture();
  try {
    await assert.rejects(call("session.save", { id: "bad", snapshot: { version: 2, logs: [] } }));
    await assert.rejects(call("session.save", { id: "bad", snapshot: { version: 1 } }));
    await assert.rejects(call("session.save", { id: "bad", snapshot: null }));
  } finally {
    cleanup();
  }
});

test("list returns saved sessions newest first and skips junk", async () => {
  const { call, cleanup } = fixture();
  try {
    await call("session.save", { id: "old", snapshot: snapshot({ createdAt: "2026-01-01T00:00:00.000Z" }) });
    await call("session.save", { id: "new", snapshot: snapshot({ createdAt: "2026-03-01T00:00:00.000Z" }) });
    const { sessions } = await call("session.list", {});
    assert.deepEqual(sessions.map((s: any) => s.id), ["new", "old"]);
  } finally {
    cleanup();
  }
});

test("SessionStore on a missing folder lists nothing and loads null", () => {
  const store = new SessionStore(join(tmpdir(), "ba-sess-none-" + Date.now()));
  assert.deepEqual(store.list(), []);
  assert.equal(store.load("x"), null);
});

test("the chat transcript is kept, bounded and cleaned; old snapshots load with []", async () => {
  const { call, cleanup } = fixture();
  try {
    await call("session.save", {
      id: "task-t",
      snapshot: snapshot({
        transcript: [
          { role: "user", text: "  tambah fitur export CSV  " },
          { role: "assistant", text: "oke" },
          { role: "robot", text: "dropped: unknown role" },
          { role: "tool", text: "x".repeat(10_000) },
          { role: "user", text: "   " },
        ],
      }),
    });
    const loaded = await call("session.load", { id: "task-t" });
    assert.equal(loaded.transcript.length, 3);
    assert.deepEqual(loaded.transcript[0], { role: "user", text: "tambah fitur export CSV" });
    assert.ok(loaded.transcript[2].text.length <= 4_000, "tool output capped");

    await call("session.save", { id: "task-old", snapshot: snapshot() });
    assert.deepEqual((await call("session.load", { id: "task-old" })).transcript, []);
  } finally {
    cleanup();
  }
});
