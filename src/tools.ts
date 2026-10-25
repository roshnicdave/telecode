// MCP tool definitions and handlers. Any MCP-capable coding agent can call
// these to manage the shared session store and talk to Telegram.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { BotHandle } from "./bot.js";
import type { Store } from "./store.js";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function text(content: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }],
    isError,
  };
}

export function registerTools(server: Server, store: Store, handle: BotHandle): void {
  const tools: Tool[] = [
    {
      name: "list_sessions",
      description: "List sessions in the telecode store, newest first.",
      inputSchema: {
        type: "object",
        properties: { search: { type: "string", description: "Optional substring to filter titles." } },
      },
      handler: async (a) => {
        let sessions = store.list();
        if (typeof a.search === "string" && a.search) {
          const q = a.search.toLowerCase();
          sessions = sessions.filter((s) => (s.title || "").toLowerCase().includes(q));
        }
        return sessions.map((s) => ({
          id: s.id,
          title: s.title,
          directory: s.directory,
          model: s.model || null,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
          pendingCount: s.pending.length,
          interrupted: !!s.interrupted,
          compactRequested: !!s.compactRequested,
        }));
      },
    },
    {
      name: "create_session",
      description: "Create a new session and return its id.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          directory: { type: "string" },
          model: { type: "string" },
        },
      },
      handler: async (a) => {
        const s = store.create({
          title: typeof a.title === "string" ? a.title : undefined,
          directory: typeof a.directory === "string" ? a.directory : undefined,
          model: typeof a.model === "string" ? a.model : undefined,
        });
        return { id: s.id, title: s.title };
      },
    },
    {
      name: "get_session",
      description: "Get a single session by id.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: async (a) => {
        const s = store.get(String(a.sessionId));
        if (!s) throw new Error(`session not found: ${a.sessionId}`);
        return {
          id: s.id,
          title: s.title,
          directory: s.directory,
          model: s.model || null,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          messageCount: s.messages.length,
          pendingCount: s.pending.length,
          interrupted: !!s.interrupted,
          compactRequested: !!s.compactRequested,
        };
      },
    },
    {
      name: "get_history",
      description: "Get the message history of a session.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          limit: { type: "number", description: "Max messages to return, from the end." },
        },
        required: ["sessionId"],
      },
      handler: async (a) => {
        const s = store.get(String(a.sessionId));
        if (!s) throw new Error(`session not found: ${a.sessionId}`);
        const limit = typeof a.limit === "number" ? a.limit : undefined;
        const msgs = limit ? s.messages.slice(-limit) : s.messages;
        return msgs.map((m) => ({ id: m.id, role: m.role, content: m.content, model: m.model ?? null, time: m.time }));
      },
    },
    {
      name: "send_prompt",
      description:
        "Queue a user prompt for a session. The prompt is stored as pending; an agent should then process it and call complete_response.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          text: { type: "string" },
        },
        required: ["sessionId", "text"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        if (!store.get(id)) throw new Error(`session not found: ${id}`);
        store.addMessage(id, { role: "user", content: String(a.text) });
        const p = store.addPending(id, String(a.text));
        return { sessionId: id, pendingId: p.id, queued: true };
      },
    },
    {
      name: "get_pending",
      description: "List pending prompts awaiting an agent. Pass sessionId to scope to one session.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
      },
      handler: async (a) => {
        const id = typeof a.sessionId === "string" ? a.sessionId : undefined;
        const items = store.takePending(id);
        return items.flatMap(({ session, pending }) =>
          pending.map((p) => ({ sessionId: session.id, title: session.title, pendingId: p.id, text: p.text, time: p.time })),
        );
      },
    },
    {
      name: "complete_response",
      description:
        "Record the assistant's response to a session and clear its pending prompts. Call after processing pending work.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          content: { type: "string", description: "The assistant response text." },
          model: { type: "string" },
          pendingIds: { type: "array", items: { type: "string" }, description: "Specific pending ids to clear (default: all)." },
        },
        required: ["sessionId", "content"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        if (!store.get(id)) throw new Error(`session not found: ${id}`);
        store.addMessage(id, {
          role: "assistant",
          content: String(a.content),
          model: typeof a.model === "string" ? a.model : undefined,
        });
        const ids = Array.isArray(a.pendingIds) ? a.pendingIds.map(String) : undefined;
        store.clearPending(id, ids);
        return { sessionId: id, ok: true };
      },
    },
    {
      name: "append_message",
      description: "Append an arbitrary message to a session (e.g. tool output or a note).",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          role: { type: "string", description: "user | assistant | system | tool" },
          content: { type: "string" },
          model: { type: "string" },
        },
        required: ["sessionId", "role", "content"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        const role = String(a.role) as "user" | "assistant" | "system" | "tool";
        if (!store.get(id)) throw new Error(`session not found: ${id}`);
        const m = store.addMessage(id, { role, content: String(a.content), model: typeof a.model === "string" ? a.model : undefined });
        return { sessionId: id, messageId: m.id };
      },
    },
    {
      name: "interrupt",
      description: "Request that a session's running work be interrupted.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        store.update(id, (s) => (s.interrupted = true));
        return { sessionId: id, interrupted: true };
      },
    },
    {
      name: "compact",
      description: "Request that a session be compacted (summarized).",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        store.update(id, (s) => (s.compactRequested = true));
        return { sessionId: id, compactRequested: true };
      },
    },
    {
      name: "switch_model",
      description: "Set the model for a session.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" }, model: { type: "string" } },
        required: ["sessionId", "model"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        store.update(id, (s) => (s.model = String(a.model)));
        return { sessionId: id, model: String(a.model) };
      },
    },
    {
      name: "delete_session",
      description: "Delete a session.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: async (a) => {
        const id = String(a.sessionId);
        return { sessionId: id, deleted: store.remove(id) };
      },
    },
    {
      name: "export_session",
      description: "Export a session as JSON.",
      inputSchema: {
        type: "object",
        properties: { sessionId: { type: "string" } },
        required: ["sessionId"],
      },
      handler: async (a) => {
        const s = store.get(String(a.sessionId));
        if (!s) throw new Error(`session not found: ${a.sessionId}`);
        return s;
      },
    },
    {
      name: "send_telegram",
      description:
        'Send a message to a Telegram chat. chatId may be "me" (your configured id), a numeric chat id, or a username.',
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: 'Telegram chat id, or "me".' },
          text: { type: "string" },
        },
        required: ["text"],
      },
      handler: async (a) => {
        const text = String(a.text);
        const chatId = resolveChatId(handle, a.chatId);
        const sent = await handle.bot.api.sendMessage(chatId, text, { parse_mode: "HTML" });
        return { messageId: sent.message_id, chatId };
      },
    },
    {
      name: "get_chat_ids",
      description: "List Telegram chat ids the bot has seen, and the configured owner id (if any).",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ knownChatIds: [...handle.knownChatIds] }),
    },
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      return text(`Unknown tool: ${request.params.name}`, true);
    }
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await tool.handler(args);
      return text(result);
    } catch (e) {
      return text(String((e as Error)?.message ?? e), true);
    }
  });
}

function resolveChatId(handle: BotHandle, chatId: unknown): number | string {
  if (chatId === undefined || chatId === null || chatId === "me") {
    if (handle.knownChatIds.size === 1) return [...handle.knownChatIds][0];
    if (handle.knownChatIds.size > 1) throw new Error("Multiple chat ids known; pass an explicit chatId.");
    throw new Error("No chat id known yet; message the bot from Telegram first.");
  }
  const n = Number(chatId);
  if (!Number.isNaN(n) && String(chatId).trim() !== "") return n;
  return String(chatId);
}
