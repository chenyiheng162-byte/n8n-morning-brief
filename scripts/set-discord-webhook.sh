#!/usr/bin/env bash
# Prompts (hidden input) for the Discord webhook URL and stores it in config.local.env.
set -euo pipefail
. "$(dirname "$0")/env.sh"; . "$(dirname "$0")/lib-config.sh"
printf "粘贴 Discord Webhook URL（输入时不显示），然后按回车："
read -rs url; echo
case "$url" in
  https://discord.com/api/webhooks/*|https://discordapp.com/api/webhooks/*) ;;
  *) echo "这看起来不是 Discord Webhook 地址（应以 https://discord.com/api/webhooks/ 开头）。没有保存。" >&2; exit 1 ;;
esac
config_set DISCORD_WEBHOOK_URL "$url"
echo "已保存到 ${BRIEF_HOME}/config.local.env（权限 600）。"
