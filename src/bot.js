import { Bot, InlineKeyboard, InputFile } from "grammy";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as oc from "./opencode.js";
import { escapeHtml, relTime, textToBlocks, packBlocks } from "./format.js";

// ---------- state ----------
const DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));
const STATE_FILE = `${DATA_DIR}/state.json`;
mkdirSync(DATA_DIR, { recursive: true });

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env");
  process.exit(1);
}

const allowed = new Set(
  (process.env.TELEGRAM_ALLOWED_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
);
const ALLOW_ALL = allowed.size === 0;

let state = { chats: {} };
try {
  state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch {}
function save() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}
function getChat(id) {
  return state.chats[String(id)] ?? {};
}
function setChat(id, patch) {
  state.chats[String(id)] = { ...getChat(id), ...patch };
  save();
}

const ui = new Map(); // chatId -> { sessions, nextCursor, searching }
const pending = new Map(); // chatId -> { kind: "model" | "agent", sessionId, items }

const bot = new Bot(token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// ---------- helpers ----------
function sessionTitle(s) {
  if (s.title) return s.title;
  const dir = s.location?.directory;
  if (dir) return dir.split("/").filter(Boolean).pop() || dir;
  return s.id.slice(0, 8);
}
function sessionModel(s) {
  const m = s.model;
  if (!m) return "default";
  return m.variant ? `${m.providerID}/${m.id}#${m.variant}` : `${m.providerID}/${m.id}`;
}
function sessionLabel(s, i) {
  return `${i + 1}. ${truncate(sessionTitle(s), 40)} · ${relTime(s.time?.updated)}`;
}

function panelText(s) {
  const lines = [`🗂 <b>${escapeHtml(sessionTitle(s))}</b>`];
  if (s.location?.directory) lines.push(`📁 <code>${escapeHtml(s.location.directory)}</code>`);
  lines.push(`🧠 ${escapeHtml(sessionModel(s))}`);
  if (s.agent) lines.push(`🤖 ${escapeHtml(s.agent)}`);
  if (s.time?.updated) lines.push(`🕐 ${escapeHtml(relTime(s.time.updated))}`);
  return lines.join("\n");
}

function panelKeyboard(sessionId) {
  return new InlineKeyboard()
    .text("👁 View", `view:${sessionId}`)
    .text("⏹ Interrupt", `interrupt:${sessionId}`)
    .row()
    .text("🧹 Compact", `compact:${sessionId}`)
    .text("🔀 Model", `model:${sessionId}`)
    .row()
    .text("🤖 Agent", `agent:${sessionId}`)
    .text("⬇️ Export", `export:${sessionId}`)
    .row()
    .text("🔁 Refresh", `refresh:${sessionId}`)
    .text("🗑 Delete", `delete:${sessionId}`)
    .row()
    .text("📂 Sessions", "sessions")
    .text("🚪 Leave", "leave");
}

function messageToBlocks(m) {
  const out = [];
  if (m.type === "user") {
    out.push({ html: "<b>👤 You</b>" });
    if (m.text) out.push(...textToBlocks(m.text));
  } else if (m.type === "assistant") {
    out.push({ html: "<b>🤖 Assistant</b>" });
    const text = (m.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const tools = (m.content ?? []).filter((c) => c.type === "tool");
    if (text) out.push(...textToBlocks(text));
    if (tools.length) out.push({ html: `<i>🛠 ${tools.length} tool call(s)</i>` });
    if (m.error) out.push({ html: `<b>⚠️ ${escapeHtml(String(m.error?.message ?? m.error))}</b>` });
  }
  return out;
}

async function sendBlocks(ctx, blocks, { editMessageId } = {}) {
  const chunks = packBlocks(blocks);
  if (!chunks.length) return;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (i === 0 && editMessageId) {
      await ctx.api
        .editMessageText(ctx.chat.id, editMessageId, chunk, { parse_mode: "HTML" })
        .catch(async () => ctx.reply(chunk, { parse_mode: "HTML" }));
    } else {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    }
  }
}

// ---------- session list (buttons only) ----------
async function showSessions(ctx, { edit = false, append = false } = {}) {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
  const u = ui.get(ctx.chat.id) ?? { sessions: [], nextCursor: null, searching: false };
  u.searching = false;
  try {
    const page =
      append && u.nextCursor
        ? await oc.listSessions({ limit: 5, cursor: u.nextCursor })
        : await oc.listSessions({ limit: 5 });
    u.sessions = append ? u.sessions.concat(page.data) : page.data;
    u.nextCursor = page.cursor?.next ?? null;
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    return;
  }
  ui.set(ctx.chat.id, u);

  if (!u.sessions.length) {
    const txt = "No sessions yet.";
    if (edit) await ctx.editMessageText(txt).catch(() => {});
    else await ctx.reply(txt);
    return;
  }

  const kb = new InlineKeyboard();
  u.sessions.forEach((s, i) => kb.text(sessionLabel(s, i), `open:${s.id}`).row());
  kb.text("🔍 Search", "search").text("➕ New", "new").row();
  kb.text(u.nextCursor ? "⬇️ Load more" : "🔁 Refresh", u.nextCursor ? "loadmore" : "sessions");

  const text = `🗂 <b>Sessions</b> (${u.sessions.length})`;
  const opts = { parse_mode: "HTML", reply_markup: kb };
  if (edit) await ctx.editMessageText(text, opts).catch(async () => ctx.reply(text, opts));
  else await ctx.reply(text, opts);
}

async function searchSessions(ctx, query) {
  let page;
  try {
    page = await oc.listSessions({ limit: 10, search: query });
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    return;
  }
  if (!page.data.length) {
    await ctx.reply("No matches.");
    return;
  }
  const kb = new InlineKeyboard();
  page.data.forEach((s, i) => kb.text(sessionLabel(s, i), `open:${s.id}`).row());
  kb.text("‹ Back", "sessions");
  await ctx.reply(`🔍 ${page.data.length} result(s)`, { parse_mode: "HTML", reply_markup: kb });
}

// ---------- send a prompt and wait for the reply ----------
async function handlePrompt(ctx, sessionId, text) {
  const info = await oc.getSession(sessionId).catch(() => null);
  const name = info?.title || sessionId.slice(0, 8);
  await ctx.replyWithChatAction("typing").catch(() => {});

  const placeholder = await ctx.reply(`🤖 <i>thinking</i>… <code>${escapeHtml(name)}</code>`, {
    parse_mode: "HTML",
  });

  const before = await oc.getMessages(sessionId, { limit: 1, order: "desc" }).catch(() => []);
  const beforeId = before[0]?.id;
  const sentAt = Date.now();

  try {
    await oc.sendPrompt(sessionId, text);
  } catch (e) {
    await ctx.api
      .editMessageText(
        ctx.chat.id,
        placeholder.message_id,
        `❌ <b>Send failed</b>\n<code>${escapeHtml(String(e.message))}</code>`,
        { parse_mode: "HTML" },
      )
      .catch(() => {});
    return;
  }

  const started = Date.now();
  const deadline = started + 5 * 60 * 1000;
  let lastTick = 0;
  let result = null;

  while (Date.now() < deadline) {
    const msgs = await oc.getMessages(sessionId, { limit: 10, order: "desc" }).catch(() => []);
    for (const m of msgs) {
      if (m.id === beforeId) break;
      if (m.type === "assistant" && m.finish && m.finish !== "tool-calls" && (m.time?.created ?? 0) >= sentAt) {
        result = m;
        break;
      }
    }
    if (result) break;
    if (Date.now() - lastTick > 12000) {
      lastTick = Date.now();
      const secs = Math.round((Date.now() - started) / 1000);
      await ctx.api
        .editMessageText(ctx.chat.id, placeholder.message_id, `🤖 <i>working</i>… ${secs}s <code>${escapeHtml(name)}</code>`, {
          parse_mode: "HTML",
        })
        .catch(() => {});
    }
    await sleep(1500);
  }

  const blocks = [];
  if (result) {
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    const tools = (result.content ?? []).filter((c) => c.type === "tool");
    if (text) blocks.push(...textToBlocks(text));
    else if (tools.length) blocks.push({ html: `<i>🛠 Ran ${tools.length} tool call(s)</i>` });
    else blocks.push({ html: "✅ <i>Done</i>" });
    if (result.error) blocks.push({ html: `<b>⚠️ ${escapeHtml(String(result.error?.message ?? result.error))}</b>` });
  } else {
    blocks.push({ html: "⏱ <i>Timed out</i>" });
  }
  await sendBlocks(ctx, blocks, { editMessageId: placeholder.message_id });
}

// ---------- auth gate ----------
bot.use(async (ctx, next) => {
  if (!ALLOW_ALL && !allowed.has(ctx.from?.id)) {
    await ctx.reply("⛔️").catch(() => {});
    return;
  }
  await next();
});

// ---------- commands ----------
bot.command("start", async (ctx) => {
  const chat = getChat(ctx.chat.id);
  const kb = new InlineKeyboard().text("📂 Sessions", "sessions").text("➕ New", "new");
  const active = chat.sessionId ? `\n🎯 <b>${escapeHtml(chat.title || chat.sessionId)}</b>` : "";
  await ctx.reply(`👋 <b>Telecode</b>${active}`, { parse_mode: "HTML", reply_markup: kb });
});

bot.command("sessions", (ctx) => showSessions(ctx));

bot.command("new", async (ctx) => {
  const dir = ctx.message.text.replace(/^\/new(?:@\w+)?\s*/, "").trim();
  try {
    const s = await oc.createSession({ directory: dir || undefined });
    setChat(ctx.chat.id, { sessionId: s.id, title: s.title });
    await ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(s.id) });
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.command("leave", (ctx) => {
  setChat(ctx.chat.id, { sessionId: null });
  ctx.reply("🚪");
});

// ---------- free text → active session (or search) ----------
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  if (text.startsWith("/")) return;
  const u = ui.get(ctx.chat.id);
  if (u?.searching) {
    u.searching = false;
    ui.set(ctx.chat.id, u);
    await searchSessions(ctx, text);
    return;
  }
  const chat = getChat(ctx.chat.id);
  if (!chat.sessionId) {
    await ctx.reply("Pick a session:", {
      reply_markup: new InlineKeyboard().text("📂 Sessions", "sessions"),
    });
    return;
  }
  await handlePrompt(ctx, chat.sessionId, text);
});

// ---------- inline callbacks ----------
bot.callbackQuery("sessions", (ctx) => showSessions(ctx, { edit: true }));

bot.callbackQuery("loadmore", (ctx) => showSessions(ctx, { edit: true, append: true }));

bot.callbackQuery("search", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  const u = ui.get(ctx.chat.id) ?? { sessions: [], nextCursor: null, searching: false };
  u.searching = true;
  ui.set(ctx.chat.id, u);
  await ctx.reply("🔍 Search:");
});

bot.callbackQuery("new", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const s = await oc.createSession({});
    setChat(ctx.chat.id, { sessionId: s.id, title: s.title });
    await ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(s.id) });
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery("leave", async (ctx) => {
  await ctx.answerCallbackQuery().catch(() => {});
  setChat(ctx.chat.id, { sessionId: null });
  await ctx.reply("🚪");
});

bot.callbackQuery(/^open:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  let s;
  try {
    s = await oc.getSession(id);
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    return;
  }
  setChat(ctx.chat.id, { sessionId: id, title: sessionTitle(s) });
  await ctx
    .editMessageText(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(id) })
    .catch(async () => ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(id) }));
});

bot.callbackQuery(/^refresh:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  let s;
  try {
    s = await oc.getSession(id);
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    return;
  }
  setChat(ctx.chat.id, { sessionId: id, title: sessionTitle(s) });
  await ctx
    .editMessageText(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(id) })
    .catch(() => {});
});

bot.callbackQuery(/^view:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const msgs = await oc.getMessages(id, { limit: 24, order: "desc" });
    const blocks = [];
    for (const m of [...msgs].reverse()) blocks.push(...messageToBlocks(m));
    if (!blocks.length) {
      await ctx.reply("_(empty)_", { parse_mode: "HTML" });
      return;
    }
    await sendBlocks(ctx, blocks);
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^interrupt:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const r = await oc.interrupt(id);
    await ctx.reply(r?.interrupted ? "⏹" : "⏹");
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^compact:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    await oc.compact(id);
    await ctx.reply("🧹");
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  const kb = new InlineKeyboard().text("⚠️ Delete", `deleteok:${id}`).text("Cancel", `refresh:${id}`);
  await ctx.reply("🗑 Delete this session?", { reply_markup: kb });
});

bot.callbackQuery(/^deleteok:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    await oc.removeSession(id);
    if (getChat(ctx.chat.id).sessionId === id) setChat(ctx.chat.id, { sessionId: null });
    await ctx.reply("🗑");
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^export:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const data = await oc.exportSession(id);
    const name = `session-${id}.json`;
    await ctx.replyWithDocument(new InputFile(Buffer.from(JSON.stringify(data, null, 2), "utf8"), name), {
      caption: name,
    });
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const models = await oc.listModels();
    const cur = await oc.getSession(id).then((s) => s.model).catch(() => null);
    pending.set(ctx.chat.id, { kind: "model", sessionId: id, items: models });
    const kb = new InlineKeyboard();
    for (let i = 0; i < Math.min(models.length, 30); i++) {
      const m = models[i];
      const mark = cur && cur.id === m.id && cur.providerID === m.providerID ? "✅ " : "";
      kb.text(truncate(`${mark}${m.name ?? `${m.providerID}/${m.id}`}`, 50), `pick:${i}`).row();
    }
    kb.text("‹ Back", `refresh:${id}`);
    await ctx.reply("🔀 Model", { parse_mode: "HTML", reply_markup: kb });
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^agent:(.+)$/, async (ctx) => {
  const id = ctx.match[1];
  await ctx.answerCallbackQuery().catch(() => {});
  try {
    const agents = await oc.listAgents();
    const cur = await oc.getSession(id).then((s) => s.agent).catch(() => null);
    pending.set(ctx.chat.id, { kind: "agent", sessionId: id, items: agents });
    const kb = new InlineKeyboard();
    for (let i = 0; i < Math.min(agents.length, 30); i++) {
      const a = agents[i];
      const mark = cur === a.id ? "✅ " : "";
      kb.text(truncate(`${mark}${a.name ?? a.id}`, 50), `pick:${i}`).row();
    }
    kb.text("‹ Back", `refresh:${id}`);
    await ctx.reply("🤖 Agent", { parse_mode: "HTML", reply_markup: kb });
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
  const idx = Number(ctx.match[1]);
  await ctx.answerCallbackQuery().catch(() => {});
  const p = pending.get(ctx.chat.id);
  if (!p || !p.items[idx]) return;
  try {
    if (p.kind === "model") {
      const m = p.items[idx];
      await oc.switchModel(p.sessionId, { id: m.id, providerID: m.providerID });
      await ctx.reply(`🔀 ${escapeHtml(m.name ?? `${m.providerID}/${m.id}`)}`, { parse_mode: "HTML" });
    } else {
      const a = p.items[idx];
      await oc.switchAgent(p.sessionId, a.id);
      await ctx.reply(`🤖 ${escapeHtml(a.name ?? a.id)}`, { parse_mode: "HTML" });
    }
    pending.delete(ctx.chat.id);
  } catch (e) {
    await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
  }
});

// ---------- boot ----------
bot.catch((err) => {
  console.error("Bot error:", err.error?.message ?? err.message ?? err);
});

export async function startBot() {
  await bot.api.setMyCommands([
    { command: "start", description: "Home" },
    { command: "sessions", description: "List sessions" },
    { command: "new", description: "New session" },
    { command: "leave", description: "Leave active session" },
  ]);
  console.log("🤖 Telecode starting…");
  if (ALLOW_ALL) console.warn("⚠️ TELEGRAM_ALLOWED_IDS not set — bot is open to anyone.");
  await bot.start();
}
