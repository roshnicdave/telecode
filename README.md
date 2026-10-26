# telecode

Control local [OpenCode](https://opencode.ai/) sessions from a private Telegram bot.

Telecode is intentionally a thin client. OpenCode owns sessions, tools, model credentials, and history; Telecode only selects a workspace/session/model and forwards messages through OpenCode's documented HTTP API. There is no terminal scraping, tmux, heartbeat registry, or per-session daemon.

## Requirements

- OpenCode 1.19.4
- Node.js 22 or newer
- A Telegram bot token and your numeric Telegram user ID

Install dependencies with `npm install`. Store the bot token in `~/.telecode/telegram-token` and allowed numeric IDs in `~/.telecode/telegram-allowed-ids`, both mode `0600`.

Start the authenticated OpenCode server with `./scripts/run-opencode-server.sh` and the bot with `./scripts/run-telecode.sh`. The included macOS launch agents run both automatically; they expect this checkout at `/Users/rd/telecode` and use `/Users/rd/ripster-system` as the default workspace.

## Telegram commands

- `/new <name>` creates and selects an OpenCode session.
- `/sessions` selects a session in the current workspace.
- `/workspace <absolute path>` changes workspace.
- `/models` chooses among configured OpenCode models.
- `/model` shows the chosen model.
- `/status` shows the workspace, session, and model.
- `/abort` stops the current turn.
- Any ordinary message is sent to the selected session.

Access is deny-by-default. Updates from Telegram user IDs outside the allowlist are ignored.

## Migrating from Pi

`node scripts/migrate-from-pi.mjs` copies provider and Telegram credentials into protected OpenCode/Telecode stores without printing their values. Run it again after the OpenCode server starts so credentials are synchronized through the API.

## Development

Run `npm test`, `npm run typecheck`, `npm pack --dry-run`, and `git diff --check` before release. Runtime state and logs live in `~/.telecode/`; OpenCode configuration lives in `~/.config/opencode/`; credentials remain outside the repository.
