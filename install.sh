#!/bin/sh
# Installs msg. Works two ways:
#   curl -fsSL https://raw.githubusercontent.com/maxvbuda/terminal-messages/main/install.sh | sh
#   ./install.sh            (from a clone)
# Downloads the program if it isn't already here, puts `msg` on your PATH
# and, if you use maxshell, hooks it in. Run it again to update;
# `msg uninstall` undoes the set-up.
set -e

REPO="${MSG_REPO:-https://github.com/maxvbuda/terminal-messages}"
DEST="${MSG_INSTALL_DIR:-$HOME/.terminal-messages/app}"

if ! command -v node >/dev/null 2>&1; then
  echo "msg needs Node.js 16 or newer — install it first (brew install node)" >&2
  exit 1
fi

# From a clone, use it as it is; otherwise fetch (or update) a copy.
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)
if [ -n "$here" ] && [ -f "$here/msg" ] && [ -d "$here/lib" ]; then
  APP="$here"
else
  APP="$DEST"
  if [ -d "$APP/.git" ] && command -v git >/dev/null 2>&1; then
    echo "updating msg in $APP"
    git -C "$APP" pull --quiet --ff-only
  elif command -v git >/dev/null 2>&1; then
    echo "downloading msg to $APP"
    rm -rf "$APP"
    mkdir -p "$(dirname "$APP")"
    git clone --quiet --depth 1 "$REPO" "$APP"
  else
    echo "downloading msg to $APP"
    tmp=$(mktemp -d)
    curl -fsSL "$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp"
    rm -rf "$APP"
    mkdir -p "$(dirname "$APP")"
    mv "$tmp"/*/ "$APP"
    rm -rf "$tmp"
  fi
fi

chmod +x "$APP/msg"
node "$APP/msg" install

if command -v msg >/dev/null 2>&1 || [ -d "$HOME/.maxshell/bin" ]; then
  echo "done — run: msg new ROOM, or msg join CODE"
else
  echo "done — run it now with: $APP/msg"
fi
