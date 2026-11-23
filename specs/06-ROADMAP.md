# BroAgentAI — Roadmap

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Date | 2026-11-15 |
| Related | `00-PRD.md`, `01-BRD.md`, `02-TSD.md`, `03-FSD.md`, `04-ERD.md`, `05-ADR.md`, `07-PLUGIN-MCP.md` |

## 1. Guiding principles

- Ship a safe, usable vertical slice before breadth.
- Native Messaging and the protocol come first; every later feature uses them.
- Provider adapters are the highest-risk area; start with the most stable.
- No feature ships without a recovery path.
- Documentation, typecheck, and tests accompany each milestone.

## 2. Milestone overview

| Milestone | Theme | Estimate | Exit criteria |
| --- | --- | --- | --- |
| M0 | Foundation + extensibility types | 3–5 days | Panel opens, host connects, workspace list/add/recent works; provider manifest generation works. |
| M1 | Workspace + config/resources + filesystem | 5–8 days | Config merge, AGENTS/rules/skills/agents discovery, explorer, read/search, watcher. |
| M2 | Editor + search UI | 4–6 days | Edit/save with conflict detection; search UI opens results. |
| M3 | SCM core | 5–7 days | Status, diff, stage, commit, branches. |
| M4 | Remote sync | 4–6 days | Fetch/pull/push, auth guidance, conflicts, pull modes. |
| M5 | Agent loop + DeepSeek plugin | 6–9 days | Full read → edit → verify loop with approvals, instructions, skills, agent profiles. |
| M6 | Gemini + Qwen + recovery | 6–10 days | Three provider plugins, recovery, docs, release candidate for core app. |
| M7 | MCP core | 5–8 days | Trusted stdio MCP server, tool catalog, approvals, settings UI. |
| M8 | Remote MCP + release | 3–5 days | HTTP/SSE MCP, trust polish, release checklist. |

Total: ~41–64 developer-days for one experienced developer. Provider breakage and MCP transport issues can extend M5–M8.

## 3. M0 — Foundation

### Goal

Prove the end-to-end plumbing: Chrome side panel ↔ service worker ↔ native host, with one real workspace.

### Deliverables

- npm workspaces root with `shared`, `extension`, `bridge`, `scripts`.
- `shared/src/protocol.ts`: envelope, methods, error codes, risk classes, config/MCP/provider types.
- MV3 manifest with side panel, `nativeMessaging`, `storage`, `tabs`, stable `key`.
- Provider manifest generator: scans `extension/src/providers/*/provider.json` and injects host permissions/content scripts.
- Provider registry with `import.meta.glob` and a fixture plugin.
- React + Vite + CRXJS panel shell: header, activity rail placeholders, status bar.
- Native host: frame reader/writer, `system.ping`, `system.info`, `workspace.list/add/remove/setActive/validate`, graceful shutdown.
- App config store with atomic writes and `BROAGENTAI_CONFIG_DIR`.
- Dev scripts: `host:build`, `host:install:dev`, `host:uninstall:dev`.
- Panel states: host offline/ready/outdated/error, no workspace, recent list.
- README setup steps.

### Acceptance

- [x] `npm install` and `npm run typecheck` pass.
- [x] `npm run host:build` produces an executable.
- [x] `host:install:dev` registers `com.broagentai.host` for the extension ID.
- [x] Loading `extension/dist` unpacked opens the side panel.
- [x] Panel shows `Ready` after `system.ping` without a terminal.
- [x] Add a folder; it appears in recent and survives restart.
- [x] Invalid path shows an inline error; duplicate focuses the existing workspace.
- [x] Restart companion reconnects.
- [x] Adding a fixture provider folder changes the generated manifest and registry without core edits.
- [x] Shared config/MCP/provider types compile with no provider-specific branching in the core.

### Risks

- Windows binary framing quirks → integration test with a Node client.
- CRXJS/Vite version mismatch → pin and verify early.
- Generated manifest complexity → snapshot test and Chrome load check.
- Over-designing extensibility before the first provider works → keep interfaces minimal and fixture-driven.

## 4. M1 — Workspace, configuration, resources, and filesystem

### Goal

A dependable local foundation: workspace/config loading, resource discovery, and a confined read-only filesystem tree.

### Deliverables

- `fs.listDir`, `fs.listTree` (depth/cursor), `fs.stat`, `fs.readFile` (cap), `fs.readFileLines`, `fs.search`, `fs.find`.
- Path confinement with realpath and symlink handling.
- Ignore rules (`.git`, `node_modules`, `.venv`, `dist`, `build`, configurable).
- Binary detection and size caps.
- Watcher with debounced `fs.changed`.
- JSONC parser + config loader: global/project/local precedence, diagnostics, size caps.
- Resource loader: `AGENTS.md`, `BROAGENTAI.md`, rules, skills, agents, commands; frontmatter; budgets.
- RPC: `config.get/reload/validate`, `instructions.list`, `skills.list/read`, `agents.list/read`, `commands.list`.
- Explorer tree: expand/collapse, icons, ignored toggle, loading/empty/error states.
- Host unit tests: traversal, symlink escape, caps, search limits, config precedence, resource discovery.

### Acceptance

- [x] Explorer loads the workspace root and expands directories lazily.
- [x] Opening a file reads content up to the cap; larger files show a notice.
- [x] `../` and symlink escapes return `PATH_ESCAPE`.
- [x] Search returns grouped results (backend only; UI in M2) capped at 500.
- [x] Creating/deleting files in the OS updates the tree within ~1 s.
- [x] `broagentai.jsonc` with comments loads; invalid JSONC shows line/column.
- [x] Global/project/local precedence is deterministic and tested.
- [x] `AGENTS.md`, rules, skills, agents, and commands are discovered without executing anything.
- [x] Skill body is read on demand, not injected wholesale.
- [x] Tests cover path escape, binary detection, config merge, and resource budgets.

### Risks

- Huge repositories → lazy loading, caps, ignores.
- Windows path separators → normalize at the boundary.
- Watcher storms → debounce and ignore filters.
- Config/resource scope creep → implement the documented schema only; defer globs and advanced frontmatter.

## 5. M2 — Editor and search UI

### Goal

Write files safely and find code quickly.

### Deliverables

- Editor tab (`editor.html`) with CodeMirror 6, language detection, tabs, dirty state.
- Save with `baseMtime`; `MTIME_CONFLICT` banner with Reload/Overwrite/Diff.
- External change handling for clean/dirty buffers.
- Create/rename/delete flows with confirmations.
- Search UI: query, toggles (case, regex, include/exclude), grouped results, open at line.
- Explorer Git badges (data from M3; fully implemented).
- Keyboard shortcuts and accessibility pass.

### Acceptance

- [x] Open, edit, save a file; reload shows the change.
- [x] External edit with a clean buffer reloads; dirty buffer warns.
- [x] Conflict on save offers Reload/Overwrite/Diff.
- [x] Search opens the file at the matching line.
- [x] Invalid regex shows an inline error.
- [x] Rename/delete update the tree and search results.

### Risks

- CodeMirror bundle size → code-split the editor page.
- Encoding issues → UTF-8 only in MVP, binary detection.
- Tab state loss → persist in `chrome.storage.session`.

## 6. M3 — SCM core

### Goal

A complete local Git loop: see changes, inspect diffs, stage, commit, branch.

### Deliverables

- Git detection and repo metadata (branch, upstream, remotes, operation state).
- `git.status` with porcelain v2 parser and ahead/behind.
- `git.diff` per file, staged/unstaged, truncated flag.
- Stage, unstage, discard (with confirmation), commit.
- Branch list, create, switch (dirty-tree guard).
- SCM panel: groups, badges, commit box, diff tab.
- Parser and host tests with fixture repositories.

### Acceptance

- [x] Status matches `git status` for modified/added/deleted/renamed/untracked.
- [x] Diff viewer shows additions/removals for staged and unstaged.
- [x] Stage/unstage/commit work; commit requires a message and staged changes.
- [x] Create/switch branch works; dirty switch is blocked with guidance.
- [x] Discard requires confirmation and cannot target the workspace root.
- [x] Non-repo workspaces show a clear state without errors.

### Risks

- Porcelain parsing edge cases (renames, conflicts).
- Hooks producing unexpected output → show stderr.
- Large diffs → per-file cap and truncation.

## 7. M4 — Remote sync

### Goal

Fetch, pull, and push safely with actionable auth and conflict handling.

### Deliverables

- `git.fetch`, `git.pull` (ff-only/merge/rebase), `git.push`, `git.testRemote`.
- Confirmation dialogs with remote/branch/ahead/behind.
- Auth failure mapping and setup guidance.
- Conflict detection, banner, open conflicted files, abort merge/rebase.
- Upstream setup on first push.
- No force-push.

### Acceptance

- [x] Fetch updates ahead/behind without changing the working tree.
- [x] Pull in all three modes behaves as expected on a divergent test repo.
- [x] Push works; first push offers `-u origin <branch>`.
- [x] Auth failure shows guidance and Test remote.
- [x] Conflicts show Abort and no auto-resolution.
- [x] Push/pull always require confirmation unless auto-sync is explicitly enabled.

### Risks

- Credential helper differences across OSes.
- Rebase conflicts leaving state behind → surface and abort.
- Network timeouts → 120 s cap and clear error.

## 8. M5 — Agent loop with DeepSeek

### Goal

The first complete AI-driven workflow: read, edit, verify, summarize, with project instructions and skills.

### Deliverables

- Provider plugin contract + registry (fixture plugin from M0 promoted to real registration).
- DeepSeek plugin: composer, submit, stream detection, reply extraction, stop, health check.
- Operating prompt with effective config: instructions, rules, skills metadata, agent profiles, tool catalog.
- Skill/agent/command RPC integration; `skills.read` on demand.
- Agent profile selection (mode/provider restrictions) in the panel.
- Command parser, corrective feedback, reminder cadence.
- Agent loop in the service worker with iteration limit and cancellation.
- Tool catalog from the host; risk mapping.
- Approval modes enforced in service worker and host.
- Agent panel: session start, conversation log, approval cards, command log, stop.
- Session persistence in `chrome.storage.session`.

### Acceptance

- [x] Session starts and the AI confirms readiness.
- [x] "Add a comment to README" completes read → write → summary.
- [x] `AGENTS.md` and rules are present in the prompt; a skill is read on demand.
- [x] Selecting an agent profile changes prompt context and may restrict mode/provider, but cannot elevate the approval mode.
- [x] Read-only denies writes; Ask prompts; Auto-edit auto-approves writes.
- [x] Approval card shows a diff preview.
- [x] Malformed/multiple commands produce corrective feedback.
- [x] Host/provider failures pause with a recovery action.
- [x] Stop cancels generation and pending work.

### Risks

- DeepSeek DOM changes → fixtures + health check.
- Streaming detection false positives → conservative completion check.
- Prompt bloat from instructions/skills → budgets + on-demand skills.
- Approval fatigue → per-session allow scope.

## 9. M6 — Gemini, Qwen, and provider polish

### Goal

Three provider plugins, robust recovery, and a core-app release candidate.

### Deliverables

- Gemini plugin (Quill composer, Angular DOM, code-block masking).
- Qwen plugin (Vue DOM, optional MAIN-world SSE tap).
- Provider plugin health UI, status, and quick switch.
- Plugin contract documentation and a "new provider" checklist.
- Recovery flows: host restart, tab closed, logged out, adapter error.
- Settings page and diagnostics.
- Onboarding checklist.
- Docs: README, user guide, provider-plugin guide, troubleshooting.
- Packaging: versioned builds, changelog, license.
- Optional: Playwright smoke test.

### Acceptance

- [x] DeepSeek, Gemini, Qwen each complete a read/edit flow.
- [x] Provider switch and tab recovery work.
- [x] Diagnostics show host version, config/log paths, extension ID.
- [x] Onboarding takes a new user from install to first edit.
- [x] No console errors in main flows; typecheck/tests pass.
- [x] Provider plugin checklist verified with Gemini and Qwen.

### Risks

- Qwen transport complexity → timebox; ship DOM-only if SSE tap is unstable.
- Gemini DOM changes → adapter isolation.
- Scope creep → defer extras to post-MVP.

## 10. M7 — MCP core

### Goal

Make MCP a first-class tool source with explicit trust and the same approval model as built-in tools.

### Deliverables

- MCP config schema and validation in the config loader.
- MCP manager: stdio transport, initialize, `tools/list`, `tools/call`, stop/restart.
- Tool catalog merge and namespacing (`mcp.<server>.<tool>`).
- Risk mapping from annotations + config overrides that may only escalate.
- Trust store, `workspace.trust`/`workspace.untrust`, origin tracking, and hash invalidation on config change.
- Settings → MCP UI: server list, origin/status, tools, review/trust, start/stop/restart.
- Agent prompt includes ready MCP tools; approval cards show server/tool.
- Output caps, timeouts, concurrency, child cleanup, redacted logs.
- Tests with a fixture MCP server.

### Acceptance

- [x] Project MCP servers are untrusted by default and cannot start.
- [x] A project override of a global server is untrusted and does not inherit global trust.
- [x] Trust review shows exact commands, working directories, URLs, and env key names, no values.
- [x] A fixture stdio server starts, lists tools, and executes a call.
- [x] Read-only denies non-read MCP tools; risk overrides may only escalate; write/destructive follow the mode table.
- [x] Config change invalidates trust, stops running project servers, and prevents start until re-review.
- [x] Timeout, result cap, and server-error isolation work.
- [x] Host shutdown terminates child processes.

### Risks

- SDK/transport compatibility with the compiled host → integration test early.
- Windows process spawning/env differences → explicit tests.
- Approval fatigue from chatty MCP tools → read-only hints + per-session scope.
- Trust UX confusion → clear review modal and persistent status.

## 11. M8 — Remote MCP and release

### Goal

Complete remote MCP support, polish recovery, and ship the first extensible release.

### Deliverables

- Streamable HTTP MCP transport; SSE fallback.
- Remote auth header env expansion and redaction.
- MCP diagnostics (connection, tool count, redacted error tail).
- Declarative provider prototype (optional/timeboxed).
- Full docs: config schema, skills/agents/rules, MCP trust, provider plugins.
- Release checklist, packaging, privacy policy, license.
- Cross-platform host verification.

### Acceptance

- [x] Remote MCP connects over HTTPS and lists tools.
- [x] Missing/invalid secret env produces a validation error, not a crash.
- [x] Remote MCP calls obey the same approval/limits as stdio.
- [x] No secrets in logs or UI.
- [x] New provider checklist verified with a fixture plugin.
- [x] Release checklist complete.

### Risks

- Remote MCP spec changes → pin supported protocol versions.
- Secret handling mistakes → review redaction paths.
- Scope creep into a plugin marketplace → defer.

## 12. Post-MVP backlog

Prioritized:

1. GUI installer and auto-update (Windows/macOS/Linux) — Deferred.
2. ChatGPT, Claude, Grok, Kimi, GLM, Meta, Mistral, Ptero, Arena provider plugins — Done.
3. Declarative provider selectors / Provider Lab — Done.
4. Allowlisted project scripts (build/test/lint) — Done.
5. Skill script runner with explicit approvals and bounded command allowlist — Done (no OS sandbox claim).
6. Terminal panel with explicit approvals — Done.
7. Multi-root workspaces — Done (registry/resolver; UI active-root only).
8. Git stash, history, blame, per-line staging — Done.
9. Inline AI suggestions and quick actions — Done.
10. Transcript history and export — Done.
11. Themes and layout customization — Done.
12. i18n — Done.
13. Provider/MCP marketplace or registry (no remote code) — Done.
14. Firefox port (different native messaging and side panel APIs) — Partial.

## 13. Release checklist

- [ ] All MVP acceptance criteria pass.
- [x] License decided and `LICENSE` added.
- [x] README covers install, setup, usage, troubleshooting, uninstall.
- [x] Privacy policy (no telemetry, local-only).
- [x] Chrome Web Store assets and permission justification.
- [x] Version numbers consistent across manifests and package.json.
- [ ] Host binaries built for supported platforms.
- [x] Config schema and examples validated; invalid config paths tested.
- [x] MCP trust review verified; no project server auto-starts.
- [x] Provider manifest generation verified with a fixture plugin.
- [ ] Clean-profile manual test on Windows (primary), macOS, Linux.
- [x] No secrets, no debug logs, no TODO blockers.
- [x] Changelog and migration notes.

## 14. Definition of done (per milestone)

- Code merged with typecheck passing.
- Tests added for new host logic.
- Error states and recovery paths implemented.
- Docs updated.
- No known security regressions.
- Demo recorded or steps documented.

