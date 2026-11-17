# Changelog

All notable changes to BroAgentAI (Browser Agent AI) are written down here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Release files are built locally with `npm run release` (see [docs/releases](docs/releases)).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-11-17

First public release. Everything below is new.

### Added

- **Side panel** for Chrome and Edge (Manifest V3) with a VS Code Dark Modern look: Explorer, Search, Source Control, Terminal, Agent and Settings tabs.
- **broagentai-bridge**, the Node.js native-messaging host (`com.broagentai.host`). The browser starts it over stdio, so there is no open port and no terminal to keep running.
- **Workspaces**: add a folder by path or the OS folder picker, switch between recent workspaces, rename or remove them (removing never deletes files).
- **Explorer**: lazy file tree, Git status badges on files and folders, new / rename / delete, "show ignored" toggle, quick preview with mtime-checked saves.
- **Editor tab**: full-tab CodeMirror 6 editor with syntax highlighting for TS/JS, JSON, HTML, CSS and Markdown.
- **Search** across the workspace with case-sensitive and regex toggles, results grouped by file.
- **Source control** on the system Git CLI: stage, unstage, diff, discard, commit, create and switch branches, fetch, pull (ff-only, merge, rebase), push with confirmation, conflict state with Abort. No force-push.
- **Terminal**: real PTY terminal (xterm.js + node-pty) in the workspace folder.
- **Agent loop** that relays tool commands between the web AI chat tab and the bridge, with an activity log, Stop, and a Resend button for stalled turns.
- **Four approval modes**: Read-only, Always ask, Ask once and Auto approve. Writes show a diff preview before you allow them; approvals are enforced by the host, not only the panel.
- **Built-in tools** for the AI: `fs.*`, `git.*`, `skills.*` and an OS-aware `shell.run` (PowerShell on Windows).
- **MCP servers** over stdio and HTTP, shown in the agent tool catalog as `mcp.<server>.<tool>` with risk labels. Project-defined servers stay untrusted until you review the exact command, and changing their config revokes trust.
- **Providers**: DeepSeek, Gemini and Qwen, each defined by a `provider.json` of DOM selectors verified against the live sites.
- Agent-typed messages in the chat page get a small `BroAgentAI` badge so you can tell them apart from your own.
- The agent also accepts a provider's native tool-call markup as a command.
- The chat loop survives rate limits, page reloads and stalled replies.
- **Project config**: `AGENTS.md` instructions, `broagentai.jsonc` settings, `broagentai.json(c)` / `broagentai.local.json(c)` MCP servers.
- English and Bahasa Indonesia UI, plus dark, light and system themes.
- Installers: `install.bat` / `install.ps1` on Windows and `npm run host:install:dev` on any OS.
- Unit tests for the bridge and extension, plus Playwright end-to-end runs against the real bridge and a scripted chat page.
- README with feature screenshots.

### Security

- Every file path is confined to the active workspace; `../` escapes and symlinks pointing outside are rejected.
- Only this extension's id may talk to the native host (`allowed_origins`).
- No telemetry, no cloud backend, no API keys, and no stored Git credentials.

[Unreleased]: https://github.com/fadhly-permata/BroAgentAI/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fadhly-permata/BroAgentAI/tree/v0.1.0
