# telecode

Control your running [Pi coding agent](https://github.com/earendil-works/pi) sessions from Telegram.

Telecode is one Pi extension. It runs locally, registers each live Pi session, and lets one private Telegram bot route messages to the session you choose. Pi's completed response is returned automatically; the model does not need to call a tool.

## Install

```sh
pi install npm:@roshnicdave/telecode
```

For local development:

```sh
git clone https://github.com/roshnicdave/telecode.git ~/telecode
cd ~/telecode && npm install
pi install ~/telecode
```

## Configure

Set the bot token and your numeric Telegram user ID:

```sh
mkdir -p ~/.pi/agent
printf '%s\n' 'YOUR_BOT_TOKEN' > ~/.pi/agent/.telegram_token
printf '%s\n' 'YOUR_TELEGRAM_USER_ID' > ~/.pi/agent/.telegram_allowed_ids
chmod 600 ~/.pi/agent/.telegram_token ~/.pi/agent/.telegram_allowed_ids
```

Environment variables `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_IDS` override those files. The allowlist is required; Telecode stays off rather than exposing a coding agent to strangers.

Restart Pi after installation. In Telegram:

- `/sessions` lists every running Pi session and lets you select one.
- `/status` shows the selected session.
- `/abort` stops the selected session's current turn.
- Any ordinary message is sent to the selected session.

If the selected session is busy, the message is queued as a follow-up. One Pi process polls Telegram at a time; another live session takes over automatically if it exits.

## Development

```sh
npm test
npm run typecheck
```

Runtime state lives in `~/.telecode/`. Bot credentials remain outside the repository.
