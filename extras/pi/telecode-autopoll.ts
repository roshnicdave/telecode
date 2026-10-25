// telecode-autopoll — makes Telegram messages feel like typing into Pi directly.
//
// The telecode bot only *queues* a prompt into the session store. This extension
// watches the store and, the moment a prompt lands, injects it into Pi as a real
// user message ("[Telegram] ..."), which starts a turn exactly like you typed it.
// The agent then replies on Telegram via the telecode MCP tools.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const POLL_MS = 3000;

function dataDir(): string {
  if (process.env.TELECODE_DATA_DIR) return process.env.TELECODE_DATA_DIR;
  if (process.env.PLUGIN_DATA) return join(process.env.PLUGIN_DATA, "data");
  return join(homedir(), ".telecode");
}

export default function (pi: ExtensionAPI) {
  let timer: ReturnType<typeof setInterval> | undefined;
  const seen = new Set<string>();

  const poll = () => {
    const dir = dataDir();
    const items: { sessionId: string; pendingId: string; text: string }[] = [];
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".json")) continue;
        try {
          const s = JSON.parse(readFileSync(join(dir, file), "utf8"));
          for (const p of s.pending || []) {
            items.push({ sessionId: s.id || "", pendingId: p.id || "", text: String(p.text || "") });
          }
        } catch {
          // ignore unreadable files
        }
      }
    } catch {
      // data dir missing
    }

    for (const it of items) {
      if (!it.pendingId || seen.has(it.pendingId)) continue;
      try {
        pi.sendUserMessage(`[Telegram] ${it.text}`);
        seen.add(it.pendingId);
      } catch {
        // Pi is busy; retry on the next poll.
      }
    }
    if (seen.size > 1000) seen.clear();
  };

  pi.on("session_start", () => {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, POLL_MS);
    poll();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
