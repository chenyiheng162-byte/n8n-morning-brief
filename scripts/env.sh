# Sourced (by bash) from the other scripts. All runtime state lives in BRIEF_HOME, deliberately outside
# ~/Documents: launchd-spawned processes are blocked by macOS privacy protection there.
[ -n "${BASH_VERSION:-}" ] || { echo "scripts/env.sh must be sourced from bash" >&2; return 1 2>/dev/null || exit 1; }
BRIEF_HOME="${BRIEF_HOME:-$HOME/.n8n-morning-brief}"
export BRIEF_HOME
export PATH="$BRIEF_HOME/.runtime/node/bin:$BRIEF_HOME/node_modules/.bin:$PATH"
export N8N_USER_FOLDER="$BRIEF_HOME/data"
export N8N_DIAGNOSTICS_ENABLED=false
export N8N_VERSION_NOTIFICATIONS_ENABLED=false
export N8N_HOST=127.0.0.1
export N8N_LISTEN_ADDRESS=127.0.0.1
# Libraries the workflow Code nodes may require().
export NODE_FUNCTION_ALLOW_BUILTIN=fs,path,os,crypto
export NODE_FUNCTION_ALLOW_EXTERNAL=ical.js
# Workflows read secrets such as DISCORD_WEBHOOK_URL via $env; keeps them out of workflow JSON.
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false

# ---- settings file: parsed strictly, never executed ----------------------------------------------------------------
# config.local.env used to be `source`d, so a typo (an unbalanced quote, a stray command) either erased every setting or
# ran as a command. Now only KEY='value' lines (also KEY="value" and simple unquoted values, which older versions wrote)
# with a known key prefix are accepted. Any other line is skipped and its NUMBER is listed in BRIEF_CONFIG_ERRORS, which
# run-brief.sh and status.sh report; the remaining settings still load.
BRIEF_CONFIG_ERRORS=""
if [ -f "$BRIEF_HOME/config.local.env" ]; then
  _re_single="^([A-Za-z_][A-Za-z0-9_]*)='([^']*)'\$"
  _re_double='^([A-Za-z_][A-Za-z0-9_]*)="(([^"$`\\]|\\[^"$`\\])*)"$'
  _re_bare='^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:@%+,=?-]*)$'
  _n=0
  while IFS= read -r _line || [ -n "$_line" ]; do
    _n=$((_n + 1)); _line="${_line%$'\r'}"; _line="${_line#export }"
    case "$_line" in ''|'#'*|[[:space:]]*'#'*) continue ;; esac
    if   [[ $_line =~ $_re_single ]]; then _k="${BASH_REMATCH[1]}"; _v="${BASH_REMATCH[2]}"
    elif [[ $_line =~ $_re_double ]]; then _k="${BASH_REMATCH[1]}"; _v="${BASH_REMATCH[2]}"
    elif [[ $_line =~ $_re_bare ]];   then _k="${BASH_REMATCH[1]}"; _v="${BASH_REMATCH[2]}"
    else BRIEF_CONFIG_ERRORS="${BRIEF_CONFIG_ERRORS:+$BRIEF_CONFIG_ERRORS,}$_n"; continue; fi
    case "$_k" in   # a settings file may not set PATH, LD_*, BASH_ENV and friends
      BRIEF_HOME|BRIEF_STATE_DIR) BRIEF_CONFIG_ERRORS="${BRIEF_CONFIG_ERRORS:+$BRIEF_CONFIG_ERRORS,}$_n" ;;   # where the files live is not a setting: every tool must agree on it
      DISCORD_WEBHOOK_URL|ICS_URLS|AI_*|BRIEF_*|N8N_*|EXECUTIONS_*) export "$_k=$_v" ;;
      *) BRIEF_CONFIG_ERRORS="${BRIEF_CONFIG_ERRORS:+$BRIEF_CONFIG_ERRORS,}$_n" ;;
    esac
  done < "$BRIEF_HOME/config.local.env"
  unset _re_single _re_double _re_bare _n _line _k _v
fi
export BRIEF_CONFIG_ERRORS

# ---- port: an uncommon default so it does not collide with an n8n you may already run ---------------------------------
case "${N8N_PORT:-}" in ''|*[!0-9]*) [ -z "${N8N_PORT:-}" ] || BRIEF_CONFIG_ERRORS="${BRIEF_CONFIG_ERRORS:+$BRIEF_CONFIG_ERRORS,}N8N_PORT"; N8N_PORT=5690 ;; esac
export N8N_PORT
# n8n's task runner opens a SECOND port (default 5679), which would collide with another n8n on this Mac as well.
export N8N_RUNNERS_BROKER_PORT="${N8N_RUNNERS_BROKER_PORT:-$((N8N_PORT + 1))}"

# ---- timezone: BRIEF_TZ from the settings (or the environment), else the system zone; validated so a typo cannot ---------
# make `date` misbehave. Derived AFTER the settings are loaded so the calendar's "today", the shell's date markers and
# n8n's own clock always agree.
_sys_tz="$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')"
if [ -n "${BRIEF_TZ:-}" ] && [ ! -e "/usr/share/zoneinfo/$BRIEF_TZ" ]; then BRIEF_TZ_INVALID="$BRIEF_TZ"; BRIEF_TZ=""; fi
BRIEF_TZ="${BRIEF_TZ:-$_sys_tz}"
unset _sys_tz
export BRIEF_TZ TZ="$BRIEF_TZ" GENERIC_TIMEZONE="$BRIEF_TZ" BRIEF_TZ_INVALID="${BRIEF_TZ_INVALID:-}"

# n8n lives for seconds, so its built-in pruning timers never fire: do not keep successful executions at all
# (they would hold your schedule forever). Failed ones are kept for troubleshooting and pruned by run-brief.sh.
export EXECUTIONS_DATA_SAVE_ON_SUCCESS="${EXECUTIONS_DATA_SAVE_ON_SUCCESS:-none}"
# (a whole number of days: run-brief.sh puts it into an SQL statement, so anything else falls back to 3 and is reported)
case "${BRIEF_EXEC_KEEP_DAYS:-}" in ''|*[!0-9]*) [ -z "${BRIEF_EXEC_KEEP_DAYS:-}" ] || BRIEF_CONFIG_ERRORS="${BRIEF_CONFIG_ERRORS:+$BRIEF_CONFIG_ERRORS,}BRIEF_EXEC_KEEP_DAYS"; BRIEF_EXEC_KEEP_DAYS=3 ;; esac
export BRIEF_EXEC_KEEP_DAYS BRIEF_CONFIG_ERRORS
# The ingest step may run several AI calls; keep n8n's own Code-node timeout above our budget.
export N8N_RUNNERS_TASK_TIMEOUT="${N8N_RUNNERS_TASK_TIMEOUT:-600}"
