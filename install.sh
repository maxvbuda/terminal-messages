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
  # An old clone would install old code: bring it up to date first.
  if [ -d "$APP/.git" ] && command -v git >/dev/null 2>&1; then
    before=$(git -C "$APP" rev-parse HEAD)
    if git -C "$APP" pull --quiet --ff-only 2>/dev/null; then
      if [ "$before" != "$(git -C "$APP" rev-parse HEAD)" ] && [ -z "$MSG_UPDATED" ]; then
        echo "updated $APP to the newest version"
        MSG_UPDATED=1 exec /bin/sh "$APP/install.sh"   # finish with the new installer
      fi
    else
      echo "couldn't update $APP (offline or local changes) — installing it as it is"
    fi
  fi
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

# Check that a new terminal window will really find msg.
login_shell="${SHELL:-/bin/zsh}"
found=$(perl -e 'alarm 15; exec @ARGV' "$login_shell" -lic 'command -v msg' </dev/null 2>/dev/null | tail -n 1)
case "$found" in
  */msg) echo "✓ new terminal windows will find msg ($found) — open one and run: msg new ROOM" ;;
  *)
    echo "✗ a new $(basename "$login_shell") window may not find msg." >&2
    echo "  Run it with the full path for now: $APP/msg" >&2
    echo "  and send this output to whoever shared msg with you." >&2
    exit 1 ;;
esac
