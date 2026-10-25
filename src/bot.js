import { Bot, InlineKeyboard, InputFile } from "grammy";
import { escapeHtml, relTime, textToBlocks, packBlocks } from "./format.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

export function createBot(api, token, allowedIds = "") {
  const allowed = new Set(
    String(allowedIds)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number),
  );
  const ALLOW_ALL = allowed.size === 0;
  const bot = new Bot(token);

  const active = new Map(); // chatId -> { sessionId, title }
  const ui = new Map(); // chatId -> { sessions, nextCursor, searching }
  const pending = new Map(); // chatId -> { kind, sessionId, items }

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
          ? await api.session.list({ limit: 5, cursor: u.nextCursor })
          : await api.session.list({ limit: 5 });
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
      page = await api.session.list({ limit: 10, search: query });
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
    const info = await api.session.get({ sessionID: sessionId }).catch(() => null);
    const name = info?.title || sessionId.slice(0, 8);
    await ctx.replyWithChatAction("typing").catch(() => {});

    const placeholder = await ctx.reply(`🤖 <i>thinking</i>… <code>${escapeHtml(name)}</code>`, {
      parse_mode: "HTML",
    });

    const before = await api.session.context({ sessionID: sessionId }).catch(() => []);
    const beforeCount = before.length;
    const sentAt = Date.now();

    try {
      await api.session.prompt({ sessionID: sessionId, text });
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

    const deadline = Date.now() + 5 * 60 * 1000;
    let lastTick = 0;
    let result = null;

    while (Date.now() < deadline) {
      const msgs = await api.session.context({ sessionID: sessionId }).catch(() => []);
      for (let i = msgs.length - 1; i >= beforeCount; i--) {
        const m = msgs[i];
        if (m.type === "assistant" && m.finish && m.finish !== "tool-calls" && (m.time?.created ?? 0) >= sentAt) {
          result = m;
          break;
        }
      }
      if (result) break;
      if (Date.now() - lastTick > 12000) {
        lastTick = Date.now();
        await ctx.api
          .editMessageText(ctx.chat.id, placeholder.message_id, `🤖 <i>working</i>… <code>${escapeHtml(name)}</code>`, {
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
    const a = active.get(ctx.chat.id);
    const kb = new InlineKeyboard().text("📂 Sessions", "sessions").text("➕ New", "new");
    const line = a ? `\n🎯 <b>${escapeHtml(a.title || a.sessionId)}</b>` : "";
    await ctx.reply(`👋 <b>Telecode</b>${line}`, { parse_mode: "HTML", reply_markup: kb });
  });

  bot.command("sessions", (ctx) => showSessions(ctx));

  bot.command("new", async (ctx) => {
    try {
      const s = await api.session.create({});
      active.set(ctx.chat.id, { sessionId: s.id, title: s.title });
      await ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(s.id) });
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    }
  });

  bot.command("leave", (ctx) => {
    active.delete(ctx.chat.id);
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
    const a = active.get(ctx.chat.id);
    if (!a) {
      await ctx.reply("Pick a session:", {
        reply_markup: new InlineKeyboard().text("📂 Sessions", "sessions"),
      });
      return;
    }
    await handlePrompt(ctx, a.sessionId, text);
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
      const s = await api.session.create({});
      active.set(ctx.chat.id, { sessionId: s.id, title: s.title });
      await ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(s.id) });
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery("leave", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    active.delete(ctx.chat.id);
    await ctx.reply("🚪");
  });

  bot.callbackQuery(/^open:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => {});
    let s;
    try {
      s = await api.session.get({ sessionID: id });
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
      return;
    }
    active.set(ctx.chat.id, { sessionId: id, title: sessionTitle(s) });
    await ctx
      .editMessageText(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(id) })
      .catch(async () => ctx.reply(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(id) }));
  });

  bot.callbackQuery(/^refresh:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => {});
    let s;
    try {
      s = await api.session.get({ sessionID: id });
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
      return;
    }
    active.set(ctx.chat.id, { sessionId: id, title: sessionTitle(s) });
    await ctx
      .editMessageText(panelText(s), { parse_mode: "HTML", reply_markup: panelKeyboard(id) })
      .catch(() => {});
  });

  bot.callbackQuery(/^view:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      const msgs = await api.session.context({ sessionID: id });
      const blocks = [];
      for (const m of msgs.slice(-24)) blocks.push(...messageToBlocks(m));
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
      await api.session.interrupt({ sessionID: id });
      await ctx.reply("⏹");
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^compact:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      await api.session.compact({ sessionID: id });
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
      await api.session.remove({ sessionID: id });
      if (active.get(ctx.chat.id)?.sessionId === id) active.delete(ctx.chat.id);
      await ctx.reply("🗑");
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    }
  });

  bot.callbackQuery(/^export:(.+)$/, async (ctx) => {
    const id = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => {});
    try {
      const info = await api.session.get({ sessionID: id });
      const messages = await api.session.context({ sessionID: id });
      const name = `session-${id}.json`;
      await ctx.replyWithDocument(new InputFile(Buffer.from(JSON.stringify({ info, messages }, null, 2), "utf8"), name), {
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
      const models = (await api.model.list()).data;
      const cur = await api.session.get({ sessionID: id }).then((s) => s.model).catch(() => null);
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
      const agents = (await api.agent.list()).data;
      const cur = await api.session.get({ sessionID: id }).then((s) => s.agent).catch(() => null);
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
        await api.session.switchModel({ sessionID: p.sessionId, model: { id: m.id, providerID: m.providerID } });
        await ctx.reply(`🔀 ${escapeHtml(m.name ?? `${m.providerID}/${m.id}`)}`, { parse_mode: "HTML" });
      } else {
        const a = p.items[idx];
        await api.session.switchAgent({ sessionID: p.sessionId, agent: a.id });
        await ctx.reply(`🤖 ${escapeHtml(a.name ?? a.id)}`, { parse_mode: "HTML" });
      }
      pending.delete(ctx.chat.id);
    } catch (e) {
      await ctx.reply(`❌ <code>${escapeHtml(String(e.message))}</code>`, { parse_mode: "HTML" });
    }
  });

  bot.catch((err) => {
    console.error("[telecode] bot error:", err.error?.message ?? err.message ?? err);
  });

  return bot;
}
