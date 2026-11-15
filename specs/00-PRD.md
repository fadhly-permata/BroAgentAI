# BroAgentAI — Product Requirements Document (PRD)

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Date | 2026-11-15 |
| Owner | BroAgentAI project |
| Related | `01-BRD.md`, `02-TSD.md`, `03-FSD.md`, `04-ERD.md`, `05-ADR.md`, `06-ROADMAP.md`, `07-PLUGIN-MCP.md` |

## 1. Summary

BroAgentAI is a Chrome Manifest V3 extension that adds a persistent side panel — similar to Chrome's "Ask Gemini" panel — for local software work. The panel contains a workspace explorer, file editor, search, source control (SCM), and an AI agent cockpit. The AI chat itself stays in the user's normal, logged-in web AI tab (Qwen, DeepSeek, or Gemini); BroAgentAI relays prompts and tool calls between that tab and a local native companion.

The product requires **no API key** and, after a one-time development setup, **no terminal or `start.bat` per session**. The extension starts and stops the native companion through Chrome Native Messaging.

## 2. Problem

- Web AI chats are good at reasoning and code generation, but they cannot inspect, edit, search, or version-control a local project.
- Existing browser connectors such as snapgent inject an agent bar into AI pages but require a manually started local bridge, and they do not provide a persistent workspace/SCM cockpit.
- Developers constantly switch between an IDE, a terminal, a Git UI, and an AI chat; context and file paths are lost between tools.
- API-key-based coding agents require billing, configuration, and trust in a cloud agent. Many users already have capable, logged-in web AI accounts.
- Local automation tools often expose broad filesystem or shell access without clear approval boundaries.

## 3. Goals and non-goals

### 3.1 Goals

| ID | Goal |
| --- | --- |
| G1 | Zero-terminal daily use: after a one-time setup, the extension starts/stops the native companion automatically. |
| G2 | A persistent side panel with workspace explorer, editor, search, and SCM next to the AI chat. |
| G3 | An AI agent that can read, search, edit, and run approved Git operations on a local workspace. |
| G4 | No API key: work with the user's existing Qwen, DeepSeek, or Gemini web session. |
| G5 | Safe by default: workspace confinement, risk-based approvals, no arbitrary shell/terminal, and MCP only from explicitly trusted config. |
| G6 | Extensible architecture: provider plugins, OpenCode-style config/resources, and first-class MCP tools so new AI sites, skills, agents, and tools can be added without core rewrites. |
| G7 | Clear recovery paths when the host, provider tab, auth, or Git operation fails. |

### 3.2 Non-goals (MVP)

- Replacing a full IDE (no LSP, debugger, terminals, or extensions).
- A hosted backend, cloud sync, or multi-user collaboration.
- Firefox, Safari, or mobile support.
- Guaranteed compatibility with every AI provider DOM or a provider's terms of service.
- Force-push, history rewriting, or automatic conflict resolution.
- Automatic native-host installation without a user-run installer or dev script (Chrome security restriction).
- Letting external MCP clients (Claude Desktop, Cursor, etc.) connect to BroAgentAI; we are an MCP client, not a general MCP server.
- Loading third-party extension code or provider plugins from a remote URL at runtime (MV3 policy and security).
- A plugin marketplace in the MVP.
- Telemetry or analytics.

## 4. Personas and jobs-to-be-done

### 4.1 Personas

| Persona | Description | Primary need |
| --- | --- | --- |
| Solo developer / creator | Uses a web AI chat daily, keeps a few local repos, dislikes switching tools. | Let the AI inspect/edit the project while chatting, without copy-paste. |
| Technical operator | Comfortable with Git and paths, wants a fast side-panel workflow. | Triage changes, commit, push/pull, and ask AI for fixes quickly. |
| Privacy-conscious user | Does not want an API key or a cloud coding agent. | Keep code and credentials local; use the AI account they already have. |

### 4.2 Jobs-to-be-done

- "When I am chatting with Gemini/Qwen/DeepSeek, I want it to inspect and edit my project, so I do not have to copy-paste code."
- "When I switch tasks, I want to see workspace files and Git changes next to the chat."
- "When the AI proposes a change, I want to review and approve it before it touches my files."
- "When I start work tomorrow, I want the local companion to start with the extension, not with a terminal command."

## 5. Product principles

1. **Cockpit, not a chat clone.** The AI chat stays in its native tab. The panel supplies context, controls, approvals, and results.
2. **Local-first.** The native companion runs on the user's machine. No telemetry by default.
3. **Safe by default.** Reads may run automatically; writes, deletes, commits, and sync require an approval mode.
4. **Recoverable.** Every connection or provider failure has a visible state and a retry/reload action.
5. **Explainable.** Tool calls, parameters, results, and errors are visible in the panel.
6. **Extensible, not bloated.** New providers, tools, skills, and agent profiles should be addable through plugins/config without editing the core UI or agent loop.
7. **Project-controlled, user-trusted.** Repo config can shape behavior, but cannot execute MCP servers or code without explicit user trust.

## 6. User journeys

### J1 — First development setup

The developer installs dependencies, builds the native host, runs the dev registration script once, loads the unpacked extension, and opens the panel. The companion auto-connects and shows a ready state. No `start.bat` is needed after registration.

### J2 — Add and switch workspace

The user adds a workspace by absolute path (or starts the host with `--workspace`), sees it in the recent list, selects it, and the panel shows the workspace name, path, and Git branch. Removing a workspace does not delete files.

### J3 — Explore and edit a file

The user expands a lazy file tree, opens a file in a full extension tab, edits it, and saves. If the file changed on disk after opening, the save is rejected with a conflict dialog offering reload or overwrite.

### J4 — AI-assisted change

The user selects a provider, starts a session, and asks for a change. The AI reads files, searches, and proposes a patch. Depending on the approval mode, the patch is applied automatically or shown as an approval card with a diff preview. The AI receives the result and summarizes the work.

### J5 — Source control

The user sees grouped changes, opens a per-file diff, stages files, writes a commit message, and commits. They fetch, pull (ff-only, merge, or rebase), and push with confirmations. Authentication uses the system credential helper or SSH agent; no tokens are stored by BroAgentAI.

### J6 — Failure recovery

The panel distinguishes: host not installed, host crashed, extension reloaded, provider tab closed, provider health check failed, Git auth failure, and merge/rebase conflict. Each state has a concrete action such as Retry, Reload AI tab, Test remote, or Abort merge.

### J7 — Switch approval mode

The user changes the approval dropdown (Read-only, Ask, Auto-edit, Full-auto) at any time. The current mode is visible in the agent header and applies to subsequent tool calls.

### J8 - Project configuration

The user adds `browseragent.jsonc` and `AGENTS.md` to a repo. Global defaults merge with project and local overrides. The panel shows the effective config, sources, and warnings; invalid JSONC shows line/column and does not crash the host.

### J9 - Skills, agents, and rules

The repo contains `.browseragent/rules`, `.browseragent/skills`, `.browseragent/agents`, and `.browseragent/commands`. The panel lists them without executing anything. The AI sees instruction text and skill metadata, reads a skill body on demand, and the user can start with a selected agent profile.

### J10 - MCP tools

The user configures a local or remote MCP server in `browseragent.jsonc`. For a project-defined server, the panel shows it as untrusted and requires explicit trust. For global or local user-authored servers, the panel treats it as trusted and honors the configured start behavior; a project override of a global server does not inherit global trust. After starting, MCP tools appear in the agent catalog and obey the same approval modes, timeouts, and result caps as built-in tools.

### J11 - Add a provider plugin

A contributor adds a new folder under `extension/src/providers/<id>/` with `provider.json` and an adapter. The build regenerates host permissions and content-script matches; the registry picks it up. The panel shows the provider without changes to the agent loop.

## 7. Functional requirements

### 7.1 Companion and setup

| ID | Requirement |
| --- | --- |
| FR-A1 | The extension action opens a global side panel in the current window. |
| FR-A2 | The service worker starts the native host through `chrome.runtime.connectNative` and reconnects after suspension, reload, or update. |
| FR-A3 | The panel shows companion states: not installed, starting, ready, error, disconnected, version mismatch. |
| FR-A4 | In dev mode, the panel shows the exact setup command when the host is not installed. |
| FR-A5 | The user can restart the companion from the panel. |
| FR-A6 | The companion writes diagnostics to stderr and a local log file, never to protocol stdout. |
| FR-A7 | The extension ID is stable across unpacked reloads through a manifest `key`. |

### 7.2 Workspace

| ID | Requirement |
| --- | --- |
| FR-B1 | Add a workspace by absolute path; validate that it exists and is a directory. |
| FR-B2 | Persist workspaces and recent order in the companion config. |
| FR-B3 | List, switch, and remove workspaces; removal never deletes files. |
| FR-B4 | The active workspace is displayed in the panel and used for all file/Git operations. |
| FR-B5 | All paths are resolved and confined to the active workspace; escaping paths and symlinks are rejected. |
| FR-B6 | Ignore common directories (`.git`, `node_modules`, virtualenvs, build outputs) by default, configurable later. |

### 7.3 Explorer, editor, and search

| ID | Requirement |
| --- | --- |
| FR-C1 | Lazy-load directory children; refresh affected nodes on filesystem events. |
| FR-C2 | Open a file in a full extension tab with syntax highlighting and line numbers. |
| FR-C3 | Save with an expected mtime; reject stale writes and offer reload/overwrite. |
| FR-C4 | Create, rename, copy, and delete files/folders with explicit confirmation for destructive actions. |
| FR-C5 | Detect binary and oversized files; show a clear message instead of corrupting them. |
| FR-C6 | Search text and glob patterns; group results by file and open at the matching line. |
| FR-C7 | Show the current Git branch, ahead/behind counts, and workspace status in the panel. |

### 7.4 Source control

| ID | Requirement |
| --- | --- |
| FR-D1 | Show staged, unstaged, untracked, and conflicted files, plus branch and ahead/behind state. |
| FR-D2 | Show a per-file unified or side-by-side diff. |
| FR-D3 | Stage and unstage individual files. Discard requires confirmation. |
| FR-D4 | Commit staged changes with a message; display hook output and errors. |
| FR-D5 | List, create, and switch branches; refuse a dirty-tree switch with guidance. |
| FR-D6 | Fetch, pull, and push with a confirmation modal showing remote, branch, ahead/behind, and affected files. |
| FR-D7 | Pull supports `ff-only`, `merge`, and `rebase` modes. |
| FR-D8 | Merge/rebase conflicts are shown as a state with conflicted files and an Abort action; no auto-resolution. |
| FR-D9 | Authentication uses the system Git credential helper or SSH agent; no secrets are stored by BroAgentAI. |
| FR-D10 | No force-push in the MVP. |

### 7.5 AI agent

| ID | Requirement |
| --- | --- |
| FR-E1 | Select a provider: Qwen, DeepSeek, Gemini (MVP priority), with a registry for more providers later. |
| FR-E2 | Start a session by finding or opening the provider tab and running a health check. |
| FR-E3 | Inject an operating prompt containing workspace context, tool catalog, command format, and safety rules. |
| FR-E4 | Accept prompts from the panel or the AI tab; mirror streamed replies into the panel. |
| FR-E5 | Parse exactly one tool command per reply; send corrective feedback for malformed or multiple commands. |
| FR-E6 | Execute tools through the companion and return results to the AI tab as the next user turn. |
| FR-E7 | Provide an approval dropdown: Read-only, Ask, Auto-edit, Full-auto. |
| FR-E8 | Show approval cards with command, parameters, risk class, and a diff preview for writes. |
| FR-E9 | Maintain a visible command log with status, duration, result, and error. |
| FR-E10 | Support Stop/Cancel, per-command timeouts, and an iteration limit per user turn. |
| FR-E11 | Inject periodic reminders with the tool list and recovery instructions. |
| FR-E12 | Detect a closed/navigated provider tab, an invalidated content script, or a failed health check and show a recovery action. |
| FR-E13 | Never call the web AI's native tools for local work; only BroAgentAI commands reach the workspace. |

### 7.6 Settings

| ID | Requirement |
| --- | --- |
| FR-F1 | Configure default approval mode, pull mode, ignore list, and theme. |
| FR-F2 | Enable/disable bundled providers and show their fixed URL patterns; runtime config cannot add host permissions. |
| FR-F3 | Show companion version, extension ID, config/log paths, and a diagnostics action. |
| FR-F4 | Do not store Git credentials or AI API keys (none are required in the MVP). |
| FR-F5 | Reset workspace/agent state without deleting user files. |
| FR-F6 | Show configuration sources, warnings, MCP trust state, and provider plugin status. |

### 7.7 Configuration, resources, plugins, and MCP

| ID | Requirement |
| --- | --- |
| FR-G1 | Load `browseragent.json`/`.jsonc` from global, project, and local scopes with deterministic precedence. |
| FR-G2 | Parse JSONC with comments and report diagnostics with file, line, and column without crashing the host. |
| FR-G3 | Discover `AGENTS.md`, `BROWSERAGENT.md`, rules, skills, agents, and commands without executing anything. |
| FR-G4 | Inject instruction/rule text and skill/agent metadata into the agent prompt within a fixed budget. |
| FR-G5 | Read a skill body on demand through a read-only, path-confined method. |
| FR-G6 | Let the user adopt a named agent profile for instructions and optional provider/mode restrictions; a profile may narrow but never elevate the current approval mode. |
| FR-G7 | Register provider plugins from `extension/src/providers/*` and generate host permissions/content scripts at build time. |
| FR-G8 | Let a new provider be added by adding a plugin folder and metadata, without editing the panel, agent loop, or parser. |
| FR-G9 | Load MCP server definitions (stdio, HTTP, SSE) and expose ready tools in the agent tool catalog. |
| FR-G10 | Require explicit workspace trust and an explicit start action before any project-defined MCP server runs; project servers never auto-start. Invalidate trust when commands, URLs, working directories, environment/header keys, or risk overrides change. |
| FR-G11 | Classify MCP tools as read/write/destructive from annotations and config overrides that may only escalate risk; enforce approval modes. |
| FR-G12 | Enforce MCP timeouts, result caps, concurrency limits, and child-process cleanup. |
| FR-G13 | Never run MCP commands through a shell; commands are argument arrays from explicit config. |
| FR-G14 | Reference secrets only through environment variables and redact values from logs, errors, and approval cards. |
| FR-G15 | Bound config/resource discovery (file size, depth, count) and confine paths to the workspace or global config root. |
| FR-G16 | Prohibit runtime remote code loading for provider plugins; plugin code ships with the extension. |

## 8. Non-functional requirements

| ID | Requirement |
| --- | --- |
| NFR-1 | Chrome 114+ (Side Panel API), Manifest V3. |
| NFR-2 | Native Messaging limits: host→extension 1 MB per message, extension→host 64 MB. Responses are capped and paginated. |
| NFR-3 | Local panel actions should feel immediate (<300 ms target); tree nodes load lazily; SCM status for typical repos should load in <1 s. |
| NFR-4 | Reconnect automatically after service-worker suspension, extension reload, or host crash; no silent data loss. |
| NFR-5 | Security: `allowed_origins` restriction, origin validation, path confinement, no arbitrary shell/terminal, explicit approvals, and trust-gated MCP. |
| NFR-6 | Privacy: no telemetry; logs stay local. |
| NFR-7 | Accessibility: keyboard navigation, visible focus, adequate contrast, screen-reader labels. |
| NFR-8 | Cross-platform host for Windows, macOS, and Linux; MVP development and verification on Windows first. |
| NFR-9 | Protocol, path, config merge, resource discovery, MCP risk mapping, parser, and Git-status parsing logic have automated tests. |
| NFR-10 | Setup and recovery are documented in README and specs. |
| NFR-11 | Config load + resource discovery for a typical repo completes in <500 ms; a parse error never prevents panel use. |
| NFR-12 | MCP server startup times out at 30 s; tool calls default to 60 s (max 120 s); results cap at 512 KB. |
| NFR-13 | Project MCP config is untrusted by default; project servers never auto-start and require explicit trust + start; trust is bound to realpath + config hash and invalidates on relevant changes. |
| NFR-14 | A broken provider plugin or MCP server affects only that provider/server; the rest of the app remains usable. |
| NFR-15 | No remote code loading in the extension; provider plugins are bundled and reviewed with the extension. |
| NFR-16 | Config/resource discovery is bounded and path-confined; symlink/path escapes are rejected. |
| NFR-17 | Secrets referenced by MCP config are never stored or logged; diagnostics show key names only. |

## 9. Success metrics

| Metric | Target |
| --- | --- |
| Time from cloned repo to first workspace in panel | < 5 minutes |
| Daily start requiring a terminal command | 0 after dev registration |
| Read/edit/Git tool success rate in supported providers | > 95% in smoke tests |
| Accidental destructive operations in test suite | 0 |
| Provider health failure detected | < 2 seconds |
| Recovery without terminal (host/provider/auth/conflict) | Every failure state has an in-panel action |
| Crash-free local sessions | > 99% |
| Config/skills/agents discovered without execution | 100% in tests |
| Project MCP server starts without explicit trust | 0 |
| MCP destructive tool runs in Read-only | 0 |
| Time to add a fixture provider plugin | < 1 day without core edits |
| Instruction prompt overflow | Truncated with warning, never silently dropped |

## 10. MVP scope

### 10.1 Included

- M0–M8 from `06-ROADMAP.md`.
- Native Messaging companion with dev-mode registration.
- Side panel shell with companion status and workspace switcher.
- Workspace tree, editor tab, search.
- SCM status, diff, stage/unstage, commit, branch, fetch/pull/push, pull modes.
- Agent relay for Qwen, DeepSeek, and Gemini through provider plugins.
- JSONC config (global/project/local), instructions, rules, skills, agents, commands.
- MCP client/host: stdio + remote transports, trust review, tool catalog, approvals.
- Approval dropdown, MCP trust state, and command log.
- Tests for host protocol, path confinement, config merge, resource discovery, MCP risk, Git parsing, and provider plugins.

### 10.2 Excluded (post-MVP)

- GUI installer and auto-update.
- Hunk-level staging and conflict resolution UI.
- Integrated terminal and arbitrary command execution.
- MCP marketplace, external apps connecting to BroAgentAI as an MCP server.
- Declarative provider selectors / Provider Lab.
- Skill script execution.
- Multi-root workspaces and multi-window coordination.
- Cloud sync, telemetry, collaboration.
- Force-push and history rewriting.

## 11. Risks and assumptions

| Risk | Impact | Mitigation |
| --- | --- | --- |
| AI provider DOM changes | Agent stops working on a provider | Provider adapters, fixture tests, health checks, fast update path |
| Native host install friction | Users cannot connect | One-time dev script now; GUI installer later; clear setup card |
| 1 MB host→extension limit | Large files/diffs fail | 512 KB caps, pagination, per-file diffs, range reads |
| Git credential prompts hang | Push/pull appears frozen | `GIT_TERMINAL_PROMPT=0`, timeouts, actionable errors, Test remote |
| Merge/rebase conflicts | Repo put in intermediate state | Show conflict state, Abort action, no auto-resolution |
| Service-worker suspension | Connection drops | Reconnect on panel activity, persisted session state |
| Provider terms of service | Account risk | User-driven automation only; document limitations |
| GPL contamination | Licensing constraints | Clean-room implementation; no copy from snapgent unless GPL-3.0 |
| Malicious project config | Repo executes MCP commands on open | Project MCP is untrusted by default; explicit trust + config hash |
| Compromised MCP server | Data exfiltration or destructive actions | Approval modes, risk annotations, result caps, trust review |
| Secret leakage in MCP logs | Credential exposure | Env refs only; redaction everywhere; diagnostics show key names |
| Config/prompt injection | Agent ignores safety rules | Instructions are data; system safety rules are immutable; approvals still apply |
| Provider plugin supply chain | Malicious adapter code | No remote code; bundled/reviewed plugins; adapters cannot call fs/Git/MCP |
| Extensibility scope creep | Delays core release | M0–M8 gated; declarative providers and marketplace are post-MVP |

Assumptions:

- The user has Chrome 114+, Node 22+, and Git installed.
- The user is logged in to at least one supported AI provider.
- The native host is installed/registered once for development.
- The workspace is a normal local directory; network drives may have reduced watcher support.
- MCP servers may require Node, Python, or other runtimes installed by the user; BroAgentAI does not install them.
- The user reviews and trusts project MCP configuration; trust is never implied by opening a folder.

## 12. Open questions

- Project license: MIT/Apache-2.0 clean-room vs GPL-3.0 reuse of snapgent code.
- Final product name and branding.
- Host packaging: Bun compile vs Node SEA vs `pkg`.
- Whether `Full-auto` may push/pull without a separate confirmation.
- Qwen transport: DOM only vs main-world SSE tap.
- Multi-window behavior when two Chrome windows open the panel.
- Trust granularity: per workspace + MCP hash vs per server approval.
- Whether skill scripts can run in the MVP or remain metadata-only.
- Final JSONC schema and whether to publish a JSON Schema URL.
- Instruction budget: 64 KB vs larger for monorepos.
- Provider Lab sequencing after the M8 release.
- MCP transport priority: Streamable HTTP vs SSE fallback.
- Whether an explicit opt-in project auto-start should be added after M8.
