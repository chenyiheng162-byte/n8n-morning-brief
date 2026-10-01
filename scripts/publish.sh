#!/usr/bin/env bash
# Publishes the friend package to the public GitHub repository that the one-line install (get.sh) downloads from.
# The content is exactly the zip of make-package.sh (committed files only, no review notes, scanned for secrets and
# personal details); it lands in the repository as one commit "release <commit>".
# The commits are made with GitHub's private "noreply" address, never the e-mail of this computer's git settings.
# Usage: scripts/publish.sh            (needs the GitHub command line tool `gh`, logged in)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="${BRIEF_PUBLIC_REPO:-chenyiheng162-byte/n8n-morning-brief}"
command -v gh >/dev/null || { echo "需要 GitHub 命令行工具 gh（brew install gh，然后 gh auth login）。" >&2; exit 1; }
"$HERE/scripts/make-package.sh"
REV="$(git -C "$HERE" rev-parse --short HEAD)"; ZIP="$HERE/dist/n8n-morning-brief-$REV.zip"
[ -f "$ZIP" ] || { echo "找不到 ${ZIP}" >&2; exit 1; }
CLONE="$HERE/dist/public-repo"
if [ ! -d "$CLONE/.git" ]; then rm -rf "$CLONE"; gh repo clone "$REPO" "$CLONE" -- --quiet; fi
LOGIN="$(gh api user --jq .login)"; ID="$(gh api user --jq .id)"
git -C "$CLONE" config user.name "$LOGIN"; git -C "$CLONE" config user.email "$ID+$LOGIN@users.noreply.github.com"
git -C "$CLONE" fetch --quiet origin 2>/dev/null || true
if git -C "$CLONE" rev-parse --verify --quiet origin/main >/dev/null; then git -C "$CLONE" checkout --quiet -B main origin/main; else git -C "$CLONE" checkout --quiet -B main; fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/brief-pub.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
unzip -q "$ZIP" -d "$WORK"
rsync -a --delete --exclude .git "$WORK/n8n-morning-brief/" "$CLONE/"
git -C "$CLONE" add -A
if git -C "$CLONE" diff --cached --quiet; then echo "公开仓库已经是这个版本（${REV}），没有改动。"; exit 0; fi
git -C "$CLONE" commit --quiet -m "release $REV"
git -C "$CLONE" push --quiet -u origin main
echo "已发布 ${REV} 到 https://github.com/${REPO}"
echo "朋友安装：curl -fsSL https://raw.githubusercontent.com/${REPO}/main/get.sh | bash"
