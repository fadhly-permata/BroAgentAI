#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
KNOWN_BROWSERS="chrome chromium edge brave firefox"
UNINSTALL=0
REBUILD=0
FORCE_PORTABLE=0
BROWSERS=""

usage() {
  printf '%s\n' \
    "BroAgentAI GUI installer (Linux / macOS)" \
    "" \
    "Usage: bash install-gui.sh [--browser chrome,firefox] [--uninstall] [--rebuild] [--portable-node] [--yes]" \
    "" \
    "Pilih browser lewat zenity (Linux/macOS), osascript (macOS), atau terminal."
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --rebuild) REBUILD=1 ;;
    --portable-node) FORCE_PORTABLE=1 ;;
    -y|--yes) ;;
    --browser) [ $# -ge 2 ] || usage 2; BROWSERS="$BROWSERS ${2//,/ }"; shift ;;
    --browser=*) v="${1#--browser=}"; BROWSERS="$BROWSERS ${v//,/ }" ;;
    -h|--help) usage 0 ;;
    *) printf '[!] Argumen tidak dikenal: %s\n' "$1" >&2; usage 2 ;;
  esac
  shift
done

is_macos() { [ "$(uname -s)" = Darwin ]; }
have_zenity() { command -v zenity >/dev/null 2>&1 && { [ -n "${DISPLAY:-}" ] || [ -n "${WAYLAND_DISPLAY:-}" ]; }; }
have_osascript() { is_macos && command -v osascript >/dev/null 2>&1; }

normalize_browsers() {
  local raw="$1" out="" name lower
  raw="${raw//,/ }"
  for name in $raw; do
    lower="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    case " $KNOWN_BROWSERS " in
      *" $lower "*)
        case " $out " in *" $lower "*) ;; *) out="$out $lower" ;; esac
        ;;
    esac
  done
  printf '%s' "${out# }"
}

select_zenity() {
  local selected
  selected="$(zenity --list --checklist \
    --title "BroAgentAI Installer" \
    --text "Pilih browser untuk mendaftarkan com.broagentai.host:" \
    --column=Browser --separator=, --width=460 --height=320 \
    TRUE chrome FALSE chromium FALSE edge FALSE brave FALSE firefox)" || return 130
  printf '%s' "$selected"
}

select_osascript() {
  local script chosen
  script="$(cat <<'APPLESCRIPT'
set browserList to {"chrome", "chromium", "edge", "brave", "firefox"}
set chosen to choose from list browserList with prompt "Pilih browser untuk BroAgentAI (bisa lebih dari satu):" with multiple selections allowed
if chosen is false then error number 130
set oldDelimiters to AppleScript's text item delimiters
set AppleScript's text item delimiters to ","
set chosenText to chosen as text
set AppleScript's text item delimiters to oldDelimiters
return chosenText
APPLESCRIPT
)"
  chosen="$(osascript -e "$script" 2>/dev/null)" || return 130
  printf '%s' "$chosen"
}

select_terminal() {
  if [ ! -r /dev/tty ]; then
    printf 'chrome'
    return 0
  fi
  printf 'BroAgentAI Installer\n'
  printf 'Pilih browser (pisahkan dengan koma): chrome, chromium, edge, brave, firefox\n'
  printf 'Contoh: chrome,firefox [chrome]: '
  local answer
  read -r answer < /dev/tty || { printf 'chrome'; return 0; }
  printf '%s' "${answer:-chrome}"
}

if [ -z "${BROWSERS// /}" ]; then
  if have_zenity; then
    BROWSERS="$(select_zenity)" || exit $?
  elif have_osascript; then
    BROWSERS="$(select_osascript)" || exit $?
  else
    BROWSERS="$(select_terminal)" || exit $?
  fi
fi

BROWSERS="$(normalize_browsers "$BROWSERS")"
if [ -z "$BROWSERS" ]; then
  printf '[!] Tidak ada browser dipilih; memakai chrome.\n'
  BROWSERS="chrome"
fi

printf '[..] Installer GUI: %s\n' "$(have_zenity && printf zenity || { have_osascript && printf osascript || printf terminal; })"
args=()
[ "$UNINSTALL" = 1 ] && args+=(--uninstall)
[ "$REBUILD" = 1 ] && args+=(--rebuild)
[ "$FORCE_PORTABLE" = 1 ] && args+=(--portable-node)
for name in $BROWSERS; do args+=(--browser "$name"); done
args+=(--yes)

exec bash "$ROOT/install.sh" "${args[@]}"
