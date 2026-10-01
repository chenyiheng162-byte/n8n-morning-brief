#!/usr/bin/env bash
# One screen that answers "is the morning brief healthy?": what is installed, what ran last, what needs attention.
# Makes no network calls unless you pass --check-net, and never prints a secret (only the NAMES of settings).
# Usage: status.sh [--check-net]      Exit code: 0 = nothing needs attention, 1 = at least one thing does.
. "$(dirname "$0")/env.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
STATE="${BRIEF_STATE_DIR:-$BRIEF_HOME/data/state}"; LABEL="${BRIEF_LABEL:-com.cc-workspace.n8n-morning-brief}"; TODAY="$(date +%F)"
PROBLEMS=0
ok()   { printf '  ✅ %s\n' "$*"; }
warn() { printf '  ⚠️  %s\n' "$*"; PROBLEMS=$((PROBLEMS + 1)); }
info() { printf '     %s\n' "$*"; }
age() { local s=$(( $(date +%s) - $1 )); if [ "$s" -lt 120 ]; then echo "${s} 秒前"; elif [ "$s" -lt 7200 ]; then echo "$((s / 60)) 分钟前"; elif [ "$s" -lt 172800 ]; then echo "$((s / 3600)) 小时前"; else echo "$((s / 86400)) 天前"; fi; }

echo "每日简报状态 · $(date '+%F %T') · 运行目录 $BRIEF_HOME"
echo
echo "安装"
[ -f "$BRIEF_HOME/.n8n-morning-brief-runtime" ] && ok "运行目录有标志文件" || warn "运行目录没有标志文件（不是由 install.sh 创建的？）"
want="$(cat "$BRIEF_HOME/workflows/BUILD" 2>/dev/null | tr -d '[:space:]')"
if [ -z "$want" ]; then warn "没有 workflows/BUILD：工作流还没有部署（运行 deploy-workflow.sh）"
else
  have="$(awk -F'[= ]' '{for(i=1;i<=NF;i++) if($i=="n8n") print $(i+1)}' "$BRIEF_HOME/workflows/DEPLOYED" 2>/dev/null)"
  ok "工作流版本 ${want}（$(sed -n 's/.*deployed=\(.*\)/\1/p' "$BRIEF_HOME/workflows/DEPLOYED" 2>/dev/null)）"
  if [ -f "$HERE/../workflows/BUILD" ] && [ "$(tr -d '[:space:]' < "$HERE/../workflows/BUILD")" != "$want" ]; then warn "源码里的版本（$(tr -d '[:space:]' < "$HERE/../workflows/BUILD")）和已部署的不同：运行 deploy-workflow.sh"; fi
fi
nv="$(n8n --version 2>/dev/null | tail -1)"; exp="$(node -e "try{console.log(require(process.argv[1]).dependencies.n8n)}catch(e){}" "$BRIEF_HOME/package.json" 2>/dev/null)"
[ -n "$nv" ] && { [ "$nv" = "$exp" ] && ok "n8n ${nv}（和测试过的版本一致）" || warn "n8n 是 ${nv}，测试过的是 ${exp}（部署脚本会拒绝修改内部表）"; } || warn "找不到 n8n"
# (BRIEF_CONFIG_ERRORS lists line numbers of lines that were skipped, and names of settings whose value was invalid)
cfg_lines="$(printf '%s' "${BRIEF_CONFIG_ERRORS:-}" | tr ',' '\n' | grep -E '^[0-9]+$' | paste -s -d , -)"
cfg_names="$(printf '%s' "${BRIEF_CONFIG_ERRORS:-}" | tr ',' '\n' | grep -vE '^[0-9]+$' | grep . | paste -s -d , -)"
[ -n "$cfg_lines" ] && warn "config.local.env 里有看不懂的行：第 ${cfg_lines} 行（已跳过；格式应为 KEY='值'）"
[ -n "$cfg_names" ] && warn "这些设置的值无效，已改用默认值：${cfg_names}"
[ -n "${BRIEF_TZ_INVALID:-}" ] && warn "BRIEF_TZ「${BRIEF_TZ_INVALID}」不是有效时区，正在使用 ${BRIEF_TZ}"
keys="$(sed -n "s/^\(export \)\{0,1\}\([A-Z_][A-Z0-9_]*\)=.*/\2/p" "$BRIEF_HOME/config.local.env" 2>/dev/null | tr '\n' ' ')"
info "设置项（只列名字）：${keys:-（无）}"
# the value as the strict loader understood it (a key that is present but empty, or skipped as unreadable, is as good as missing)
if [ -z "${DISCORD_WEBHOOK_URL:-}" ]; then warn "DISCORD_WEBHOOK_URL 没有值（没写、写成空、或那一行没被读懂）：简报发不出去，运行 ./scripts/set-discord-webhook.sh"
else case "$DISCORD_WEBHOOK_URL" in https://*|http://127.0.0.1*|http://localhost*) ok "已配置 Discord Webhook" ;; *) warn "DISCORD_WEBHOOK_URL 不是 http(s) 地址，看起来不对" ;; esac; fi
if [ -n "${ICS_URLS:-}" ]; then
  ics_list="$(printf '%s' "$ICS_URLS" | tr -s ' \t' '\n\n')"; n_ics="$(printf '%s\n' "$ics_list" | grep -c .)"; n_uniq="$(printf '%s\n' "$ics_list" | sort -u | grep -c .)"
  if [ "$n_ics" != "$n_uniq" ]; then info "ICS_URLS 里有 $((n_ics - n_uniq)) 个重复的链接（每个只会读一次）；想接多个不同的日历，请运行 ./scripts/set-calendar-urls.sh"; else ok "日历链接 ${n_uniq} 个"; fi
fi
# scripts in the runtime folder older than the source (only checkable when this script runs from the source folder)
if [ -d "$HERE/../workflows/src" ] && [ -d "$BRIEF_HOME/scripts" ] && [ "$(cd "$HERE" && pwd -P)" != "$(cd "$BRIEF_HOME/scripts" && pwd -P)" ]; then
  stale="$(for f in "$HERE"/*.sh "$HERE"/*.mjs; do b="$(basename "$f")"; cmp -s "$f" "$BRIEF_HOME/scripts/$b" || printf '%s ' "$b"; done)"
  [ -z "$stale" ] && ok "运行目录里的脚本和源码一致" || warn "运行目录里这些脚本和源码不一致：${stale}（运行 ./scripts/install-launchd.sh 同步）"
fi
case " $keys " in *" ICS_URLS "*) ;; *) info "没有配置日历链接（ICS_URLS），简报里不会有日程" ;; esac
case " $keys " in *" AI_BASE_URL "*) ;; *) info "没有配置 AI，放进收件夹的文件不会被读取" ;; esac
perm="$(stat -f '%Lp' "$BRIEF_HOME" 2>/dev/null)"; [ "$perm" = 700 ] && ok "运行目录权限 700" || info "运行目录权限是 ${perm:-?}（下一次运行会改成 700）"
echo
echo "定时"
if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  ok "定时任务已加载（${LABEL}）"
  slots="$(plutil -p "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null | awk '/"Hour"/{h=$3} /"Minute"/{printf "%02d:%02d ", h, $3}')"
  info "每天 ${slots:-?}（后面几个是重试时间点，成功后会自动跳过）"
else warn "定时任务没有加载：运行 ./scripts/install-launchd.sh"; fi
systz="$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')"
[ -n "$systz" ] && [ "$systz" != "$BRIEF_TZ" ] && warn "定时任务按系统时区（${systz}）触发，而简报里的「今天」按 BRIEF_TZ（${BRIEF_TZ}）：两者不同时，简报可能属于另一天"
wake="$(pmset -g sched 2>/dev/null | grep -iE 'wake|poweron' | head -2 | tr -s ' ' | tr '\n' ';')"
[ -n "$wake" ] && ok "唤醒计划：$wake" || info "没有设置定时唤醒：Mac 睡着时，简报要等你唤醒电脑后才补发"
echo
echo "今天（${TODAY}）"
if [ -f "$STATE/sent-$TODAY" ]; then ok "今天的简报已发送（$(age "$(stat -f %m "$STATE/sent-$TODAY")")）"
elif [ -f "$STATE/pending-$TODAY" ]; then warn "今天有一次发送状态不明（$(cat "$STATE/pending-$TODAY")）：没收到的话运行 run-brief.sh --force"
else info "今天还没有发送（下一个定时点会发送）"; fi
[ -f "$STATE/alerts-$TODAY" ] && warn "今天已发出 $(cat "$STATE/alerts-$TODAY") 条报警"
if [ -f "$STATE/last-run.json" ]; then
  lr() { sed -n "s/.*\"$1\":\"\{0,1\}\([^\",}]*\).*/\1/p" "$STATE/last-run.json" | head -1; }
  started="$(lr started)"; res="$(lr result)"
  line="最近一次运行：$( [ -n "$started" ] && age "$started") · 模式 $(lr mode) · 引擎 $(lr engine) · 结果 $res · 用时 $(lr seconds) 秒"
  [ "$res" = ok ] && ok "$line" || { [ "$res" = skipped ] && info "$line" || warn "${line}（原因：$(lr reason)）"; }
  info "日程 $(lr events) · 进行中任务 $(lr tasks) · 新任务 $(lr newTasks) · AI 调用 $(lr aiCalls) 次 · 读日历 $(lr calendarMs) ms · 入库 $(lr ingestMs) ms · 等网络 $(lr waitNetSec)s · 等 n8n $(lr waitReadySec)s · 执行 $(lr execSec)s"
else info "还没有运行记录"; fi
days="$(ls "$STATE" 2>/dev/null | sed -n 's/^sent-//p' | sort | tail -7 | tr '\n' ' ')"; info "最近发送的日期：${days:-（无）}"
echo
echo "进程与锁"
. "$HERE/lock.sh"
if lock_busy "$STATE/run.lockf"; then info "运行锁正被占用（$(awk '{print "pid "$1" · "$3}' "$STATE/run.lockf" 2>/dev/null)）：有一次运行、部署或控制台操作正在进行"
else ok "运行锁空闲（它是系统级的锁，进程一结束就自动释放，不会残留）"; fi
if [ -f "$STATE/n8n.pid" ]; then p="$(awk '{print $1}' "$STATE/n8n.pid")"; kill -0 "$p" 2>/dev/null && info "n8n 正在运行（pid ${p}，应该只在运行简报的几十秒内出现）" || warn "记录了 n8n 的进程号但它已不存在：下一次运行会清理"; fi
curl -s -o /dev/null -m 2 "http://127.0.0.1:$N8N_PORT/healthz" && info "端口 $N8N_PORT 现在有程序在回应" || ok "端口 $N8N_PORT 空闲（n8n 没有常驻，这是正常的）"
echo
echo "收件夹"
node "$HERE/inbox-tool.mjs" status 2>&1 | sed 's/^/  /' | head -25
echo
echo "数据"
DB="$BRIEF_HOME/data/.n8n/database.sqlite"
if [ -f "$DB" ]; then
  n="$(sqlite3 -readonly "$DB" 'select count(*) from execution_entity;' 2>/dev/null)"; sz="$(du -sh "$DB" 2>/dev/null | cut -f1)"
  info "n8n 执行记录 ${n:-?} 条，数据库 ${sz}（每次运行会清理 ${BRIEF_EXEC_KEEP_DAYS} 天前的）"
  dperm="$(stat -f '%Lp' "$DB" 2>/dev/null)"; [ "$dperm" = 600 ] || info "数据库权限是 ${dperm}（下一次运行会改成 600）"
fi
info "运行目录总大小 $(du -sh "$BRIEF_HOME" 2>/dev/null | cut -f1)"
if [ "${1:-}" = "--check-net" ]; then
  echo; echo "网络（--check-net）"
  curl -s -o /dev/null -m 8 https://discord.com && ok "能连上 discord.com" || warn "连不上 discord.com"
  if [ -n "${AI_BASE_URL:-}" ]; then ai_host="${AI_BASE_URL#*://}"; ai_host="${ai_host%%/*}"; curl -s -o /dev/null -m 8 "$AI_BASE_URL" && ok "能连上 AI 服务（${ai_host}）" || warn "连不上 AI 服务（${ai_host}）"; fi
fi
echo
if [ "$PROBLEMS" = 0 ]; then echo "一切正常。"; exit 0; else echo "有 $PROBLEMS 项需要留意（上面带 ⚠️ 的）。"; exit 1; fi
