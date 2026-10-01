# Sourced by run-brief.sh and deploy-workflow.sh. The one run lock of this project (scripts/lock.mjs is the same protocol
# for the Node tools). A lock is a directory with an "owner" file ("pid epoch").
#
# lock_acquire LOCKDIR LIVE_REGEX
#   0  the lock is ours (owner written)
#   1  someone else has it: LOCK_HOLDER is its pid, "unknown" (no owner yet) or "takeover" (another process is taking a
#      stale lock over right now)
#   2  the lock cannot be created at all (state folder not writable)
# LOCK_TOOK_OVER is set to the previous owner when a stale lock (its owner is no longer a live process of this project)
# was taken over.
#
# Why a second lock: deciding "this lock is stale" and replacing it are two steps. Two processes that both looked at the
# same dead owner could otherwise both replace it, and the slower one would throw away the lock the faster one had just
# created. So every takeover happens while holding LOCKDIR.takeover, and the decision is made again, under it, from what
# is on disk at that moment.
lock_acquire() {
  local lock="$1" live="$2" tk="$1.takeover" owner
  LOCK_HOLDER=""; LOCK_TOOK_OVER=""
  if mkdir "$lock" 2>/dev/null; then echo "$$ $(date +%s)" > "$lock/owner"; return 0; fi
  [ -d "$lock" ] || return 2
  if ! mkdir "$tk" 2>/dev/null; then
    # a takeover lock older than two minutes was left by a process that died in the middle of a takeover (it takes ms)
    if [ -n "$(find "$tk" -maxdepth 0 -mmin +2 2>/dev/null)" ] && rm -rf "${tk:?}" && mkdir "$tk" 2>/dev/null; then :
    else LOCK_HOLDER=takeover; return 1; fi
  fi
  if [ -d "$lock" ]; then
    owner="$(awk '{print $1}' "$lock/owner" 2>/dev/null)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null && ps -p "$owner" -o command= 2>/dev/null | grep -qE "$live"; then
      LOCK_HOLDER="$owner"; rmdir "$tk" 2>/dev/null; return 1
    fi
    if [ -z "$owner" ] && [ -z "$(find "$lock" -maxdepth 0 -mmin +60 2>/dev/null)" ]; then
      LOCK_HOLDER=unknown; rmdir "$tk" 2>/dev/null; return 1   # just created, its owner is about to be written
    fi
    rm -rf "${lock:?}"; LOCK_TOOK_OVER="${owner:-unknown}"
  fi
  # A process that simply created the lock in the meantime (without a takeover) wins; that is fine: there is one holder.
  if mkdir "$lock" 2>/dev/null; then echo "$$ $(date +%s)" > "$lock/owner"; rmdir "$tk" 2>/dev/null; return 0; fi
  LOCK_HOLDER=unknown; LOCK_TOOK_OVER=""; rmdir "$tk" 2>/dev/null; return 1
}

# Only the owner removes its lock (a lock that was taken over from us is somebody else's now).
lock_release() { [ "$(awk '{print $1}' "$1/owner" 2>/dev/null)" = "$$" ] && rm -rf "${1:?}"; return 0; }
