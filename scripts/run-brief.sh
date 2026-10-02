#!/usr/bin/env bash
# Delivers the morning brief: start n8n -> trigger the workflow once -> stop n8n (with a direct fallback).
#
# Usage: run-brief.sh [--test | --force | --dry-run | --ingest]
#   (no option)  the scheduled run: skipped when today's brief was already sent; records delivery in state markers
#   --test       send a brief NOW, labelled "测试", ignoring and NOT writing any markers (safe at any time of day)
#   --force      send a brief NOW without the label, ignoring and NOT writing any markers
#   --dry-run    build the brief and print it; sends nothing, calls no AI, writes nothing (does not start n8n)
#   --ingest     read the inbox now (PDF/DOCX text, AI, tasks.csv) under the run lock; sends nothing, writes no markers,
#                does not start n8n (the console's 「现在读取」)
# Only the scheduled run writes markers, so a manual check can never cancel the real morning brief.
#
# Tuning (mainly for tests): BRIEF_READY_TIMEOUT (120s to wait for n8n), BRIEF_EXEC_TIMEOUT (1200s for one accepted run),
#   BRIEF_POLL (2s), BRIEF_GRACE (3s), BRIEF_NO_NOTIFY=1, BRIEF_FALLBACK=direct|none (default direct),
#   BRIEF_ENGINE=n8n|direct (default n8n), BRIEF_REUSE_N8N=1 (allow talking to an n8n that is already running).
set -u
. "$(dirname "$0")/env.sh"
. "$(dirname "$0")/lock.sh"
cd "$BRIEF_HOME" || exit 1

MODE=normal
case "${1:-}" in
  '') ;; --test) MODE=test ;; --force) MODE=force ;; --dry-run) MODE=dry ;; --ingest) MODE=ingest ;;
  -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
  *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
esac
TODAY="$(date +%F)"
# One state folder for this run and everything it starts (n8n, the direct engine): the send step writes its attempt
# record there, and this script looks for it there.
STATE_DIR="${BRIEF_STATE_DIR:-$BRIEF_HOME/data/state}"; export BRIEF_STATE_DIR="$STATE_DIR"
LOG_DIR="$BRIEF_HOME/logs"
LOG="$LOG_DIR/run-$TODAY.log"
MARKER="$STATE_DIR/sent-$TODAY"
PENDING="$STATE_DIR/pending-$TODAY"
LOCK="$STATE_DIR/run.lockf"   # an operating-system file lock, see scripts/lock.sh
N8N_PIDFILE="$STATE_DIR/n8n.pid"
READY_TIMEOUT="${BRIEF_READY_TIMEOUT:-120}"
EXEC_TIMEOUT="${BRIEF_EXEC_TIMEOUT:-1200}"
POLL="${BRIEF_POLL:-2}"
FALLBACK="${BRIEF_FALLBACK:-direct}"
ENGINE_PREF="${BRIEF_ENGINE:-n8n}"
RUN_ID="$(date +%H%M%S)-$$"
ATTEMPT="$STATE_DIR/attempt-$RUN_ID"   # written by the Send to Discord node just before it posts (see workflows/src/send-discord.js)
STARTED_AT="$(date +%s)"
DIRECT_REASON=""; CHILD_PID=""; N8N_PID=""; STARTED_BY_US=0; FAILED=0; RESULT=fail; REASON="unexpected exit"; ENGINE=""; BODY=""; MISSED=""; MISSED_DAYS=""; HAVE_LOCK=0
T_NET=0; T_READY=0; T_EXEC=0

mkdir -p "$STATE_DIR" "$LOG_DIR"
log() { printf '%s [%s] %s\n' "$(date '+%F %T')" "$RUN_ID" "$*" >> "$LOG"; }

# A desktop notification works even when Discord (and therefore the Discord alert) does not.
notify_local() {
  [ -n "${BRIEF_NO_NOTIFY:-}" ] && return 0
  command -v osascript >/dev/null 2>&1 || return 0
  osascript -e "display notification \"${1//\"/}\" with title \"每日简报\"" >/dev/null 2>&1 || true
}
# Post a plain-text alert straight to Discord (URL passed via stdin so it never shows in `ps`). At most two per day.
alert() {
  notify_local "$1"
  [ -n "${DISCORD_WEBHOOK_URL:-}" ] || return 0
  local n; n="$(cat "$STATE_DIR/alerts-$TODAY" 2>/dev/null || echo 0)"
  [ "$n" -lt 2 ] || return 0
  echo $((n + 1)) > "$STATE_DIR/alerts-$TODAY"
  local code
  # (an alert can quote a file name or a server's answer: allowed_mentions keeps an "@everyone" in it from pinging anyone)
  code="$(printf 'url = "%s"\n' "$DISCORD_WEBHOOK_URL" | curl -s -o /dev/null -m 15 -w '%{http_code}' -K - \
    -H 'Content-Type: application/json' -X POST \
    --data "$(printf '{"content":"⚠️ 每日简报：%s","allowed_mentions":{"parse":[]}}' "$(json_escape "$1")")" 2>/dev/null)" || true
  case "$code" in 2??) ;; *) log "alert to Discord failed (HTTP ${code:-none})"; notify_local "Discord 报警也没有发出去，请检查 Webhook 是否还有效" ;; esac
}

# A JSON string body: line breaks and tabs become spaces, other control characters (invalid in JSON) are dropped.
json_escape() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
num_of() { printf '%s' "$BODY" | sed -n "s/.*\"$1\":\([0-9][0-9]*\).*/\1/p" | head -1; }
# One small machine-readable record of the latest run, for scripts/status.sh.
write_last_run() {
  case "$MODE" in dry|ingest) return 0 ;; esac   # not a delivery: the record of the last delivery stays
  [ "$HAVE_LOCK" = 1 ] || return 0   # a process that did not get the lock must not overwrite the record of the one that has it
  local ended; ended="$(date +%s)"
  printf '{"run":"%s","mode":"%s","result":"%s","reason":"%s","engine":"%s","date":"%s","started":%s,"seconds":%s,"missedDays":"%s","events":%s,"tasks":%s,"newTasks":%s,"aiCalls":%s,"calendarMs":%s,"ingestMs":%s,"waitNetSec":%s,"waitReadySec":%s,"execSec":%s}\n' \
    "$RUN_ID" "$MODE" "$RESULT" "$(json_escape "$REASON")" "${ENGINE:-none}" "$TODAY" "$STARTED_AT" "$((ended - STARTED_AT))" "${MISSED_DAYS# }" \
    "$(num_of events)" "$(num_of tasks)" "$(num_of newTasks)" "$(num_of aiCalls)" "$(num_of calendarMs)" "$(num_of ingestMs)" "$T_NET" "$T_READY" "$T_EXEC" \
    | sed 's/:,/:0,/g; s/:}/:0}/g' > "$STATE_DIR/last-run.json.tmp" 2>/dev/null && mv "$STATE_DIR/last-run.json.tmp" "$STATE_DIR/last-run.json" 2>/dev/null
  return 0
}

stop_n8n() {
  if [ "$STARTED_BY_US" = 1 ] && [ -n "$N8N_PID" ] && kill -0 "$N8N_PID" 2>/dev/null; then
    log "stopping n8n (pid $N8N_PID)"
    kill "$N8N_PID" 2>/dev/null
    for _ in $(seq 1 20); do kill -0 "$N8N_PID" 2>/dev/null || break; sleep 1; done
    kill -0 "$N8N_PID" 2>/dev/null && { log "n8n ignored SIGTERM, sending SIGKILL"; kill -9 "$N8N_PID" 2>/dev/null; }
  fi
  [ "$STARTED_BY_US" = 1 ] && rm -f "$N8N_PIDFILE"
  STARTED_BY_US=0
}
# Old day markers and logs go after every successful delivery, whichever engine sent it (called from cleanup, so the
# direct engine and the fallback, which end the script early, are covered too).
tidy_files() {
  find "$STATE_DIR" \( -name 'sent-*' -o -name 'reported-*' -o -name 'alerts-*' -o -name 'pending-*' -o -name 'attempt-*' \) -mtime +14 -delete 2>/dev/null
  find "$LOG_DIR" -name 'run-*.log' -mtime +30 -delete 2>/dev/null
  if [ -f "$LOG_DIR/n8n-run.log" ] && [ "$(wc -c < "$LOG_DIR/n8n-run.log")" -gt 5242880 ]; then
    tail -c 1048576 "$LOG_DIR/n8n-run.log" > "$LOG_DIR/n8n-run.log.tmp" && mv "$LOG_DIR/n8n-run.log.tmp" "$LOG_DIR/n8n-run.log"
  fi
  return 0
}
cleanup() {
  local rc=$?
  # a request that is still in flight must not outlive us
  if [ -n "$CHILD_PID" ]; then pkill -P "$CHILD_PID" 2>/dev/null; kill "$CHILD_PID" 2>/dev/null; fi
  rm -f "$STATE_DIR"/resp.$$ "$STATE_DIR"/direct.$$ "$STATE_DIR"/direct.err.$$ "$STATE_DIR"/ingest.$$ "$ATTEMPT" 2>/dev/null   # the attempt record has been read by now
  if [ "$rc" -ne 0 ] && [ "$FAILED" = 0 ]; then
    case "$rc" in
      143|130|129) REASON="interrupted by a signal"; log "interrupted by a signal (launchd stop, logout, shutdown or Ctrl-C)" ;;
      *) FAILED=1; REASON="unexpected exit code $rc"; log "FAIL: 脚本意外退出（退出码 ${rc}），没有记录具体原因"; alert "脚本意外退出（退出码 ${rc}）（详见 logs/run-${TODAY}.log）" ;;   # an error nobody handled (for example an unset variable): never exit silently
    esac
  fi
  stop_n8n
  [ "$RESULT" = ok ] && tidy_files
  write_last_run
  # release the lock only if it is still ours (another process may have taken over a lock it considered stale)
  [ "$HAVE_LOCK" = 1 ] && lock_release
  return 0
}
trap cleanup EXIT
trap 'exit 143' TERM INT HUP
fail() { FAILED=1; REASON="$1"; log "FAIL: $1"; alert "运行失败：$1（详见 logs/run-$TODAY.log）"; exit 1; }

# ---------- dry run: no lock, no n8n, no markers ----------
if [ "$MODE" = dry ]; then
  node "$BRIEF_HOME/scripts/brief.mjs" --dry-run; exit $?
fi

# ---------- settings problems are visible, not silent ----------
[ -z "${BRIEF_CONFIG_ERRORS:-}" ] || log "WARN: config.local.env: line(s) ${BRIEF_CONFIG_ERRORS} were not understood and skipped (expected KEY='value')"
[ -z "${BRIEF_TZ_INVALID:-}" ] || log "WARN: BRIEF_TZ '${BRIEF_TZ_INVALID}' is not a valid timezone; using ${BRIEF_TZ}"
[ "$MODE" = ingest ] || [ -n "${DISCORD_WEBHOOK_URL:-}" ] || fail "settings 里没有可用的 DISCORD_WEBHOOK_URL"

# ---------- single-instance lock ----------
# An operating-system file lock held by a guard process (scripts/lock.sh): it is released by the system as soon as the run
# ends in any way, so a crash never blocks the next slots. An n8n left behind by a crashed run is stopped below.
# Epoch seconds at which a process started (empty when unknown).
proc_start() {
  local l; l="$(ps -p "$1" -o lstart= 2>/dev/null)"; [ -n "$l" ] || return 0
  date -j -f '%a %b %e %T %Y' "$l" +%s 2>/dev/null || date -d "$l" +%s 2>/dev/null || true
}
kill_orphan_n8n() {
  [ -f "$N8N_PIDFILE" ] || return 0
  local p rec st; p="$(awk '{print $1}' "$N8N_PIDFILE" 2>/dev/null)"; rec="$(awk '{print $2}' "$N8N_PIDFILE" 2>/dev/null)"
  # the pid must still be an n8n that started when we recorded it: a reused pid number is left alone
  if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ps -p "$p" -o command= 2>/dev/null | grep -q "n8n"; then
    st="$(proc_start "$p")"
    if [ -n "$st" ] && [ -n "$rec" ] && [ "$(( st - rec ))" -gt 120 -o "$(( rec - st ))" -gt 120 ]; then
      log "pid $p looks like an n8n but it did not start when the run recorded it; leaving it alone"; rm -f "$N8N_PIDFILE"; return 0
    fi
    log "stopping an n8n left over from a crashed run (pid $p)"; kill "$p" 2>/dev/null; sleep 2; kill -0 "$p" 2>/dev/null && kill -9 "$p" 2>/dev/null
  fi
  rm -f "$N8N_PIDFILE"
}
lock_take "$LOCK" run-brief; rc=$?
case "$rc" in
  0) HAVE_LOCK=1 ;;
  2) fail "无法取得运行锁（状态目录 $STATE_DIR 不可写？或者系统缺少 /usr/bin/lockf）" ;;
  *) log "the lock is held by another process of this project (${LOCK_HOLDER:-unknown}: a run, a deployment, the inbox tool or the console), exiting"
     # the scheduled run simply leaves it to its next slot; a manual action is told that nothing happened, and why
     if [ "$MODE" != normal ]; then echo "现在有另一项操作在进行（一次运行、部署或控制台的保存），这次没有执行：请一两分钟后再试。"; FAILED=1; exit 1; fi
     exit 0 ;;
esac
kill_orphan_n8n

# ---------- permissions: this folder holds your schedule and your credentials ----------
chmod 700 "$BRIEF_HOME" "$BRIEF_HOME/data" "$STATE_DIR" 2>/dev/null
chmod 600 "$BRIEF_HOME/config.local.env" "$BRIEF_HOME/data/.n8n/database.sqlite" 2>/dev/null

# ---------- scheduled run: skip if done, refuse to guess if the last outcome is unknown ----------
if [ "$MODE" = normal ]; then
  if [ -f "$MARKER" ]; then RESULT=skipped; REASON="already sent today"; log "already sent today ($MARKER), skipping"; exit 0; fi
  if [ -f "$PENDING" ]; then
    RESULT=skipped; REASON="delivery state unknown"; log "SKIP: a delivery attempt started earlier today ($(cat "$PENDING" 2>/dev/null)) and its outcome is unknown; not sending again automatically"
    [ -f "$STATE_DIR/alerts-$TODAY" ] || alert "今天早些时候的一次发送状态不明（可能已经送达，也可能没有）。为避免重复，不再自动重发。没收到的话请运行：run-brief.sh --force"
    exit 0
  fi
  # A run that cannot record its outcome must not send at all: it could not prevent a duplicate later.
  touch "$STATE_DIR/.write-test.$$" 2>/dev/null && rm -f "$STATE_DIR/.write-test.$$" || fail "状态目录不可写（磁盘满或权限问题），为避免无法记录而重复发送，本次不发送"
fi

# Days in the last 3 with no "sent" marker (only since installation, and only reported once) are passed to the workflow so
# the brief can say it was missed (Mac off / asleep at the time). Manual runs never touch this.
INSTALLED_FILE="$STATE_DIR/installed-at"
[ -f "$INSTALLED_FILE" ] || echo "$TODAY" > "$INSTALLED_FILE"
INSTALLED_AT="$(cat "$INSTALLED_FILE")"
if [ "$MODE" = normal ]; then
  for back in 3 2 1; do
    d="$(date -v-${back}d +%F 2>/dev/null || date -d "-${back} day" +%F)"
    if ! [[ "$d" < "$INSTALLED_AT" ]]; then
      # a day whose delivery state is unknown (pending) may well have been delivered: it is not reported as missed
      if [ ! -f "$STATE_DIR/sent-$d" ] && [ ! -f "$STATE_DIR/reported-$d" ] && [ ! -f "$STATE_DIR/pending-$d" ]; then MISSED="${MISSED:+$MISSED,}\"$d\""; MISSED_DAYS="$MISSED_DAYS $d"; fi
    fi
  done
fi
TEST_FIELD=""; [ "$MODE" = test ] && TEST_FIELD=',"test":true'
PAYLOAD="{\"missed\":[${MISSED}],\"run\":\"${RUN_ID}\"${TEST_FIELD}}"
MISSED_ARG=""; [ -n "$MISSED_DAYS" ] && MISSED_ARG="--missed=$(printf '%s' "${MISSED_DAYS# }" | tr ' ' ',')"
[ "$MODE" = test ] && export BRIEF_TEST=1

# Keep the Mac awake for the duration of this script (display may stay off).
command -v caffeinate >/dev/null 2>&1 && { caffeinate -i -w $$ >/dev/null 2>&1 & }

# ---------- read the inbox now (--ingest): the ingest step only, under the lock; no n8n, no Discord, no markers ----------
if [ "$MODE" = ingest ]; then
  log "reading the inbox now (--ingest)"
  node "$BRIEF_HOME/scripts/extract-inbox.mjs" > "$STATE_DIR/ingest.$$" 2>&1; cat "$STATE_DIR/ingest.$$"; cat "$STATE_DIR/ingest.$$" >> "$LOG"
  # (background + wait, as below: a stop signal is handled at once)
  node "$BRIEF_HOME/scripts/brief.mjs" --ingest > "$STATE_DIR/ingest.$$" 2>&1 &
  CHILD_PID=$!; wait "$CHILD_PID"; rc=$?; CHILD_PID=""
  cat "$STATE_DIR/ingest.$$"; cat "$STATE_DIR/ingest.$$" >> "$LOG"; rm -f "$STATE_DIR/ingest.$$"
  # a manual action that failed is shown where it was started; it is not a failed brief (no alert, no FAIL line in the history)
  if [ "$rc" = 0 ]; then RESULT=ok; REASON="inbox read"; log "OK: inbox read (--ingest)"; exit 0; fi
  FAILED=1; REASON="inbox read failed"; log "ERROR: reading the inbox failed (exit code ${rc})"; exit 1
fi

# After waking from sleep the network can take a while to come back: wait for Discord, with a hard deadline. 60 seconds
# normally; 180 when the Mac woke up less than five minutes ago (on 2026-10-01 the network needed about 100 seconds after
# a wake from hibernation). BRIEF_NET_WAIT overrides both.
t=$(date +%s)
NET_WAIT="${BRIEF_NET_WAIT:-60}"
if [ -z "${BRIEF_NET_WAIT:-}" ]; then
  woke="$(sysctl -n kern.waketime 2>/dev/null | sed -n 's/^{ *sec = \([0-9][0-9]*\).*/\1/p')"
  [ -n "$woke" ] && [ "$(( t - woke ))" -ge 0 ] && [ "$(( t - woke ))" -lt 300 ] && NET_WAIT=180
fi
case "$DISCORD_WEBHOOK_URL" in
  https://*) NET_DEADLINE=$(( t + NET_WAIT ))
             until curl -s -o /dev/null --connect-timeout 5 -m 8 https://discord.com; do [ "$(date +%s)" -lt "$NET_DEADLINE" ] || { log "Discord not reachable after ${NET_WAIT}s, continuing anyway"; break; }; sleep 3; done ;;
esac
T_NET=$(( $(date +%s) - t ))

# PDF/DOCX -> text cache (a failure here must not stop the brief; the ingest node reports it)
node "$BRIEF_HOME/scripts/extract-inbox.mjs" >> "$LOG" 2>&1 || log "extract-inbox failed (continuing)"

# ---------- delivery ----------
# The direct engine runs the same code as the workflow, without n8n. $1 = a note shown in the brief when this is a fallback.
# Every delivery attempt ends in one of three states: NOT ACCEPTED (nothing can have been sent: pending is removed and a
# later slot may try again), CONFIRMED (sent), or UNKNOWN (the request left this machine but no answer came back: pending is
# KEPT, nothing is sent again automatically, and one alert tells you to check).
unknown_outcome() {
  RESULT=unknown; FAILED=1; REASON="$1; delivery state unknown"; log "FAIL: ${REASON}"
  alert "$1，简报可能已经发出，也可能没有。为避免重复不会自动重发；没收到的话请运行：run-brief.sh --force"
  exit 1
}
write_pending() { [ "$MODE" = normal ] || return 0; echo "$RUN_ID $(date +%s)" > "$PENDING" 2>/dev/null && [ -f "$PENDING" ] || fail "无法写入「发送中」记录（磁盘或权限问题），为避免无法防重，本次不发送"; }
deliver_direct() {
  ENGINE=direct
  write_pending
  local rc
  # Run in the background and wait: `wait` is interrupted by a signal at once, a foreground command substitution is not.
  # shellcheck disable=SC2086
  # the user's own BRIEF_NOTE stays; a fallback adds its reason after it
  ( BRIEF_NOTE="${BRIEF_NOTE:-}${BRIEF_NOTE:+${1:+ · }}${1:-}" node "$BRIEF_HOME/scripts/brief.mjs" --run="$RUN_ID" $MISSED_ARG 2>"$STATE_DIR/direct.err.$$" ) > "$STATE_DIR/direct.$$" &
  CHILD_PID=$!; wait "$CHILD_PID"; rc=$?; CHILD_PID=""
  BODY="$(cat "$STATE_DIR/direct.$$" 2>/dev/null)"
  cat "$STATE_DIR/direct.err.$$" >> "$LOG" 2>/dev/null
  # the engine's own explanation ("brief.mjs failed: Discord: 404 ..."), for the alert and the run record
  DIRECT_REASON="$(sed -n 's/^brief.mjs failed: //p' "$STATE_DIR/direct.err.$$" 2>/dev/null | tail -1 | cut -c1-200)"; rm -f "$STATE_DIR/direct.err.$$"
  if [ "$rc" = 0 ] && printf '%s' "$BODY" | grep -q '"status":"sent"'; then return 0; fi
  # 3 = the request to Discord may have been delivered. Any other failure AFTER the attempt record exists (a crash, a
  # kill, an unexpected exit) is just as uncertain; only a failure before it can have sent nothing.
  [ "$rc" = 3 ] && unknown_outcome "直连模式发送时没有得到明确回答${DIRECT_REASON:+（${DIRECT_REASON}）}"
  # 4 = Discord clearly did not take it (the send step also removed its attempt record): nothing was delivered.
  if [ "$rc" = 4 ]; then [ "$MODE" = normal ] && rm -f "$PENDING"; return 1; fi
  [ -f "$ATTEMPT" ] && unknown_outcome "直连模式在发送过程中意外结束（退出码 ${rc}）"
  [ "$MODE" = normal ] && rm -f "$PENDING"
  return 1
}
record_delivered() {
  if [ "$MODE" = normal ]; then
    if { touch "$MARKER" 2>/dev/null && [ -f "$MARKER" ]; }; then
      rm -f "$PENDING"
      for d in $MISSED_DAYS; do touch "$STATE_DIR/reported-$d" 2>/dev/null; done
    else
      # pending stays: it is what stops the later slots (it was written before sending, so it exists)
      log "ERROR: the brief was delivered but the sent marker could not be written; the pending record is kept so nothing is sent again"
      alert "简报已经发出，但无法记录「今天已发送」（磁盘或权限问题）。为避免重复，之后的时间点不会再发送；请检查磁盘空间"
    fi
  fi
  RESULT=ok; REASON="brief sent"; log "OK: brief sent (engine: $ENGINE, mode: $MODE)"
}
# n8n could not take the request at all: nothing was sent, so the direct engine may deliver without risking a duplicate.
unavailable() {
  log "n8n unavailable: $1"
  if [ "$FALLBACK" = direct ]; then
    log "falling back to the direct engine"
    stop_n8n
    if deliver_direct "n8n 没能工作（$1），这份简报由直连模式发送"; then
      record_delivered; alert "n8n 这次没能工作（$1），简报已改用直连模式发出。请运行 scripts/status.sh 检查 n8n"; exit 0
    fi
    fail "$1；直连模式也失败了${DIRECT_REASON:+（${DIRECT_REASON}）}"
  fi
  fail "$1"
}

if [ "$ENGINE_PREF" = direct ]; then
  if deliver_direct ""; then record_delivered; exit 0; fi
  fail "直连模式发送失败${DIRECT_REASON:+（${DIRECT_REASON}）}"
fi

# The webhook path contains the build hash of the deployed workflow. If n8n still runs an older version, that path does
# not exist there (HTTP 404): nothing can be sent by a stale workflow.
EXPECT=""; [ -f "$BRIEF_HOME/workflows/BUILD" ] && EXPECT="$(tr -d '[:space:]' < "$BRIEF_HOME/workflows/BUILD")"
[ -n "$EXPECT" ] || unavailable "没有找到 workflows/BUILD（工作流没有部署好）"
WEBHOOK_URL="http://127.0.0.1:$N8N_PORT/webhook/morning-brief-$EXPECT"

REUSED=0
if curl -s -o /dev/null -m 3 "http://127.0.0.1:$N8N_PORT/healthz"; then
  [ -n "${BRIEF_REUSE_N8N:-}" ] || unavailable "端口 $N8N_PORT 已经被另一个程序（可能是你自己的 n8n）占用：请在设置里改 N8N_PORT，或先把它关掉"
  REUSED=1; log "reusing the n8n already running on port $N8N_PORT (BRIEF_REUSE_N8N)"
else
  log "starting n8n on port $N8N_PORT"
  n8n start >> "$LOG_DIR/n8n-run.log" 2>&1 &
  N8N_PID=$!; STARTED_BY_US=1; echo "$N8N_PID $(date +%s)" > "$N8N_PIDFILE"
fi
ENGINE=n8n

# n8n answers HTTP 200 "starting up" to everything until its database migrations have finished (for example on the first
# start after an upgrade), so wait for the readiness endpoint before sending the one real request. This applies to a
# freshly started n8n and to a reused one alike.
t=$(date +%s); RDEADLINE=$(( t + READY_TIMEOUT ))
until [ "$(curl -s -o /dev/null --connect-timeout 3 -m 5 -w '%{http_code}' "http://127.0.0.1:$N8N_PORT/healthz/readiness" 2>/dev/null)" = 200 ]; do
  [ "$STARTED_BY_US" = 1 ] && ! kill -0 "$N8N_PID" 2>/dev/null && unavailable "n8n 启动后意外退出（详见 logs/n8n-run.log）"
  [ "$(date +%s)" -lt "$RDEADLINE" ] || unavailable "等待 ${READY_TIMEOUT} 秒后 n8n 仍未就绪（数据库迁移可能还在进行）"
  sleep "$POLL"
done
T_READY=$(( $(date +%s) - t ))

# Two different waits, never confused with each other:
#  1. REGISTRATION: the webhook is not registered yet (HTTP 404) or n8n is not listening (connection refused). Only then is
#     the request repeated, for at most READY_TIMEOUT seconds; if it never registers, n8n cannot take the request at all.
#  2. EXECUTION: once n8n accepted the request the run is under way. It is sent exactly once and may take up to
#     EXEC_TIMEOUT; a timeout means the outcome is UNKNOWN, so nothing is sent again automatically.
log "triggering webhook (missed days: ${MISSED_DAYS:-none})"
RC=0; CODE=""; DEADLINE=$(( $(date +%s) + READY_TIMEOUT )); t=$(date +%s)
while :; do
  [ "$STARTED_BY_US" = 1 ] && ! kill -0 "$N8N_PID" 2>/dev/null && unavailable "n8n 启动后意外退出（详见 logs/n8n-run.log）"
  write_pending   # written BEFORE the request that may deliver the brief
  # Background + wait (see deliver_direct): a stop signal during the long wait must be handled immediately.
  ( { [ -n "${BRIEF_TOKEN:-}" ] && printf 'header = "x-brief-token: %s"\n' "$BRIEF_TOKEN"; true; } | curl -s -K - --connect-timeout 5 -m "$EXEC_TIMEOUT" -w '\n%{http_code} %{size_upload}' -X POST -H 'Content-Type: application/json' --data "$PAYLOAD" "$WEBHOOK_URL" 2>/dev/null ) > "$STATE_DIR/resp.$$" &
  CHILD_PID=$!; wait "$CHILD_PID"; RC=$?; CHILD_PID=""
  RESP="$(cat "$STATE_DIR/resp.$$" 2>/dev/null)"; rm -f "$STATE_DIR/resp.$$"
  LAST="${RESP##*$'\n'}"; BODY="${RESP%$'\n'*}"; CODE="${LAST%% *}"; SENT_BYTES=""; case "$LAST" in *' '*) SENT_BYTES="${LAST#* }" ;; esac
  # Was anything sent? Not registered yet (404), not listening (7), cannot resolve (6), or a timeout/error before a single
  # byte of the request went out: NOT ACCEPTED, safe to repeat. Anything else that is not a clean HTTP answer is UNKNOWN.
  if [ "$RC" = 0 ] && [ "$CODE" = 404 ]; then NOT_ACCEPTED=1
  elif [ "$RC" = 7 ] || [ "$RC" = 6 ]; then NOT_ACCEPTED=1
  elif [ "$RC" != 0 ] && [ "$SENT_BYTES" = 0 ]; then NOT_ACCEPTED=1
  else NOT_ACCEPTED=0; fi
  if [ "$NOT_ACCEPTED" = 1 ]; then [ "$MODE" = normal ] && rm -f "$PENDING"
  elif [ "$RC" != 0 ]; then
    T_EXEC=$(( $(date +%s) - t ))
    if [ "$RC" = 28 ]; then unknown_outcome "工作流执行超过 ${EXEC_TIMEOUT} 秒没有返回"; fi
    unknown_outcome "触发工作流时连接中断（curl 退出码 ${RC}）"
  else break
  fi
  [ "$(date +%s)" -lt "$DEADLINE" ] || unavailable "等待 ${READY_TIMEOUT} 秒后 Webhook 仍未注册（n8n 里可能没有期望的工作流版本 ${EXPECT}，请运行 deploy-workflow.sh）"
  sleep "$POLL"
done
T_EXEC=$(( $(date +%s) - t ))

# The workflow ends with the Send to Discord node's verdict: sent / not_sent / unknown. Anything else (HTTP 500, an
# unexpected body) means the workflow failed somewhere: if the send step had already recorded its attempt, the brief
# may be out, so that is UNKNOWN; otherwise the failure happened before sending and the day stays open.
# (n8n answers HTTP 500 to every workflow error, including a wrong token, so the cause has to be read from the log.)
WF_STATUS="$(printf '%s' "$BODY" | sed -n 's/.*"status":"\([a-z_]*\)".*/\1/p' | head -1)"
WF_REASON="$(printf '%s' "$BODY" | sed -n 's/.*"reason":"\([^"]*\)".*/\1/p' | head -1)"
if [ "$CODE" = 200 ] && [ "$WF_STATUS" = sent ]; then :
elif [ "$CODE" = 200 ] && [ "$WF_STATUS" = not_sent ]; then [ "$MODE" = normal ] && rm -f "$PENDING"; fail "Discord 没有接受简报（${WF_REASON:-原因不明}）"
elif [ "$WF_STATUS" = unknown ]; then unknown_outcome "发送给 Discord 时没有得到明确回答（${WF_REASON:-原因不明}）"
elif [ -f "$ATTEMPT" ]; then unknown_outcome "工作流在发送步骤开始之后出错（HTTP ${CODE}）"
elif [ "$CODE" = 500 ]; then [ "$MODE" = normal ] && rm -f "$PENDING"; fail "Webhook 返回 HTTP 500（工作流在发送之前出错；令牌不匹配也会是 500，详见 logs/n8n-run.log，必要时运行 deploy-workflow.sh）"
elif [ "$CODE" != 200 ]; then [ "$MODE" = normal ] && rm -f "$PENDING"; fail "Webhook 返回 HTTP $CODE"
else [ "$MODE" = normal ] && rm -f "$PENDING"; fail "工作流返回异常内容（发送步骤没有开始）"; fi

# The brief has been delivered: record that FIRST, so nothing below can ever cause a second delivery.
record_delivered
# The workflow also returns the build hash it ran. It cannot differ any more (the path carries it), but if it ever does
# the brief is already out, so report it once and do NOT retry.
printf '%s' "$BODY" | grep -q "\"build\":\"$EXPECT\"" || alert "简报已发出，但工作流返回的版本不是期望的 ${EXPECT}，请运行 deploy-workflow.sh 核对（已标记为已发送，不会重复发送）"
sleep "${BRIEF_GRACE:-3}"
stop_n8n

# ---------- housekeeping (n8n is stopped, so its database is ours alone) ----------
DB="$BRIEF_HOME/data/.n8n/database.sqlite"
if [ "$REUSED" = 1 ]; then log "an n8n we did not start is still running: its database is left alone"
elif [ -f "$DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  # n8n's own pruning timers never fire in a process that lives seconds. Even a successful run leaves a stub row that holds
  # the request headers (with the token); with EXECUTIONS_DATA_SAVE_ON_SUCCESS=none n8n leaves it as "running", not "success".
  # n8n is stopped and it was ours, so nothing can still be running: those rows go at once. Failed ones stay a few days.
  sqlite3 "$DB" "PRAGMA foreign_keys=ON; delete from execution_entity where status in ('success','running','new') or startedAt < datetime('now','-${BRIEF_EXEC_KEEP_DAYS:-3} days') or (status='running' and startedAt < datetime('now','-1 hour'));" >/dev/null 2>&1 || log "WARN: could not prune old n8n executions"
fi
exit 0   # (old markers and logs are tidied by cleanup)
