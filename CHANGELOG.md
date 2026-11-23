# Changelog

All notable changes to BroAgentAI (Browser Agent AI) are written down here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Release files are built locally with `npm run release` (see [docs/releases](docs/releases)).

## [Unreleased]

### Added

- **All remaining non-installer backlog items.** Added Claude, Grok, Kimi, GLM, Mistral and Arena provider plugins, Provider Lab with a bundled local catalog, allowlisted project scripts, approved skill runs, multi-root path resolution, Git blame/stash/per-line staging, quick actions, session resume from the bridge store, transcript export, layout settings and full en/id i18n parity.
- **Plugin hardening.** Gemini/Qwen get stable message-order fallback keys; DeepSeek quota errors are detected by a `detectError` hook and suggested as a provider switch; a plugin template, `docs/write-a-webchat-plugin.md`, isolated-plugin e2e, and ADR-020 acceptance complete web chat P5.
- **Cross-platform CI.** `.github/workflows/ci.yml` runs typecheck, unit tests, build, the shell benchmark gate, and browser e2e on Windows, macOS and Linux.
- **Linux installer (`install.sh`).** Prepares everything on the first run: Node.js 22.6+ (a portable, SHA-256-checked copy from nodejs.org in `.runtime/` when the one on `PATH` is missing or too old), the build tools node-pty needs (shows the apt/dnf/yum/pacman/zypper/apk command, asks, then runs it with `sudo`), `npm ci`, the build, and the native host registration for every detected browser (Chrome, Chromium, Edge, Brave). Without build tools the bridge still installs; only the Terminal tab is unavailable. `--uninstall` removes the registration.
- **Brave** is a supported browser for the native host (`--browser brave`) on Windows, Linux and macOS.
- **Co-authors on commits.** Every commit made through BroAgentAI (Git panel and agent) carries a `Co-authored-by` trailer for BroAgentAI's author. More co-authors can be added as `coAuthors` (a list of `"Name <email>"`) in `~/.broagentai/config.json`, `broagentai.jsonc` or `.broagentai/config.json`; the most specific layer wins, `[]` removes the added ones, malformed entries are skipped and a co-author already named in the message is not repeated.
- **Failed generations are retried.** A web chat plugin can list its site's failure text in `errorReplies` (regular expressions). A short reply that matches, such as "Something went wrong generating that response", is no longer taken as the AI's final answer: the panel resends the agent's last message twice (after 3 s and 8 s), then shows Resend and a notification. A failure on the user's own message is reported, not resent.
- **Blocking prompts: ChatGPT's "Context window full" no longer stalls the agent.** A web chat plugin can list `blockingPrompts`: a banner that replaces the composer (a title regex) and the one button that gets past it (a button regex inside the same banner). ChatGPT's plugin names "Context window full" with its "New chat" button. Whenever a session is active and the banner shows (also when the page keeps a typed message in its input, which looked like a rate limit before), the panel presses that button, waits for the new chat, and sends the operating prompt with a handoff of the old chat, since ChatGPT's own summary lacks the tool catalog. A message the old chat never answered (such as a tool result) is carried over and the agent continues; with nothing pending (agent idle, or a session started in a chat that was already full) the AI answers READY and the user goes on typing in the new chat. The panel log and a notification say "context window full - dilanjutkan di chat baru". Upgrade and billing buttons are refused in plugin.json and never pressed. Loop guard: a banner back within 90 s of a new chat, a 6th new chat in one session, a button that cannot be pressed or a new chat without a composer stop the automation with a message instead of clicking again.
- **Source Control graph.** A Changes / Graph toggle shows the commit history across all refs with branch and merge lanes, ref chips and the HEAD commit; click a commit to list the files it changed and a file to open its diff (`git.log`, `git.commitFiles`, `git.commitDiff`).
- **plugin.js of imported plugins runs.** Each custom plugin's hooks run through `chrome.userScripts` in a world of their own, with a CSP that blocks network and eval and no access to the extension: hooks only reach the page and talk to the relay through the DOM. They need Chrome's "Allow User Scripts" for BroAgentAI; the Plugins page shows whether each plugin's script is on, off or not registered yet, with the steps to turn it on, and registers the scripts itself when the service worker predates the toggle. Sessions on a custom plugin are labelled "(custom)", and Auto approve with a custom plugin needs a confirmation once per session (declining switches to Always ask).
- **Web chat plugins without rebuilding** (Settings → Plugins). Import a plugin folder or `.zip`, review it (sites, warnings, the code it brings; for an update the version change and a diff), and Chrome asks for access to its sites only. Each plugin can be turned on/off, updated or rolled back in place, exported as `.zip`, removed (an override goes back to the built-in), re-granted access, checked on an open chat tab, and its open tabs reloaded. One plugin per site: installing or turning on a plugin turns off the one that claimed the same site. Plugins live in `chrome.storage.local`; the service worker registers the relay on their sites (`relay-dynamic.js`) and re-applies that after every extension reload. Hostile `.zip` files (`../` paths, symlinks, zip bombs, too many files or bytes) are refused before anything is inflated.
- **ChatGPT and Ptero providers** (experimental). ChatGPT works signed in and logged out; Ptero needs its **Quick Answer** mode, because in Smart mode its server-side agent runs the commands itself. Official favicons on the Home cards.
- **`codeBlock` provider selector.** Providers whose code blocks are not a `<pre>` (ChatGPT's CodeMirror only draws on-screen lines) read each block's full code from the page's React props, then from `codeLine` lines.
- **Side panel rail on the window edge.** The activity rail now sits on the right, next to the browser edge, and follows the panel to the left when Chrome docks it there (`chrome.sidePanel.getLayout()`). About sits right above Settings.
- **Runtime-installable web chat plugins**: `specs/09-WEBCHAT-PLUGINS.md`, ADR-020 (Accepted), plugin template and guide.

- **Live refresh.** The bridge now watches the active workspace (`bridge/src/watcher.ts`) and emits debounced `fs.changed` / `git.changed` events. The Explorer and Source Control panels redraw on their own when files change on disk, after a commit or branch switch made outside the panel, or when a terminal command touches the repo. Expanded folders survive the redraw.

### Changed

- **ChatGPT provider is ready** (no longer experimental). The full read → write → answer loop and the automatic "New chat" on a full context window were checked on the live site.
- **One VS Code look for every tab.** A shared design system (`extension/src/vscode.css`) mirrors VS Code Dark+ / Light+ theme colors (side bar, activity bar, title bar, inputs, buttons, list hover/selection, badges, menus, dialogs, scrollbars) and is used by every view: Home, Explorer, Search, Source Control, Terminal, Agent, About, Settings, the context menu, the diff view and the full-tab editor. All views share one frame (35px view title, side bar surface), sub-tabs (Settings sections, Changes / Graph) use one panel-tab style, Home uses list rows, flat provider tiles and the standard primary button. Icons are VS Code codicons (`@vscode/codicons`, CC-BY-4.0), inlined by `scripts/gen-codicons.mjs`. The code preview, full-tab editor and terminal now follow the light theme too.
- **Source Control laid out like VS Code.** Collapsible Repositories / Changes / Graph panes replace the Changes / Graph toggle, so the graph stays visible under the changes. The repository row holds the branch picker, ahead/behind counts or a Publish icon and Create Branch; Fetch, Pull, Push and Commit sit in the Changes header. The message box grows with its text and commits on Ctrl+Enter, and the button under it becomes Publish Branch or Sync Changes (pull ff-only, then push) when there is nothing to commit. Graph refs are right-aligned colored badges, and local branches with a slash (`feat/x`) are no longer shown as remote. The border between Changes and Graph is a sash: drag to resize, double-click to reset; the sizes are remembered.
- **One editor tab with VS Code-style editor tabs.** Explorer files, Search hits and Source Control diffs (working tree, staged, or one commit's change) all open in a single browser tab, the editor page (`editor.html`), each as an editor tab of its own (`file-preview.ts`): a tab strip with the file name, dirty dot and close button (middle-click closes too), the active tab's actions, breadcrumbs, the content and a status bar. Only the first file opens the browser tab; later ones are added to it and the page is focused, and a file or diff that is already open is activated (a search hit jumps to its line). Files are editable with Save (Ctrl+S) and mtime conflict detection; a diff has Unified / Split and Open File. Open tabs survive a reload of the page. The split preview at the bottom of the Explorer and the diff overlay inside the panel are gone.
- **No native right-click menu on extension pages.** Like VS Code, right-clicking anywhere in the side panel or the full-tab editor does nothing unless the spot has its own menu (the Explorer tree keeps its context menu). Text inputs, textareas and the code editor keep the browser's edit menu for copy/paste; an area can opt back in with `data-context-menu="native"` (`extension/src/context-guard.ts`).
- **`install.ps1` prepares everything too.** Like `install.sh`: Node.js (portable copy when needed, no admin rights), `npm ci` when `node_modules` is missing or older than `package-lock.json`, a node-pty load check (with `npm rebuild node-pty` as fallback), the build, and registration for every detected browser (Chrome, Edge, Brave, Chromium) instead of always Chrome and Edge. Options: `-Browser`, `-Rebuild`, `-PortableNode`, `-Uninstall`. `install.bat` is now a thin wrapper that passes its arguments to `install.ps1`.
- **Native host launcher on Linux/macOS** quotes its paths for `sh`, so a repo or Node.js path with spaces, quotes or `$` works. Manifests for Chromium-based browsers on Linux follow `$XDG_CONFIG_HOME`. Uninstalling one browser keeps the shared launcher while another browser still uses it.
- **Agent messages look right on every chat site.** The badge sits in a label strip above the text instead of covering it, the page keeps its own bubble shape, and icons inside a bubble keep their icon font (Gemini's expand arrow no longer turns into the letters "expand"). Site-specific fixes live in each plugin's `style.css` (Gemini, Ptero).
- **DeepSeek replies are read without the code-block banner** (language, Copy, Download), and agent marks no longer land on the off-screen conversation outline: on pages whose chat rows carry a message key, only messages inside those rows are marked.
- **Ptero switches itself to Quick Answer.** Its plugin's `prepare` hook closes the welcome dialog and selects Quick Answer when a session starts or moves to Ptero, so its server-side agent no longer grabs the commands.
- **Providers are built-in web chat plugins.** Each lives in `extension/plugins/<id>/` with a `plugin.json` (`apiVersion`, `name`, `version`, `author`, `matches`, `selectors`, ...) and its icon; `src/plugins/manifest.ts` validates them (concrete https hosts only, supported `apiVersion`, required selectors) and the build fails on an invalid plugin or a URL pattern claimed twice. Behaviour is unchanged: same selectors, same host permissions.

### Fixed

- **Switch chat** reuses an open tab of the target provider instead of opening a new one every time, waits up to 30 s for the target page to load its composer, no longer pauses the session half-way, and no longer makes the new chat answer `READY` and stop (`agent.prompt` takes `handoff: true`).
- **Start session** waits for the chat composer after the relay reloads a tab, instead of failing with "chat field not found".
- The agent never types into a **hidden composer** anymore (ChatGPT keeps the previous chat view hidden in the page), which caused `NOT_ACCEPTED` and messages landing in another chat.
- DeepSeek's "generating" check no longer matches the **warning button** next to an error reply, which made a chat with an error look busy forever.
- Saving from the side-panel preview now refreshes the Explorer tree as well as the Source Control panel, so the file's size and Git badge are no longer stale.

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
