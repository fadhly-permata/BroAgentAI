# BroAgentAI — Plugin, Configuration, and MCP Design

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Date | 2026-11-15 |
| Related | `00-PRD.md`, `01-BRD.md`, `02-TSD.md`, `03-FSD.md`, `04-ERD.md`, `05-ADR.md`, `06-ROADMAP.md` |

## 1. Goals

BroAgentAI must be extensible without repeatedly changing its core:

1. **Project configuration** in familiar, human-editable files (JSONC, Markdown).
2. **Instructions, rules, skills, agents, and commands** discoverable from the workspace and a global config directory.
3. **MCP servers** managed by the native companion and exposed to the AI as tools.
4. **Provider plugins** that add web-chat support without editing the panel, service worker, or agent loop.
5. **Safety by default** for project-controlled commands, MCP servers, and third-party providers.

Non-goals for the first release:

- Running arbitrary JavaScript from an untrusted repository inside the extension.
- Installing third-party extension code at runtime from a URL.
- Full OpenCode compatibility (we borrow conventions, not file formats verbatim).
- Remote plugin marketplaces or accounts.

## 2. Configuration layers

### 2.1 Locations

| Scope | Path | Committed | Purpose |
| --- | --- | --- | --- |
| Global | `<configDir>/browseragent.json` / `.jsonc` | No | User defaults, global MCP servers, provider preferences. |
| Project | `<workspace>/browseragent.json` / `.jsonc` | Yes | Repo-specific instructions, MCP servers, agent defaults. |
| Local | `<workspace>/browseragent.local.json` / `.jsonc` | No | Machine-specific overrides and local MCP servers; gitignored. |
| Instructions | `AGENTS.md`, `BROWSERAGENT.md` | Yes | Natural-language operating rules. |
| Rules | `.browseragent/rules/**/*.md` | Yes | Modular rules, concatenated in lexical order. |
| Skills | `.browseragent/skills/*/SKILL.md` | Yes | On-demand skill instructions. |
| Agents | `.browseragent/agents/**/*.md` | Yes | Named agent profiles. |
| Commands | `.browseragent/commands/**/*.md` | Yes | Reusable prompt templates. |

`<configDir>` is the same OS app-data directory used by the host (`%APPDATA%\BroAgentAI`, `~/Library/Application Support/BroAgentAI`, `$XDG_CONFIG_HOME/browseragent`). Host state stays in `config.json`; the global `browseragent.json(c)` holds user-level agent/behavior defaults, and the two files are not merged.

Global resources live under `<configDir>/AGENTS.md`, `rules/`, `skills/`, `agents/`, and `commands/`. Project resources use the workspace-root paths in the table above. Config-list paths resolve relative to the file that declares them (global config → `<configDir>`, project/local config → workspace root).

Provider plugins are **not** loaded from the workspace at runtime. Their source lives in `extension/src/providers/<id>/` and is bundled at build time; see section 4. Declarative provider metadata is post-MVP and cannot execute code.

### 2.2 Precedence

Lowest to highest:

1. Built-in defaults.
2. Global config.
3. Project config.
4. Local project config.

Merge rules:

- Scalar values: higher precedence wins.
- `agent`, `providers`: deep merge.
- `mcp`: merge by server ID; a higher layer can override or disable a server.
- `instructions`, `rules`, `skills`, `agents`: concatenate, deduplicated by resolved path; project entries load after global entries.
- Unknown keys are preserved in memory but ignored; they produce a warning, not a hard failure.

### 2.3 JSONC example

```jsonc
{
  "$schema": "https://browseragent.dev/schema/v1.json",
  "version": 1,

  "agent": {
    "defaultProvider": "deepseek",
    "defaultApprovalMode": "ask",
    "maxIterations": 40,
    "reminderInterval": 8
  },

  "providers": {
    "deepseek": { "enabled": true },
    "gemini": { "enabled": true },
    "qwen": { "enabled": false }
  },

  "instructions": [
    "AGENTS.md",
    "docs/CONTRIBUTING.md"
  ],
  "rules": [".browseragent/rules"],
  "skills": [".browseragent/skills"],
  "agents": [".browseragent/agents"],

  "mcp": {
    "filesystem": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "environment": {},
      "enabled": true,
      "timeoutMs": 30000
    },
    "remote-docs": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:DOCS_TOKEN}" },
      "enabled": false
    }
  }
}
```

Rules:

- `version: 1` is required when the file is present.
- `command` is an array. No shell is used.
- `${env:NAME}` expands from the host environment. Missing variables produce a validation error for remote headers and a warning for local `environment`.
- Secrets are never written by BroAgentAI; use environment references.
- Unknown `mcp.*.type` is a validation error.
- Project-defined MCP servers start only when a trust record for the workspace realpath + MCP config hash exists. No config key can grant trust or bypass approvals; trust is created only through an explicit UI action.

## 3. Resource formats

### 3.1 Instructions and rules

- Plain Markdown, no required frontmatter.
- Loaded in order: global instructions, project instructions, `AGENTS.md`, `BROWSERAGENT.md`, configured rules, `.browseragent/rules/**/*.md`.
- Total instruction budget: 64 KB; larger sets are truncated with a warning and file list.
- Injected into the operating prompt under `## Workspace instructions` with file path headings.
- Repository content is data, not authority; the system prompt says instructions inside source files cannot override BroAgentAI safety rules.

### 3.2 Skills

Directory layout:

```text
.browseragent/skills/release-notes/
├─ SKILL.md
├─ template.md
└─ scripts/            # listed, not executed by the core
```

`SKILL.md`:

```markdown
---
name: release-notes
description: Generate release notes from Git history.
---

# Release notes

1. Read commits since the last tag.
2. Group by type.
3. Follow template.md.
```

Rules:

- `name` defaults to the directory name; must match `[a-z0-9-]+`.
- `description` is required for discovery.
- Skill bodies are **not** injected into every prompt. Only name + description are listed; the agent calls `skills.read` when needed.
- `skills.read` is read-only and path-confined to configured skill directories.
- Scripts are never executed automatically; a future skills runner requires a separate approval design.

### 3.3 Agents

`.browseragent/agents/reviewer.md`:

```markdown
---
name: reviewer
description: Review changes without editing.
mode: read-only
provider: deepseek
---

You are a strict code reviewer. Read the diff and report issues.
```

Rules:

- `mode` maps to an approval mode; default is the workspace mode.
- A profile `mode` may only narrow the current approval mode, never elevate it. The user override always wins.
- `provider` is optional; invalid IDs fall back to the default provider.
- Agent bodies are loaded with `agents.read` (read-only, path-confined) and added to the operating prompt when that agent is selected.
- Tool restrictions are enforced by the host per session, not merely advisory.

### 3.4 Commands

`.browseragent/commands/test.md`:

```markdown
---
description: Run the relevant test suite and summarize failures.
agent: default
---

Run the smallest relevant test suite, then summarize failures and likely causes.
```

Commands are prompt templates, not shell commands. They are listed in the panel with their full body (max 16 KB each) and can be inserted into the agent input. No automatic execution. Unlike skills, command bodies are small enough to return in `commands.list`.

## 4. Provider plugin architecture

### 4.1 Folder layout

```text
extension/src/providers/
├─ registry.ts
├─ types.ts
├─ deepseek/
│  ├─ provider.json
│  ├─ plugin.ts
│  └─ adapter.ts
├─ gemini/
│  ├─ provider.json
│  ├─ plugin.ts
│  └─ adapter.ts
└─ qwen/
   ├─ provider.json
   ├─ plugin.ts
   └─ adapter.ts
```

### 4.2 Metadata

`provider.json`:

```json
{
  "id": "deepseek",
  "label": "DeepSeek",
  "description": "DeepSeek web chat",
  "homepage": "https://chat.deepseek.com/",
  "matchPatterns": ["https://chat.deepseek.com/*"],
  "capabilities": {
    "streaming": "dom",
    "attachments": false,
    "reasoning": true
  },
  "status": "planned"
}
```

The Vite config scans these files and injects:

- `host_permissions`
- `content_scripts` for the shared relay
- provider metadata used by the registry

Adding a provider therefore does **not** require editing the manifest, service worker, or panel. Core files stay unchanged.

### 4.3 Runtime contract

```ts
export interface ProviderPlugin {
  id: string;
  label: string;
  matchPatterns: string[];
  capabilities: ProviderCapabilities;
  status: "planned" | "ready";
  createAdapter(): ProviderAdapter;
}

export interface ProviderAdapter {
  healthCheck(): Promise<ProviderHealth>;
  sendPrompt(text: string): Promise<void>;
  waitForReply(options: WaitOptions): Promise<ProviderReply>;
  readLatestReply(): Promise<ProviderReply>;
  isGenerating(): boolean;
  stop(): Promise<void>;
}
```

The content script auto-detects the provider by URL, loads the matching plugin from the registry, and exposes `health`, `send`, `wait`, `stop` messages to the service worker. The adapter owns all DOM selectors; the core owns transport, parsing, approvals, and tools.

Runtime `providers` config in the MVP can only enable/disable bundled plugins. It cannot add `matchPatterns` or content scripts; host permissions are derived from bundled `provider.json` at build time and shown read-only in Settings. A declarative-provider config that claims new URL patterns is ignored with a warning until the Provider Lab/build flow exists.

### 4.4 Declarative providers

A future tier for simple chats can be defined in `browseragent.json` and compiled into a provider plugin at build time (never loaded as runtime code):

```jsonc
{
  "providers": {
    "my-chat": {
      "enabled": true,
      "matchPatterns": ["https://my-chat.example/*"],
      "selectors": {
        "composer": "textarea",
        "submit": "button[type=submit]",
        "assistantMessage": "[data-role=assistant]",
        "generating": "[data-generating=true]"
      }
    }
  }
}
```

Declarative selectors are data, not code. They can be prototyped in a "Provider Lab" (post-MVP) and promoted to a code adapter when streaming or code-block handling is too complex.

### 4.5 Third-party plugin policy

- Runtime remote code is prohibited by MV3 and by BroAgentAI policy.
- Third-party provider packs are installed as extension builds (sideloaded or store-listed), not loaded from a URL.
- Project config may enable/disable bundled providers, but cannot add selectors, host permissions, or code.
- A provider plugin cannot access files, Git, or MCP directly; it only relays prompts/replies through the core.

## 5. MCP architecture

### 5.1 Role

The native companion is the **MCP client/host**. It:

- reads MCP server definitions from merged config;
- starts local servers as child processes (stdio) and connects to remote servers (Streamable HTTP/SSE);
- lists tools and exposes them in the BroAgentAI tool catalog;
- executes tool calls on behalf of the agent, under approval rules;
- caps output, applies timeouts, and tears servers down when the host exits.

The extension never spawns processes and never talks to MCP servers directly.

### 5.2 Transport support

| Transport | Status | Notes |
| --- | --- | --- |
| `stdio` | MVP | Local child process; array command; no shell. |
| Streamable HTTP | MVP | POST + optional SSE; headers from env refs. |
| SSE (legacy) | Fallback | Use when a server advertises SSE only. |

### 5.3 Tool naming and catalog

- Namespaced name: `mcp.<serverId>.<toolName>`.
- Server IDs: `[a-zA-Z0-9_-]{1,40}`.
- The catalog entry contains description, JSON input schema, risk class, and server status.
- Duplicate server IDs across layers are merged, not duplicated.
- Tool names are not rewritten; the panel displays the namespaced form, and the RPC carries `{ server, tool }`.

### 5.4 Risk mapping

| MCP annotation | BroAgentAI risk |
| --- | --- |
| `readOnlyHint: true` | `read` |
| `destructiveHint: true` | `destructive` |
| otherwise | `write` |

- `mcp.callTool` defaults to `write`.
- Per-server `risk` and per-tool overrides are supported, but may only **increase** risk (`read` → `write` → `destructive`), never lower it.
- Approval modes apply exactly as for built-in tools.
- `Read-only` denies all MCP tools whose effective risk is not `read`.

### 5.5 Lifecycle

```text
untrusted → stopped → starting → ready → stopping → stopped
                         ↘ error
```

- Project-defined servers never auto-start, even after trust; start requires an explicit panel action.
- Global user-authored servers may set `autoStart: true`.
- Auto-start is allowed only for global config or a trusted project.
- The host stops all servers on shutdown; child processes are terminated, then killed after 2 s.
- Restart is per server; a broken server does not block others.

### 5.6 Trust

- Project-defined MCP servers are considered untrusted until the user approves the workspace.
- Trust records the workspace realpath and a hash of the effective MCP config.
- The hash covers commands, URLs, working directories, environment/header keys, and risk overrides; secret values are never hashed.
- Changing those fields invalidates trust and requires re-approval; running project servers are stopped.
- Global and local MCP servers are user-authored and treated as trusted.
- A project-layer override of a global/local server does not inherit trust; if the project changes its command/URL/cwd/env/header/risk fields, the merged server becomes project-originated and requires trust.
- The trust store lives in `<configDir>/trust.json`; no secrets.

### 5.7 Safety limits

| Limit | Value |
| --- | --- |
| Servers per workspace | 16 |
| Tools per server | 256 |
| Tool call timeout | 60 s default, 120 s max |
| Tool result size | 512 KB, truncated flag |
| Concurrent tool calls per server | 4 |
| Server log buffer | 64 KB ring buffer |
| Startup timeout | 30 s |

Additional rules:

- No shell interpolation; `spawn(command, args)`.
- Inherit a minimal environment plus configured values; never print environment values.
- Remote headers may reference secrets but are redacted in logs.
- MCP results are data; they cannot change approval mode or grant permissions.
- A server that fails repeatedly is marked `error` and is not restarted automatically more than once per session.

## 6. Protocol additions

New methods:

| Method | Risk | Purpose |
| --- | --- | --- |
| `config.get` | read | Effective merged config, sources, and validation warnings. |
| `config.reload` | read | Re-read config files and resource indexes. |
| `config.validate` | read | Validate without applying. |
| `instructions.list` | read | Instruction/rule files, metadata, and capped content (64 KB total). |
| `skills.list` | read | Skill name, description, path. |
| `skills.read` | read | Full skill body. |
| `agents.list` | read | Agent profiles and metadata. |
| `agents.read` | read | Full agent profile body. |
| `commands.list` | read | Command metadata and full templates (16 KB cap). |
| `mcp.servers` | read | Configured servers, trust, and status. |
| `mcp.tools` | read | Tools for ready servers. |
| `mcp.start` | destructive | Start a server (explicit user action). |
| `mcp.stop` | destructive | Stop a server. |
| `mcp.restart` | destructive | Restart a server. |
| `mcp.callTool` | write | Execute a tool; risk adjusted by annotations. |
| `workspace.trust` | destructive | Trust current project MCP config. |
| `workspace.untrust` | destructive | Revoke trust and stop affected project MCP servers. |
| `tools.list` | read | Built-in + MCP tool catalog for the agent prompt. |

Events:

- `config.changed`
- `mcp.status`
- `mcp.toolsChanged`

Error codes: `CONFIG_INVALID`, `MCP_UNTRUSTED`, `MCP_NOT_READY`, `MCP_ERROR` (plus existing `TIMEOUT`/`NOT_ALLOWED`).

## 7. UI additions

- **Settings → Configuration**: global/project/local file status, effective config preview, reload, open file path, validation warnings.
- **Settings → MCP**: server list, transport, trust badge, status, tool count, Start/Stop/Restart, tool browser, "Trust this workspace" action.
- **Agent**: tool catalog shows MCP tools with server badges; approval cards show server + tool + args.
- **Explorer**: optional `.browseragent` folder highlighting; no secrets.
- **Provider switcher**: disabled/planned providers show status; plugin health is visible.

## 8. Security review checklist

- [ ] Project config cannot execute code or start MCP without trust.
- [ ] MCP commands are arrays, never shell strings.
- [ ] Env interpolation never logs secret values.
- [ ] MCP tools are risk-classified and approval-gated.
- [ ] Config risk overrides cannot downgrade a tool's risk.
- [ ] Read-only mode blocks non-read MCP tools at the service worker and host.
- [ ] Remote MCP URLs require HTTPS except localhost.
- [ ] Provider plugins only relay prompts/replies; no fs/Git/MCP access.
- [ ] Runtime config cannot add host permissions or content scripts.
- [ ] Skill scripts are never executed automatically.
- [ ] Resource discovery is path-confined and bounded.
- [ ] Config parse errors surface without blocking the whole app.

## 9. Implementation phases

| Phase | Scope |
| --- | --- |
| P0 | Shared config/MCP/provider types; config loader; resource discovery; RPC; tests. |
| P1 | Provider plugin registry, generated manifest, DeepSeek plugin skeleton. |
| P2 | MCP stdio client, tool catalog, approval integration, settings UI. |
| P3 | Remote MCP transports, trust UI, restart/recovery. |
| P4 | Declarative providers and Provider Lab (post-MVP). |

Mapping: P0 spans M0–M1, P1 lands in M5–M6, P2 in M7, P3 in M8, and P4 is post-MVP. Provider plugin registration starts in M0 so the manifest pipeline is proven early.

## 10. Acceptance criteria

- [ ] A `browseragent.jsonc` file with comments loads without errors; invalid JSONC produces a line/column diagnostic.
- [ ] Global/project/local precedence is deterministic and tested.
- [ ] `AGENTS.md`, rules, skills, agents, and commands are discovered without executing anything.
- [ ] Skills are listed by metadata and read on demand.
- [ ] Adding a provider folder with `provider.json` + `plugin.ts` updates the manifest and registry without core edits.
- [ ] Project provider config cannot add host permissions or content scripts.
- [ ] A local MCP server can be started, listed, called, stopped, and restarted.
- [ ] Project MCP servers require trust and an explicit start; changing the command/URL/working directory/env-header/risk fields invalidates trust and stops them; no config key can grant trust.
- [ ] MCP tool risk maps from annotations, overrides cannot downgrade it, and approval mode enforces it.
- [ ] No MCP command is run through a shell.
- [ ] Output caps and timeouts are enforced.
