#!/bin/sh
# Sets up msg: puts it on your PATH and, if you use maxshell, hooks it in so
# new messages show up above the prompt. Safe to run again; `msg uninstall`
# undoes it.
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "msg needs Node.js (16 or newer): brew install node" >&2
  exit 1
fi
chmod +x msg
node msg install
