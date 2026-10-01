#!/usr/bin/env bash
# Prompts (hidden input) for one or more calendar .ics URLs and stores them as ICS_URLS.
# Each URL is a read-only secret link; it is never printed. Enter an empty line to finish.
set -euo pipefail
. "$(dirname "$0")/env.sh"; . "$(dirname "$0")/lib-config.sh"
urls=()
while :; do
  printf "粘贴第 %d 个日历 .ics 链接（输入时不显示；直接回车表示结束）：" $((${#urls[@]}+1))
  read -rs u; echo
  [ -z "$u" ] && break
  case "$u" in
    https://*) urls+=("$u") ;;
    webcal://*) urls+=("https://${u#webcal://}") ;;
    *) echo "不是 https://（或 webcal://）链接，跳过。" >&2 ;;
  esac
done
[ "${#urls[@]}" -gt 0 ] || { echo "没有输入链接，没有保存。" >&2; exit 1; }
config_set ICS_URLS "${urls[*]}"
echo "已保存 ${#urls[@]} 个日历链接到 ${BRIEF_HOME}/config.local.env（权限 600）。"
