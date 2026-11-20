# P0 spike findings — web chat plugins

| Field | Value |
| --- | --- |
| Date | 2026-11-19 |
| Browser | Google Chrome 157 (Windows 11), the user's own signed-in profile |
| Spike | this folder, loaded unpacked; test page `https://example.com/` |
| Plan | `specs/09-WEBCHAT-PLUGINS.md` §5 P0 |

## How it was run

1. Loaded this folder with *Load unpacked*, turned on **Allow User Scripts** for it.
2. Side panel: *Request access to example.com* (Chrome prompt accepted), then *Configure worlds + register scripts*.
3. Opened `https://example.com/`; the content script printed every result into the page, read from the tab.
4. Reloaded the extension in `chrome://extensions`, opened the page again; then clicked only *Configure worlds + register scripts* (no permission request) and opened the page again.

The setup registers two "plugins" as user scripts from **code strings** (the way stored user plugins will be registered), each in its own world: `plugin-a` with CSP `script-src 'self'; connect-src 'none'`, `plugin-b` with the default CSP. A dynamic content script (`cs.js` + `cs.css`) plays the relay.

## Results

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| C1 | Detect whether user scripts are usable | ✅ with a caveat | With the toggle on, `chrome.userScripts.getScripts()` resolves. With the toggle off, **`chrome.userScripts` is `undefined`** (seen in the service worker at install time, before the toggle was turned on). |
| C2 | `configureWorld` per plugin (`worldId`, `messaging`, `csp`) | ✅ | Both worlds listed by `getWorldConfigurations()` with their settings. |
| C3 | Two plugins on one page are isolated | ✅ | Both set `window.__p0Name`; each answered with its own value (`A`, `B`). The page's MAIN world sees `typeof window.__p0Name === "undefined"`. |
| C4 | Messaging user script → extension | ✅ | `runtime.onUserScriptMessage` receives the message, `sendResponse` reaches the script (`{ok:true, echo:"A"}` / `"B"`). |
| C4b | Sender identifies the user-script world | ❌ **not available** | `sender` keys: `id, url, origin, frameId, documentId, documentLifecycle, tab`. There is **no** `userScriptWorldId`. |
| C5 | Synchronous DOM-event bridge, isolated world → user-script worlds | ✅ | `dispatchEvent` returned with both replies already set; 0.1–0.3 ms. |
| C6 | `registerContentScripts` with `css` | ✅ | CSS custom property from `cs.css` applied on the page. |
| C7 | Registrations after an extension reload/update | ❌ **cleared** | `onInstalled` (`reason: "update"`) lists **no** content scripts, **no** user scripts and **no** world configurations; nothing ran on the page. |
| C7b | Host permission after an extension reload/update | ✅ kept | Re-registering without a new `permissions.request` worked at once. |
| C7c | Registrations after a full browser restart | ⏭️ not tested | Covered anyway by re-syncing on `onStartup` (R15). |
| C8 | `permissions.request` from a side-panel click | ✅ | Chrome prompt shown, `contains` → `true`. |
| C9 | World CSP limits network / eval | ✅ | `plugin-a` (`connect-src 'none'`): `fetch` → `Failed to fetch`. `plugin-b` (default): `fetch` → 200. `eval` is blocked in both (also by the default CSP). |
| C10 | What a user script can reach | ℹ️ | `chrome.runtime.sendMessage` exists; `chrome.storage` does **not**. |

Note: only one of the two hello messages was stored by the spike's own `record()` (a read-modify-write race in the spike, not an API issue); both scripts received their echo.

## Consequences for the plan

1. **R4 (plugin pretending to be another plugin):** the world id cannot come from the sender. Use a **per-plugin secret**: when registering a plugin's user script, the host prepends a random token to its code; every message carries it; the service worker maps token → plugin id and also checks that the sender tab URL matches that plugin's `matches`. The page cannot read the token (C3: user-script globals are invisible to the MAIN world).
2. **R14 (toggle off):** feature-detect with `typeof chrome.userScripts?.getScripts === "function"`, not only with try/catch. Re-check whenever the Plugins page opens.
3. **R15 (registrations lost):** confirmed for extension reload/update: content scripts, user scripts **and** world configurations are all gone. The registry must re-apply everything (worlds first, then scripts) on `runtime.onInstalled` and `runtime.onStartup`, idempotently. Host permissions survive, so no new prompt is needed.
4. **R11 (exfiltration):** `configureWorld({ csp: "...; connect-src 'none'" })` blocks `fetch` from the plugin world. Plugin worlds get a strict CSP by default. Not tested: a plugin adding elements to the page (e.g. an `<img>` to another host), which the page's own CSP governs; that stays a documented residual risk.
5. **Hook bridge (§4.2):** synchronous DOM events work between the relay's isolated world and the plugin world, so sync hooks can be called inline as planned.
