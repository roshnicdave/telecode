# telecode

[![npm](https://img.shields.io/npm/v/@roshnicdave/telecode)](https://www.npmjs.com/package/@roshnicdave/telecode)
[![GitHub](https://img.shields.io/github/stars/roshnicdave/telecode?style=social)](https://github.com/roshnicdave/telecode)

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
│   └── index.cjs        # self-contained bundle (no runtime deps)
└── src/                 # TypeScript source
```

## Install

### From npm

```sh
npm install @roshnicdave/telecode
```

Then point your agent's plugin loader at the installed package directory
(`node_modules/@roshnicdave/telecode`). A conforming client reads `plugin.json`,
discovers `skills/`, and launches the `mcp.json` server.

### From source

```sh
git clone https://github.com/roshnicdave/telecode
```

Then point your agent's plugin loader at the cloned directory.

### Configure

1. Point your agent's plugin loader at the package directory (from npm or source).
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
| `TELECODE_MODELS` | Comma-separated model list for the bot's model picker (empty by default). |

## Works with any MCP agent

`telecode` speaks standard stdio MCP, so any MCP-capable harness can drive it —
Claude Code, Cursor, VS Code, Pi, and others. Point the harness at the bundled
server and set the two env vars:

```json
{
  "mcpServers": {
    "telecode": {
      "command": "node",
      "args": ["/path/to/node_modules/@roshnicdave/telecode/dist/index.cjs"],
      "env": {
        "TELEGRAM_BOT_TOKEN": "1234567890:AA-your-token",
        "TELEGRAM_ALLOWED_IDS": "8010764520"
      }
    }
  }
}
```

- **Claude Code**: `claude mcp add telecode --env TELEGRAM_BOT_TOKEN=… --env TELEGRAM_ALLOWED_IDS=… -- node /path/to/dist/index.cjs`
- **Cursor**: add the JSON above to `.cursor/mcp.json`
- **VS Code**: add the JSON above to `.vscode/mcp.json`
- **Pi**: add the JSON above to `~/.pi/agent/mcp.json`. For seamless phone → agent turns (no manual polling), also copy `extras/pi/telecode-autopoll.ts` into `~/.pi/agent/extensions/` — it injects queued Telegram prompts as real user messages so the agent answers immediately.

## Development

```sh
npm install
npm run build     # bundles src/index.ts -> dist/index.cjs (esbuild)
node dist/index.cjs
```

## How it works

The MCP server and the Telegram bot run in one process and share one session
store. When you type a message in an open session on Telegram, the bot queues it
as a *pending prompt*. The connected agent reads pending prompts (via the
`get_pending` tool), does the work, records the answer (`complete_response`),
and sends it back to you (`send_telegram`). See `skills/telecode/SKILL.md` for
the agent-side workflow.
