import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { CONTEXT_TEMPLATE, clipToBytes, ensureContextTemplate, extractBroAgentSection, readContext, redactSecrets, summarizeContext } from "./context.ts";

function workspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("extractBroAgentSection stops at the next level-two heading", () => {
  const section = extractBroAgentSection("# Title\n\n## BroAgentAI\nProject note.\n\n## Other\nOther note.\n");
  assert.equal(section, "## BroAgentAI\nProject note.");
  assert.equal(extractBroAgentSection("# Title\nNo context.\n"), null);
});

test("redactSecrets masks tokens, passwords, headers and credentials in URLs", () => {
  const redacted = redactSecrets("Authorization: Bearer abcdefghijklmnopqrst\napi_key: \"sk-abcdefghijklmnopqrstuvwxyz\"\npassword=hunter2secret\nurl=https://user:pass@example.com/x");
  assert.ok(!redacted.includes("abcdefghijklmnopqrst"));
  assert.ok(!redacted.includes("hunter2secret"));
  assert.ok(!redacted.includes("user:pass@"));
  assert.match(redacted, /Authorization: \[REDACTED\]/);
  assert.match(redacted, /api_key: "\[REDACTED\]"/);
  assert.match(redacted, /password=\[REDACTED\]/);
  assert.match(redacted, /https:\/\/\[REDACTED\]@example\.com/);
});

test("context summaries stay within the 2 KB byte budget", () => {
  const result = summarizeContext("## BroAgentAI\n" + "x".repeat(5000));
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.summary, "utf8") <= 2048);
  assert.match(result.summary, /\[\.\.\. konteks dipotong/);

  const clipped = clipToBytes("😀".repeat(1000), 64);
  assert.equal(clipped.truncated, true);
  assert.ok(Buffer.byteLength(clipped.text, "utf8") <= 64);
});

test("readContext returns only the redacted section and never modifies AGENTS.md", () => {
  const ws = workspace("ba-context-read-");
  const file = join(ws, "AGENTS.md");
  writeFileSync(file, "# Rules\nAlways answer in haiku.\n\n## BroAgentAI\nAPI token: abcdefghijklmnopqrstuvwxyz\n\n## Other\nignored\n");
  const before = readFileSync(file, "utf8");

  const context = readContext(ws);
  assert.equal(context.found, true);
  assert.equal(context.section?.includes("## Other"), false);
  assert.ok(!context.summary.includes("abcdefghijklmnopqrstuvwxyz"));
  assert.equal(context.redacted, true);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("ensureContextTemplate appends once without overwriting existing content", () => {
  const ws = workspace("ba-context-append-");
  const file = join(ws, "AGENTS.md");
  writeFileSync(file, "# Rules\nKeep existing.\n");

  const first = ensureContextTemplate(ws);
  assert.equal(first.created, false);
  assert.equal(first.appended, true);
  const afterFirst = readFileSync(file, "utf8");
  assert.ok(afterFirst.startsWith("# Rules\nKeep existing.\n"));
  assert.equal(afterFirst.split("## BroAgentAI").length - 1, 1);

  const second = ensureContextTemplate(ws);
  assert.equal(second.changed, false);
  assert.equal(readFileSync(file, "utf8"), afterFirst);

  const fresh = workspace("ba-context-create-");
  assert.equal(ensureContextTemplate(fresh).created, true);
  assert.equal(readFileSync(join(fresh, "AGENTS.md"), "utf8"), CONTEXT_TEMPLATE);
});

test("context RPC methods expose the same contract", async () => {
  const configDir = workspace("ba-context-rpc-cfg-");
  const ws = workspace("ba-context-rpc-ws-");
  writeFileSync(join(ws, "AGENTS.md"), "# Rules\n\n## BroAgentAI\n- Use npm test.\n");
  const server = new RpcServer({ store: new WorkspaceStore({ configDir }) });
  await server.handle({ id: 1, method: "workspace.add", params: { path: ws } });

  const ensured = await server.handle({ id: 2, method: "context.ensureTemplate" });
  assert.equal(ensured.error, undefined);
  assert.equal((ensured.result as any).changed, false);

  const read = await server.handle({ id: 3, method: "context.read" });
  assert.equal(read.error, undefined);
  assert.equal((read.result as any).found, true);
  assert.match((read.result as any).section, /Use npm test/);
});
