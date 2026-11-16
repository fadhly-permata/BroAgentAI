# BroAgentAI â€” Agent Guidelines

## Terminology
- Do not reintroduce the brand name of the legacy third-party connector referenced in the early specs (removed on purpose). Refer to it only as **legacy connectors** or **existing connectors**.
- The local companion is **broagentai-bridge**: a Node.js native-messaging host (`bridge/dist/index.js`, launched via `bridge/broagentai-host.cmd`), dev install via `npm run host:install:dev`, native-host id `com.broagentai.host`. Never label it with another product's name (editor, game host, etc.).
- Keep terminology consistent across docs, specs, code, comments, and commit messages.

## Workflow
- Validate before commit: `npm run typecheck` and `npm run test` must pass.
- Use conventional commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `chore:`.
- Keep e2e artifacts out of git (`.pw-profile` is ignored).
