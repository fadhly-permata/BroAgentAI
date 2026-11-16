# BroAgentAI — Architecture Decision Records (ADR)

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Date | 2026-11-15 |
| Related | `00-PRD.md`, `01-BRD.md`, `02-TSD.md`, `03-FSD.md`, `04-ERD.md`, `06-ROADMAP.md`, `07-PLUGIN-MCP.md` |

## ADR-001: Use Native Messaging instead of a local WebSocket bridge

**Status:** Accepted

**Context:** legacy connectors start a local WebSocket bridge with `start.bat`. Users must keep a terminal open, a localhost port is exposed, and pairing/origin checks must be implemented manually. Chrome extensions can instead launch a native host through Native Messaging.

**Decision:** Use a single native companion registered as `com.broagentai.host` over stdio. The extension calls `chrome.runtime.connectNative`; the host lifecycle is tied to the port.

**Consequences:**

- No port, token, or manual bridge process.
- One-time native host registration is still required (dev script now, GUI installer later).
- Chrome limits host→extension messages to 1 MB, so responses need caps and pagination.
- The host exits when Chrome disconnects; long-running work must be resumable or idempotent.
- Debugging requires logging to stderr/files, never stdout.

## ADR-002: Side-panel cockpit with AI-tab-first operation

**Status:** Accepted

**Context:** legacy connectors inject a floating control bar into AI pages. That keeps users in the chat but provides no persistent workspace, SCM, or file cockpit. Embedding provider sites in an iframe is blocked by `X-Frame-Options`/CSP.

**Decision:** Build a Chrome side panel as the primary UI. The AI chat stays in its provider tab. A content script relays prompts and replies between the panel/service worker and the AI tab.

**Consequences:**

- Users get Explorer/Search/SCM/Agent in one persistent surface.
- The panel cannot render the AI page itself; it shows a conversation log instead.
- Provider DOM changes can break adapters; adapters must be isolated and tested.
- Users can keep using the provider's native UI, including its own features.

## ADR-003: React + TypeScript + Vite + CRXJS

**Status:** Accepted

**Context:** The UI is state-heavy (workspace tree, editor tabs, SCM, agent log, approvals). A component framework and typed protocol reduce bugs. The extension targets MV3.

**Decision:** Use React 19, TypeScript, Vite 7, and `@crxjs/vite-plugin` 3.x for the extension; CodeMirror 6 for editing.

**Consequences:**

- Fast HMR and a familiar stack.
- CRXJS 3.0 supports Vite 3–8; pin compatible versions and verify the build after upgrades.
- Side panel, service worker, content scripts, and HTML pages are separate entry points in the manifest.
- No SSR; all UI is client-side.

## ADR-004: Node/TypeScript native host, compiled to a single executable

**Status:** Accepted

**Context:** The host needs filesystem, Git, search, and process management. Node has mature APIs and the same language as the extension, enabling shared types. End users should not need Node installed.

**Decision:** Implement the host in TypeScript on Node (22+), bundle to one executable with `bun build --compile` as the preferred path. Keep a Node SEA/`pkg` fallback.

**Consequences:**

- Shared protocol types via the `shared` workspace.
- Cross-compilation and code signing are later concerns.
- Native modules must be avoided or bundled carefully.
- The executable path must be recorded in the native host manifest.

## ADR-005: npm workspaces monorepo

**Status:** Accepted

**Context:** Shared types, extension, bridge, and scripts must evolve together. Separate repositories add version skew.

**Decision:** Use npm workspaces with `shared`, `extension`, and `bridge` packages.

**Consequences:**

- One lockfile, one install, one typecheck/test command.
- Workspace packages must be built or resolved via TypeScript paths.
- Publishing individual packages is not a goal.

## ADR-006: Host app config in OS app-data; project config via layered JSONC

**Status:** Accepted

**Context:** The host must persist a workspace list and app settings without a database. The extension cannot read arbitrary host files. Project repositories also need their own portable configuration and Markdown resources.

**Decision:** Store host app config as `config.json` under the OS app-data directory (`%APPDATA%`, `~/Library/Application Support`, `$XDG_CONFIG_HOME`). Allow `BROAGENTAI_CONFIG_DIR` for development. Write atomically. Project configuration is separate: `broagentai.json(c)` and `broagentai.local.json(c)` merged over global defaults, plus Markdown resources (ADR-017).

**Consequences:**

- Host app config is easy to inspect, back up, and migrate.
- Project config is portable, reviewable, and can be committed (local overrides are gitignored).
- Concurrent writes must be serialized in the host.
- No secrets are stored; project MCP env vars are references only.
- A corrupt host config is backed up and replaced with defaults; a broken project config produces diagnostics without blocking file/Git tools.

## ADR-007: Four approval modes with risk classes

**Status:** Accepted

**Context:** Local file and Git access is powerful. A single "allow everything" toggle is unsafe; per-action prompts alone are fatiguing.

**Decision:** Classify tools as read/write/destructive/git/sync and expose four modes: Read-only, Ask, Auto-edit, Full-auto.

**Consequences:**

- Read-only is a hard safety boundary enforced in the service worker and host.
- Auto-edit still asks for delete, commit, and sync.
- Full-auto still asks for push/pull unless the user explicitly enables auto-sync.
- The host must also enforce mode-specific denials so a compromised panel cannot bypass them.

## ADR-008: Git via CLI, not a Git library

**Status:** Accepted

**Context:** Git behavior (hooks, credential helpers, SSH config, worktrees, submodules) is best matched by the real CLI. Pure JS Git libraries diverge.

**Decision:** Spawn `git` with argument arrays and no shell; parse porcelain/structured output.

**Consequences:**

- Behavior matches the user's terminal.
- Parsing and error mapping are required.
- Git must be installed; detect and report a clear error if missing.
- No interactive prompts; fail fast on auth.
- Never force-push in the MVP.

## ADR-009: Pagination and size caps instead of generic chunking

**Status:** Accepted

**Context:** Chrome caps host→extension messages at 1 MB. Trees, diffs, and search results can exceed that.

**Decision:** Make each method return a bounded page (depth/entry/match/byte caps) with cursors where needed. Use per-file diffs and line-range reads for large files.

**Consequences:**

- Simpler protocol and UI in the MVP.
- Some operations require "Load more" or per-file navigation.
- Generic chunking can be added later without breaking the envelope.

## ADR-010: Clean-room implementation, MIT/Apache-2.0 by default

**Status:** Accepted (license subject to final review)

**Context:** legacy connectors are GPL-3.0-or-later. Copying their code would force BroAgentAI to GPL-3.0.

**Decision:** Implement from concepts and public behavior, not copied code. Default license: MIT or Apache-2.0. Revisit if code reuse becomes desirable.

**Consequences:**

- Contributors must not paste legacy connector code.
- Concepts (provider adapters, command parser, tool catalog, workspace confinement) can be reimplemented.
- A license review is required before public release.

## ADR-011: Stable extension ID via manifest key

**Status:** Accepted

**Context:** Native Messaging `allowed_origins` requires a fixed extension ID. Unpacked extensions otherwise get an ID derived from their path.

**Decision:** Include a `key` in `extension/manifest.json` and derive the ID during dev registration.

**Consequences:**

- The same ID works across machines and reinstallations.
- The private key is not needed for an unpacked extension; the public key is embedded.
- Chrome Web Store may assign its own ID; the registration script must use the actual installed ID.

## ADR-012: Full browser tabs for editor and diff

**Status:** Accepted

**Context:** A side panel is narrow; code editing and diffs need horizontal space.

**Decision:** Open files and diffs in extension pages (`editor.html`, `diff.html`) as full tabs. The panel shows entry points and status.

**Consequences:**

- Better editing experience.
- Tab state must be passed via URL/query and `chrome.storage.session`.
- External-change notifications must reach open tabs.
- The panel remains the cockpit, not the editor.

## ADR-013: Provider priority DeepSeek → Gemini → Qwen

**Status:** Accepted

**Context:** Provider adapters are the most fragile part. Legacy connectors report DeepSeek as the most stable, Gemini as moderate, Qwen as more complex.

**Decision:** Implement DeepSeek first, then Gemini, then Qwen. Keep a provider registry so others (ChatGPT, Claude, Grok, Kimi, GLM, Meta, Mistral, Ptero, Arena) can follow.

**Consequences:**

- Early milestones validate the agent loop with the least risk.
- Qwen may need a MAIN-world SSE tap.
- Each adapter needs fixture tests and a health check.
- Marketing should not promise unsupported providers.

## ADR-014: No arbitrary shell in the MVP

**Status:** Accepted

**Context:** Shell access is the largest security risk and the hardest to approve meaningfully.

**Decision:** Do not expose arbitrary command execution. Allow only typed tools (filesystem, search, Git) and MCP tools through the dedicated MCP client (ADR-016). MCP is not a general shell: commands come only from explicit server configurations, run without a shell, and are approval-gated.

**Consequences:**

- Build/test commands are not available as free-form shell commands.
- Users can still run commands in their terminal.
- MCP servers introduce third-party processes and therefore require explicit trust and approval.
- A future project-script tool must use an allowlist, approvals, and output caps.

## ADR-015: Host lifecycle owned by the extension port

**Status:** Accepted

**Context:** A daemon that survives Chrome exit complicates updates and security. Native Messaging already defines a clean lifecycle.

**Decision:** The host runs while a native port is open. The panel can Restart by reconnecting. The service worker reconnects on demand after suspension.

**Consequences:**

- No orphan processes in normal operation.
- Long-running Git operations must handle disconnect.
- Watchers stop when the host exits; state is rebuilt on reconnect.
- A future background mode would require a separate decision.

## ADR-016: Make MCP a first-class tool source in the native companion

**Status:** Accepted

**Context:** MCP is the emerging standard for connecting AI applications to local and remote tools. Re-implementing every integration inside BroAgentAI is not scalable. MCP servers, however, are third-party processes with broad capabilities and must not become an unguarded shell.

**Decision:** The native companion is the MCP client/host. It reads server definitions from merged configuration, supports stdio and remote transports, lists tools into the agent catalog, and executes calls under the same approval modes as built-in tools. The extension never spawns MCP processes or talks to servers directly.

**Consequences:**

- BroAgentAI can gain filesystem, database, browser, search, and other tools without changing the agent loop.
- MCP tool risk is derived from annotations (`readOnlyHint`, `destructiveHint`) with config overrides that may only escalate risk.
- Project-defined servers require explicit workspace trust and an explicit start; they never auto-start.
- Commands are arrays and are never passed through a shell.
- Server output, startup time, tool count, and concurrency must be bounded.
- The host must terminate child processes on shutdown and surface per-server errors.
- MCP is not a license to run arbitrary commands outside configured servers.

## ADR-017: Use OpenCode-style project configuration and Markdown resources

**Status:** Accepted

**Context:** Users want portable, human-editable configuration for instructions, rules, skills, agents, and commands. OpenCode has established a familiar convention (JSON/JSONC config plus Markdown resources) that other tools are beginning to share.

**Decision:** Support `broagentai.json`/`.jsonc` at global, project, and local scope, plus `AGENTS.md`, `.broagentai/rules`, `.broagentai/skills/*/SKILL.md`, `.broagentai/agents`, and `.broagentai/commands`. Markdown resources use optional YAML frontmatter. Merge precedence is built-in → global → project → local.

**Consequences:**

- Repositories can carry their own agent behavior without code changes.
- Configuration is inspectable, diffable, and shareable.
- JSONC requires a comment-tolerant parser and line/column diagnostics.
- Resource discovery must be bounded and path-confined.
- Skills are listed by metadata and read on demand, not injected wholesale.
- We borrow conventions, not implementation; compatibility with OpenCode schemas is not guaranteed.
- Project-controlled instructions can never override safety rules or approvals.

## ADR-018: Provider support is a plugin registry, not core branching

**Status:** Accepted

**Context:** Web-chat adapters are the most fragile part of the product. If every new provider requires edits across the manifest, service worker, panel, agent loop, and parser, support will not scale.

**Decision:** Implement a provider plugin registry. Each provider lives in its own folder with metadata (`provider.json`) and a code adapter (`plugin.ts`/`adapter.ts`). Vite scans provider metadata to generate host permissions and content-script registrations. The core detects the provider at runtime and calls the adapter through a stable interface.

**Consequences:**

- Adding a provider requires a new folder, not a core rewrite.
- Provider-specific selectors and streaming logic stay isolated.
- Manifest generation becomes a build-time concern; CI must test it.
- The provider contract is versioned; breaking changes require a migration.
- Runtime config can only enable/disable bundled providers; it cannot add host permissions or content scripts.
- A declarative selector tier can support simple chats later without code, compiled into a bundled provider at build time.
- Third-party code cannot be fetched at runtime under MV3; provider packs ship with the extension.
- The core remains responsible for transport, parsing, approvals, and tool execution.

## ADR-019: Trust project MCP configuration explicitly

**Status:** Accepted

**Context:** A repository can contain a `broagentai.jsonc` that starts arbitrary MCP server commands. Opening a folder must not silently execute a repository's commands.

**Decision:** Project-defined MCP servers start only after the user trusts the workspace and explicitly starts them; they never auto-start. Trust records the realpath and a hash of the effective MCP configuration. Any change to commands, URLs, working directories, environment/header keys, or risk overrides invalidates trust and requires re-approval. Global MCP servers are user-authored, trusted by default, and may opt into auto-start. A project-layer override of a global server does not inherit that trust.

**Consequences:**

- Cloning and opening a repository cannot trigger code execution.
- The user sees exactly which commands/URLs will run before trusting.
- Editing MCP config requires a trust refresh.
- Trust state is local and per machine; it is never committed.
- The host can still list untrusted server definitions, but cannot start or call them.
- Automation (CI, headless) needs an explicit opt-in flag, not an implicit bypass.
