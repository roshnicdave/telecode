import {
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Bot, InlineKeyboard } from "grammy";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DATA = join(homedir(), ".telecode");
const SESSIONS = join(DATA, "sessions");
const LOCK = join(DATA, "bot.lock");
const SELECTIONS = join(DATA, "selections.json");
const TELEGRAM_PREFIX = /^\[Telegram:(-?\d+)\]\s/;

type SessionRecord = {
  id: string;
  pid: number;
  port: number;
  secret: string;
  cwd: string;
  name?: string;
  busy: boolean;
  startedAt: number;
  lastActivity: number;
  heartbeat: number;
};

function readSecret(envName: string, fileName: string): string {
  if (process.env[envName]?.trim()) return process.env[envName]!.trim();
  try {
    return readFileSync(join(homedir(), ".pi", "agent", fileName), "utf8").trim();
  } catch {
    return "";
  }
}

export function parseAllowedIds(value: string): Set<number> {
  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
  );
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(DATA, { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function acquireLock(): boolean {
  mkdirSync(DATA, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      symlinkSync(String(process.pid), LOCK);
      return true;
    } catch {
      let owner = 0;
      try {
        owner = Number(readlinkSync(LOCK));
      } catch {
        try {
          owner = Number(readFileSync(LOCK, "utf8").trim());
        } catch {
          // The lock disappeared between attempts.
        }
      }
      if (owner && processAlive(owner)) return owner === process.pid;
      rmSync(LOCK, { force: true });
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    let owner: number;
    try {
      owner = Number(readlinkSync(LOCK));
    } catch {
      owner = Number(readFileSync(LOCK, "utf8").trim());
    }
    if (owner === process.pid) rmSync(LOCK);
  } catch {
    // Already released.
  }
}

function liveSessions(): SessionRecord[] {
  mkdirSync(SESSIONS, { recursive: true });
  const now = Date.now();
  const records: SessionRecord[] = [];
  for (const file of readdirSync(SESSIONS).filter((name) => name.endsWith(".json"))) {
    const path = join(SESSIONS, file);
    const record = readJson<SessionRecord | undefined>(path, undefined);
    if (!record || now - record.heartbeat > 30_000 || !processAlive(record.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    records.push(record);
  }
  return records.sort((a, b) => b.lastActivity - a.lastActivity);
}

function label(session: SessionRecord): string {
  return `${session.name || basename(session.cwd) || "session"} · ${session.id.slice(0, 8)}${session.busy ? " · busy" : ""}`;
}

export function assistantText(message: { role?: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } =>
      typeof part === "object" && part !== null && (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function splitTelegram(text: string, limit = 4000): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export default function telecode(pi: ExtensionAPI): void {
  const botToken = readSecret("TELEGRAM_BOT_TOKEN", ".telegram_token");
  const allowed = parseAllowedIds(readSecret("TELEGRAM_ALLOWED_IDS", ".telegram_allowed_ids"));
  if (!botToken || allowed.size === 0) return;

  mkdirSync(SESSIONS, { recursive: true });
  const bot = new Bot(botToken);
  const secret = randomBytes(18).toString("hex");
  const registryPath = join(SESSIONS, `${process.pid}.json`);
  let context: ExtensionContext | undefined;
  let server: Server | undefined;
  let port = 0;
  let startedAt = Date.now();
  let lastActivity = startedAt;
  let heartbeat: NodeJS.Timeout | undefined;
  let leaderCheck: NodeJS.Timeout | undefined;
  let polling = false;
  let shuttingDown = false;
  let remoteChat: number | undefined;
  let responseText = "";

  const authorized = (id?: number): boolean => id !== undefined && allowed.has(id);
  const selections = (): Record<string, string> => readJson(SELECTIONS, {});
  const select = (chatId: number, sessionId: string): void => {
    const value = selections();
    value[String(chatId)] = sessionId;
    writeJson(SELECTIONS, value);
  };
  const selectedSession = (chatId: number): SessionRecord | undefined => {
    const sessions = liveSessions();
    const selected = selections()[String(chatId)];
    return sessions.find((session) => session.id === selected) ?? sessions[0];
  };

  const saveRegistry = (): void => {
    if (!context || !port) return;
    writeJson(registryPath, {
      id: context.sessionManager.getSessionId(),
      pid: process.pid,
      port,
      secret,
      cwd: context.cwd,
      name: pi.getSessionName(),
      busy: !context.isIdle(),
      startedAt,
      lastActivity,
      heartbeat: Date.now(),
    } satisfies SessionRecord);
  };

  const send = async (chatId: number, text: string): Promise<void> => {
    for (const chunk of splitTelegram(text || "Pi finished without a text response.")) {
      await bot.api.sendMessage(chatId, chunk);
    }
  };

  const route = async (chatId: number, text: string): Promise<string> => {
    const session = selectedSession(chatId);
    if (!session) return "No live Pi sessions. Start Pi on the computer first.";
    select(chatId, session.id);
    try {
      const response = await fetch(`http://127.0.0.1:${session.port}/message`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telecode-secret": session.secret },
        body: JSON.stringify({ chatId, text }),
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(String(response.status));
      return `Sent to ${label(session)}`;
    } catch {
      return "That Pi session stopped responding. Use /sessions and choose another one.";
    }
  };

  const abortSelected = async (chatId: number): Promise<string> => {
    const session = selectedSession(chatId);
    if (!session) return "No live Pi sessions.";
    try {
      const response = await fetch(`http://127.0.0.1:${session.port}/abort`, {
        method: "POST",
        headers: { "x-telecode-secret": session.secret },
        signal: AbortSignal.timeout(3000),
      });
      return response.ok ? `Abort requested for ${label(session)}` : "Could not abort that session.";
    } catch {
      return "That Pi session stopped responding.";
    }
  };

  bot.command("start", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    await ctx.reply("Telecode is connected. Use /sessions, choose a Pi session, then send it a message.");
  });
  bot.command("help", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    await ctx.reply("/sessions — list and select live Pi sessions\n/status — show the selected session\n/abort — stop its current turn\n\nAny other text is sent to the selected session.");
  });
  bot.command("sessions", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    const sessions = liveSessions();
    if (!sessions.length) return void await ctx.reply("No live Pi sessions. Start Pi on the computer first.");
    const keyboard = new InlineKeyboard();
    sessions.forEach((session) => keyboard.text(label(session), `use:${session.id}`).row());
    await ctx.reply("Choose a Pi session:", { reply_markup: keyboard });
  });
  bot.command("status", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    const session = selectedSession(ctx.chat.id);
    await ctx.reply(session ? `Selected: ${label(session)}\n${session.cwd}` : "No live Pi sessions.");
  });
  bot.command("abort", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    await ctx.reply(await abortSelected(ctx.chat.id));
  });
  bot.callbackQuery(/^use:(.+)$/, async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    const session = liveSessions().find((item) => item.id === ctx.match[1]);
    if (!session) return void await ctx.answerCallbackQuery({ text: "Session is no longer running." });
    select(ctx.chat!.id, session.id);
    await ctx.answerCallbackQuery({ text: "Selected" });
    await ctx.editMessageText(`Selected: ${label(session)}\n${session.cwd}`);
  });
  bot.on("message:text", async (ctx) => {
    if (!authorized(ctx.from?.id) || ctx.message.text.startsWith("/")) return;
    await ctx.reply(await route(ctx.chat.id, ctx.message.text));
  });
  bot.catch(() => {
    // A bad update or transient Telegram error must not kill the bridge.
  });

  const startPolling = (): void => {
    if (polling || shuttingDown || !acquireLock()) return;
    polling = true;
    void bot.api.setMyCommands([
      { command: "sessions", description: "List and select live Pi sessions" },
      { command: "status", description: "Show the selected Pi session" },
      { command: "abort", description: "Stop the selected session's current turn" },
      { command: "help", description: "Show Telecode help" },
    ]).catch(() => {});
    void bot.start({ allowed_updates: ["message", "callback_query"] }).catch(() => {}).finally(() => {
      polling = false;
      releaseLock();
    });
  };

  const startServer = async (): Promise<void> => {
    if (server) return;
    server = createServer((request, response) => {
      if (request.headers["x-telecode-secret"] !== secret) {
        response.writeHead(403).end();
        return;
      }
      if (request.method === "POST" && request.url === "/abort") {
        context?.abort();
        response.writeHead(202).end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/message") {
        response.writeHead(404).end();
        return;
      }
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
        if (body.length > 65_536) request.destroy();
      });
      request.on("end", () => {
        try {
          const message = JSON.parse(body) as { chatId: number; text: string };
          if (!Number.isSafeInteger(message.chatId) || typeof message.text !== "string" || !message.text.trim()) throw new Error();
          lastActivity = Date.now();
          const content = `[Telegram:${message.chatId}] ${message.text.trim()}`;
          pi.sendUserMessage(content, context?.isIdle() ? undefined : { deliverAs: "followUp" });
          saveRegistry();
          response.writeHead(202).end();
        } catch {
          response.writeHead(400).end();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Telecode could not open its local session port");
    port = address.port;
  };

  pi.registerCommand("telecode", {
    description: "Show Telecode phone bridge status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(`${polling ? "Connected" : "Standby"} · ${liveSessions().length} live session(s)`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    context = ctx;
    startedAt = Date.now();
    lastActivity = startedAt;
    await startServer();
    saveRegistry();
    heartbeat = setInterval(saveRegistry, 5000);
    leaderCheck = setInterval(startPolling, 3000);
    startPolling();
  });
  pi.on("session_info_changed", () => saveRegistry());
  pi.on("before_agent_start", (event) => {
    lastActivity = Date.now();
    if (event.messageType === "user") {
      const match = event.prompt.match(TELEGRAM_PREFIX);
      remoteChat = match ? Number(match[1]) : undefined;
      responseText = "";
    }
    saveRegistry();
  });
  pi.on("message_end", (event) => {
    const text = assistantText(event.message);
    if (text) responseText = text;
  });
  pi.on("agent_settled", async () => {
    saveRegistry();
    if (remoteChat !== undefined) {
      const chatId = remoteChat;
      remoteChat = undefined;
      await send(chatId, responseText).catch(() => {});
    }
  });
  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    if (heartbeat) clearInterval(heartbeat);
    if (leaderCheck) clearInterval(leaderCheck);
    rmSync(registryPath, { force: true });
    if (polling) await bot.stop().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    releaseLock();
  });
}
