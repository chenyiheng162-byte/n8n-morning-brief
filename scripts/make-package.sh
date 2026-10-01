#!/usr/bin/env bash
# Builds the zip you can give to friends: dist/n8n-morning-brief-<commit>.zip
# Only COMMITTED files go in (git archive), so nothing half-edited, no runtime folder and no settings file can slip in.
# The review notes are left out. Before zipping, the package is scanned for secrets and personal details: the real values
# in your own config.local.env (if there is one), anything that looks like a webhook / API key / private calendar link,
# your home folder path, user name and git e-mail. Any hit stops the script and nothing is written.
# Usage: scripts/make-package.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
command -v git >/dev/null && git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "需要在项目的 git 仓库里运行。" >&2; exit 1; }
[ -z "$(git status --porcelain -- .)" ] || { echo "这个项目有没提交的修改，包里只会有已提交的内容：请先提交。" >&2; git status --short -- . >&2; exit 1; }
REV="$(git rev-parse --short HEAD)"
OUT="$HERE/dist"; NAME="n8n-morning-brief"; ZIP="$OUT/$NAME-$REV.zip"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/brief-pkg.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/$NAME"
git archive --format=tar HEAD -- . | tar -x -C "$WORK/$NAME"   # (run from this folder, the paths are relative to it)
rm -f "$WORK/$NAME/REVIEW.md" "$WORK/$NAME/REVIEW-HISTORY.md" "$WORK/$NAME/.gitignore"
printf '%s\n' "$REV" > "$WORK/$NAME/VERSION"
[ -f "$WORK/$NAME/install.sh" ] && [ -f "$WORK/$NAME/安装说明.md" ] || { echo "包里缺少 install.sh 或 安装说明.md。" >&2; exit 1; }

# ---------- scan ----------
hits=0; checked=0
hit() { echo "  ✗ $1" >&2; hits=$((hits + 1)); }
CFG="${BRIEF_HOME:-$HOME/.n8n-morning-brief}/config.local.env"
if [ -f "$CFG" ]; then
  while IFS= read -r v; do
    [ "${#v}" -ge 8 ] || continue; checked=$((checked + 1))
    grep -rqF -- "$v" "$WORK" && hit "包里出现了你 config.local.env 里的一个真实值（不打印它）"
  done < <(grep -E '^(export )?(DISCORD_WEBHOOK_URL|ICS_URLS|AI_API_KEY|BRIEF_TOKEN)=' "$CFG" | sed -E "s/^(export )?[A-Z_]+=//; s/^['\"]//; s/['\"]\$//" | tr ' ' '\n')
fi
for pat in 'discord(app)?\.com/api/webhooks/[0-9]{15,}/' 'sk-[A-Za-z0-9]{24,}' 'calendar/ical/[^/ ]+/private-[0-9a-f]{16,}'; do
  f="$(grep -rlE --exclude=package-lock.json -- "$pat" "$WORK" || true)"; [ -z "$f" ] || hit "看起来像真实密钥（${pat}）：${f//$WORK\//}"
done
for word in "$HOME" "$(id -un)" "$(git config user.email 2>/dev/null || true)"; do
  [ -n "$word" ] || continue
  f="$(grep -rlF -- "$word" "$WORK" || true)"; [ -z "$f" ] || hit "包里有个人信息（主目录、用户名或邮箱）：${f//$WORK\//}"
done
if [ "$hits" != 0 ]; then echo "发现 ${hits} 处问题，没有生成安装包。" >&2; exit 1; fi

mkdir -p "$OUT"; rm -f "$ZIP"
(cd "$WORK" && COPYFILE_DISABLE=1 zip -qrX "$ZIP" "$NAME")
echo "安装包：${ZIP}（$(du -h "$ZIP" | cut -f1)，$(unzip -l "$ZIP" | tail -1 | awk '{print $2}') 个文件，版本 ${REV}）"
echo "检查通过：对照了 config.local.env 里的 ${checked} 个真实值、密钥样式、主目录、用户名和邮箱。"
echo "朋友收到后：解压，双击「双击安装.command」（第一次要在「系统设置 → 隐私与安全性」点「仍要打开」）；或者用一行命令安装，见 安装说明.md。"
