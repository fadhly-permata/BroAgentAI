# BroAgentAI — Functional Specification Document (FSD)

| Field | Value |
| --- | --- |
| Status | Draft v0.1 |
| Date | 2026-11-15 |
| Related | `00-PRD.md`, `01-BRD.md`, `02-TSD.md`, `04-ERD.md`, `05-ADR.md`, `06-ROADMAP.md`, `07-PLUGIN-MCP.md` |

## 1. UI shell

### 1.1 Layout

```text
┌──────────────────────────────────────────────┐
│ BroAgentAI   [workspace ▾]   [status] [⋯]  │  header
├───────────────┬──────────────────────────────┤
│ Explorer      │                              │
│ Search        │        Main content          │
│ SCM           │  (editor / diff / chat)      │
│ Agent         │                              │
│               │                              │
├───────────────┴──────────────────────────────┤
│ branch ↑2 ↓1   provider: Ready   mode: Ask   │  status bar
└──────────────────────────────────────────────┘
```

- The side panel is the primary surface; narrow widths collapse secondary labels.
- Explorer/Search/SCM/Agent are tabs within the activity rail.
- Editor and diff open in full tabs; the panel keeps their entry point.
- The header is always visible. The status bar is always visible.

### 1.2 Header

Elements:

- Product mark + name.
- Workspace selector: active workspace name, dropdown of recent workspaces, "Open folder…", "Manage workspaces".
- Companion status pill: `Checking`, `Ready`, `Host offline`, `Host outdated`, `Error`.
- Overflow menu: Settings, Diagnostics, Restart companion, Reload panel.

Behavior:

- Clicking the workspace selector lists recent workspaces with paths.
- Selecting a workspace validates it with the host and sets it active.
- Companion pill opens Diagnostics when not ready.

### 1.3 Status bar

Elements:

- Git branch, ahead/behind counts, dirty indicator.
- Provider status: `No tab`, `Ready`, `Generating`, `Needs login`, `Adapter error`.
- Approval mode selector.
- Tool activity spinner during host calls.

### 1.4 Global states

| State | UI |
| --- | --- |
| Host offline | Banner: "Companion not running." Buttons: Restart companion, Setup help. |
| Host outdated | Banner with host/extension versions and update instructions. |
| No workspace | Empty state with "Open folder" and "Recent" options. |
| Workspace missing | Inline error with Remove and Locate actions. |
| Provider not configured | Agent tab prompts to choose/open a provider tab. |
| Permission denied | Approval card or inline error; no silent failure. |
| Loading | Skeleton rows, not full-screen spinners. |

## 2. First-run and setup

### 2.1 First-run checklist

Shown in the panel when no workspace is configured:

1. **Companion installed** — status from `system.ping`.
2. **Workspace opened** — add a folder.
3. **AI tab ready** — open Qwen/DeepSeek/Gemini and sign in.
4. **Approval mode chosen** — default `Ask`.

Each item shows Done / Action / Help. The checklist dismisses when all items are done.

### 2.2 Companion setup help

Contents:

- Build/registration commands for dev mode.
- Host name `com.browseragent.host`.
- Config path and log path.
- Extension ID.
- "Recheck" button.
- Error details expander.

## 3. Workspace management

### 3.1 Open folder

Flow:

1. User clicks "Open folder…".
2. Panel shows an input for an absolute path plus recent paths.
3. User submits.
4. Host validates: existing directory, readable, realpath.
5. Success: workspace added, active, Explorer loads.
6. Failure: inline error (`not found`, `not a directory`, `permission denied`, duplicate handled silently by focusing existing).

Constraints:

- Paths are absolute; `~` is expanded by the host.
- Duplicate paths focus the existing workspace and update `lastOpenedAt`.

### 3.2 Workspace dropdown

- Shows up to 10 recent workspaces, name + truncated path.
- Current workspace is checked.
- Actions: Open folder, Manage workspaces.
- Missing workspace shows a warning icon and "Remove" action.

### 3.3 Manage workspaces

- List with name, path, last opened.
- Actions: Open, Rename (display name only), Remove from list (does not delete files).
- Removing the active workspace switches to the most recent remaining or none.

## 4. Explorer

### 4.1 Structure

- Tree of directories and files from `fs.listTree`/`fs.listDir`.
- Root label is the workspace name.
- Each row: chevron (dirs), icon, name, optional Git status badge.
- Sorted: directories first, then files, case-insensitive.
- Ignored paths hidden by default; toggle "Show ignored".

### 4.2 Interactions

| Action | Result |
| --- | --- |
| Click file | Open in editor tab. |
| Click dir | Expand/collapse. |
| Right-click | Context menu. |
| Double-click dir | Expand and focus first child. |
| Drag file | Optional post-MVP move. |

Context menu:

- New File…
- New Folder…
- Rename…
- Duplicate
- Copy Path
- Copy Relative Path
- Reveal in Explorer/Finder (post-MVP)
- Delete (confirmation)

### 4.3 States

- Loading: skeleton rows.
- Empty workspace: "This folder is empty."
- Error: message + Retry.
- File too large to preview: size + "Open anyway" (if under hard cap) or "Open externally" (post-MVP).
- Git-decorated: modified `M`, added `A`, deleted `D`, untracked `U`, conflict `C`.

### 4.4 Create/rename/delete

- Inline input in the tree; Enter commits, Escape cancels.
- Validation: non-empty, no path separators, no `.`/`..`, no collision.
- Rename preserves extension by default.
- Delete asks for confirmation and states whether the path is tracked by Git.
- After mutation, refresh the parent and update SCM.

## 5. Editor

### 5.1 Open file

- Full tab (`editor.html?workspaceId=…&path=…`).
- Loads via `fs.readFile`.
- Breadcrumb: workspace / path segments.
- Tabs for multiple open files, persisted in `chrome.storage.session`.
- Dirty indicator, Save (Ctrl/Cmd+S), Close.

### 5.2 Editing

- CodeMirror 6 with language detection by extension.
- Line numbers, bracket matching, search, undo/redo.
- No auto-save in MVP.
- Save sends `fs.writeFile` with `baseMtime`; on `MTIME_CONFLICT`, show:
  - "File changed on disk." Actions: Reload, Overwrite, Diff.
- Binary/large files show a read-only notice.
- Read-only mode blocks editing and Save.

### 5.3 External changes

- `fs.changed` for an open file triggers:
  - Clean buffer → reload silently.
  - Dirty buffer → "Changed on disk" banner with Reload/Keep.
- Deleted file → banner with Close/Save as…

### 5.4 Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+S | Save |
| Ctrl/Cmd+W | Close tab |
| Ctrl/Cmd+P | Quick open (post-MVP) |
| Ctrl/Cmd+F | Find in file |
| Ctrl/Cmd+Shift+F | Search workspace |

## 6. Search

### 6.1 UI

- Query input with case-sensitive, regex, and include/exclude toggles.
- Results grouped by file: path, match count, expandable lines.
- Click result → open file at line (editor tab scrolls to line).
- Replace is post-MVP.
- Cap: 500 matches; "Load more" uses cursor.

### 6.2 Behavior

- Debounced 250 ms; cancel previous request.
- Empty query clears results.
- Invalid regex shows inline error, no request.
- Backend uses `rg` when available; fallback scan respects ignores and size caps.
- "No results" state includes the query and toggles.

## 7. Source Control

### 7.1 Layout

```text
┌────────────────────────────────────────────┐
│ branch ▾   ↑2 ↓1   [Fetch] [Pull] [Push]   │
├────────────────────────────────────────────┤
│ Staged changes (2)                         │
│   M src/app.tsx                    [−]     │
│ Changes (5)                                │
│   M src/lib.ts                     [+]     │
│   U notes.md                       [+]     │
│   C merge.txt                      [!]     │
├────────────────────────────────────────────┤
│ [message input]                  [Commit]  │
└────────────────────────────────────────────┘
```

- Groups: Merge changes, Staged, Changes, Untracked.
- Row actions: stage, unstage, discard, open diff.
- Click row opens diff tab.
- Commit button disabled when message empty or no staged changes.

### 7.2 Diff viewer

- Full tab; unified diff with line numbers, additions/removals colored.
- File header with path and change type.
- Toggle staged/unstaged.
- Truncated diffs show "Diff truncated" + "Load more".
- Binary files show metadata only.

### 7.3 Commit

Flow:

1. User stages files.
2. Enters message (multi-line, first line subject).
3. Clicks Commit.
4. Host runs `git commit -m`.
5. Success: clear message, refresh status, toast with commit short hash.
6. Failure: inline error, preserve message.

Rules:

- No auto-stage.
- No amend in MVP.
- Empty message blocked client-side and host-side.
- Hooks run normally; hook output is shown on failure.

### 7.4 Branch

- Branch picker lists local branches + "Create new branch…".
- Switching with a dirty tree asks to commit/stash (stash post-MVP) or cancel.
- Detached HEAD shows a warning with "Create branch here".

### 7.5 Fetch / Pull / Push

Fetch:

- Button with spinner; updates ahead/behind; no working-tree change.
- Auth failure → error banner with "Test remote" and setup hint.

Pull:

- Opens a small dialog: remote/branch, mode (`ff-only` default, `merge`, `rebase`), ahead/behind.
- Requires confirmation.
- On conflict: banner with Abort pull, open conflicted files.
- On success: refresh status/tree.

Push:

- Confirmation dialog: remote, branch, commits to push.
- Refuses force-push (not implemented).
- No upstream → offers `git push -u origin <branch>`.
- Auth failure → same guidance as fetch.

Pull modes:

| Mode | Behavior on divergence |
| --- | --- |
| ff-only | Fails with hint to choose merge/rebase. |
| merge | Creates a merge commit if needed; conflicts surface. |
| rebase | Rebases local commits; conflicts surface. |

### 7.6 Conflict state

- Banner: "Merge/rebase in progress."
- List conflicted files with `C` badge.
- Actions: Open file, Mark resolved (stage), Abort.
- Commit button changes to "Commit merge" when appropriate.
- No automatic conflict resolution.

## 8. Agent

### 8.1 Layout

```text
┌────────────────────────────────────────────┐
│ Provider: [DeepSeek ▾]  Mode: [Ask ▾]      │
│ Status: Ready · Workspace: my-project      │
├────────────────────────────────────────────┤
│ Conversation log                           │
│  ▸ You: add tests for parser               │
│  ▸ Tool: fs.readFile src/parser.ts         │
│  ▸ Tool result: 214 lines                  │
│  ▸ Approval: fs.writeFile (pending)        │
│                                            │
├────────────────────────────────────────────┤
│ [Prompt input....................] [Send]  │
└────────────────────────────────────────────┘
```

- Conversation log shows user prompts, AI summaries, tool calls, results, approvals, errors.
- Tool entries are collapsible; raw params available; MCP tools show a server badge.
- An agent selector lists discovered profiles plus "Default"; selecting one applies its instructions/restrictions to the next turn.
- A context strip shows active agent profile, loaded instructions count, and MCP tools count.
- Prompt input supports multi-line; Send disabled while generating.
- Stop button replaces Send during generation.

### 8.2 Provider selection

- Dropdown: supported providers + "Open provider tab".
- If the provider tab is missing, selecting it offers to open the URL.
- If not logged in, status `Needs login` with "Open tab".
- Changing provider mid-session asks to end the current session.

### 8.3 Session start

1. Ensure workspace active.
2. Ensure provider tab ready.
3. Ensure approval mode selected (default `Ask`); optionally select an agent profile.
4. Send operating prompt; wait for readiness.
5. Show "Session ready" and enable the prompt input.

If the host is offline, session start is blocked with Restart/Setup actions.

### 8.4 Sending a prompt

1. User types and sends.
2. Panel appends the prompt to the log.
3. Content script inserts the prompt into the provider composer and submits.
4. Deltas stream into the log.
5. Parser extracts commands; loop proceeds.
6. Final answer ends the turn; input re-enables.

### 8.5 Approval card

Contents:

- Risk badge: Read / Write / Destructive / Git / Push.
- Tool name and summary.
- Params (path, range, message).
- Diff preview for writes and patches (unified, capped).
- Buttons: Allow once, Allow for session, Deny.
- Countdown? No; waits indefinitely, but shows "Waiting".

Behavior:

- Multiple pending approvals queue; only one is actionable at a time.
- Deny sends a structured error back to the AI.
- "Allow for session" applies to the exact tool + path scope, not all tools.
- Mode changes mid-session apply to subsequent commands.

### 8.6 Command log

- Every tool call: timestamp, tool, risk, decision, duration, status.
- Filter by status/risk.
- Copy command JSON.
- Clear log (does not cancel pending).
- Persisted in `chrome.storage.session`.

### 8.7 Errors and recovery

| Error | UI |
| --- | --- |
| Host offline | Pause loop, banner with Restart. |
| Provider tab closed | Pause, "Reopen tab" action. |
| Provider logged out | Pause, "Sign in" action. |
| Parser failure | Send corrective feedback automatically (max 3 times), then pause. |
| Tool failure | Send error to AI; show in log. |
| Iteration limit | Pause with "Continue" or "Stop". |
| User stops | Stop provider generation; log cancelled. |
| Config invalid | Banner with file/line, "Use previous config" and "Open config". |
| MCP server error | Server row shows error, log tail, Restart; other servers keep working. |
| MCP config changed | Running project servers stop; banner "Re-trust required"; tools locked. |
| MCP server not ready | Tool call fails with retryable error; server row shows state. |
| MCP untrusted | Tool list shows locked badge; action "Review & trust". |

### 8.8 Configuration and resources

Session context strip:

- `Config: project + local` or `global only`.
- `Instructions: 4 files, 12.4 KB`.
- `Skills: 6` (metadata loaded; bodies on demand).
- `Agent: default` (profile selector).
- Clicking opens **Settings → Configuration**.

Config states:

| State | UI |
| --- | --- |
| No config | "Using defaults"; Create project config action. |
| Valid | Source badges (global/project/local), warnings count. |
| Warnings | Yellow banner; session can start. |
| Invalid | Red banner; previous config used if available; session start blocked when safety-critical fields are invalid. |
| Missing referenced file | Warning listing the path; continue. |
| Budget exceeded | Warning with truncated file list. |

Skill/agent behavior:

- Skill metadata appears in the agent context; the AI can call `skills.read` on demand.
- Selecting an agent profile adds its instructions and optional provider/mode restrictions; it can narrow but never elevate the current approval mode.
- Commands are user-triggered prompt templates; they never execute automatically.
- Config changes are not applied mid-turn; show "Reload for next turn" or "Restart session".

### 8.9 MCP

Panel section under **Settings → MCP**:

```text
┌────────────────────────────────────────────┐
│ MCP servers                    [Reload]    │
├────────────────────────────────────────────┤
│ filesystem   stdio   ● ready   12 tools    │
│   npx -y @modelcontextprotocol/...         │
│   [Stop] [Restart] [Tools]                 │
│                                            │
│ remote-docs  http    ○ disabled  0 tools   │
│   [Enable]                                 │
└────────────────────────────────────────────┘
```

- Server rows show transport, trust, status, tool count, and redacted command/URL.
- `untrusted` rows show **Review & trust**; the review modal lists exact commands/URLs and env variable names (never values).
- Start/Stop/Restart are explicit user actions.
- Starting requires trust for project-defined servers; global servers are trusted.
- Changing MCP config invalidates trust and shows a re-review banner.
- Tool browser shows name, description, risk, and annotations.
- MCP tools appear in the agent tool catalog only when the server is `ready`.
- A failed server does not block other servers or built-in tools.
- Approval cards include server, tool, arguments, and risk.

### 8.10 Trust flow

1. User opens **Settings → MCP** in a project with project-defined servers.
2. Panel shows "This workspace wants to run N MCP servers."
3. Review lists origin (global/project/local), each command array/URL, working directory, environment variable names, and risk defaults.
4. Buttons: Trust and start, Trust only, Cancel.
5. Trust stores realpath + config hash.
6. On config change: banner "MCP configuration changed; re-trust required." Running project servers stop and none start until re-approved.
7. Revoke trust action stops servers and removes the record.

## 9. Settings

Sections:

- Companion: status, version, app config path, log path, restart, diagnostics.
- Workspaces: list, remove, default ignore patterns.
- Configuration: global/project/local source status, effective config preview, validation warnings, reload, open file, create project config.
- Instructions: discovered `AGENTS.md`/`BROWSERAGENT.md`/rules, sizes, warnings.
- Skills: name, description, path; preview body.
- Agents: profiles, mode/provider restrictions, preview.
- Commands: templates and descriptions.
- MCP: server list, trust, status, tools, start/stop/restart, review modal, revoke trust.
- Providers: plugin status, version, fixed URL patterns (read-only), tab URL, health check, enabled toggle.
- Editor: font size, tab size, word wrap, theme.
- Agent: default provider, default approval mode, iteration limit, reminder interval.
- Advanced: protocol version, extension ID, export/import config (post-MVP).

## 10. Notifications and toasts

- Success: commit created, file saved, workspace added.
- Error: host disconnected, Git auth failed, save conflict.
- Info: host restarted, provider tab opened.
- Toasts auto-dismiss after 5 s; errors persist until dismissed.
- Critical banners are inline, not toasts.

## 11. Keyboard and accessibility

- Focus ring visible on all interactive elements.
- All icon buttons have `aria-label`.
- Tabs use roving tabindex; arrow keys navigate.
- Modals trap focus and close on Escape.
- Approval decisions are reachable by keyboard.
- Color is never the only signal for status (icons + text).
- Minimum contrast WCAG AA.

## 12. Acceptance criteria (MVP)

### Setup and connection

- [ ] Fresh profile can install the unpacked extension, register the dev host, and see `Ready` without restarting Chrome.
- [ ] If the host is not registered, the panel shows a setup state with commands and does not crash.
- [ ] Restart companion reconnects and preserves the active workspace.

### Workspace and files

- [ ] Open folder validates and persists; recent list survives browser restart.
- [ ] Explorer lists directories, opens files, and respects ignores.
- [ ] Editing and saving a file works; external modification produces a conflict banner.
- [ ] Path traversal (`../`) and symlink escape are rejected with `PATH_ESCAPE`.

### Search

- [ ] Search returns grouped results and opens the file at the matching line.
- [ ] Invalid regex shows an error without sending a request.
- [ ] Results cap at 500 with Load more.

### SCM

- [ ] Status shows staged/unstaged/untracked/conflicts and ahead/behind.
- [ ] Diff opens per file for staged and unstaged.
- [ ] Stage, unstage, commit with message.
- [ ] Create/switch branch; switching with dirty tree is blocked with guidance.
- [ ] Fetch, pull (three modes), push work against a test remote.
- [ ] Auth failure maps to guidance with Test remote.
- [ ] Conflicts show Abort and no auto-resolution.

### Agent

- [ ] DeepSeek session starts and completes a read → edit → summary flow.
- [ ] `Read-only` denies writes; `Ask` prompts; `Auto-edit` auto-approves writes but asks for delete/commit; `Full-auto` auto-approves except push/pull unless auto-sync is enabled.
- [ ] Approval card shows a diff preview for writes.
- [ ] Parser handles fenced JSON, rejects multiple commands, and sends corrective feedback.
- [ ] Host/provider failures pause the loop with a recovery action.
- [ ] Stop cancels generation and pending work.

### Configuration and resources

- [ ] `browseragent.jsonc` with comments loads; invalid JSONC shows file/line and does not crash.
- [ ] Global → project → local precedence is visible and correct.
- [ ] `AGENTS.md`, rules, skills, agents, and commands are discovered; nothing executes during discovery.
- [ ] Skill body is read on demand via `skills.read`; it is not injected into every prompt.
- [ ] A command template can be listed and inserted into the input without executing anything.
- [ ] Selecting an agent profile changes prompt context and may restrict mode/provider, but cannot elevate the approval mode.
- [ ] Config reload does not mutate a running turn; the UI offers next-turn/restart.
- [ ] Instruction budget overflow shows a truncation warning.

### MCP

- [ ] Project MCP config is untrusted by default; no process starts before trust.
- [ ] Trust alone never auto-starts a project server; an explicit Start is required.
- [ ] A project override of a global server is untrusted and cannot inherit global trust.
- [ ] No project config key can grant trust or bypass approvals.
- [ ] Trust review shows exact commands/URLs and env variable names, not values.
- [ ] Trust is invalidated when MCP config changes; running project servers stop.
- [ ] A local stdio server starts, lists tools, and executes a call.
- [ ] A remote HTTP server can be configured and connected (manual test if no fixture).
- [ ] MCP read/write/destructive risk maps from annotations, overrides may only escalate, and the result is enforced by the selected mode.
- [ ] Read-only mode denies non-read MCP tools.
- [ ] MCP timeout, result cap, and server error isolation work.
- [ ] Stopping/restarting a server updates the tool catalog and agent context.
- [ ] No MCP command is invoked through a shell.

### Provider plugins

- [ ] Adding a provider folder with `provider.json` + `plugin.ts` updates host permissions/content-script matches at build time.
- [ ] Provider registry selects the adapter by URL; an unknown URL shows no provider.
- [ ] A broken adapter affects only that provider and shows `adapter-error`.
- [ ] Runtime provider config only enables/disables bundled plugins; it cannot add host permissions or URL patterns.
- [ ] A provider plugin cannot call filesystem/Git/MCP methods directly.

### Quality

- [ ] Typecheck passes for all workspaces.
- [ ] Host unit/integration tests pass.
- [ ] No secrets or file contents in logs.
- [ ] No console errors during the main flows.
