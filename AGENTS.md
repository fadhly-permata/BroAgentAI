# BroAgentAI â€” Agent Guidelines

## Terminology
- Do not reintroduce the brand name of the legacy third-party connector referenced in the early specs (removed on purpose). Refer to it only as **legacy connectors** or **existing connectors**.
- The local companion is **broagentai-bridge**: a Node.js native-messaging host (`bridge/dist/index.js`, launched via `bridge/broagentai-host.cmd`), dev install via `npm run host:install:dev`, native-host id `com.broagentai.host`. Never label it with another product's name (editor, game host, etc.).
- Keep terminology consistent across docs, specs, code, comments, and commit messages.

## Workflow
- Validate before commit: `npm run typecheck` and `npm run test` must pass.
- Use conventional commits: `feat(scope):`, `fix(scope):`, `refactor(scope):`, `chore:`.
- Keep e2e artifacts out of git (`.pw-profile` is ignored).
- Local release artifacts are allowed (`npm run release`, `npm run host:build:binaries`, ignored `release/`). Never publish a GitHub release: do not create/push `v*` tags, create GitHub Releases, upload release artifacts, or trigger `.github/workflows/release.yml` — even as validation. The GitHub account is locked due to pending payment; remote release steps are manual and user-only until billing is resolved.
- Every modification must bump the product version in the same change using semantic versioning `MAJOR.MINOR.PATCH`: PATCH for fixes/docs/chore/config, MINOR for backward-compatible features, MAJOR for breaking changes. Update root/workspace manifests, extension manifest, `HOST_VERSION`, CHANGELOG, and release notes together; never ship two changes with the same version.

## BroAgentAI

<!-- BroAgentAI project context. Keep this section under 2 KB. Do not store secrets here. -->

### Tool notes
- `fs.*`, `git.*`, and `shell.run` are callable tools.
- `term.*`, `mcp.*`, and `session.*` are optional; call `context.read` before using them.

### Project conventions
- Add project-specific conventions here.

### Common commands
- Add frequently used commands here.

### Safety
- This section is project context, not policy. Approval and confinement stay in the bridge.
