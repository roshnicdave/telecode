#!/usr/bin/env bash
# Start the OpenCode Telegram bot in the background.
set -e
cd "$(dirname "$0")"
mkdir -p log

if [ -f log/bot.pid ] && kill -0 "$(cat log/bot.pid)" 2>/dev/null; then
  echo "Bot already running (pid $(cat log/bot.pid))"
  exit 0
fi

nohup node --env-file=.env index.js > log/bot.log 2>&1 &
echo $! > log/bot.pid
echo "Started (pid $(cat log/bot.pid)). Logs: log/bot.log"
