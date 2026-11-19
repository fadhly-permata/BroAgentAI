# BroAgentAI — Web Chat Plugins (runtime-installable)

| Field | Value |
| --- | --- |
| Status | Draft v0.2 (plan; P0 spike done, see `spikes/webchat-plugins-p0/FINDINGS.md`) |
| Date | 2026-11-19 |
| Related | `05-ADR.md` (ADR-018, ADR-020), `07-PLUGIN-MCP.md` §4, `08-BACKLOG.md` |
| Supersedes | `07-PLUGIN-MCP.md` §4.3–4.5 once ADR-020 is accepted |

## 1. Why

Today a web chat provider is `extension/src/providers/<id>/provider.json`: selectors only, bundled at build time. Two limits showed up while adding ChatGPT and Ptero:

1. **Every site quirk lands in the core.** ChatGPT's CodeMirror code blocks needed a new generic `codeBlock` field; its hidden previous-chat composer needed a change to the shared `visible()`; DeepSeek's warning button needed a selector patch; Ptero's "Quick Answer" mode cannot be automated at all with selectors.
2. **Adding a chat needs a rebuild.** Users cannot add or fix a provider themselves.

A third problem is visual: `content/agent-marks.ts` injects one CSS for every site (monospace 12 px, collapsed bubble with a fade mask, badge in the top-right corner, bubble found by climbing up to 8 ancestors). Each site's DOM differs, so the marks look broken on some of them.

## 2. Goals and non-goals

Goals:

- A user can **install, update, disable and remove** a web chat plugin from the side panel, **without rebuilding** the extension.
- A plugin carries, per web chat: **selectors**, an optional **CSS** for how BroAgentAI looks on that site, and an optional **script** with hooks for that site's special cases.
- The five current providers become **built-in plugins** in the same format.
- Plugins are **isolated from each other**: a DeepSeek plugin can never change behaviour or look on Qwen.
- A plugin can never reach files, Git, shell or MCP. Those stay behind the panel, the bridge and approvals.

Non-goals:

- Installing plugins from a URL, a store, or a marketplace (local files only).
- Plugins that change the panel UI, the agent loop, the prompt, or approvals.
- Plugins for anything other than a chat page.

## 3. Plugin format

### 3.1 Folder

```text
my-chat/
├─ plugin.json    required: metadata, matches, selectors
├─ style.css      optional: BroAgentAI marks on this site
├─ plugin.js      optional: hooks for this site's special cases
└─ icon.png       optional: card icon (png/svg, ≤ 64 KB)
```

Built-in plugins live in `extension/plugins/<id>/` and ship with the extension. User plugins are imported from a local **folder or `.zip`** (Settings → Plugins → Import) and stored in `chrome.storage.local`. Any installed plugin, built-in included, can be **exported as a `.zip`** with the same layout, so users can share plugins and plugin updates with each other.

A `.zip` holds the files at its root or inside one top-level folder; nothing else is read (see R28).

### 3.2 `plugin.json`

```json
{
  "apiVersion": 1,
  "id": "ptero",
  "name": "Ptero",
  "version": "1.0.0",
  "author": "BroAgentAI",
  "description": "Ptero multi-model web chat (no signup)",
  "homepage": "https://ptero.pro/",
  "matches": ["https://ptero.pro/*"],
  "status": "experimental",
  "selectors": {
    "composer": "#chat-input",
    "submit": "#chat-send-btn:not(.is-stop)",
    "assistantMessage": "#chat-messages .chat-msg.assistant > .chat-msg-content > .chat-msg-text",
    "userMessage": "#chat-messages .chat-msg.user .chat-msg-text",
    "generating": "#chat-send-btn.is-stop",
    "exclude": ".chat-code-block-header"
  },
  "script": "plugin.js",
  "style": "style.css",
  "icon": "icon.png"
}
```

`selectors` keeps every field of today's `ProviderSelectors` (`codeLine`, `codeBlock`, `markdownSource`, `messageKeyAttr`, ...), so a selector-only plugin behaves exactly like a current `provider.json`.

### 3.3 `plugin.js` hooks

```js
BroAgentAI.registerPlugin('my-chat', {   // first argument: the id from plugin.json
  async prepare(api) {},            // before the first prompt in a tab (close popups, pick a mode)
  findComposer(api) {},             // -> Element | null (default: selectors.composer)
  isGenerating(api) {},             // -> boolean (default: selectors.generating)
  readCode(block, api) {},          // -> string | null (default: pre/code text, codeLine, page source)
  detectError(api) {},              // -> { kind: 'quota' | 'blocked' | 'other', message } | null
  findBubble(markerEl, api) {},     // -> Element | null: which element agent-marks styles
});
```

Every hook is optional. A missing hook, a hook that throws, or a hook that times out falls back to the generic adapter. **Implemented so far (P2): `prepare`** (10 s timeout). The others are added when a plugin needs them; unknown hook names are ignored with a warning, so a newer plugin still loads on an older runtime. `api` exposes only page helpers: `$`, `$$`, `click`, `setSelect`, `sleep`, `reactProp(el, names)` (served by the core MAIN-world helper, see §4.3). It exposes nothing that reaches the extension, the bridge, or other tabs.

### 3.4 Built-in plugins after conversion

| Plugin | `plugin.json` | `plugin.js` | `style.css` |
| --- | --- | --- | --- |
| chatgpt | data-* selectors | `readCode` (full code from React props), `findComposer` (skip the hidden previous-chat composer) | bubble shape and badge spot |
| deepseek | `.ds-*` selectors, `messageKeyAttr` | `detectError` ("Usage limit reached" → tell the panel) | badge away from the edit/copy buttons |
| gemini | Quill composer, `exclude` chips | none | yes |
| ptero | `#chat-*` ids | `prepare` (close welcome popup, set Quick Answer) | optional |
| qwen | `markdownSource`, `codeLine` (Monaco) | none | yes |

## 4. Architecture

### 4.1 Where things run

| Piece | World | Built-in plugins | User plugins |
| --- | --- | --- | --- |
| Relay + generic adapter | content script (isolated) | static `content_scripts` in the manifest | `chrome.scripting.registerContentScripts` with `src/content/relay-dynamic.js`, a second, self-contained IIFE build of the relay (`vite.relay.config.ts`): the manifest relay goes through a CRXJS loader whose chunks are only web-accessible on built-in sites. Only patterns the manifest does not cover; a flag in the relay keeps one relay per page. |
| Plugin CSS | page document | injected by the relay (agent-marks) | same: the relay reads `style.css` from the registry, so no separate CSS registration |
| Plugin hooks (`plugin.js`) | — | compiled into the relay bundle at build time (no user-scripts toggle needed) | `chrome.userScripts.register`, one `worldId` per plugin |
| React-props reader | MAIN | existing `page-source.iife.ts` | same core helper, reached through `api.reactProp` |

Selector-only and CSS-only user plugins work **without** the user-scripts toggle. Only user plugins with `plugin.js` need it.

### 4.2 Relay ↔ hooks bridge

The relay (isolated world) calls a hook by dispatching a DOM `CustomEvent` that carries a request id. The plugin world answers with another event. Synchronous hooks answer within the same dispatch, like the page-source helper does today. `prepare` is async and gets a timeout. Results are plain data (strings, booleans, small objects) and are validated by the relay before use.

The chat page can see and forge these events. That is acceptable: the page already decides what the reply says, so a forged hook result gives it no power it does not already have. The relay never executes anything a hook returns.

### 4.3 Runtime registry

`providers/registry.ts` stops being a build-time `import.meta.glob` list. It becomes an async registry: built-in plugins (bundled) merged with user plugins (`chrome.storage.local`), with user overrides applied. The panel, Home cards, `findChatTab`/`findProviderTab` and the relay all read from it. The relay finds its plugin by matching `location.href` against the active plugins' `matches`.

### 4.4 Install flow

1. User picks a folder (directory picker) or a `.zip` (file picker; unpacked in the panel, R28).
2. Validate: JSON schema, `apiVersion`, sizes, `matches` patterns (§6 R5, R6), CSS lint (§6 R9).
3. Show a review screen: name, version, author, domains, which files exist, the full `plugin.js` source, warnings.
4. `chrome.permissions.request({ origins: matches })` from the click (Chrome prompt, once per domain).
5. Save to storage, register content script + CSS (+ user script when present).
6. Tabs already open on that domain show "reload to activate".

### 4.5 Updates

Every user may publish and install updates for any plugin, built-in ones included; there is no central publisher. An update is simply an import whose `id` already exists:

- **Same id, any version:** the review screen shows it as an update: old vs new version and author, which files changed, a diff of `plugin.js` and `style.css`, and any change to `matches`.
- **New or wider `matches`:** permissions are requested again for the new domains only; removed domains are released (`permissions.remove`).
- **Built-in id:** the import becomes a user override of the built-in (R24); "Reset to built-in" restores the shipped version.
- **Lower version than installed:** allowed (rollback), shown as a downgrade warning.
- An update never applies silently: no auto-update and no update check against a URL.

### 4.6 Plugins page (Settings → Plugins)

The only place where plugins are managed. There is no separate developer mode.

| Area | Content |
| --- | --- |
| Header | **Import** (folder or `.zip`), the user-scripts status ("Allow User Scripts" on/off, with steps to turn it on when a plugin needs it) |
| One row per plugin | icon, name, version, author, domains, badges (Built-in / Custom / Override / Script / Needs update / Access revoked), enable/disable switch |
| Row actions | **Update** (import a newer copy, §4.5), **Export `.zip`**, **Remove** (user plugins), **Reset to built-in** (overrides), **Re-grant access** (R7), **Reload open tabs** (R16), **Health check** on an open tab of that domain (R25) |
| Review screen | shared by install and update: metadata, files, `plugin.js` source or diff, domain changes, warnings (R26) |

Home provider cards and the switch-provider list show only enabled plugins.

## 5. Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| **P0 Spike** | Prove the unknowns on Chrome 157 with the user's own profile: user-scripts toggle detection, `worldId` per plugin, the sender field that identifies a user-script world, dynamic content scripts after an extension reload, `registerContentScripts` with `css`, DOM-event bridge between isolated and user-script worlds, `permissions.request` from the side panel. | **Done 2026-11-19:** `spikes/webchat-plugins-p0/FINDINGS.md`; R4, R11, R14, R15 adjusted. Browser-restart persistence not tested (covered by R15 re-sync). |
| **P1 Format + registry** | `plugin.json` schema + validator, registry reading built-in plugins (it becomes async and storage-backed in P3, when user plugins join), convert the five providers to `extension/plugins/`, keep behaviour identical. | Typecheck + tests pass; all five providers pass the live loop again; no user-visible change. |
| **P2 Built-in hooks + CSS** (done except DeepSeek, see 9.2 in the backlog) | Hook bridge, compiled built-in hooks (ChatGPT `readCode`/`findComposer`, DeepSeek `detectError`, Ptero `prepare`), neutral base CSS in `agent-marks.ts`, per-plugin `style.css`, `findBubble`. Move the ChatGPT `codeBlock` logic out of the core. | Ptero works without manual mode change; DeepSeek quota shows in the panel; marks look right on all five sites. |
| **P3 User plugins (no script)** (done 2026-11-19) | Import from folder or `.zip`, validate/review, permissions, dynamic registration, Settings → Plugins tab (list, enable/disable, update with diff, remove, reset built-in, export `.zip`), Home cards from the registry, conflict handling. | A selector + CSS plugin for a new site installs from a folder and from a `.zip` and runs a full loop without a rebuild; an exported `.zip` re-imports as an update. |
| **P4 User plugin scripts** | `userScripts` registration per world, toggle detection and guidance, messaging checks, timeouts, fallback, custom-plugin safety rules. | A user plugin with `plugin.js` hooks runs a full loop; toggle off → falls back to selectors with a clear notice. |
| **P5 Hardening + docs** | Plugin template, README "Write a plugin" guide, e2e with a fake chat plugin, ADR-020 accepted, `07-PLUGIN-MCP.md` §4 updated. | Docs reviewed; e2e green. |

## 6. Risks and countermeasures

### 6.1 Isolation between plugins

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R1 | Plugin A's script or CSS affects site B | Behaviour/look broken on another chat | Chrome injects only on URLs matching the plugin's `matches`; each tab is its own document. Covered by an e2e with two plugins on two fake domains. | P3 |
| R2 | Two plugins claim the same domain | Both inject; selectors/CSS fight | One active plugin per domain. Import detects overlapping `matches` and asks: replace the active one, or cancel. Built-in vs user override is explicit ("Replace built-in ChatGPT?"). | P3 |
| R3 | Two scripts on the same page share globals | Hooks overwrite each other or the runtime | One `userScripts` world per plugin (`worldId` = plugin id); the hook runtime lives inside that world. | P4 |
| R4 | A plugin sends messages pretending to be another plugin | Wrong plugin's data trusted | P0 showed the sender carries **no** user-script world id. Instead the host prepends a random **per-plugin token** to each plugin's script at registration; every message carries it; the service worker maps token → plugin id and also requires the sender tab URL to match that plugin's `matches`. The page cannot read the token (user-script globals are invisible to the MAIN world, P0 C3). | P4 |

### 6.2 Permissions and domains

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R5 | Over-broad match patterns (`<all_urls>`, `https://*/*`, `*://*.com/*`) | Plugin runs on every site the user visits | Rejected at import. Patterns must be `https://`, a concrete host (one leading `*.` subdomain wildcard allowed), any path. | P3 |
| R6 | Pattern overlaps a built-in domain silently | Built-in replaced without the user noticing | Overlap check covers built-ins too; the review screen says which plugin is replaced. | P3 |
| R7 | User revokes site access in Chrome | Relay silently missing, session "chat not found" | Registry checks `chrome.permissions.contains` on load and on `permissions.onRemoved`; the plugin row and Home card show "access revoked" with a Re-grant button. | P3 |
| R8 | `permissions.request` needs a user gesture | Prompt never shows | Only called directly from the Import / Re-grant click handler. | P3 |

### 6.3 Security

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R9 | Plugin CSS restyles the chat site itself (hides buttons, fakes UI) | Confusing or deceptive page | Lint at import: selectors outside `[data-ba-*]` produce a warning shown on the review screen; CSS size cap. CSS can only affect that plugin's own domain (R1). | P3 |
| R10 | Malicious `plugin.js` forges an assistant reply containing a command | Command executed on the user's machine | Plugins cannot call the bridge; commands still go through the parser and approvals. Sessions on a **custom** plugin are labelled "custom plugin" in the session pill; switching to **Auto approve** with a custom plugin needs an explicit confirmation each session. | P4 |
| R11 | Malicious `plugin.js` reads the chat (which contains tool results, i.e. file contents) and sends it elsewhere | Code/data leak | Plugin worlds get a strict CSP by default (`connect-src 'none'`, no eval); P0 confirmed it blocks `fetch` from the plugin world. A plugin can still add elements to the page (e.g. an image to another host), which only the page's own CSP governs, so the risk is not zero. Further mitigations: local-file install only (no URL), full source shown before install, "custom" label, README warning. Documented as residual risk. | P4 |
| R12 | Plugin hook returns huge or hostile data | Panel slowdown, injection into UI | Relay validates hook results (type, size caps); the panel renders plugin strings as text, never HTML. | P2 |
| R13 | A plugin is installed from a repository the user just opened | Workspace content running in the browser | Workspace folders are never scanned for plugins; install is always an explicit Import. | P3 |

### 6.4 Chrome platform

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R14 | User-scripts toggle off, or Chrome older than 138 | `plugin.js` never runs | P0: with the toggle off, `chrome.userScripts` is `undefined`. Detect with `typeof chrome.userScripts?.getScripts === "function"`, re-checked whenever the Plugins page opens; the page shows "script disabled — enable Allow User Scripts" with steps; the plugin still runs on selectors + CSS. Built-in hooks never depend on the toggle (compiled into the relay). | P4 |
| R15 | Dynamic registrations lost after extension update/reload | User plugins stop working | **Confirmed in P0:** an extension reload/update clears dynamic content scripts, user scripts **and** world configurations; host permissions are kept. On `runtime.onInstalled` and `runtime.onStartup`, re-apply everything from storage idempotently (worlds first, then scripts); no new permission prompt is needed. | P3 |
| R16 | Tabs opened before install/enable have no relay | "Chat tab not found" | Existing `ensureRelay` reloads the tab once; the plugin row also offers "Reload open tabs". | P3 |
| R17 | User-script world cannot read the page's React props | ChatGPT/Qwen code reading breaks for user plugins | Keep `page-source.iife.ts` as the only MAIN-world code; plugins reach it through `api.reactProp`, never by running in MAIN themselves. | P2 |
| R18 | `chrome.storage.local` quota | Import fails with many plugins | Size caps per file (plugin.json 32 KB, plugin.js 256 KB, style.css 64 KB, icon 64 KB); clear error when storage is full. | P3 |

### 6.5 Compatibility and lifecycle

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R19 | Core changes break existing plugins | Silent failures after an update | `apiVersion` in every plugin; the runtime declares the versions it supports; unsupported plugins are disabled with "needs update", never run half-working. | P1 |
| R20 | Plugin disabled, updated or removed during an active session | Session points at a tab with no relay | Disabling/removing stops sessions on that plugin with a log entry; an update asks to reload open tabs and resumes through the existing resume guard. | P3 |
| R21 | Hook hangs (e.g. `prepare` waits forever) | Session stuck at start | Per-hook timeouts (sync hooks: same dispatch; `prepare` ≤ 10 s); timeout logs a warning and falls back to the generic path. | P2 |
| R22 | Hook throws on every poll | Log spam, CPU | Errors per hook are counted; after N failures the hook is turned off for that tab and one warning is logged. | P2 |
| R23 | Converting built-ins changes behaviour (regression) | Working providers break | P1 is behaviour-neutral; each provider re-runs the live loop (start → read → write → final answer, no duplicate commands) before P1 is merged. | P1 |
| R24 | User edits a built-in plugin and loses track | Hard to recover | Built-ins are read-only; editing creates a user override with the same id; "Reset to built-in" removes it. | P3 |

### 6.6 UX

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R25 | Users write broken selectors | "Composer not found" with no hint | Review screen runs a health check on an open tab of that domain (composer found, messages counted) before saving; Diagnostics shows per-selector results. | P3 |
| R26 | Too many warnings make install scary | Users ignore all warnings | Only three levels: block (R5, schema, size), warn (R9, script present, custom + auto-approve, update from a different author), info. | P3 |

### 6.7 Sharing and updates

| # | Risk | Impact | Countermeasure | Phase |
| --- | --- | --- | --- | --- |
| R27 | An update from another user hides new behaviour (new script, new domains) | Trusted plugin turns malicious after an "update" | Updates go through the same review as a new install, plus a diff of `plugin.js`/`style.css` and of `matches`; a different `author` than the installed one is a warning; new domains need a new Chrome permission prompt; no auto-update. | P3 |
| R28 | Hostile `.zip` (zip bomb, `../` paths, thousands of files, symlinks) | Panel freeze, storage filled, files outside the plugin | Unpack in memory in the panel only; read just the known file names at the root or in one top-level folder; reject `..`, absolute paths and links; caps on file count (≤ 10) and total uncompressed size (≤ 512 KB) checked before inflating. | P3 |
| R29 | Two shared plugins use the same `id` for different sites | Importing one silently "updates" the other | Same `id` with no overlapping `matches` is treated as a conflict, not an update: the user renames on import or cancels. | P3 |
| R30 | Exported `.zip` carries personal data | Leak when sharing | Export writes only the plugin files from storage (never settings, sessions, logs or workspace data). | P3 |

## 7. Testing

- Unit (`node:test`): `plugin.json` validator, match-pattern checks and overlap detection, CSS lint, apiVersion gate, registry merge/override, hook-result validation.
- E2E (fake chat, Playwright): two user plugins on two fake domains (isolation, R1), domain conflict (R2), toggle-off fallback (R14), plugin removal during a session (R20).
- Live (user's own Chrome profile): every built-in plugin runs the full loop and a provider switch chain after P1 and P2.

## 8. Decisions

Decided (2026-11-19):

1. **Folder and `.zip`** are both supported for import; any plugin can be exported as a `.zip` (§3.1, §4.4).
2. **Any user may publish and install updates** for any plugin, built-ins included, by sharing the plugin; updates are always reviewed, never automatic (§4.5, R27–R29).
3. **No developer/live-reload mode.** The bridge does not watch plugin folders. Plugins are managed only through the Plugins page (§4.6); after editing a plugin on disk, its author imports it again as an update.

No open questions remain.
