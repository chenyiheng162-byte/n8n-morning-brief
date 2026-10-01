#!/usr/bin/env bash
# Syncs scripts/workflows into BRIEF_HOME and (re)installs the per-user launchd job.
# Usage: install-launchd.sh [HH:MM]     default 08:00
# The job also runs again 20, 40 and 90 minutes later: the "already sent today" marker makes those runs no-ops
# unless an earlier one failed (for example because the network was not back yet after waking from sleep).
set -euo pipefail
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
. "$SRC_DIR/scripts/env.sh"; . "$SRC_DIR/scripts/lib-config.sh"
LABEL="${BRIEF_LABEL:-com.cc-workspace.n8n-morning-brief}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TIME="${1:-08:00}"
case "$TIME" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "Time must be HH:MM (24h)" >&2; exit 1 ;; esac
HOUR=$((10#${TIME%%:*})); MIN=$((10#${TIME##*:}))
[ "$HOUR" -le 23 ] || { echo "Hour must be 00-23" >&2; exit 1; }

# launchd's bash cannot read ~/Documents, so the scripts it runs must live in BRIEF_HOME.
runtime_check || exit 1                       # check FIRST: nothing is created inside a folder that is not ours
mkdir -p "$BRIEF_HOME/logs" "$HOME/Library/LaunchAgents"
# (When this copy runs from BRIEF_HOME itself, for example from the console to change the time, there is nothing to sync.)
if [ "$(cd "$SRC_DIR" && pwd -P)" != "$(cd "$BRIEF_HOME" && pwd -P)" ]; then
  rsync -a --delete "$SRC_DIR/scripts/" "$BRIEF_HOME/scripts/"
  # workflows/ is deliberately NOT synced here: only deploy-workflow.sh may change it, together with importing the
  # workflow into n8n, so the expected build and the workflow n8n actually runs can never drift apart.
  cp "$SRC_DIR/config.example.env" "$BRIEF_HOME/config.example.env"
fi

# Start times: the requested one plus retries, never crossing midnight.
SLOTS=""
for extra in 0 20 40 90; do
  t=$(( HOUR * 60 + MIN + extra ))
  [ "$t" -lt 1440 ] || continue
  SLOTS="$SLOTS
    <dict><key>Hour</key><integer>$((t / 60))</integer><key>Minute</key><integer>$((t % 60))</integer></dict>"
done

# Settings that must survive into the scheduled run (launchd starts with an almost empty environment).
# (N8N_PORT and BRIEF_INBOX come from config.local.env via env.sh, where install.sh stores them, so re-running this
# script without those variables keeps them.)
ENVVARS="    <key>BRIEF_HOME</key><string>$(xml_escape "$BRIEF_HOME")</string>"
[ -n "${N8N_PORT:-}" ] && ENVVARS="$ENVVARS
    <key>N8N_PORT</key><string>$(xml_escape "$N8N_PORT")</string>"
[ -n "${BRIEF_INBOX:-}" ] && ENVVARS="$ENVVARS
    <key>BRIEF_INBOX</key><string>$(xml_escape "$BRIEF_INBOX")</string>"

NEWPLIST="$(mktemp "$PLIST.XXXXXX")"
cat > "$NEWPLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$BRIEF_HOME")/scripts/run-brief.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
$ENVVARS
  </dict>
  <key>StartCalendarInterval</key>
  <array>$SLOTS
  </array>
  <key>StandardOutPath</key><string>$(xml_escape "$BRIEF_HOME")/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$BRIEF_HOME")/logs/launchd.log</string>
</dict>
</plist>
PLISTEOF
# Validate first, replace afterwards: a bad path must never leave a broken or missing job behind.
plutil -lint "$NEWPLIST" >/dev/null || { rm -f "$NEWPLIST"; echo "Generated an invalid plist (see the path above); the existing job was left untouched." >&2; exit 1; }
PREV=""
if [ -f "$PLIST" ]; then PREV="$(mktemp "$PLIST.prev.XXXXXX")"; cp "$PLIST" "$PREV"; fi
mv "$NEWPLIST" "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# launchd often answers "Input/output error" or "Operation already in progress" when asked to load a job it just
# removed: that goes away within a second or two, so try a few times before giving up.
bootstrap_ok=0
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>"$PLIST.err"; then bootstrap_ok=1; break; fi
  [ "$attempt" -lt 5 ] && sleep 1
done
[ -s "$PLIST.err" ] && [ "$bootstrap_ok" = 0 ] && cat "$PLIST.err" >&2; rm -f "$PLIST.err"
if [ "$bootstrap_ok" != 1 ]; then
  # Loading the new definition failed: put the old job back, so the morning brief still has a schedule.
  echo "ERROR: launchctl could not load the new schedule." >&2
  if [ -n "$PREV" ]; then
    mv "$PREV" "$PLIST" && launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "The previous schedule was restored." >&2 || echo "WARNING: the previous schedule could not be restored either; run this script again." >&2
  else rm -f "$PLIST"; fi
  exit 1
fi
[ -n "$PREV" ] && rm -f "$PREV"
echo "定时任务已安装（${LABEL}）：每天 $(printf '%02d:%02d' "$HOUR" "$MIN") 运行；没发成功时 20、40、90 分钟后各再试一次"
