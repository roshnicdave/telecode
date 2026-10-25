# telecode

Control your [OpenCode](https://opencode.ai) sessions from Telegram. Runs as an
**OpenCode plugin**, in-process with the OpenCode service — so it's up exactly
when OpenCode is, and there's no separate process or HTTP hop.

- List sessions (5 at a time, load more, search)
- Open a session and just type to chat with it
- View history, interrupt, compact, switch model/agent, export, delete, new

## How it works

OpenCode loads this plugin into its background service. The plugin starts a
Telegram bot (grammY, long polling) and talks to your sessions directly through
the in-process plugin API — no public URL, no webhook, no extra server.

Lifecycle follows OpenCode: when the service starts, the bot starts; when it
stops, the bot stops. (Keep the Mac awake — if it sleeps, everything pauses.)

## Requirements

- [OpenCode](https://opencode.ai) installed
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```sh
git clone https://github.com/<you>/telecode
cd telecode
npm install
```

Add it to your OpenCode config (`~/.config/opencode/opencode.json`, or
`opencode.json` in a project) with your token:

```jsonc
{
  "plugins": [
    {
      "package": "/path/to/telecode",
      "options": {
        "token": "1234567890:AA-your-token",
        "allowedIds": "8010764520"   // optional: your Telegram user ID(s), comma-separated
      }
    }
  ]
}
```

`token` can also come from the `TELEGRAM_BOT_TOKEN` environment variable.
`allowedIds` (or `TELEGRAM_ALLOWED_IDS`) locks the bot to your account — set it,
because the bot can run prompts and shell commands. Find your numeric ID from
[@userinfobot](https://t.me/userinfobot).

Reload OpenCode to pick up the plugin:

```sh
opencode api post /api/location/reload
```

(or restart `opencode`).

## Usage

- `/start` — home
- `/sessions` — list sessions (5 at a time, **Load more** to page, **Search** to filter)
- `/new` — create a session
- With a session open, **just type** to send it a message.
- Session buttons: **View / Interrupt / Compact / Model / Agent / Export / Delete**
- `/leave` — close the active session

## Project layout

- `index.ts` — plugin entrypoint (single instance, tied to OpenCode lifecycle)
- `src/bot.js` — the Telegram bot (grammY)
- `src/format.js` — markdown → Telegram HTML + message chunking
