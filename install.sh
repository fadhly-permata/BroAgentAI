#!/usr/bin/env bash
# BroAgentAI installer (Linux / macOS).
#
# The first run prepares everything the bridge needs, then registers the
# native-messaging host com.broagentai.host:
#   1. Node.js 22.6+: the one on PATH, or else a portable copy downloaded from
#      nodejs.org (SHA-256 checked) into .runtime/node. Nothing is installed
#      system-wide for this.
#   2. Build tools for the terminal backend (node-pty has no prebuilt binary
#      for Linux/macOS, so it is compiled): gcc/g++, make, python3. On Linux the
#      installer shows the package-manager command, asks, and runs it with sudo;
#      on macOS it offers xcode-select --install (no sudo).
#   3. npm dependencies (npm ci) when node_modules is missing or out of date,
#      and a check that node-pty loads.
#   4. npm run build when the build output is missing (or with --rebuild).
#   5. scripts/native-host.mjs install for every detected browser
#      (Chrome, Chromium, Edge, Brave, Firefox).
#
# Usage:
#   ./install.sh [--browser chrome,chromium,edge,brave,firefox] [--rebuild] [--portable-node] [--yes]
#   ./install.sh --uninstall [--browser ...]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"

MIN_NODE="22.6.0"
NODE_LINE=22 # portable downloads take the latest release of this major line
RUNTIME_DIR="$ROOT/.runtime"
PORTABLE_DIR="$RUNTIME_DIR/node"
KNOWN_BROWSERS="chrome chromium edge brave firefox"

UNINSTALL=0
REBUILD=0
FORCE_PORTABLE=0
ASSUME_YES=0
BROWSERS=""

if [ -t 1 ]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_OFF=""
fi
step() { printf '%s[..]%s %s\n' "$C_CYAN" "$C_OFF" "$*"; }
ok()   { printf '%s[OK]%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
die()  { printf '%s[X]%s %s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) PLATFORM=linux ;;
  Darwin) PLATFORM=darwin ;;
  *) die "install.sh mendukung Linux dan macOS. Di Windows pakai install.ps1, install-gui.ps1 atau node scripts/install-gui.mjs." ;;
esac

usage() {
  sed -n '/^# Usage:/,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) UNINSTALL=1 ;;
    --rebuild) REBUILD=1 ;;
    --portable-node) FORCE_PORTABLE=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --browser) [ $# -ge 2 ] || usage 2; BROWSERS="$BROWSERS ${2//,/ }"; shift ;;
    --browser=*) v="${1#--browser=}"; BROWSERS="$BROWSERS ${v//,/ }" ;;
    -h|--help) usage 0 ;;
    *) warn "Argumen tidak dikenal: $1"; usage 2 ;;
  esac
  shift
done

# --------------------------------------------------------------- helpers

# version_ge A B: true when version A >= version B (numeric x.y.z).
version_ge() {
  local IFS=.
  local -a a=($1) b=($2)
  local i
  for i in 0 1 2; do
    local x="${a[$i]:-0}" y="${b[$i]:-0}"
    if (( 10#$x > 10#$y )); then return 0; fi
    if (( 10#$x < 10#$y )); then return 1; fi
  done
  return 0
}

node_version() { # prints x.y.z, or nothing when $1 cannot run
  "$1" -v 2>/dev/null | head -n1 | sed 's/^v//' || true
}

# Ask a yes/no question; default no. --yes answers yes. No terminal: no.
confirm() {
  if [ "$ASSUME_YES" = 1 ]; then return 0; fi
  if [ ! -r /dev/tty ]; then return 1; fi
  local answer
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r answer < /dev/tty || return 1
  case "$answer" in y|Y|yes|YES|ya|Ya|YA) return 0 ;; *) return 1 ;; esac
}

as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

download() { # download URL FILE
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "curl atau wget dibutuhkan untuk mengunduh Node.js. Install salah satunya lalu jalankan ulang."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum tidak ditemukan; tidak bisa memverifikasi unduhan Node.js."
  fi
}

install_portable_node() {
  local arch
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l|ppc64le|s390x)
      [ "$PLATFORM" = linux ] || die "Arsitektur $(uname -m) tidak didukung di macOS. Install Node.js $MIN_NODE+ manual lalu jalankan ulang."
      arch="$(uname -m)" ;;
    *) die "Arsitektur $(uname -m) tidak didukung. Install Node.js $MIN_NODE+ manual lalu jalankan ulang." ;;
  esac
  local base="https://nodejs.org/dist/latest-v${NODE_LINE}.x"
  mkdir -p "$RUNTIME_DIR"
  local sums="$RUNTIME_DIR/SHASUMS256.txt"

  step "Mengunduh daftar rilis Node.js $NODE_LINE dari nodejs.org..."
  download "$base/SHASUMS256.txt" "$sums"
  local line hash file
  line="$(grep -E "^[0-9a-f]{64}  node-v[0-9.]+-${PLATFORM}-${arch}\.tar\.gz$" "$sums" | head -n1 || true)"
  rm -f "$sums"
  [ -n "$line" ] || die "Paket Node.js untuk $PLATFORM-$arch tidak ditemukan di $base."
  hash="${line%% *}"
  file="${line##* }"

  step "Mengunduh $file..."
  download "$base/$file" "$RUNTIME_DIR/$file"
  local actual
  actual="$(sha256_of "$RUNTIME_DIR/$file")"
  if [ "$actual" != "$hash" ]; then
    rm -f "$RUNTIME_DIR/$file"
    die "Checksum $file tidak cocok (diharapkan $hash, didapat $actual)."
  fi

  local staging="$RUNTIME_DIR/node-staging"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$RUNTIME_DIR/$file" -C "$staging"
  rm -rf "$PORTABLE_DIR"
  mv "$staging/${file%.tar.gz}" "$PORTABLE_DIR"
  rm -rf "$staging" "$RUNTIME_DIR/$file"

  if [ -z "$(node_version "$PORTABLE_DIR/bin/node")" ]; then
    if [ "$PLATFORM" = darwin ]; then
      die "Node.js portable tidak bisa dijalankan di macOS ini. Install Node.js $MIN_NODE+ manual lalu jalankan ulang."
    fi
    die "Node.js portable tidak bisa dijalankan di sistem ini (butuh glibc 2.28+; Alpine/musl tidak didukung). Install Node.js $MIN_NODE+ lewat package manager lalu jalankan ulang."
  fi
  ok "Node.js portable terpasang di $PORTABLE_DIR"
}

# Sets NODE to a node binary that is new enough. Downloads one only when $1 = download.
resolve_node() {
  NODE=""
  if [ "$FORCE_PORTABLE" = 0 ] && command -v node >/dev/null 2>&1; then
    local candidate version
    candidate="$(command -v node)"
    version="$(node_version "$candidate")"
    if [ -n "$version" ] && version_ge "$version" "$MIN_NODE"; then NODE="$candidate"; return 0; fi
    warn "Node.js di PATH versi ${version:-?} terlalu lama (butuh $MIN_NODE+). Memakai Node.js portable."
  fi
  local version
  version="$(node_version "$PORTABLE_DIR/bin/node")"
  if [ -n "$version" ] && version_ge "$version" "$MIN_NODE"; then NODE="$PORTABLE_DIR/bin/node"; return 0; fi
  [ "${1:-}" = download ] || return 1
  install_portable_node
  NODE="$PORTABLE_DIR/bin/node"
}

have_build_tools() {
  command -v make >/dev/null 2>&1 &&
    { command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1; } &&
    command -v python3 >/dev/null 2>&1 &&
    { [ "$PLATFORM" != darwin ] || xcode-select -p >/dev/null 2>&1; }
}

# Prints the command that installs the build tools on this OS, or nothing.
build_tools_command() {
  if [ "$PLATFORM" = darwin ]; then
    command -v xcode-select >/dev/null 2>&1 && echo "xcode-select --install"
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then echo "apt-get install -y build-essential python3"
  elif command -v dnf >/dev/null 2>&1; then echo "dnf install -y gcc-c++ make python3"
  elif command -v yum >/dev/null 2>&1; then echo "yum install -y gcc-c++ make python3"
  elif command -v pacman >/dev/null 2>&1; then echo "pacman -S --needed --noconfirm base-devel python"
  elif command -v zypper >/dev/null 2>&1; then echo "zypper --non-interactive install gcc-c++ make python3"
  elif command -v apk >/dev/null 2>&1; then echo "apk add build-base python3"
  fi
}

# Returns 0 when build tools are available (installing them after asking), 1 otherwise.
ensure_build_tools() {
  have_build_tools && return 0
  local cmd
  cmd="$(build_tools_command)"
  warn "Build tools (gcc/g++, make, python3) belum lengkap. Ini dibutuhkan untuk compile node-pty (tab Terminal)."
  if [ -z "$cmd" ]; then
    warn "Package manager tidak dikenali. Install gcc/g++, make dan python3 manual, lalu jalankan ulang."
    return 1
  fi
  if [ "$PLATFORM" = darwin ]; then
    echo "    Perintah: $cmd"
    if ! confirm "Jalankan perintah itu sekarang?"; then
      warn "Build tools dilewati."
      return 1
    fi
    xcode-select --install || warn "xcode-select --install gagal atau sudah berjalan."
    warn "Setelah Command Line Tools selesai dipasang, jalankan ulang installer agar node-pty bisa di-compile."
    return 1
  fi
  echo "    Perintah: sudo $cmd"
  if ! confirm "Jalankan perintah itu sekarang?"; then
    warn "Build tools dilewati."
    return 1
  fi
  if command -v apt-get >/dev/null 2>&1; then as_root apt-get update; fi
  # shellcheck disable=SC2086 # the command is meant to be word-split
  as_root $cmd || { warn "Gagal memasang build tools."; return 1; }
  have_build_tools
}

pty_loads() {
  "$NODE" -e "require(require.resolve('node-pty', { paths: [process.argv[1]] }))" "$ROOT/bridge" >/dev/null 2>&1
}

# Compile node-pty directly with the node-gyp that ships with npm (works even
# when npm skips dependency install scripts).
compile_pty() {
  local pty_dir gyp
  pty_dir="$("$NODE" -p "require('path').dirname(require.resolve('node-pty/package.json', { paths: [process.argv[1]] }))" "$ROOT/bridge" 2>/dev/null)" || return 1
  gyp="$(npm prefix -g)/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js"
  if [ -f "$gyp" ]; then
    (cd "$pty_dir" && "$NODE" "$gyp" rebuild)
  else
    (cd "$pty_dir" && npm exec --yes -- node-gyp rebuild)
  fi
}

browser_dir() { # profile folder that shows the browser is used by this account
  local config="${XDG_CONFIG_HOME:-$HOME/.config}"
  if [ "$PLATFORM" = darwin ]; then
    local support="$HOME/Library/Application Support"
    case "$1" in
      chrome) echo "$support/Google/Chrome" ;;
      chromium) echo "$support/Chromium" ;;
      edge) echo "$support/Microsoft Edge" ;;
      brave) echo "$support/BraveSoftware/Brave-Browser" ;;
      firefox) echo "$support/Mozilla/Firefox" ;;
    esac
    return 0
  fi
  case "$1" in
    chrome) echo "$config/google-chrome" ;;
    chromium) echo "$config/chromium" ;;
    edge) echo "$config/microsoft-edge" ;;
    brave) echo "$config/BraveSoftware/Brave-Browser" ;;
    firefox) echo "$HOME/.mozilla/firefox" ;;
  esac
}

browser_commands() {
  if [ "$PLATFORM" = darwin ]; then
    case "$1" in
      chrome) echo "google-chrome" ;;
      chromium) echo "chromium" ;;
      edge) echo "microsoft-edge" ;;
      brave) echo "brave" ;;
      firefox) echo "firefox" ;;
    esac
    return 0
  fi
  case "$1" in
    chrome) echo "google-chrome google-chrome-stable" ;;
    chromium) echo "chromium chromium-browser" ;;
    edge) echo "microsoft-edge microsoft-edge-stable" ;;
    brave) echo "brave-browser brave" ;;
    firefox) echo "firefox firefox-esr" ;;
  esac
}

detect_browsers() {
  local found="" name cmd
  for name in $KNOWN_BROWSERS; do
    if [ -d "$(browser_dir "$name")" ]; then found="$found $name"; continue; fi
    if [ "$PLATFORM" = darwin ]; then
      case "$name" in
        chrome) [ ! -d "/Applications/Google Chrome.app" ] || found="$found $name" ;;
        chromium) [ ! -d "/Applications/Chromium.app" ] || found="$found $name" ;;
        edge) [ ! -d "/Applications/Microsoft Edge.app" ] || found="$found $name" ;;
        brave) [ ! -d "/Applications/Brave Browser.app" ] || found="$found $name" ;;
        firefox) [ ! -d "/Applications/Firefox.app" ] || found="$found $name" ;;
      esac
      continue
    fi
    for cmd in $(browser_commands "$name"); do
      if command -v "$cmd" >/dev/null 2>&1; then found="$found $name"; break; fi
    done
  done
  echo "$found"
}

warn_sandboxed_browsers() {
  [ "$PLATFORM" = linux ] || return 0
  if [ -d "$HOME/snap/chromium" ] || [ -d "$HOME/.var/app/com.google.Chrome" ] ||
     [ -d "$HOME/.var/app/org.chromium.Chromium" ] || [ -d "$HOME/.var/app/com.brave.Browser" ] ||
     [ -d "$HOME/.var/app/com.microsoft.Edge" ]; then
    warn "Terdeteksi browser versi Snap/Flatpak. Versi itu berjalan di sandbox dan belum didukung; pakai paket .deb/.rpm resmi browser."
  fi
}

# --------------------------------------------------------------- main

echo "${C_CYAN}==========================================${C_OFF}"
echo "${C_CYAN}BroAgentAI Installer${C_OFF}"
echo "${C_CYAN}==========================================${C_OFF}"

for name in $BROWSERS; do
  case " $KNOWN_BROWSERS " in *" $name "*) ;; *) die "Browser tidak dikenal: $name (pilihan: ${KNOWN_BROWSERS// /, })" ;; esac
done

if [ "$UNINSTALL" = 1 ]; then
  resolve_node || die "Node.js tidak ditemukan, jadi registrasi tidak bisa dihapus otomatis."
  for name in ${BROWSERS:-$KNOWN_BROWSERS}; do
    "$NODE" scripts/native-host.mjs uninstall --browser "$name" || die "Gagal menghapus registrasi untuk $name."
  done
  ok "Registrasi native host dihapus."
  [ -d "$RUNTIME_DIR" ] && echo "Node.js portable masih ada di $RUNTIME_DIR; hapus folder itu kalau tidak dipakai lagi."
  exit 0
fi

# 1. Node.js
resolve_node download
export PATH="$(dirname "$NODE"):$PATH" # npm and its child processes use this same Node
command -v npm >/dev/null 2>&1 || die "npm tidak ditemukan. Install ulang Node.js atau jalankan dengan --portable-node."
ok "Node.js $(node_version "$NODE"): $NODE"

# 2. Build tools for node-pty
TOOLS=0
if ensure_build_tools; then TOOLS=1; ok "Build tools tersedia."; fi

# 3. Dependencies
NEED_INSTALL=0
if [ -f package-lock.json ]; then
  if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then NEED_INSTALL=1; fi
elif [ ! -d node_modules ]; then
  # A release bundle ships node_modules and has no lockfile; never run npm install there.
  die "package-lock.json dan node_modules tidak ada. Unduh ulang bundle atau clone repo lengkap."
fi
if [ "$NEED_INSTALL" = 1 ]; then
  if [ "$TOOLS" = 1 ]; then
    step "Memasang dependensi (npm ci)..."
    npm ci --no-audit --no-fund || die "npm ci gagal."
  else
    # Without a compiler node-pty's install script fails and would abort the
    # whole install, so skip install scripts; only the Terminal tab is lost.
    step "Memasang dependensi tanpa compile (npm ci --ignore-scripts)..."
    npm ci --no-audit --no-fund --ignore-scripts || die "npm ci gagal."
  fi
else
  ok "Dependensi sudah terpasang."
fi

if ! pty_loads; then
  if [ "$TOOLS" = 1 ]; then
    step "Compile backend terminal (node-pty)..."
    compile_pty || true
  fi
  if pty_loads; then ok "node-pty siap."
  else warn "node-pty tidak bisa di-load. Bridge tetap jalan, tapi tab Terminal tidak tersedia. Pasang build tools lalu jalankan ulang installer."
  fi
fi

# 4. Build
if [ "$REBUILD" = 1 ] || [ ! -f bridge/dist/index.js ] || [ ! -f extension/dist/manifest.json ]; then
  step "Menjalankan npm run build..."
  npm run build || die "Build gagal."
else
  ok "Build sudah ada (pakai --rebuild untuk build ulang)."
fi

# 5. Register the native host (the launcher runs bridge/dist/index.js with this same node)
if [ -z "${BROWSERS// /}" ]; then
  BROWSERS="$(detect_browsers)"
  if [ -z "${BROWSERS// /}" ]; then
    warn "Tidak ada browser yang terdeteksi; mendaftarkan untuk Chrome."
    BROWSERS="chrome"
  fi
fi
warn_sandboxed_browsers
for name in $BROWSERS; do
  step "Mendaftarkan com.broagentai.host untuk $name..."
  if [ "$name" = firefox ]; then
    "$NODE" scripts/native-host.mjs install --browser "$name" --extension-id broagentai@local || die "Registrasi untuk $name gagal."
  else
    "$NODE" scripts/native-host.mjs install --browser "$name" || die "Registrasi untuk $name gagal."
  fi
done

echo "${C_CYAN}==========================================${C_OFF}"
ok "Instalasi selesai untuk:$(printf ' %s' $BROWSERS)"
echo "1. Buka chrome://extensions (atau edge://extensions, brave://extensions), aktifkan Developer mode."
echo "2. Load unpacked: $ROOT/extension/dist"
echo "3. Kalau sudah ter-load, klik Reload pada kartu BroAgentAI."
case " $BROWSERS " in
  *" firefox "*)
    echo "Firefox: jalankan npm run build:firefox lalu about:debugging -> This Firefox -> Load Temporary Add-on..."
    echo "Pilih $ROOT/extension/dist/manifest.json. Lihat docs/firefox.md."
    ;;
esac
echo "${C_CYAN}==========================================${C_OFF}"
