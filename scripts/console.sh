#!/usr/bin/env bash
# Opens the local control console in your browser.  Usage: console.sh [--port=5698] [--no-open]
# The settings file is NOT loaded into this process: the console reads it itself and never hands secrets to the page.
BRIEF_HOME="${BRIEF_HOME:-$HOME/.n8n-morning-brief}"; export BRIEF_HOME
NODE="$BRIEF_HOME/.runtime/node/bin/node"; [ -x "$NODE" ] || NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "找不到 Node：请先运行 install.sh" >&2; exit 1; }
exec "$NODE" "$(cd "$(dirname "$0")" && pwd)/console.mjs" "$@"
