#!/bin/zsh
# 本地 TTS 双运行时回归：系统 Node + DeepSeek Harness 的 Electron 运行时。
# Electron 的 V8 沙箱会拒绝 external ArrayBuffer；只跑系统 Node 会漏掉这个故障
#（实测：系统 Node 通过、DSH 运行时 synthesis 报 "TTS settlement failed"）。
# 用法：./tests/tts-smoke.sh
set -u
cd "$(dirname "$0")/.."

rc=0
echo "== 系统 Node =="
if command -v node >/dev/null 2>&1; then
  node tests/tts-smoke.mjs || rc=1
else
  echo "跳过（未找到 node）"
fi

APP="/Applications/DeepSeek Harness.app"
if [[ -x "$APP/Contents/Resources/runtime/bin/node" && -x "$APP/Contents/MacOS/DeepSeek Harness" ]]; then
  echo "== DSH Electron 运行时 =="
  DSH_DESKTOP_NODE_EXECUTABLE="$APP/Contents/MacOS/DeepSeek Harness" \
    "$APP/Contents/Resources/runtime/bin/node" tests/tts-smoke.mjs || rc=1
else
  echo "跳过（未安装 DeepSeek Harness）"
fi

if [[ $rc -eq 0 ]]; then echo "全部通过"; else echo "存在失败"; fi
exit $rc
