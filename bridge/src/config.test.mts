import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RpcServer } from "./rpc-server.ts";
import { WorkspaceStore } from "./workspace.ts";

function server() {
  const dir = mkdtempSync(join(tmpdir(), "ba-rpc-cfg-"));
  return new RpcServer({ store: new WorkspaceStore({ configDir: dir }) });
}

test("config.get returns merged config with defaults", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-cfg-"));
  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });

  const res = await s.handle({ id: 2, method: "config.get" });
  assert.ok(res.result);
  const cfg = res.result as any;
  assert.equal(cfg.approval, "ask");
  assert.equal(cfg.approvalConfigured, false);
  assert.ok(Array.isArray(cfg.ignore));
  assert.ok(cfg.ignore.includes(".git"));
  assert.equal(typeof cfg.maxFileBytes, "number");
});

test("config.get loads project config from broagentai.jsonc", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-cfg-proj-"));
  writeFileSync(
    join(wsDir, "broagentai.jsonc"),
    `{
      // Override approval
      "approval": "auto",
      "maxFileBytes": 1024,
    }`
  );
  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });

  const res = await s.handle({ id: 2, method: "config.get" });
  const cfg = res.result as any;
  assert.equal(cfg.approval, "auto");
  assert.equal(cfg.maxFileBytes, 1024);
  assert.ok(cfg.sources.project);
});

test("config.get exposes merged script and skill-run allowlists", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-allowlist-"));
  writeFileSync(join(wsDir, "broagentai.jsonc"), JSON.stringify({
    approval: "ask",
    scripts: { emit: { manager: "npm", args: ["--silent"] } },
    skillRuns: { ping: { command: ["node", "-e", "console.log('ok')"], env: ["PING_TOKEN"] } },
  }));
  mkdirSync(join(wsDir, ".broagentai"));
  writeFileSync(join(wsDir, ".broagentai", "config.json"), JSON.stringify({
    scripts: { emit: { manager: "pnpm", timeoutMs: 5000 } },
  }));
  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });

  const res = await s.handle({ id: 2, method: "config.get" });
  const cfg = res.result as any;
  assert.equal(cfg.approvalConfigured, true);
  assert.deepEqual(cfg.scripts, { emit: { manager: "pnpm", timeoutMs: 5000 } });
  assert.deepEqual(cfg.skillRuns, { ping: { command: ["node", "-e", "console.log('ok')"], env: ["PING_TOKEN"] } });
});

test("instructions.list returns AGENTS.md and rules", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-instr-"));
  writeFileSync(join(wsDir, "AGENTS.md"), "# Agent Instructions");
  mkdirSync(join(wsDir, "rules"));
  writeFileSync(join(wsDir, "rules", "coding.md"), "# Coding Rules");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "instructions.list" });

  const data = res.result as any;
  assert.ok(data.agents);
  assert.equal(data.agents.name, "AGENTS.md");
  assert.equal(data.instructions.length, 2); // AGENTS.md + coding.md
});

test("instructions.get loads a specific rule file", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-rule-"));
  mkdirSync(join(wsDir, "rules"));
  writeFileSync(join(wsDir, "rules", "coding.md"), "# Coding Rules");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "instructions.get", params: { path: "coding.md" } });

  assert.ok(res.result);
  const rule = res.result as any;
  assert.equal(rule.name, "coding.md");
  assert.equal(rule.content, "# Coding Rules");
});

test("skills.list returns skill files", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-skills-"));
  mkdirSync(join(wsDir, "skills"));
  writeFileSync(join(wsDir, "skills", "refactor.md"), "# Refactor Skill");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "skills.list" });

  const data = res.result as any;
  assert.equal(data.skills.length, 1);
  assert.equal(data.skills[0].name, "refactor.md");
});

test("skills.get loads a specific skill file", async () => {
  const s = server();
  const wsDir = mkdtempSync(join(tmpdir(), "ba-ws-skill-"));
  mkdirSync(join(wsDir, "skills"));
  writeFileSync(join(wsDir, "skills", "refactor.md"), "# Refactor Skill");

  await s.handle({ id: 1, method: "workspace.add", params: { path: wsDir } });
  const res = await s.handle({ id: 2, method: "skills.get", params: { name: "refactor.md" } });

  assert.ok(res.result);
  const skill = res.result as any;
  assert.equal(skill.name, "refactor.md");
  assert.equal(skill.content, "# Refactor Skill");
});
