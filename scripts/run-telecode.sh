#!/bin/zsh
set -eu
cd /Users/rd/telecode
exec /opt/homebrew/bin/node --experimental-strip-types src/index.ts
