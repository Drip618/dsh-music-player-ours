#!/bin/zsh
# 同步上游 kendu76/dsh-music-player 的更新到本仓库。
# 用法：tools/sync-upstream.sh [--install]
#   不带参数：只 fetch + merge，报告冲突（不自动装）。
#   --install：merge 干净后顺手重装进 desktop profile。
# 我们的新增功能都在独立文件（lib/fanqie.js / lib/local-tts.js / lib/tts-download.js / lib/unblock.js）
# 与少量打标记的接缝改动里，冲突面较小。
set -e
cd "$(dirname "$0")/.."

echo "== 当前分支 =="
git branch --show-current

echo "== 拉取上游 =="
git fetch upstream main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse upstream/main)
BASE=$(git merge-base HEAD upstream/main)

if [[ "$LOCAL" == "$REMOTE" || "$REMOTE" == "$BASE" ]]; then
  echo "上游无新提交，已是最新。"
  exit 0
fi

echo "== 上游新增提交 =="
git log --oneline HEAD..upstream/main

echo "== 合并 =="
if git merge upstream/main --no-edit; then
  echo "合并干净。"
else
  echo "!! 有冲突，请手工解决后 git commit。冲突文件："
  git diff --name-only --diff-filter=U
  exit 1
fi

if [[ "$1" == "--install" ]]; then
  echo "== 重装进 desktop profile =="
  tools/install-local.sh
fi