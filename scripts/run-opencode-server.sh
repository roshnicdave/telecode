#!/bin/zsh
set -eu
export OPENCODE_SERVER_PASSWORD="$(tr -d '\n' < "$HOME/.telecode/opencode-server-password")"
export CLOUDFLARE_ACCOUNT_ID="$(tr -d '\n' < "$HOME/.config/opencode/secrets/cloudflare-account-id")"
export CLOUDFLARE_API_TOKEN="$(tr -d '\n' < "$HOME/.config/opencode/secrets/cloudflare-api-token")"
exec /opt/homebrew/bin/opencode serve --hostname 127.0.0.1 --port 4098
