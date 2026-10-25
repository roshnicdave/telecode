// telecode entrypoint: an MCP server (stdio) + the Telegram bot, sharing one
// session store. Any MCP-capable agent connects via stdio; the bot runs for as
// long as this process is alive.

import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Bot } from "grammy";
import { createBot, type BotHandle } from "./bot.js";
import { Store } from "./store.js";
import { registerTools } from "./tools.js";

// The bot's model picker lists these unless TELECODE_MODELS is set.
// Keep it empty: each deployment should configure its own model list.
const DEFAULT_MODELS: string[] = [];

const VERSION = "1.0.2";

function dataDir(): string {
  if (process.env.TELECODE_DATA_DIR) return process.env.TELECODE_DATA_DIR;
  if (process.env.PLUGIN_DATA) return join(process.env.PLUGIN_DATA, "data");
  return join(homedir(), ".telecode");
}

function models(): string[] {
  if (process.env.TELECODE_MODELS) {
    return process.env.TELECODE_MODELS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return DEFAULT_MODELS;
}

async function main() {
  const store = new Store(dataDir());

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedIds = process.env.TELEGRAM_ALLOWED_IDS ?? "";
  const modelList = models();

  console.error(`[telecode] telecode v${VERSION}`);
  console.error(`[telecode] store: ${dataDir()} (${store.list().length} sessions)`);
  console.error(`[telecode] models: ${modelList.join(", ") || "none"}`);

  let handle: BotHandle;
  if (token) {
    handle = createBot(store, token, allowedIds, modelList);
    console.error(`[telecode] telegram bot: enabled${allowedIds ? ` (allowed ids: ${allowedIds})` : " (allow all)"}`);
  } else {
    console.error("[telecode] telegram bot: disabled (TELEGRAM_BOT_TOKEN not set)");
    const stubBot = {
      api: {
        sendMessage: async () => {
          throw new Error("TELEGRAM_BOT_TOKEN not set");
        },
      },
    } as unknown as Bot;
    handle = { bot: stubBot, knownChatIds: new Set(), start: async () => {}, stop: async () => {} };
  }

  const server = new Server(
    { name: "telecode", version: VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, store, handle);

  // Start the bot and connect the MCP transport. Both keep the process alive.
  const botReady = handle.start().catch((e) => {
    console.error("[telecode] bot failed to start:", (e as Error)?.message ?? e);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await handle.stop().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await botReady;
}

main().catch((e) => {
  console.error("[telecode] fatal:", (e as Error)?.message ?? e);
  process.exit(1);
});
