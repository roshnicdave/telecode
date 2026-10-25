#!/usr/bin/env bash
# Stop the OpenCode Telegram bot.
cd "$(dirname "$0")"

if [ -f log/bot.pid ]; then
  pid="$(cat log/bot.pid)"
  if kill "$pid" 2>/dev/null; then
    echo "Stopped (pid $pid)."
  else
    echo "Not running."
  fi
  rm -f log/bot.pid
else
  echo "No pid file found."
fi
