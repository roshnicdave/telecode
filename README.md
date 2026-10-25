# telecode

Control your coding agent sessions from Telegram. `telecode` is an
[Agent Plugins 1.0.0](https://agent-plugins.org) plugin: a portable
**MCP server** plus a **skill**, so it works with any MCP-capable coding agent
(Pi, Cursor, VS Code, Claude Code, …) instead of being tied to one harness.

- **Session store** — portable JSON sessions shared by the MCP tools and the bot.
- **Telegram bot** — `/sessions`, `/new`, and inline buttons (view, interrupt,
  compact, switch model, export, delete) to drive sessions from your phone.
- **MCP tools** — any agent can list/create/read sessions, queue prompts, record
  responses, and send Telegram messages.

## Layout (Agent Plugins 1.0.0)

```
telecode/
├── plugin.json          # manifest
├── mcp.json             # MCP server (stdio)
├── skills/
│   └── telecode/
│       └── SKILL.md     # instructions for the agent
├── dist/
│   └── index.mjs        # self-contained bundle (no runtime deps)
└── src/                 # TypeScript source
```

## Install

1. Point your agent's plugin loader at this directory. A conforming client reads
   `plugin.json`, discovers `skills/`, and launches the `mcp.json` server.
2. Set the bot token (and optional owner allow-list) in the agent's environment:

```sh
export TELEGRAM_BOT_TOKEN="1234567890:AA-your-token"
export TELEGRAM_ALLOWED_IDS="8010764520"   # optional: comma-separated user ids
```

The token is **not** embedded in `mcp.json` (spec §7.2.1 forbids secrets there);
it is read from the environment of the process that launches the agent.

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token (required for the bot). |
| `TELEGRAM_ALLOWED_IDS` | Comma-separated numeric Telegram user ids to allow. Empty = allow all. |
| `TELECODE_DATA_DIR` | Where sessions are stored. Defaults to `${PLUGIN_DATA}/data` or `~/.telecode`. |
| `TELECODE_MODELS` | Comma-separated model list for the bot's model picker. |

## Development

```sh
npm install
npm run build     # bundles src/index.ts -> dist/index.mjs (esbuild)
node dist/index.mjs
```

## How it works

The MCP server and the Telegram bot run in one process and share one session
store. When you type a message in an open session on Telegram, the bot queues it
as a *pending prompt*. The connected agent reads pending prompts (via the
`get_pending` tool), does the work, records the answer (`complete_response`),
and sends it back to you (`send_telegram`). See `skills/telecode/SKILL.md` for
the agent-side workflow.
