import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Model, Session } from "@opencode-ai/sdk/v2";
import {
  type ChatState, type ModelRef, type State, normalizeSessionName, parseAllowedIds,
  readJson, splitTelegram, visibleText, writeJson,
} from "./core.ts";

const HOME = homedir();
const DATA = join(HOME, ".telecode");
const STATE_FILE = join(DATA, "opencode-state.json");
const TOKEN_FILE = process.env.TELEGRAM_BOT_TOKEN_FILE || join(DATA, "telegram-token");
const IDS_FILE = process.env.TELEGRAM_ALLOWED_IDS_FILE || join(DATA, "telegram-allowed-ids");
const SERVER_PASSWORD_FILE = process.env.OPENCODE_SERVER_PASSWORD_FILE || join(DATA, "opencode-server-password");

function secret(env: string, file: string): string {
  return process.env[env]?.trim() || readFileSync(file, "utf8").trim();
}

const bot = new Bot(secret("TELEGRAM_BOT_TOKEN", TOKEN_FILE));
const allowed = parseAllowedIds(secret("TELEGRAM_ALLOWED_IDS", IDS_FILE));
const state = readJson<State>(STATE_FILE, { chats: {} });
const modelMenus = new Map<string, ModelRef[]>();
const running = new Set<string>();
const serverURL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4098";
const serverPassword = secret("OPENCODE_SERVER_PASSWORD", SERVER_PASSWORD_FILE);
const client = createOpencodeClient({
  baseUrl: serverURL,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` },
});

const authorized = (id?: number): boolean => id !== undefined && allowed.has(id);
const chatState = (chatID: number): ChatState => state.chats[String(chatID)] ??= {};
const save = (): void => writeJson(STATE_FILE, state);
const sessionLabel = (session: Session): string => `${session.title} · ${session.id.slice(-8)}`;
const modelLabel = (model: ModelRef): string => `${model.name} · ${model.providerID}/${model.modelID}`;

async function sessions(chatID: number): Promise<Session[]> {
  const result = await client.session.list({ directory: HOME, roots: true, limit: 30 }, { throwOnError: true });
  return result.data.filter((item) => !item.parentID && !item.time.archived).sort((a, b) => b.time.updated - a.time.updated);
}

async function selected(chatID: number): Promise<Session | undefined> {
  const current = chatState(chatID);
  const items = await sessions(chatID);
  const item = items.find((session) => session.id === current.sessionID) ?? items[0];
  if (item && current.sessionID !== item.id) { current.sessionID = item.id; save(); }
  return item;
}

async function availableModels(chatID: number): Promise<ModelRef[]> {
  const result = await client.provider.list({ directory: HOME }, { throwOnError: true });
  const preferred = new Set(["deepseek", "evil-qwen", "cloudflare-workers-ai"]);
  return result.data.all
    .filter((provider) => result.data.connected.includes(provider.id) || provider.source === "config" || preferred.has(provider.id))
    .flatMap((provider) => Object.values(provider.models).filter((model: Model) => model.status !== "deprecated").map((model: Model) => ({
      providerID: provider.id, modelID: model.id, name: model.name,
    })))
    .sort((a, b) => Number(preferred.has(b.providerID)) - Number(preferred.has(a.providerID)) || a.name.localeCompare(b.name));
}

async function send(chatID: number, text: string): Promise<void> {
  for (const chunk of splitTelegram(text || "OpenCode finished without a text response.")) await bot.api.sendMessage(chatID, chunk);
}

async function prompt(chatID: number, text: string): Promise<void> {
  const current = chatState(chatID);
  const session = await selected(chatID);
  if (!session) { await send(chatID, "No session here yet. Use /new <name>."); return; }
  if (running.has(session.id)) { await send(chatID, "That session is already working. Use /abort or wait for it to finish."); return; }
  running.add(session.id);
  await bot.api.sendChatAction(chatID, "typing").catch(() => {});
  try {
    const result = await client.session.prompt({
      sessionID: session.id,
      directory: HOME,
      model: current.model ? { providerID: current.model.providerID, modelID: current.model.modelID } : undefined,
      parts: [{ type: "text", text }],
    }, { throwOnError: true });
    await send(chatID, visibleText(result.data.parts));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await send(chatID, `OpenCode failed: ${message.slice(0, 700)}`);
  } finally {
    running.delete(session.id);
  }
}

bot.use(async (ctx, next) => { if (authorized(ctx.from?.id)) await next(); });
bot.command("start", (ctx) => ctx.reply("Telecode is connected to OpenCode. Use /new, /sessions, /models, or send a message."));
bot.command("help", (ctx) => ctx.reply([
  "/new <name> — create and select a session", "/sessions — select a session",
  "/models — pick a model", "/model — show the current model",
  "/status — show workspace and session", "/abort — stop the current turn", "", "Any other text goes to the selected OpenCode session.",
].join("\n")));
bot.command("new", async (ctx) => {
  const title = normalizeSessionName(ctx.match);
  if (!title) return void await ctx.reply("Use /new <name>.");
  const current = chatState(ctx.chat.id);
  const result = await client.session.create({
    directory: HOME, title,
    model: current.model ? { providerID: current.model.providerID, id: current.model.modelID } : undefined,
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
    metadata: { telecode: true },
  }, { throwOnError: true });
  current.sessionID = result.data.id; save();
  await ctx.reply(`Created and selected: ${sessionLabel(result.data)}\n${HOME}`);
});
bot.command("sessions", async (ctx) => {
  const items = await sessions(ctx.chat.id);
  if (!items.length) return void await ctx.reply("No OpenCode sessions in this workspace. Use /new <name>.");
  const keyboard = new InlineKeyboard(); items.slice(0, 20).forEach((item, index) => keyboard.text(sessionLabel(item), `s:${index}`).row());
  await ctx.reply("Choose a session:", { reply_markup: keyboard });
});
bot.callbackQuery(/^s:(\d+)$/, async (ctx) => {
  const items = await sessions(ctx.chat!.id); const item = items[Number(ctx.match[1])];
  if (!item) return void await ctx.answerCallbackQuery({ text: "Session list changed. Run /sessions again." });
  chatState(ctx.chat!.id).sessionID = item.id; save(); await ctx.answerCallbackQuery({ text: "Selected" });
  await ctx.editMessageText(`Selected: ${sessionLabel(item)}\n${item.directory}`);
});
bot.command("models", async (ctx) => {
  const models = await availableModels(ctx.chat.id); modelMenus.set(String(ctx.chat.id), models);
  if (!models.length) return void await ctx.reply("No configured models. Check OpenCode credentials.");
  const current = chatState(ctx.chat.id).model; const keyboard = new InlineKeyboard();
  models.slice(0, 45).forEach((model, index) => keyboard.text(`${current?.providerID === model.providerID && current.modelID === model.modelID ? "✓ " : ""}${model.name}`, `m:${index}`).row());
  await ctx.reply(current ? `Current: ${modelLabel(current)}` : "Choose a model:", { reply_markup: keyboard });
});
bot.callbackQuery(/^m:(\d+)$/, async (ctx) => {
  const model = modelMenus.get(String(ctx.chat!.id))?.[Number(ctx.match[1])];
  if (!model) return void await ctx.answerCallbackQuery({ text: "Model list expired. Run /models again." });
  chatState(ctx.chat!.id).model = model; save(); await ctx.answerCallbackQuery({ text: "Selected" });
  await ctx.editMessageText(`Using: ${modelLabel(model)}`);
});
bot.command("model", async (ctx) => { const model = chatState(ctx.chat.id).model; await ctx.reply(model ? modelLabel(model) : "Using the OpenCode default model."); });
bot.command("status", async (ctx) => { const item = await selected(ctx.chat.id); const current = chatState(ctx.chat.id); await ctx.reply(`Session: ${item ? sessionLabel(item) : "none"}\nModel: ${current.model ? modelLabel(current.model) : "OpenCode default"}`); });
bot.command("abort", async (ctx) => { const item = await selected(ctx.chat.id); if (!item) return void await ctx.reply("No selected session."); await client.session.abort({ sessionID: item.id, directory: item.directory }); await ctx.reply("Abort requested."); });
bot.on("message:text", (ctx) => { if (!ctx.message.text.startsWith("/")) void prompt(ctx.chat.id, ctx.message.text); });
bot.catch(({ error }) => console.error("telegram update failed", error));

await bot.api.setMyCommands([
  { command: "new", description: "Create an OpenCode session" }, { command: "sessions", description: "Select a session" },
  { command: "models", description: "Choose a model" },
  { command: "model", description: "Show the selected model" }, { command: "status", description: "Show current state" },
  { command: "abort", description: "Stop the current turn" }, { command: "help", description: "Show help" },
]);
const stop = async (): Promise<void> => { await bot.stop().catch(() => {}); };
process.once("SIGINT", () => void stop()); process.once("SIGTERM", () => void stop());
console.log(`Telecode OpenCode bridge ready (${serverURL})`);
await bot.start({ allowed_updates: ["message", "callback_query"] });
