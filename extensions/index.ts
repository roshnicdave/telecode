import {
  existsSync,
  mkdirSync,
  readlinkSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
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
  model?: ModelRecord;
  models?: ModelRecord[];
};

type ModelRecord = {
  provider: string;
  id: string;
  name: string;
};

type ModelState = {
  current?: ModelRecord;
  models: ModelRecord[];
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

function lockOwner(): number {
  try {
    return Number(readlinkSync(LOCK));
  } catch {
    try {
      return Number(readFileSync(LOCK, "utf8").trim());
    } catch {
      return 0;
    }
  }
}

function acquireLock(): boolean {
  mkdirSync(DATA, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      symlinkSync(String(process.pid), LOCK);
      return true;
    } catch {
      const owner = lockOwner();
      if (owner && processAlive(owner)) return owner === process.pid;
      if (lockOwner() === owner) {
        try {
          unlinkSync(LOCK);
        } catch {
          // Another session already replaced or removed the stale lock.
        }
      }
    }
  }
  return false;
}

function releaseLock(): void {
  try {
    if (lockOwner() === process.pid) unlinkSync(LOCK);
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

function modelLabel(model: ModelRecord): string {
  return `${model.name} · ${model.provider}/${model.id}`;
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

export function normalizeSessionName(value: string): string | undefined {
  const name = value.trim().replace(/\s+/g, " ");
  if (!name || name.length > 50 || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)) return undefined;
  return name;
}

function executable(envName: string, candidates: string[], fallback: string): string {
  const configured = process.env[envName]?.trim();
  if (configured) return configured;
  return candidates.find(existsSync) ?? fallback;
}

function runFile(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 5000 }, (error) => error ? reject(error) : resolve());
  });
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export default function telecode(pi: ExtensionAPI): void {
  const botToken = readSecret("TELEGRAM_BOT_TOKEN", ".telegram_token");
  const allowed = parseAllowedIds(readSecret("TELEGRAM_ALLOWED_IDS", ".telegram_allowed_ids"));
  if (!botToken || allowed.size === 0) return;

  mkdirSync(SESSIONS, { recursive: true });
  const bot = new Bot(botToken);
  const secret = randomBytes(18).toString("hex");
  const registryPath = join(SESSIONS, `${process.pid}.json`);
  const cleanupFiles = (): void => {
    rmSync(registryPath, { force: true });
    releaseLock();
  };
  process.once("exit", cleanupFiles);
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

  const availableModels = (): ModelRecord[] => {
    if (!context) return [];
    const models = context.scopedModels.length
      ? context.scopedModels.map((item) => item.model)
      : context.modelRegistry.getAvailable();
    const unique = new Map<string, ModelRecord>();
    for (const model of models) {
      unique.set(`${model.provider}/${model.id}`, { provider: model.provider, id: model.id, name: model.name });
    }
    return [...unique.values()];
  };
  const currentModel = (): ModelRecord | undefined => context?.model
    ? { provider: context.model.provider, id: context.model.id, name: context.model.name }
    : undefined;
  const localModelState = (): ModelState => ({ current: currentModel(), models: availableModels() });

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
      model: currentModel(),
      models: availableModels(),
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

  const getModels = async (session: SessionRecord): Promise<ModelState | undefined> => {
    try {
      const response = await fetch(`http://127.0.0.1:${session.port}/models`, {
        headers: { "x-telecode-secret": session.secret },
        signal: AbortSignal.timeout(3000),
      });
      return response.ok ? await response.json() as ModelState : undefined;
    } catch {
      return undefined;
    }
  };

  const setModel = async (session: SessionRecord, model: ModelRecord): Promise<{ ok: boolean; message: string }> => {
    try {
      const response = await fetch(`http://127.0.0.1:${session.port}/model`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telecode-secret": session.secret },
        body: JSON.stringify({ provider: model.provider, id: model.id }),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json() as { message?: string };
      return { ok: response.ok, message: body.message ?? (response.ok ? "Model changed." : "Could not change model.") };
    } catch {
      return { ok: false, message: "That Pi session stopped responding." };
    }
  };

  const showModels = async (chatId: number): Promise<{ text: string; keyboard?: InlineKeyboard }> => {
    const session = selectedSession(chatId);
    if (!session) return { text: "No live Pi sessions. Create one with /new <name>." };
    const state = await getModels(session);
    if (!state?.models.length) return { text: "That session has no available models." };
    const keyboard = new InlineKeyboard();
    state.models.forEach((model, index) => {
      const selected = state.current?.provider === model.provider && state.current.id === model.id;
      keyboard.text(`${selected ? "✓ " : ""}${model.name}`, `model:${session.id}:${index}`).row();
    });
    const current = state.current ? modelLabel(state.current) : "none";
    return { text: `Models for ${label(session)}\nCurrent: ${current}`, keyboard };
  };

  const createSession = async (chatId: number, requestedName: string): Promise<string> => {
    const name = normalizeSessionName(requestedName);
    if (!name) return "Use /new <name>. Names may be 1–50 letters, numbers, spaces, dots, dashes, or underscores.";

    const before = liveSessions();
    if (before.some((session) => session.name?.toLowerCase() === name.toLowerCase())) {
      return `A live session named ${name} already exists. Use /sessions to select it.`;
    }

    const cwd = selectedSession(chatId)?.cwd ?? homedir();
    const knownIds = new Set(before.map((session) => session.id));
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "pi";
    const tmuxSession = `telecode-${slug}-${Date.now().toString(36)}`;
    const tmux = executable("TELECODE_TMUX_BINARY", ["/opt/homebrew/bin/tmux", "/usr/bin/tmux"], "tmux");
    const piCommand = executable("TELECODE_PI_BINARY", [join(homedir(), ".local", "bin", "pi")], "pi");

    try {
      await runFile(tmux, ["new-session", "-d", "-s", tmuxSession, "-c", cwd, piCommand, "--name", name]);
    } catch {
      return "Could not start Pi. Telecode needs tmux and the pi command installed on this computer.";
    }

    for (let attempt = 0; attempt < 40; attempt++) {
      await wait(250);
      const created = liveSessions().find((session) => !knownIds.has(session.id) && session.name === name);
      if (created) {
        select(chatId, created.id);
        return `Created and selected: ${label(created)}\n${created.cwd}`;
      }
    }
    return `Pi was launched as ${name}, but it did not register within 10 seconds. Try /sessions in a moment.`;
  };

  bot.command("start", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    await ctx.reply("Telecode is connected. Use /sessions, choose a Pi session, then send it a message.");
  });
  bot.command("help", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    await ctx.reply("/new <name> — create and select a Pi session\n/sessions — list and select live Pi sessions\n/models — choose its model\n/model — show its current model\n/status — show the selected session\n/abort — stop its current turn\n\nAny other text is sent to the selected session.");
  });
  bot.command("new", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    await ctx.reply(await createSession(ctx.chat.id, ctx.match));
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
  bot.command("model", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    const session = selectedSession(ctx.chat.id);
    if (!session) return void await ctx.reply("No live Pi sessions.");
    const state = await getModels(session);
    await ctx.reply(state?.current ? `Current: ${modelLabel(state.current)}` : "That session has no active model.");
  });
  bot.command("models", async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    const result = await showModels(ctx.chat.id);
    await ctx.reply(result.text, result.keyboard ? { reply_markup: result.keyboard } : undefined);
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
  bot.callbackQuery(/^model:([^:]+):(\d+)$/, async (ctx) => {
    if (!authorized(ctx.from?.id)) return;
    const session = liveSessions().find((item) => item.id === ctx.match[1]);
    if (!session) return void await ctx.answerCallbackQuery({ text: "Session is no longer running." });
    const state = await getModels(session);
    const model = state?.models[Number(ctx.match[2])];
    if (!model) return void await ctx.answerCallbackQuery({ text: "Model is no longer available." });
    const result = await setModel(session, model);
    await ctx.answerCallbackQuery({ text: result.message });
    if (result.ok) {
      const updated = await getModels(session);
      await ctx.editMessageText(`Models for ${label(session)}\nCurrent: ${updated?.current ? modelLabel(updated.current) : modelLabel(model)}`);
    }
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
      { command: "new", description: "Create and select a Pi session" },
      { command: "sessions", description: "List and select live Pi sessions" },
      { command: "models", description: "Choose the selected session's model" },
      { command: "model", description: "Show the selected session's model" },
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
      if (request.method === "GET" && request.url === "/models") {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(localModelState()));
        return;
      }
      if (request.method === "POST" && request.url === "/model") {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
          if (body.length > 16_384) request.destroy();
        });
        request.on("end", () => {
          void (async () => {
            try {
              const requested = JSON.parse(body) as { provider?: string; id?: string };
              if (!context?.isIdle()) {
                response.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ message: "Wait for the current turn to finish first." }));
                return;
              }
              const model = availableModels().find((item) => item.provider === requested.provider && item.id === requested.id);
              const resolved = model && context.modelRegistry.find(model.provider, model.id);
              if (!resolved) {
                response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Model is not available in this session." }));
                return;
              }
              if (!await pi.setModel(resolved)) {
                response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ message: `No configured credentials for ${model.provider}.` }));
                return;
              }
              lastActivity = Date.now();
              saveRegistry();
              response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: `Using ${model.name}.` }));
            } catch {
              response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ message: "Invalid model request." }));
            }
          })();
        });
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
    if (polling) await bot.stop().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    process.off("exit", cleanupFiles);
    cleanupFiles();
  });
}
