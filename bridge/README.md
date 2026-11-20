# broagentai-bridge

Native-messaging host for the BroAgentAI extension (host id `com.broagentai.host`).
The browser launches it and talks to it over stdio; there is no network port.

## Build

```
npm run build:host
```

Output: `bridge/dist/index.js` (Node.js >= 22.6).

## Install

The installers at the repo root prepare everything on the first run (Node.js
22.6+, as a portable copy in `.runtime/` when needed; `npm ci`; the build) and
then register the host for every detected browser:

- Windows: `install.bat` (wraps `install.ps1`). Chrome, Edge, Brave, Chromium.
- Linux: `bash install.sh`. Chrome, Chromium, Edge, Brave. node-pty has no
  prebuilt Linux binary, so it is compiled: the installer checks for gcc/g++,
  make and python3 and offers to install them with `sudo`. Without them the
  bridge still runs, only the Terminal tab is unavailable.

Both take an uninstall switch (`-Uninstall` / `--uninstall`).

By hand (one browser per run):

```
npm run build
npm run host:install:dev                      # Chrome
npm run host:install:dev -- --browser brave   # chrome | chromium | edge | brave | firefox
npm run host:uninstall:dev -- --browser brave
```

This writes the launcher, the host manifest and, on Windows, the HKCU registry key:

| | Launcher | Manifest folder |
| --- | --- | --- |
| Windows | `bridge/broagentai-host.cmd` | `%LOCALAPPDATA%\<browser>\NativeMessagingHosts` + `HKCU\Software\<browser>\NativeMessagingHosts\com.broagentai.host` |
| Linux | `bridge/broagentai-host.sh` | `~/.config/google-chrome`, `~/.config/chromium`, `~/.config/microsoft-edge`, `~/.config/BraveSoftware/Brave-Browser` (each `/NativeMessagingHosts`; honours `$XDG_CONFIG_HOME`) |

The launcher runs `bridge/dist/index.js` with the absolute path of the Node.js
that ran the installer, because browsers start hosts with a minimal `PATH`.
Run the installer again after moving the repo or changing Node.js. The
extension id is derived from `extension/dist`, so load the unpacked extension
from exactly that folder.

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
