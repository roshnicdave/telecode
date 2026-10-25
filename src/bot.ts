// Telegram bot (grammY) frontend for the telecode session store.

import { Bot, InlineKeyboard, InputFile } from "grammy";
import { escapeHtml, packBlocks, relTime, textToBlocks, truncate } from "./format.js";
import type { Session, Store } from "./store.js";

const HTML = { parse_mode: "HTML" } as const;

export interface BotHandle {
  bot: Bot;
  knownChatIds: Set<number>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function sessionTitle(s: Session): string {
  return s.title || s.id.slice(0, 8);
}

function shortModel(m: string): string {
  const last = m.split("/").pop() || m;
  return truncate(last, 24);
}

function sessionLabel(s: Session, i: number): string {
  const parts = [`${i + 1}. ${truncate(sessionTitle(s), 40)}`];
  if (s.model) parts.push(shortModel(s.model));
  parts.push(relTime(s.updatedAt));
  return parts.join(" · ");
}

function panelText(s: Session): string {
  const lines = [`<b>${escapeHtml(sessionTitle(s))}</b>`];
  if (s.directory) lines.push(`<code>${escapeHtml(s.directory)}</code>`);
  lines.push(escapeHtml(s.model || "default model"));
  if (s.pending.length) lines.push(`${s.pending.length} pending`);
  if (s.interrupted) lines.push("interrupted");
  lines.push(relTime(s.updatedAt));
  return lines.join("\n");
}

export function createBot(
  store: Store,
  token: string,
  allowedIds: string,
  models: string[],
): BotHandle {
  const allowed = new Set(
    String(allowedIds)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
  const ALLOW_ALL = allowed.size === 0;
  const bot = new Bot(token);
  const knownChatIds = new Set<number>();

  const active = new Map<number, string>(); // chatId -> sessionId
  const ui = new Map<number, { sessions: Session[]; page: number; searching: boolean }>();
  const pendingModel = new Map<number, { sessionId: string; items: string[] }>();

  const err = (e: unknown) => `<code>${escapeHtml(String((e as Error)?.message ?? e))}</code>`;

  async function sendBlocks(
    ctx: { chat: { id: number }; reply: (t: string, o?: unknown) => Promise<unknown>; api: Bot["api"] },
    blocks: { html: string }[],
    editMessageId?: number,
  ) {
    const chunks = packBlocks(blocks);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0 && editMessageId) {
        await ctx.api
          .editMessageText(ctx.chat.id, editMessageId, chunks[i], HTML)
          .catch(async () => ctx.reply(chunks[i], HTML));
      } else {
        await ctx.reply(chunks[i], HTML);
      }
    }
  }

  function panelKeyboard(sessionId: string): InlineKeyboard {
    return new InlineKeyboard()
      .text("View", `view:${sessionId}`)
      .text("Interrupt", `interrupt:${sessionId}`)
      .row()
      .text("Compact", `compact:${sessionId}`)
      .text("Model", `model:${sessionId}`)
      .row()
      .text("Export", `export:${sessionId}`)
      .text("Delete", `delete:${sessionId}`)
      .row()
      .text("Sessions", "sessions")
      .text("Leave", "leave");
  }

  async function showSessions(
    ctx: { chat: { id: number }; reply: (t: string, o?: unknown) => Promise<unknown>; editMessageText: (t: string, o?: unknown) => Promise<unknown> },
    opts: { edit?: boolean; append?: boolean } = {},
  ) {
    const u = ui.get(ctx.chat.id) ?? { sessions: [], page: 0, searching: false };
    u.searching = false;
    const all = store.list();
    const pageSize = 5;
    const start = opts.append ? u.page * pageSize : 0;
    u.sessions = opts.append ? u.sessions.concat(all.slice(start, start + pageSize)) : all.slice(0, pageSize);
    u.page = Math.floor((opts.append ? u.page : 0) + 1);
    ui.set(ctx.chat.id, u);

    if (!u.sessions.length) {
      const txt = "No sessions.";
      if (opts.edit) await ctx.editMessageText(txt).catch(() => {});
      else await ctx.reply(txt);
      return;
    }

    const kb = new InlineKeyboard();
    u.sessions.forEach((s, i) => kb.text(sessionLabel(s, i), `open:${s.id}`).row());
    kb.text("Search", "search").text("New", "new").row();
    const hasMore = u.sessions.length < all.length;
    kb.text(hasMore ? "More" : "Refresh", hasMore ? "loadmore" : "sessions");

    const text = `<b>Sessions</b> (${u.sessions.length}${hasMore ? "+" : ""})`;
    const o = { parse_mode: "HTML", reply_markup: kb };
    if (opts.edit) await ctx.editMessageText(text, o).catch(async () => ctx.reply(text, o));
    else await ctx.reply(text, o);
  }

  async function searchSessions(
    ctx: { chat: { id: number }; reply: (t: string, o?: unknown) => Promise<unknown> },
    query: string,
  ) {
    const q = query.toLowerCase();
    const hits = store.list().filter((s) => (s.title || "").toLowerCase().includes(q));
    if (!hits.length) return ctx.reply("No matches.");
    const kb = new InlineKeyboard();
    hits.slice(0, 10).forEach((s, i) => kb.text(sessionLabel(s, i), `open:${s.id}`).row());
    kb.text("Back", "sessions");
    await ctx.reply(`${hits.length} result(s)`, { parse_mode: "HTML", reply_markup: kb });
  }

  function openSession(
    ctx: { chat: { id: number }; reply: (t: string, o?: unknown) => Promise<unknown>; editMessageText: (t: string, o?: unknown) => Promise<unknown> },
    id: string,
    opts: { edit?: boolean } = {},
  ) {
    const s = store.get(id);
    if (!s) return ctx.reply(err(new Error("session not found")));
    active.set(ctx.chat.id, id);
    const o = { parse_mode: "HTML", reply_markup: panelKeyboard(id) };
    if (opts.edit) return ctx.editMessageText(panelText(s), o).catch(() => ctx.reply(panelText(s), o));
    return ctx.reply(panelText(s), o);
  }

  function newSession(ctx: { chat: { id: number }; reply: (t: string, o?: unknown) => Promise<unknown> }) {
    const s = store.create();
    active.set(ctx.chat.id, s.id);
    return ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(s.id) });
  }

  // ---- auth gate ----
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (id !== undefined) knownChatIds.add(id);
    if (!ALLOW_ALL && (id === undefined || !allowed.has(id))) {
      return;
    }
    await next();
  });

  // ---- commands ----
  bot.command("start", async (ctx) => {
    const a = active.get(ctx.chat.id);
    const s = a ? store.get(a) : undefined;
    const lines = ["<b>Telecode</b>"];
    if (s) {
      lines.push(`Active: <b>${escapeHtml(sessionTitle(s))}</b>`);
      if (s.model) lines.push(escapeHtml(shortModel(s.model)));
      if (s.directory) lines.push(`<code>${escapeHtml(s.directory)}</code>`);
    } else {
      lines.push("No active session.");
    }
    await ctx.reply(lines.join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("Sessions", "sessions").text("New", "new"),
    });
  });

  bot.command("sessions", (ctx) => showSessions(ctx));
  bot.command("new", (ctx) => newSession(ctx));
  bot.command("leave", (ctx) => {
    active.delete(ctx.chat.id);
    ctx.reply("Left.");
  });

  // ---- free text -> active session ----
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;
    const u = ui.get(ctx.chat.id);
    if (u?.searching) {
      u.searching = false;
      ui.set(ctx.chat.id, u);
      return searchSessions(ctx, text);
    }
    const sid = active.get(ctx.chat.id);
    if (!sid) {
      return ctx.reply("Pick a session:", {
        reply_markup: new InlineKeyboard().text("Sessions", "sessions"),
      });
    }
    const s = store.get(sid);
    if (!s) return ctx.reply(err(new Error("session not found")));
    store.addMessage(sid, { role: "user", content: text });
    store.addPending(sid, text);
    await ctx.reply("Queued.", HTML);
  });

  // ---- inline callbacks ----
  bot.on("callback_query:data", async (ctx, next) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await next();
  });

  bot.callbackQuery("sessions", (ctx) => showSessions(ctx, { edit: true }));
  bot.callbackQuery("loadmore", (ctx) => showSessions(ctx, { edit: true, append: true }));

  bot.callbackQuery("search", async (ctx) => {
    const u = ui.get(ctx.chat.id) ?? { sessions: [], page: 0, searching: false };
    u.searching = true;
    ui.set(ctx.chat.id, u);
    await ctx.reply("Search:");
  });

  bot.callbackQuery("new", (ctx) => newSession(ctx));
  bot.callbackQuery("leave", (ctx) => {
    active.delete(ctx.chat.id);
    ctx.reply("Left.");
  });

  bot.callbackQuery(/^open:(.+)$/, (ctx) => openSession(ctx, ctx.match[1], { edit: true }));
  bot.callbackQuery(/^refresh:(.+)$/, (ctx) => openSession(ctx, ctx.match[1], { edit: true }));

  bot.callbackQuery(/^view:(.+)$/, async (ctx) => {
    const s = store.get(ctx.match[1]);
    if (!s) return ctx.reply(err(new Error("session not found")));
    const msgs = s.messages.slice(-24);
    const blocks: { html: string }[] = [];
    for (const m of msgs) {
      const who = m.role === "user" ? "You" : m.role === "assistant" ? "Assistant" : m.role;
      blocks.push({ html: `<b>${escapeHtml(who)}</b>` });
      blocks.push(...textToBlocks(m.content));
    }
    if (!blocks.length) return ctx.reply("(empty)", HTML);
    await sendBlocks(ctx, blocks);
  });

  bot.callbackQuery(/^interrupt:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    try {
      store.update(id, (s) => (s.interrupted = true));
      await ctx.reply("Interrupted.");
    } catch (e) {
      await ctx.reply(err(e), HTML);
    }
  });

  bot.callbackQuery(/^compact:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    try {
      store.update(id, (s) => (s.compactRequested = true));
      await ctx.reply("Compacted.");
    } catch (e) {
      await ctx.reply(err(e), HTML);
    }
  });

  bot.callbackQuery(/^delete:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const kb = new InlineKeyboard().text("Delete", `deleteok:${id}`).text("Cancel", `refresh:${id}`);
    await ctx.reply("Delete this session?", { reply_markup: kb });
  });

  bot.callbackQuery(/^deleteok:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    store.remove(id);
    if (active.get(ctx.chat.id) === id) active.delete(ctx.chat.id);
    await ctx.reply("Deleted.");
  });

  bot.callbackQuery(/^export:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const s = store.get(id);
    if (!s) return ctx.reply(err(new Error("session not found")));
    const name = `session-${id}.json`;
    await ctx.replyWithDocument(new InputFile(Buffer.from(JSON.stringify(s, null, 2), "utf8"), name), { caption: name });
  });

  bot.callbackQuery(/^model:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    const s = store.get(id);
    if (!s) return ctx.reply(err(new Error("session not found")));
    if (!models.length) return ctx.reply("No models configured.", HTML);
    pendingModel.set(ctx.chat.id, { sessionId: id, items: models });
    const kb = new InlineKeyboard();
    models.slice(0, 30).forEach((m, i) => {
      const isCur = s.model === m;
      kb.text(truncate(`${isCur ? "* " : ""}${m}`, 50), `pick:${i}`).row();
    });
    kb.text("Back", `refresh:${id}`);
    await ctx.reply("Model", { parse_mode: "HTML", reply_markup: kb });
  });

  bot.callbackQuery(/^pick:(\d+)$/, async (ctx) => {
    const p = pendingModel.get(ctx.chat.id);
    if (!p) return;
    const m = p.items[Number(ctx.match[1])];
    if (!m) return;
    try {
      store.update(p.sessionId, (s) => (s.model = m));
      await ctx.reply(`Model: ${escapeHtml(m)}`, HTML);
    } catch (e) {
      await ctx.reply(err(e), HTML);
    }
    pendingModel.delete(ctx.chat.id);
  });

  bot.catch((err2) => {
    console.error("[telecode] bot error:", err2.error?.message ?? err2.message ?? err2);
  });

  return {
    bot,
    knownChatIds,
    async start() {
      await bot.start({ drop_pending_updates: true });
    },
    async stop() {
      await bot.stop();
    },
  };
}
