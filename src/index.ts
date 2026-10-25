// telecode entrypoint: an MCP server (stdio) + the Telegram bot, sharing one
// session store. Any MCP-capable agent connects via stdio; the bot runs for as
// long as this process is alive.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Bot } from "grammy";
import { createBot, type BotHandle } from "./bot.js";
import { Store } from "./store.js";
import { registerTools } from "./tools.js";

// The bot's model picker lists these unless TELECODE_MODELS is set.
// Keep it empty: each deployment should configure its own model list.
const DEFAULT_MODELS: string[] = [];

const VERSION = "1.0.4";

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Only one process should poll Telegram. The lock holder polls; other
// instances serve MCP tools only and automatically take over polling if the
// holder exits. The lock is a PID file in the data dir, so it stays portable
// across harnesses and needs no harness-specific configuration.
function tryAcquireBotLock(dir: string): boolean {
  const lockPath = join(dir, "bot.lock");
  try {
    if (existsSync(lockPath)) {
      const pid = Number(readFileSync(lockPath, "utf8").trim());
      if (pid && pid !== process.pid && isProcessAlive(pid)) return false;
      rmSync(lockPath, { force: true });
    }
    writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function releaseBotLock(dir: string): void {
  const lockPath = join(dir, "bot.lock");
  try {
    if (readFileSync(lockPath, "utf8").trim() === String(process.pid)) rmSync(lockPath, { force: true });
  } catch {
    // ignore
  }
}

function startBotSupervisor(handle: BotHandle, dir: string): { stop: () => Promise<void> } {
  let polling = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || polling) return;
    if (!tryAcquireBotLock(dir)) return; // another live instance holds it; retry next tick
    polling = true;
    console.error("[telecode] telegram bot: polling");
    try {
      await handle.start();
    } catch (e) {
      console.error("[telecode] bot failed to start:", (e as Error)?.message ?? e);
      polling = false;
      releaseBotLock(dir);
    }
  };

  void tick();
  const interval = setInterval(() => void tick(), 5000);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      if (polling) {
        await handle.stop().catch(() => {});
        polling = false;
      }
      releaseBotLock(dir);
    },
  };
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
    console.error(`[telecode] telegram bot: token set${allowedIds ? ` (allowed ids: ${allowedIds})` : " (allow all)"}`);
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

  // Poll Telegram only while this process holds the bot lock. If another
  // instance holds it, we keep serving MCP and take over automatically.
  const supervisor = token ? startBotSupervisor(handle, dataDir()) : null;

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await supervisor?.stop();
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[telecode] fatal:", (e as Error)?.message ?? e);
  process.exit(1);
});
