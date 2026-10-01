#!/usr/bin/env bash
# One-command installer for macOS.  Usage:  ./install.sh [--terminal | --yes] [--no-schedule] [--no-test-run] [--no-console]
#   (default)      installs without asking anything, then opens the console in the browser, where a setup wizard asks for
#                  the Discord webhook, calendars, AI and the time
#   --terminal     ask those questions here in the terminal instead (hidden input), as older versions did
#   --yes          non-interactive: read answers from environment variables (see below)
#   --no-schedule  do not install the daily launchd job
#   --no-test-run  do not run the brief once at the end (it only runs when a webhook is already set)
#   --no-console   do not open the console at the end
# Environment (also used by --yes): BRIEF_HOME, BRIEF_TIME (HH:MM, default 08:00), DISCORD_WEBHOOK_URL,
#   ICS_URLS (space separated), AI_BASE_URL, AI_MODEL, AI_API_KEY, BRIEF_BASE_DATE, BRIEF_IGNORE, N8N_PORT, BRIEF_INBOX
# Values passed explicitly always win over what is already saved in an existing installation.
set -euo pipefail
umask 077   # everything this script creates is private to the current user

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
# some ways of copying a zip lose the executable bit (only then: never touch the modes of a source checkout)
[ -x "$SRC_DIR/scripts/deploy-workflow.sh" ] || chmod u+x "$SRC_DIR"/*.sh "$SRC_DIR"/scripts/*.sh 2>/dev/null || true
NODE_VERSION="v24.21.0"   # n8n 2.x needs Node >= 24
# SHA-256 of the official tarballs, pinned here so the download is not trusted just because it matches a
# checksum file fetched from the same server (values taken from https://nodejs.org/dist/v24.21.0/SHASUMS256.txt).
NODE_SHA256_ARM64="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"
NODE_SHA256_X64="1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"
YES=0; TERMINAL=0; SCHEDULE=1; TEST_RUN=1; CONSOLE=1
for a in "$@"; do case "$a" in --yes) YES=1 ;; --terminal) TERMINAL=1 ;; --no-schedule) SCHEDULE=0 ;; --no-test-run) TEST_RUN=0 ;; --no-console) CONSOLE=0 ;; -h|--help) sed -n '2,13p' "$0"; exit 0 ;; *) echo "不认识的选项：$a" >&2; exit 1 ;; esac; done

# Capture what the caller passed BEFORE any existing config is loaded (loading it would overwrite these variables).
IN_DISCORD="${DISCORD_WEBHOOK_URL-}"; IN_ICS="${ICS_URLS-}"; IN_AI_BASE="${AI_BASE_URL-}"; IN_AI_MODEL="${AI_MODEL-}"
IN_AI_KEY="${AI_API_KEY-}"; IN_BASE_DATE="${BRIEF_BASE_DATE-}"; IN_IGNORE="${BRIEF_IGNORE-}"; IN_TIME="${BRIEF_TIME-}"
IN_PORT="${N8N_PORT-}"; IN_INBOX="${BRIEF_INBOX-}"
unset DISCORD_WEBHOOK_URL ICS_URLS AI_BASE_URL AI_MODEL AI_API_KEY BRIEF_BASE_DATE BRIEF_IGNORE N8N_PORT BRIEF_INBOX

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ask() { local prompt="$1" def="${2:-}" v; if [ "$YES" = 1 ]; then echo "$def"; return; fi
        if [ -n "$def" ]; then printf '%s [%s]：' "$prompt" "$def" >&2; else printf '%s：' "$prompt" >&2; fi
        read -r v; echo "${v:-$def}"; }

# ---------- 1. preflight ----------
say "检查这台 Mac"
[ "$(uname -s)" = "Darwin" ] || { echo "只支持 macOS（定时任务用的是 launchd 和 pmset）。" >&2; exit 1; }
for tool in curl tar shasum rsync sqlite3 mktemp; do command -v "$tool" >/dev/null || { echo "缺少系统工具：${tool}" >&2; exit 1; }; done
case "$(uname -m)" in arm64) PLATFORM=darwin-arm64; NODE_SHA256="$NODE_SHA256_ARM64" ;; x86_64) PLATFORM=darwin-x64; NODE_SHA256="$NODE_SHA256_X64" ;; *) echo "不支持的处理器：$(uname -m)" >&2; exit 1 ;; esac
export BRIEF_HOME="${BRIEF_HOME:-$HOME/.n8n-morning-brief}"
case "$SRC_DIR" in "$BRIEF_HOME"|"$BRIEF_HOME"/*) echo "请在下载解压出来的文件夹里运行 install.sh，不要在 ${BRIEF_HOME} 里运行。" >&2; exit 1 ;; esac
VOL="$BRIEF_HOME"; while [ ! -d "$VOL" ]; do VOL="$(dirname "$VOL")"; done   # the nearest folder that exists: check the disk that will really hold the runtime
FREE_GB=$(df -g "$VOL" | awk 'NR==2{print $4}'); [ "${FREE_GB:-0}" -ge 5 ] || { echo "需要大约 5 GB 空闲磁盘空间（现在只有 ${FREE_GB:-?} GB）。" >&2; exit 1; }
# in the default (browser) mode the time is chosen in the setup wizard; 08:00 until then
if [ "$TERMINAL" = 1 ]; then BRIEF_TIME="${IN_TIME:-$(ask '每天几点收到简报？（24 小时制 HH:MM）' 08:00)}"; else BRIEF_TIME="${IN_TIME:-08:00}"; fi
case "$BRIEF_TIME" in [0-2][0-9]:[0-5][0-9]) [ "$((10#${BRIEF_TIME%%:*}))" -le 23 ] || { echo "小时要在 00–23 之间。" >&2; exit 1; } ;; *) echo "时间要写成 08:00 这样。" >&2; exit 1 ;; esac
. "$SRC_DIR/scripts/lib-config.sh"
if ! runtime_claimable; then
  echo "${BRIEF_HOME} 已经存在，而且不是本项目创建的（was not created by this project：没有 ${RUNTIME_MARKER}，也没有本项目的 run-brief.sh）。请换一个 BRIEF_HOME；什么都没有改动。" >&2; exit 1
fi
# n8n's database library (sqlite3) has no prebuilt binary that installs here, so npm compiles it on this Mac: that needs
# Apple's command line developer tools. Check BEFORE downloading anything, and only when the libraries still need installing.
if ! { [ -x "$BRIEF_HOME/node_modules/.bin/n8n" ] && cmp -s "$SRC_DIR/package-lock.json" "$BRIEF_HOME/package-lock.json"; } \
   && ! { d="$(xcode-select -p 2>/dev/null)" && [ -d "$d" ]; }; then
  echo "需要先安装 Apple 的「命令行开发者工具」：安装 n8n 时要在这台 Mac 上编译一个数据库组件。" >&2
  echo "马上会弹出苹果的安装窗口，点「安装」，等它装完（通常 5–15 分钟），然后重新运行同一条安装命令（或者再双击一次「双击安装」）。什么都还没有改动。" >&2
  echo "（没有弹出的话，在终端运行：xcode-select --install）" >&2
  xcode-select --install >/dev/null 2>&1 || true
  exit 1
fi
echo "运行目录：${BRIEF_HOME}（故意放在「文稿」之外：macOS 不允许定时任务读取那里）"
mkdir -p "$BRIEF_HOME/logs"; runtime_mark

# ---------- 2. Node (project-local, verified) ----------
if [ "$("$BRIEF_HOME/.runtime/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  say "下载 Node ${NODE_VERSION}（只给本项目用，不影响系统里别的 Node）"
  F="node-$NODE_VERSION-$PLATFORM.tar.gz"; TMP="$BRIEF_HOME/.runtime/tmp"; rm -rf "$TMP"; mkdir -p "$TMP"
  curl -fsSL --retry 4 --retry-delay 3 --connect-timeout 20 --max-time 600 -o "$TMP/$F" "https://nodejs.org/dist/$NODE_VERSION/$F" || { echo "下载 Node 失败：检查网络后重新运行 install.sh（已完成的部分会跳过）。" >&2; exit 1; }
  printf '%s  %s\n' "$NODE_SHA256" "$F" > "$TMP/sha.txt"
  (cd "$TMP" && shasum -a 256 -c sha.txt) || { echo "下载的 Node 校验值不对（和写死的 SHA-256 不一致），已停止。" >&2; exit 1; }
  tar -xzf "$TMP/$F" -C "$TMP" && rm -rf "$BRIEF_HOME/.runtime/node" && mv "$TMP/node-$NODE_VERSION-$PLATFORM" "$BRIEF_HOME/.runtime/node" && rm -rf "$TMP"
fi
export PATH="$BRIEF_HOME/.runtime/node/bin:$PATH"
echo "Node $(node -v)"

# ---------- 3. n8n and libraries (locked versions) ----------
if [ -x "$BRIEF_HOME/node_modules/.bin/n8n" ] && cmp -s "$SRC_DIR/package-lock.json" "$BRIEF_HOME/package-lock.json"; then
  say "n8n 和依赖已是锁定的版本（跳过 3 GB 的安装）"
else
  say "安装 n8n 和依赖（几分钟，约 3 GB，请保持联网）"
  cp "$SRC_DIR/package.json" "$SRC_DIR/package-lock.json" "$BRIEF_HOME/"
  # SCARF_ANALYTICS=false: one of n8n's dependencies would otherwise report install statistics.
  (cd "$BRIEF_HOME" && SCARF_ANALYTICS=false npm ci --no-audit --no-fund 2>&1 | grep -vE 'install-scripts|npm warn' | tail -3) || true
fi
[ -x "$BRIEF_HOME/node_modules/.bin/n8n" ] || { echo "n8n 没有装好，请看上面的输出；修好网络后重新运行 install.sh 即可。" >&2; exit 1; }
. "$SRC_DIR/scripts/env.sh"
echo "n8n $(n8n --version)"

# ---------- 4. settings ----------
if [ "$YES" = 1 ]; then
  [ -n "$IN_DISCORD" ] && config_set DISCORD_WEBHOOK_URL "$IN_DISCORD"
  [ -n "$IN_ICS" ] && config_set ICS_URLS "$IN_ICS"
  ai_merge "$IN_AI_BASE" "$IN_AI_MODEL" "$IN_AI_KEY"
elif [ "$TERMINAL" = 1 ]; then
  say "设置（密钥输入时不显示，只保存在本机 $(config_file)，权限 600）"
  if config_has DISCORD_WEBHOOK_URL; then echo "已经设置过 Discord Webhook（保留）。"; else
    echo "1/4  Discord：在你的服务器里选一个频道 → 编辑频道 → 整合 → Webhook → 新 Webhook → 复制 Webhook URL。"
    "$SRC_DIR/scripts/set-discord-webhook.sh"; fi
  if config_has ICS_URLS; then echo "已经设置过日历链接（保留）。"; else
    echo "2/4  日历（可选）：电脑网页版 Google 日历 → 设置 → 左边选你的日历 →「iCal 格式的私人地址」。不想接日历就直接按回车跳过。"
    "$SRC_DIR/scripts/set-calendar-urls.sh" || echo "（跳过：不接日历）"; fi
  if config_has AI_BASE_URL; then echo "已经设置过 AI（保留）。"; else
    echo "3/4  AI（可选）：读你放进收件夹的课程大纲、作业说明，从里面找出任务。任何 OpenAI 兼容的接口都行（比如 DeepSeek，或本机模型）。可以先回答 n，以后再设置。"
    case "$(ask '现在设置 AI 吗？(y/n)' y)" in y|Y|yes|YES|Yes) "$SRC_DIR/scripts/set-ai-key.sh" || echo "（AI 没有设置；以后可以运行 scripts/set-ai-key.sh）" ;; esac; fi
  [ -n "$IN_BASE_DATE" ] || IN_BASE_DATE="$(ask '4/4  可选：第 1 周的周一是哪天（YYYY-MM-DD），用来理解文件里「第 4 周周五」这种写法。按回车跳过' '')"
  [ -n "$IN_IGNORE" ] || IN_IGNORE="$(ask '可选：不想在简报里看到的日程，写关键词，多个用 | 隔开（例如 午饭|课间）。按回车跳过' '')"
fi
# Port and inbox are stored in the config so every later run (scheduled, manual, re-installed) sees the same values.
[ -n "$IN_PORT" ] && config_set N8N_PORT "$IN_PORT"
[ -n "$IN_INBOX" ] && config_set BRIEF_INBOX "$IN_INBOX"
[ -n "$IN_BASE_DATE" ] && config_set BRIEF_BASE_DATE "$IN_BASE_DATE"
[ -n "$IN_IGNORE" ] && config_set BRIEF_IGNORE "$IN_IGNORE"
# without the browser the webhook must be there by now; with it, the setup wizard asks for it next
if [ "$YES" = 1 ] || [ "$TERMINAL" = 1 ]; then
  config_has DISCORD_WEBHOOK_URL || { echo "还没有设置 Discord Webhook：运行 scripts/set-discord-webhook.sh，然后重新运行 install.sh。" >&2; exit 1; }
fi

# ---------- 5. workflow, inbox, schedule ----------
say "安装工作流"
"$SRC_DIR/scripts/deploy-workflow.sh"
INBOX="${IN_INBOX:-${BRIEF_INBOX:-$HOME/n8n-inbox}}"   # the folder the user asked for, not the default
mkdir -p "$INBOX"

if [ "$SCHEDULE" = 1 ]; then
  say "设置每天 ${BRIEF_TIME} 的定时任务"
  "$SRC_DIR/scripts/install-launchd.sh" "$BRIEF_TIME"
fi

if [ "$TEST_RUN" = 1 ] && config_has DISCORD_WEBHOOK_URL; then
  say "试跑一次（往 Discord 发一条带 🧪 标记的测试简报；不影响明天正式的那条）"
  if bash "$BRIEF_HOME/scripts/run-brief.sh" --test; then echo "已发送，去 Discord 频道看看。"; else
    echo "试跑失败。日志：${BRIEF_HOME}/logs/run-$(date +%F).log" >&2; fi
fi

# ---------- 6. what is left for the user ----------
WAKE_TOTAL=$(( (10#${BRIEF_TIME%%:*} * 60 + 10#${BRIEF_TIME##*:} - 5 + 1440) % 1440 ))
WAKE="$(printf '%02d:%02d:00' $((WAKE_TOTAL / 60)) $((WAKE_TOTAL % 60)))"
if [ "$CONSOLE" = 1 ] && [ "$YES" != 1 ] && [ "$TERMINAL" != 1 ]; then
  say "装好了。接下来在浏览器里完成设置"
  cat <<MSG
马上会在浏览器里打开「每日简报控制台」，跟着设置向导填 Discord、日历和 AI 就行（大约 3 分钟）。
- 浏览器没有自动打开的话，把下面出现的那条 http://127.0.0.1 开头的链接复制到浏览器里。
- 设置完可以关掉这个终端窗口，每天的定时发送不受影响。以后想再打开控制台，在终端运行：
    ${BRIEF_HOME}/scripts/console.sh
- 以后想全部移除：在终端运行 bash "${SRC_DIR}/uninstall.sh"

MSG
  exec bash "$BRIEF_HOME/scripts/console.sh"
fi
say "装好了。还剩几件事要你自己来"
cat <<EOF
1) 建议：让 Mac 在简报前 5 分钟自动唤醒。需要管理员密码，所以请你自己运行。先看看现在有没有别的定时开关机设置：
     pmset -g sched
   注意：pmset repeat 只保留一条重复规则，下面这条会替换你以前设过的重复规则：
     sudo pmset repeat wakeorpoweron MTWRFSU $WAKE
   晚上一定要插着电源（用电池过夜，电量耗尽后不会被唤醒）。如果 ${BRIEF_TIME} 时 Mac 在睡觉，醒来后会补发。
2) 把课程大纲、作业说明（pdf、docx、txt、md）放进 ${INBOX}/ 。下一次简报会把找到的任务写进
   ${INBOX}/tasks.csv，状态是「待确认」；改成「进行中」才会出现在简报里（做完改「完成」，不要的改「忽略」）。
3) 随时可以用：
     ${BRIEF_HOME}/scripts/console.sh      在浏览器里打开控制台（状态、设置、任务、收件夹、日志都在里面，推荐）
     ${BRIEF_HOME}/scripts/status.sh       在终端里看健康状况
     ${BRIEF_HOME}/scripts/run-brief.sh --dry-run   只预览、不发送

以后想全部移除：在终端运行 bash "${SRC_DIR}/uninstall.sh"
EOF
