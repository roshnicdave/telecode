# telecode

Control your [OpenCode](https://opencode.ai) sessions from Telegram. Leave the
computer running and drive any of your sessions from your phone — send messages,
view history, interrupt, compact, switch model/agent, export, delete, create new.

## How it works

A tiny Node service sits between a Telegram bot and OpenCode's background
service. It discovers and authenticates with the local OpenCode service via
`@opencode/client/service` (auto-starting it if needed) and drives it over the
HTTP API. The bot uses long polling, so there's no public URL or webhook to set up.

## Requirements

- Node.js 20.6+
- [OpenCode](https://opencode.ai) installed and on your `PATH`
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```sh
git clone https://github.com/<you>/telecode
cd telecode
npm install
cp .env.example .env   # then edit .env and paste your bot token
```

Optional but recommended — lock the bot to your account: put your numeric
Telegram user ID (e.g. from [@userinfobot](https://t.me/userinfobot)) into
`TELEGRAM_ALLOWED_IDS` in `.env`.

## Run

```sh
npm start       # foreground
./start.sh      # background, logs to log/bot.log
./stop.sh       # stop the background process
```

Run at login (macOS `launchd`) — replace the paths and `node` path:

```sh
mkdir -p ~/Library/LaunchAgents
cat > ~/Library/LaunchAgents/com.telecode.plist <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.telecode</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>--env-file=.env</string>
    <string>index.js</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/telecode</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/telecode/log/bot.log</string>
  <key>StandardErrorPath</key><string>/path/to/telecode/log/bot.err.log</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.telecode.plist
```

## Usage

- `/start` — home
- `/sessions` — list sessions (5 at a time, **Load more** to page, **Search** to filter)
- `/new` — create a session
- With a session open, **just type** to send it a message.
- Session buttons: **View / Interrupt / Compact / Model / Agent / Export / Delete**
- `/leave` — close the active session

## Test

```sh
npm test
```

Runs the smoke test: formatting helpers, the OpenCode API (a real
create → prompt → reply → switch → compact → delete round-trip), and Telegram
reachability. It does not start the bot.

## Security

The bot can run prompts, shell commands, and edit files through OpenCode — treat
the token like a password. Set `TELEGRAM_ALLOWED_IDS` so only you can use it, and
never commit `.env`.

## Project layout

- `src/opencode.js` — OpenCode HTTP API wrapper
- `src/format.js` — markdown → Telegram HTML + message chunking
- `src/bot.js` — the Telegram bot (grammY)
- `index.js` — entrypoint
