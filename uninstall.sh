#!/usr/bin/env bash
# Removes the daily job. Add --purge to also delete the runtime folder (n8n, Node, data, logs, config).
# Your ~/n8n-inbox folder and tasks.csv are never deleted.
set -u
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
export BRIEF_HOME="${BRIEF_HOME:-$HOME/.n8n-morning-brief}"
. "$SRC_DIR/scripts/lib-config.sh"
"$SRC_DIR/scripts/uninstall-launchd.sh"
if [ "${1:-}" = "--purge" ]; then
  runtime_check || exit 1                                   # only a folder this project created (marker file)
  case "$BRIEF_HOME" in "$HOME"|"$HOME"/|/|"") echo "Refusing to delete $BRIEF_HOME" >&2; exit 1 ;; esac
  printf '删除 %s 吗？（包括保存的 Discord / AI 设置、n8n 和日志）输入 yes 确认：' "$BRIEF_HOME"; read -r a
  [ "$a" = yes ] && { rm -rf "$BRIEF_HOME"; echo "已删除 ${BRIEF_HOME}"; } || echo "保留了 ${BRIEF_HOME}"
fi
echo "如果设置过定时唤醒：'sudo pmset repeat cancel' 会取消所有重复的开关机/唤醒规则，包括你为别的原因设的（先用 pmset -g sched 看一眼）。你的收件夹和 tasks.csv 不会被删除。"
