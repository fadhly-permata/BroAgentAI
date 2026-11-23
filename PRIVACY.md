# Privacy

BroAgentAI is local-only.

- No telemetry, analytics, crash reporting, or advertising SDKs are sent anywhere.
- AI prompts and replies stay between the browser tab you chose and the provider website you already use.
- The extension talks to the local `broagentai-bridge` native-messaging host on your machine.
- Workspace files, Git history, shell output, and provider transcripts are not uploaded by BroAgentAI.
- Saved sessions, approval logs, and configuration are stored locally under the bridge config directory or inside your workspace when you explicitly use handoff.
- Remote MCP servers and provider plugins are local configuration. BroAgentAI never installs or executes remote code automatically.
- Secrets are redacted from logs and UI. Review plugin source and MCP server commands before granting access.

For the full data model and trust boundaries, see `specs/04-ERD.md`, `specs/07-PLUGIN-MCP.md`, and `specs/09-WEBCHAT-PLUGINS.md`.
