#!/bin/zsh
# 把本仓库装进 desktop profile（link: 软链，改代码即时生效）。
# 安全前置：必须先退出 DeepSeek Harness，避免与插件市场并发抢 pnpm store 锁。
# 用法：tools/install-local.sh
set -e
PROFILE="${DSH_PROFILE:-$HOME/.dsh/profiles/desktop}"
FORK="$(cd "$(dirname "$0")/.." && pwd)"
PNPM="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs"
NODE="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"

if pgrep -f "DeepSeek Harness.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "!! DeepSeek Harness 还在运行。请先完全退出（Cmd+Q）再跑本脚本。"
  echo "   （宿主 pnpm 与市场并发会抢 store index.db 锁）"
  exit 1
fi

if [[ ! -d "$PROFILE" ]]; then
  echo "!! 找不到 DSH profile：$PROFILE"
  echo "   可用 DSH_PROFILE=/path/to/profile 指定。"
  exit 1
fi

if [[ ! -f "$PNPM" ]]; then
  echo "!! 找不到宿主 pnpm：$PNPM"
  exit 1
fi

if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "!! 找不到 node。请安装 Node.js 20+，或用 DSH 自带的 runtime/bin/node。"
  exit 1
fi

echo "== 把 dsh-music-player 指向 fork：$FORK =="
cd "$PROFILE"
# link: 不访问 registry，只建软链；其余依赖沿用现有 lockfile/store。
"$NODE" "$PNPM" add "link:$FORK" --config.minimum-release-age=0

echo "== 校验软链 =="
ls -la "$PROFILE/node_modules/dsh-music-player"
echo "完成。重新打开 DeepSeek Harness 即加载我们的版本。"
echo "提示：改 lib/index.js（host）须重启应用；只改 lib/client.js（界面）重载窗口即可。"