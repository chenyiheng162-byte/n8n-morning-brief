# Sourced by run-brief.sh and deploy-workflow.sh: the one run lock of this project (scripts/lock.mjs does the same for
# the Node tools: the inbox tool and the console).
#
# The lock is an operating-system file lock (flock) on STATE/run.lockf, held by a small guard process:
#   /usr/bin/lockf takes the lock or fails at once (exit 75 = held by someone else), then runs a guard that lives exactly
#   as long as the process that asked for the lock. When that process ends in ANY way (normal exit, crash, kill -9), the
#   guard ends within a second and the system releases the lock. Nothing is ever "judged stale" and deleted, so two
#   processes can never both conclude that they may take a lock over.
#
# lock_take LOCKFILE TAG   0 = ours (guard pid in LOCK_GUARD), 1 = held by someone else (LOCK_HOLDER = "pid tag"
#                          from the file, for messages only), 2 = cannot lock at all
# lock_release             ends the guard; the lock is free again
LOCK_GUARD=""; LOCK_HOLDER=""; LOCK_LEGACY=""

# Bridge to the OLD lock (a directory STATE/run.lock with an "owner" file, used up to version 8). Processes started
# before an update keep running the old code -- a console left open, for example -- and only understand that lock. So
# whoever holds the new lock ALSO holds the old one, taken by the old rules, and refuses while a live old process holds it.
LEGACY_LIVE='run-brief|deploy-workflow|inbox-tool|inbox\.sh|console\.mjs'
legacy_take() {
  local dir="$1" tk="$1.takeover" owner tag="$2"
  if mkdir "$dir" 2>/dev/null; then printf '%s %s %s\n' "$$" "$(date +%s)" "$tag" > "$dir/owner"; LOCK_LEGACY="$dir"; return 0; fi
  [ -d "$dir" ] || return 2
  if ! mkdir "$tk" 2>/dev/null; then
    # an old process is in the middle of a takeover -- or died during one: the old rules clear that after two minutes.
    # (Holding the new lock, the only competitors left are old processes, which follow the same rule.)
    if [ -n "$(find "$tk" -maxdepth 0 -mmin +2 2>/dev/null)" ] && rm -rf "${tk:?}" && mkdir "$tk" 2>/dev/null; then :
    else LOCK_HOLDER="old version (taking over)"; return 1; fi
  fi
  owner="$(awk '{print $1}' "$dir/owner" 2>/dev/null)"
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null && ps -p "$owner" -o command= 2>/dev/null | grep -qE "$LEGACY_LIVE"; then
    rmdir "$tk" 2>/dev/null; LOCK_HOLDER="$owner old version"; return 1
  fi
  if [ -z "$owner" ] && [ -z "$(find "$dir" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then rmdir "$tk" 2>/dev/null; LOCK_HOLDER="old version (just starting)"; return 1; fi
  rm -rf "${dir:?}"
  if mkdir "$dir" 2>/dev/null; then printf '%s %s %s\n' "$$" "$(date +%s)" "$tag" > "$dir/owner"; rmdir "$tk" 2>/dev/null; LOCK_LEGACY="$dir"; return 0; fi
  rmdir "$tk" 2>/dev/null; LOCK_HOLDER="old version"; return 1
}
legacy_release() { [ -n "$LOCK_LEGACY" ] && [ "$(awk '{print $1}' "$LOCK_LEGACY/owner" 2>/dev/null)" = "$$" ] && rm -rf "${LOCK_LEGACY:?}"; LOCK_LEGACY=""; return 0; }

lock_take() {
  local file="$1" tag="$2" ready rc i
  LOCK_GUARD=""; LOCK_HOLDER=""
  [ -x /usr/bin/lockf ] || return 2
  touch "$file" 2>/dev/null || return 2
  ready="$(mktemp "${TMPDIR:-/tmp}/brief-lock.XXXXXX")" || return 2
  /usr/bin/lockf -k -s -t 0 "$file" /bin/sh -c "echo locked > '$ready'; while kill -0 $$ 2>/dev/null; do sleep 1; done" </dev/null >/dev/null 2>&1 &
  LOCK_GUARD=$!
  for i in $(seq 1 100); do
    if [ -s "$ready" ]; then
      rm -f "$ready"; printf '%s %s %s\n' "$$" "$(date +%s)" "$tag" > "$file"
      legacy_take "$(dirname "$file")/run.lock" "$tag" && return 0
      rc=$?; lock_release; [ "$rc" = 2 ] && return 2; return 1
    fi
    if ! kill -0 "$LOCK_GUARD" 2>/dev/null; then
      wait "$LOCK_GUARD"; rc=$?; rm -f "$ready"; LOCK_GUARD=""
      [ "$rc" = 75 ] && { LOCK_HOLDER="$(awk '{print $1" "$3}' "$file" 2>/dev/null)"; return 1; }
      return 2
    fi
    sleep 0.05
  done
  kill "$LOCK_GUARD" 2>/dev/null; rm -f "$ready"; LOCK_GUARD=""; return 2
}
lock_release() {
  legacy_release
  [ -n "$LOCK_GUARD" ] || return 0
  # (each step may "fail" harmlessly, for example when the guard is already gone: never let that end a set -e script)
  pkill -P "$LOCK_GUARD" 2>/dev/null || true; kill "$LOCK_GUARD" 2>/dev/null || true; wait "$LOCK_GUARD" 2>/dev/null || true
  LOCK_GUARD=""; return 0
}
# Is the lock held right now (by anyone)? For status screens only.
lock_busy() {
  [ -f "$1" ] && ! /usr/bin/lockf -k -s -t 0 "$1" /usr/bin/true 2>/dev/null && return 0
  local o; o="$(awk '{print $1}' "$(dirname "$1")/run.lock/owner" 2>/dev/null)"   # or an old-version process holds the old lock
  [ -n "$o" ] && kill -0 "$o" 2>/dev/null && ps -p "$o" -o command= 2>/dev/null | grep -qE "$LEGACY_LIVE"
}
