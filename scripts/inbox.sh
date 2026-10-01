#!/usr/bin/env bash
# Look at, retry or ignore the files in your inbox.  Usage: inbox.sh status | retry <file> [--full] | ignore <file>
. "$(dirname "$0")/env.sh"
exec node "$(dirname "$0")/inbox-tool.mjs" "$@"
