#!/bin/bash
# Double-click installer. Copies this folder to ~/n8n-morning-brief (so it is found again for updates and uninstalling,
# wherever the zip was opened -- WeChat keeps received files deep inside its own folder) and runs install.sh from there,
# which installs everything and then opens the setup wizard in the browser.
here="$(cd "$(dirname "$0")" && pwd)"
# For testing only: inside a folder marked with .brief-sandbox-home, that folder plays the user's home folder, with its own
# daily job and n8n port, so a test installation never touches the real one.
d="$here"
while [ "$d" != "/" ]; do
  if [ -f "$d/.brief-sandbox-home" ]; then export HOME="$d" BRIEF_LABEL="com.cc-workspace.n8n-morning-brief.sandbox" N8N_PORT=5790; break; fi
  d="$(dirname "$d")"
done
dest="$HOME/n8n-morning-brief"
stop() { echo; echo "$1"; echo; read -r -p "按回车关闭这个窗口" _; exit 1; }
if [ "$here" != "$dest" ]; then
  [ -e "$dest" ] && [ ! -f "$dest/install.sh" ] && stop "${dest} 已经存在，但不是这个项目的文件夹。请先把它改名或移走，再双击一次。"
  # a git checkout there is someone's working copy (with history and unpublished changes): it is never replaced
  [ -e "$dest/.git" ] && stop "${dest} 是一个 git 仓库（可能是你自己的开发副本），不会覆盖它。请先把它改名或移走，再双击一次。"
  echo "正在把安装文件放到 ${dest} ……"
  rm -rf "$dest.new" && cp -R "$here" "$dest.new" || stop "复制失败（磁盘满了？），什么都没有改动。"
  rm -rf "$dest.old"; if [ -e "$dest" ]; then mv "$dest" "$dest.old"; fi
  mv "$dest.new" "$dest" && rm -rf "$dest.old"
fi
cd "$dest" || stop "找不到 ${dest}"
# install.sh normally ends by running the console in this window; it only comes back here when something went wrong
bash ./install.sh || stop "安装没有完成，原因在上面。修好之后再双击一次就行：已经装好的部分会跳过。"
read -r -p "按回车关闭这个窗口" _
