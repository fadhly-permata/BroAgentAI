# BroAgentAI — Business Requirements Document (BRD)

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Date | 2026-11-15 |
| Related | `00-PRD.md`, `02-TSD.md`, `03-FSD.md`, `04-ERD.md`, `05-ADR.md`, `06-ROADMAP.md` |

## 1. Background and opportunity

Developers increasingly use web AI chats (Qwen, DeepSeek, Gemini, ChatGPT, Claude) for coding help. Those chats cannot access a local repository, so users copy-paste code, switch to a terminal, and lose context. Existing connectors prove the demand for browser-to-local automation, but they:

- inject a control bar into AI pages instead of offering a persistent workspace cockpit;
- require a manually started local bridge (`start.bat`);
- expose broad filesystem and Git access without a visible approval model;
- do not provide a source-control UI.

BroAgentAI combines the legacy connector concept with a side-panel workspace cockpit and a native companion that the extension can start, stop, and restart. It targets users who already pay for or have access to capable web AI accounts and do not want another API key or cloud coding agent.

## 2. Business objectives

| ID | Objective | Measure |
| --- | --- | --- |
| BO-1 | Reduce context-switching between AI chat, file explorer, and Git UI. | A user can complete explore → edit → diff → commit without leaving the browser. |
| BO-2 | Remove per-session terminal setup. | After one-time dev registration, zero terminal commands to start working. |
| BO-3 | Avoid recurring AI API costs for the core workflow. | No API key required for MVP supported providers. |
| BO-4 | Make local automation trustworthy. | Every write/commit/sync is governed by a visible approval mode. |
| BO-5 | Create an extensible connector platform. | New AI providers and MCP servers can be added behind stable interfaces. |

## 3. Stakeholders

| Stakeholder | Interest |
| --- | --- |
| End user / developer | Fast, safe local coding with a web AI chat. |
| Project maintainer | A maintainable, testable, documented codebase. |
| Contributors | Clear architecture, provider adapter contract, tests, and specs. |
| Security reviewer | Path confinement, approvals, no secrets, no arbitrary shell. |
| Future distributor (Chrome Web Store) | Policy compliance, minimal permissions, clear setup. |

## 4. Value proposition

**For** developers who already use a web AI chat, **who** need the AI to work on a local repository, **BroAgentAI** is a Chrome side-panel companion **that** lets the AI read, search, edit, and version-control the active workspace with explicit approvals. **Unlike** legacy connectors, it provides a persistent workspace/SCM cockpit and removes the per-session bridge start; **unlike** API-key agents, it uses the AI session the user already has.

Differentiators:

- Side panel with Explorer, Search, SCM, and Agent in one place.
- Native Messaging lifecycle controlled by the extension; no `start.bat` after setup.
- Approval modes plus a visible command log.
- Full Git workflow including pull modes and push/pull confirmations.
- Provider-agnostic plugin registry with Qwen, DeepSeek, and Gemini first; new providers do not require core edits.
- OpenCode-style project config: instructions, rules, skills, agents, and commands in Markdown/JSONC.
- First-class MCP client for local/remote tools, with explicit workspace trust and the same approval model.
- Extensible by files and plugins rather than a monolithic app update.

## 5. Scope

### 5.1 In scope (MVP)

- Chrome MV3 side panel.
- Local native companion over Native Messaging.
- Workspace registry and recent list.
- Explorer, editor, search.
- SCM status/diff/stage/commit/branch/fetch/pull/push, pull modes.
- AI relay for Qwen, DeepSeek, Gemini through provider plugins.
- Approval modes and command log.
- JSONC config (global/project/local), instructions, rules, skills, agents, commands.
- MCP client/host (stdio, HTTP/SSE), trust review, tool catalog, approvals.
- Provider plugin registry and build-time manifest generation.
- Dev-mode host build/registration scripts.
- Documentation, tests, build pipeline.

### 5.2 Out of scope

- Signed/notarized distributables (post-MVP, pending credentials).
- Arbitrary shell/terminal.
- BroAgentAI acting as a general MCP server for external apps.
- MCP marketplace and remote plugin marketplace.
- Declarative provider selectors / Provider Lab.
- Skill script execution.
- Multi-root workspaces.
- Cloud sync, accounts, billing, telemetry.
- Firefox/Safari/mobile.
- Force-push and history rewriting.

## 6. Distribution and licensing

### 6.1 Distribution channels

| Channel | Purpose | Notes |
| --- | --- | --- |
| GitHub repository | Source, issues, releases | Primary for the MVP. |
| Chrome Web Store | End-user distribution | Requires package review, privacy policy, and a native-host installer story. |
| Unpacked extension | Development | Load `extension/dist` in developer mode. |

### 6.2 Native companion distribution

- MVP: developer builds the host with `npm run host:build` and registers it with `npm run host:install:dev`.
- Post-MVP: GUI installers per OS register the native host manifest and launcher; the user-run updater verifies checksums before replacing files. Signed/notarized packages remain pending credentials.
- Chrome Web Store policy does not allow an extension to install a native host silently; the installer must be a user action.

### 6.3 Licensing

Two viable paths:

1. **Clean-room (recommended):** implement from concepts and public documentation; license the project under MIT or Apache-2.0.
2. **Reuse legacy connector code:** legacy connectors are GPL-3.0-or-later; any copied code requires BroAgentAI to be GPL-3.0.

Decision is tracked in `05-ADR.md`; the default assumption for the MVP is clean-room.

## 7. Success criteria

| Criterion | Target |
| --- | --- |
| First workspace visible after setup | < 5 minutes |
| Daily terminal commands after setup | 0 |
| Supported provider smoke tests | Qwen, DeepSeek, Gemini pass read/edit/git flows |
| Destructive operations without approval | 0 in automated tests |
| SCM workflow | status → diff → stage → commit → push works on a test repo |
| Recovery | Host/provider/auth/conflict failures have an in-panel action |
| Configuration | JSONC + AGENTS/rules/skills/agents/commands load with deterministic precedence |
| MCP safety | 0 project MCP servers start without explicit trust; 0 destructive MCP tools run in Read-only |
| Provider extensibility | Fixture provider added with a folder + metadata, no core edits |
| Documentation | README + PRD/BRD/TSD/FSD/ERD/ADR/Roadmap + plugin/MCP design complete |

## 8. Business risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| AI provider UI changes break adapters | High | High | Adapter isolation, fixture tests, health checks, quick releases |
| Native host installation confuses users | Medium | High | GUI/CLI installers now, setup card with exact steps |
| Git auth hangs or fails | Medium | Medium | Non-interactive Git, credential-helper guidance, Test remote |
| Security incident from broad local access | Low | High | Path confinement, approvals, no shell, no secrets, logs |
| Chrome Web Store rejection | Medium | Medium | Minimal permissions, privacy policy, native-host install flow |
| GPL contamination | Medium | Medium | Clean-room process and license review |
| Low adoption due to provider fragility | Medium | High | Start with the most stable providers, document limits |
| Maintenance burden of many providers | High | Medium | Provider registry and adapter contract; prioritize three providers |
| Malicious project config starts MCP commands | Medium | High | Untrusted by default; explicit trust; hash invalidation; no shell |
| Compromised MCP server | Medium | High | Risk classes, approvals, output caps, per-server isolation |
| Secret leakage through MCP env/headers | Low | High | Env refs only; redaction; show key names only |
| Config/prompt injection overrides safety | Medium | High | Instructions are data; immutable safety rules; approvals |
| Plugin supply-chain risk | Low | High | No remote code; bundled/reviewed plugins; capabilities limited to relay |
| Extensibility scope creep delays core | High | Medium | M0–M8 gated; declarative providers/marketplace post-MVP |

## 9. Effort and roadmap

| Phase | Scope | Estimate |
| --- | --- | --- |
| M0 | Docs, monorepo, side panel shell, native host skeleton, dev registration, provider manifest generation | 3–5 days |
| M1 | Workspace registry, config/resources, fs list/read/search, watcher, tests | 5–8 days |
| M2 | Explorer, editor tab, search UI, status bar | 4–6 days |
| M3 | SCM read/write, diff, commit, branch | 5–7 days |
| M4 | Fetch/pull/push, auth errors, pull modes, conflicts | 4–6 days |
| M5 | DeepSeek agent relay, instructions/skills/agents, approvals, command log | 6–9 days |
| M6 | Gemini + Qwen provider plugins, reminders, recovery, polish | 6–10 days |
| M7 | MCP core: trust, stdio, tool catalog, approvals, settings | 5–8 days |
| M8 | Remote MCP (HTTP/SSE), trust polish, release checklist | 3–5 days |

Estimates assume one experienced developer and no major provider breakage. Total ~41–64 developer-days. Provider adapters and MCP transports are the largest schedule risks.

## 10. Monetization and sustainability

The MVP is free and open source. No monetization is planned. Potential future options (not committed):

- Sponsorships or donations.
- Optional paid code-signing/notarization for the existing GUI installer/updater.
- Optional team configuration or managed MCP catalog.

No telemetry, ads, or data sale is planned. Any future monetization must preserve local-first operation and user trust.

## 11. Go/no-go criteria

The MVP is a go when:

1. The panel opens and the native host connects without a terminal after dev registration.
2. Workspace add/switch and file read/edit work with path confinement.
3. SCM status/diff/stage/commit/pull/push works on a test repository.
4. At least one provider (DeepSeek) completes a read → edit → verify flow through approvals.
5. No destructive action can run in `Read-only` mode.
6. Config/resources load with deterministic precedence; a parse error never blocks the panel.
7. No project MCP server starts before explicit trust; changing its command/URL/working directory/env-header/risk fields invalidates trust.
8. A trusted MCP server exposes tools through the same approval model; a broken server cannot crash the host.
9. A fixture provider plugin can be added without edits to the panel, agent loop, or parser.
10. Documentation and recovery paths are complete.

The MVP is a no-go or needs re-scoping if:

- Native Messaging cannot be made reliable on the target OS.
- Provider automation is unusable after a reasonable adapter effort.
- Security review finds unmitigated path escape or approval bypass.
- MCP trust cannot be enforced reliably or child processes cannot be contained/cleaned up.
- Config/resource discovery cannot be bounded safely for large monorepos.
