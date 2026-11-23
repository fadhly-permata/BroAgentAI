# Chrome Web Store permission justification

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Read the provider chat tab the user explicitly starts a session on. |
| `scripting` | Register the relay and optional plugin selectors/CSS on the chosen chat domain. |
| `storage` | Persist UI settings, plugin state, and local session preferences. |
| `tabs` | Find or open the provider tab used by the agent loop. |
| `contextMenus` | Optional path actions from the file explorer and workspace shortcuts. |
| `userScripts` | Run optional `plugin.js` hooks in an isolated world per plugin. |
| `nativeMessaging` | Connect to the local `com.broagentai.host` companion for workspace tools. |
| `sidePanel` | Host the BroAgentAI side panel where approvals and tool activity are shown. |
| `<all_urls>` host access in `optional_host_permissions` | Only requested when the user installs a plugin for that chat domain; BroAgentAI does not fetch or install remote code. |

BroAgentAI does not collect personal data, does not use remote APIs of its own, and keeps all project access behind the local bridge and explicit approvals. See `PRIVACY.md` for the full privacy statement.
