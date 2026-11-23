# Write a web chat plugin

A web chat plugin tells BroAgentAI how to drive one chat site. It is a folder with a `plugin.json` and, optionally, a `style.css`, a `plugin.js` and an icon. Start from [`templates/webchat-plugin/`](../templates/webchat-plugin/) and work through the steps below.

## 1. Copy the template

Copy `templates/webchat-plugin/` anywhere outside a workspace folder, rename the folder to your plugin id, and edit these files:

| File | Required | What it does |
| --- | --- | --- |
| `plugin.json` | yes | Metadata, `matches`, `selectors`, optional hook declaration |
| `style.css` | no | How BroAgentAI's agent-message marks look on this site |
| `plugin.js` | no | Optional hooks for site-specific quirks |
| `icon.svg` / `icon.png` | no | Card icon, at most 64 KB |

Use lowercase letters, digits and `-` for `id` (max 40 characters). The version must look like `1.0.0`. `matches` may only list concrete `https://` host patterns such as `https://chat.example.com/*`; `https://*/*` and `<all_urls>` are refused.

## 2. Find the selectors

Open the site logged in and inspect the DOM. The minimum is `composer` (a `<textarea>`, `<input>` or contenteditable element) and `assistantMessage` (one element per reply). Useful extras:

- `submit`: a send button; leave it empty to press Enter.
- `userMessage`: the bubble that holds a user message.
- `generating`: a Stop button shown while the reply streams; without it the relay uses text stability.
- `exclude`: page chrome inside a reply (code headers, suggestion chips).
- `codeBlock` / `codeLine`: for editor-style code widgets.
- `messageKeyAttr`: an attribute with a number that grows per message, for virtualized lists. If the site has no such number, set `messageKeyFallback: true` instead: BroAgentAI derives a bounded key from the message's `id`/`data-*` attributes plus a text hash. Treat that key as an identity, not as an ordering number.
- `errorReplies`: regular expressions for short failure texts such as `^Something went wrong`.

Prefer stable `id`/`data-*` attributes over translated labels or CSS class names that change with the site's framework. Keep `status: "experimental"` until you have run a full read → write → answer loop on the live page (or against a local fixture); then describe what you checked in `verified` and change it to `"ready"`.

## 3. Optional hooks

If you add `plugin.js`, name it in `script`, register with the id from `plugin.json`, and declare any optional hook in `hooks` so the relay only calls it when needed:

```js
BroAgentAI.registerPlugin('my-chat', {
  async prepare(api) {},
  detectError(api) {},
});
```

`api` is deliberately small: `$`, `$$`, `text`, `click`, `setSelect`, `sleep`. Hooks are page-only; they cannot reach files, Git, shell, MCP, other tabs or the network. `prepare` runs before the operating prompt and times out after 10 s. `detectError` runs during an active session; return `null` or `{ kind: 'quota' | 'blocked' | 'other', message }`. The relay sends that result to the panel as `{ type: 'ba.pluginError', pluginId, kind, message }`. A missing, slow or invalid hook falls back to the generic adapter.

User plugins with `plugin.js` need Chrome's **Allow User Scripts** toggle (Chrome 138+): each plugin runs in its own `chrome.userScripts` world. Selector-only and CSS-only plugins need no toggle.

## 4. Install and check

Zip the folder (files at the root or in one top-level folder) or keep it as a folder, then use **Settings → Plugins → Import**. You get a review screen with the files, domains and warnings; Chrome asks for site access from that click. Only one plugin owns a domain: an import that overlaps another plugin's `matches` asks you to replace it or cancel. After install, reload the open chat tab and use **Check on open tab**.

Updates are imports of the same `id`: the review screen shows a diff and any new domains. Nothing downloads automatically, and there is no remote code. **Export .zip** writes only the plugin's own files. See [`specs/09-WEBCHAT-PLUGINS.md`](../specs/09-WEBCHAT-PLUGINS.md) for the full format, safety rules and architecture.
