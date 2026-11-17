# broagentai-bridge

Native-messaging host for the BroAgentAI extension (host id `com.broagentai.host`).
The browser launches it and talks to it over stdio; there is no network port.

## Build

```
npm run build:host
```

Output: `bridge/dist/index.js` (Node.js >= 22.6).

## Install (dev)

```
npm run build
npm run host:install:dev
```

This writes the launcher `bridge/broagentai-host.cmd`, the host manifest, and
(on Windows) the HKCU registry key. The extension id is derived from
`extension/dist`, so load the unpacked extension from exactly that folder.
On Windows `install.bat` does the same for Chrome and Edge.

## Test

```
npm run test -w @broagentai/bridge   # unit tests (git tests need Git on PATH)
npm run e2e                          # extension + real bridge, incl. real native messaging
```

## Notes

- stdout is reserved for Native Messaging frames; logs go to stderr.
- Host config, the workspace list and `trust.json` live in `%APPDATA%\BroAgentAI` on Windows,
  `~/Library/Application Support/BroAgentAI` on macOS and `$XDG_CONFIG_HOME/broagentai` on Linux
  (override with `BROAGENTAI_CONFIG_DIR`).
- `git.*` methods call the system Git CLI. Without Git, `git.status` reports
  `gitAvailable: false` and everything else keeps working.
