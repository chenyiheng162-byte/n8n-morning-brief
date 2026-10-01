#!/usr/bin/env bash
set -u
LABEL="${BRIEF_LABEL:-com.cc-workspace.n8n-morning-brief}"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "已移除定时任务（${LABEL}）"
