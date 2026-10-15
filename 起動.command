#!/bin/zsh
# ダブルクリックでアプリを起動する（このウィンドウを閉じるとサーバーも止まります）
cd "$(dirname "$0")"
if ! curl -s -o /dev/null http://localhost:8000/; then
  python3 -m http.server 8000 >/dev/null 2>&1 &
  sleep 1
fi
open http://localhost:8000/
echo "スキーフォーム解析を起動しました： http://localhost:8000/"
echo "終了するときはこのウィンドウを閉じてください。"
wait
