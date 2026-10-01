#!/usr/bin/env bash
# Stores an OpenAI-compatible chat API (default: DeepSeek) in config.local.env, then lists the
# available models so you can pick one. The key is entered hidden and never printed.
# A local model (http://127.0.0.1:... or http://localhost:...) is allowed and needs no key.
set -euo pipefail
. "$(dirname "$0")/env.sh"; . "$(dirname "$0")/lib-config.sh"
DEFAULT_BASE="https://api.deepseek.com"
printf "接口地址 [%s]：" "$DEFAULT_BASE"; read -r base; base="${base:-$DEFAULT_BASE}"; base="${base%/}"
case "$base" in
  https://*|http://127.0.0.1|http://127.0.0.1:*|http://localhost|http://localhost:*) ;;
  *) echo "接口地址要以 https:// 开头（http:// 只允许用于本机上的模型）。" >&2; exit 1 ;;
esac
printf "API 密钥（输入时不显示；本机模型留空），然后按回车："; read -rs key; echo

echo "正在用密钥查询可用模型……"
resp="$({ printf 'url = "%s/models"\n' "$base"; [ -n "$key" ] && printf 'header = "Authorization: Bearer %s"\n' "$key"; true; } | curl -s -m 30 -K - -w '\n%{http_code}')" || true
code="${resp##*$'\n'}"; body="${resp%$'\n'*}"
if [ "$code" != "200" ]; then echo "接口返回 HTTP ${code}：密钥或地址可能不对。没有保存。" >&2; exit 1; fi
models="$(printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(((JSON.parse(d).data)||[]).map(m=>m.id).join("\n")))')"
echo "可用的模型："; printf '%s\n' "$models" | sed 's/^/  - /'
first="$(printf '%s\n' "$models" | head -1)"
printf "使用哪个模型 [%s]：" "$first"; read -r model; model="${model:-$first}"
printf '%s\n' "$models" | grep -qx "$model" || { echo "「${model}」不在列表里。没有保存。" >&2; exit 1; }

config_set AI_BASE_URL "$base"; config_set AI_MODEL "$model"; config_set AI_API_KEY "$key"
echo "已保存 AI 设置（模型：${model}）到 ${BRIEF_HOME}/config.local.env（权限 600）。"
