# telecode

Control your [OpenCode](https://opencode.ai) sessions from Telegram. Runs as an
**OpenCode plugin**, in-process with the OpenCode service — so it's up exactly
when OpenCode is, and there's no separate process or HTTP hop.

- List sessions (5 at a time, load more, search)
- Open a session and just type to chat with it
- View history, interrupt, compact, switch model/agent, export, delete, new

## Install

Add it to `opencode.json` (global or project):

```jsonc
{
  "plugins": [
    {
      "package": "opencode-telecode",
      "options": {
        "token": "1234567890:AA-your-token",
        "allowedIds": "8010764520"   // optional: your Telegram user ID(s), comma-separated
      }
    }
  ]
}
```

Or from a checkout:

```jsonc
{ "plugins": [{ "package": "/path/to/telecode", "options": { "token": "..." } }] }
```

`token` can also come from the `TELEGRAM_BOT_TOKEN` environment variable.
`allowedIds` (or `TELEGRAM_ALLOWED_IDS`) locks the bot to your account — set it,
because the bot can run prompts and shell commands. Find your numeric ID from
[@userinfobot](https://t.me/userinfobot).

Reload to pick up the plugin:

```sh
opencode api post /api/location/reload
```

## Usage

- `/start` — home
- `/sessions` — list sessions (5 at a time, **Load more** to page, **Search** to filter)
- `/new` — create a session
- With a session open, **just type** to send it a message.
- Session buttons: **View / Interrupt / Compact / Model / Agent / Export / Delete**
- `/leave` — close the active session

## Development

```sh
npm install
```

A Telegram bot token from [@BotFather](https://t.me/BotFather) is required. The
plugin is a single `setup` entrypoint (`index.ts`) plus the grammY bot
(`src/bot.js`) and formatting helpers (`src/format.js`). It talks to sessions
through the in-process plugin API — no HTTP client.

## Publish

```sh
npm publish
```

## Project layout

- `index.ts` — plugin entrypoint (single instance, tied to OpenCode lifecycle)
- `src/bot.js` — the Telegram bot (grammY)
- `src/format.js` — markdown → Telegram HTML + message chunking
