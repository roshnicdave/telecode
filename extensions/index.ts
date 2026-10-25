import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DATA = join(homedir(), ".telecode");
const LOCK = join(DATA, "bot.lock");
const CHAT = join(DATA, "chat-id");

function token(): string | undefined {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  try {
    return readFileSync(join(homedir(), ".pi", "agent", ".telegram_token"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function allowedIds(): string {
  if (process.env.TELEGRAM_ALLOWED_IDS) return process.env.TELEGRAM_ALLOWED_IDS;
  try {
    return readFileSync(join(homedir(), ".pi", "agent", ".telegram_allowed_ids"), "utf8").trim();
  } catch {
    return "";
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquire(): boolean {
  try {
    mkdirSync(DATA, { recursive: true });
    if (existsSync(LOCK)) {
      const pid = Number(readFileSync(LOCK, "utf8").trim());
      if (pid && pid !== process.pid && alive(pid)) return false;
      rmSync(LOCK, { force: true });
    }
    writeFileSync(LOCK, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

function release(): void {
  try {
    if (readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK, { force: true });
  } catch {
    // ignore
  }
}

function readChatId(): number | undefined {
  try {
    return Number(readFileSync(CHAT, "utf8").trim()) || undefined;
  } catch {
    return undefined;
  }
}

function writeChatId(id: number): void {
  try {
    mkdirSync(DATA, { recursive: true });
    writeFileSync(CHAT, String(id));
  } catch {
    // ignore
  }
}

export default function (pi: ExtensionAPI) {
  const tokenValue = token();
  if (!tokenValue) return;

  const allowed = allowedIds()
    .split(",")
    .map((s) => Number(s.trim()))
    .filter(Boolean);

  const bot = new Bot(tokenValue);
  let chatId = readChatId();
  let polling = false;

  pi.registerTool(
    defineTool({
      name: "telegram_send",
      label: "Telegram Send",
      description: "Send a message to the user's Telegram chat. Use this to reply whenever a user message starts with [Telegram].",
      parameters: Type.Object({
        text: Type.String({ description: "Message text to send" }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const id = chatId ?? readChatId();
        if (!id) {
          return { content: [{ type: "text", text: "No Telegram chat known yet." }], details: undefined };
        }
        const sent = await bot.api.sendMessage(id, params.text);
        return { content: [{ type: "text", text: `Sent (message ${sent.message_id}).` }], details: undefined };
      },
    }),
  );

  bot.on("message:text", (ctx) => {
    const from = ctx.from?.id;
    if (from !== undefined) {
      chatId = ctx.chat.id;
      writeChatId(chatId);
    }
    if (allowed.length && (from === undefined || !allowed.includes(from))) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    try {
      pi.sendUserMessage(`[Telegram] ${text}`);
    } catch {
      try {
        pi.sendUserMessage(`[Telegram] ${text}`, { deliverAs: "followUp" });
      } catch {
        // busy; dropped
      }
    }
  });

  pi.on("session_start", async () => {
    if (polling || !acquire()) return;
    polling = true;
    try {
      await bot.start({ drop_pending_updates: true });
    } catch {
      polling = false;
      release();
    }
  });

  pi.on("session_shutdown", async () => {
    if (polling) {
      await bot.stop().catch(() => {});
      polling = false;
    }
    release();
  });
}
