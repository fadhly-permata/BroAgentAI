import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";
import { ErrorCode } from "./rpc.ts";
import { clearSkillRunHistory } from "./skill-runs.ts";

async function fixture(config: object) {
  const configDir = mkdtempSync(join(tmpdir(), "ba-skill-cfg-"));
  const ws = mkdtempSync(join(tmpdir(), "ba-skill-ws-"));
  mkdirSync(join(ws, ".broagentai"));
  writeFileSync(join(ws, "broagentai.jsonc"), JSON.stringify(config));
  const s = new RpcServer({ store: new WorkspaceStore({ configDir }) });
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

test("skill.list exposes metadata only and rejects command arrays with shell metacharacters", async () => {
  const { ok } = await fixture({ skillRuns: { ping: { command: [process.execPath, "-e", "console.log('ok')"], env: ["BA_SKILL_OK"] } } });
  const data = await ok("skill.list");
  assert.equal(data.skills.length, 1);
  assert.deepEqual(data.skills[0].command, [process.execPath, "-e", "console.log('ok')"]);
  assert.deepEqual(data.skills[0].envKeys, ["BA_SKILL_OK"]);
  assert.equal(JSON.stringify(data).includes("skill-ok"), false);

  const bad = await fixture({ skillRuns: { bad: { command: [process.execPath, "-e", "console.log('x'); echo pwned"] } } });
  assert.ok((await bad.call("skill.list")).error);
});

test("skill.run requires explicit approval and keeps bounded redacted history", async () => {
  clearSkillRunHistory();
  const previous = process.env.BA_SKILL_SECRET;
  process.env.BA_SKILL_SECRET = "skill-secret-value";
  try {
    const { ok, call } = await fixture({ skillRuns: { ping: {
      command: [process.execPath, "-e", "console.log(process.env.BA_SKILL_SECRET)"],
      env: ["BA_SKILL_SECRET"],
      timeoutMs: 5000,
    } } });
    assert.equal((await call("skill.run", { name: "ping" })).error?.code, ErrorCode.NOT_ALLOWED);
    assert.equal((await call("skill.run", { name: "ping", approved: true, command: ["evil"] })).error?.code, ErrorCode.INVALID_PARAMS);

    const result = await ok("skill.run", { name: "ping", approved: true });
    assert.equal(result.name, "ping");
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "skill-secret-value");
    assert.equal(result.shell, undefined);

    const history = await ok("skill.history");
    assert.equal(history.total, 1);
    assert.equal(history.entries[0].approved, true);
    assert.equal(JSON.stringify(history).includes("skill-secret-value"), false);
    assert.equal((await ok("skill.history.clear")).cleared, 1);
    assert.equal((await ok("skill.history")).total, 0);
  } finally {
    if (previous === undefined) delete process.env.BA_SKILL_SECRET;
    else process.env.BA_SKILL_SECRET = previous;
    clearSkillRunHistory();
  }
});

test("skill.run spawns the exact allowlisted command, not its redacted display copy", async () => {
  clearSkillRunHistory();
  const secret = "sk_abcdefghijklmnopqrst";
  const script = "require('node:fs').writeFileSync(process.argv[1], process.argv[2])";
  const { ws, ok } = await fixture({ skillRuns: { echo: {
    command: [process.execPath, "-e", script, "argv.txt", secret],
    timeoutMs: 5000,
  } } });
  try {
    const result = await ok("skill.run", { name: "echo", approved: true });
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(join(ws, "argv.txt"), "utf8"), secret);
    assert.deepEqual(result.command, [process.execPath, "-e", script, "argv.txt", "[REDACTED]"]);

    const history = await ok("skill.history");
    assert.equal(history.total, 1);
    assert.deepEqual(history.entries[0].command, result.command);
    assert.equal(JSON.stringify(history).includes(secret), false);
  } finally {
    clearSkillRunHistory();
  }
});

test("skill.run reports unset allowlisted environment variables without printing values", async () => {
  const { call } = await fixture({ skillRuns: { ping: {
    command: [process.execPath, "-e", "console.log('x')"],
    env: ["BA_SKILL_UNSET_XYZ"],
  } } });
  const res = await call("skill.run", { name: "ping", approved: true });
  assert.equal(res.error?.code, ErrorCode.CONFIG_INVALID);
  assert.match(res.error?.message ?? "", /BA_SKILL_UNSET_XYZ/);
});
