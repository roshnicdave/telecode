import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
import { createBot } from "./src/bot.js";

const KEY = "__telecode";
const LOG = "/tmp/telecode-bot.log";
function log(m) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + m + "\n");
  } catch {}
}

export default Plugin.define({
  id: "telecode",
  async setup(ctx) {
    const options = (ctx.options ?? {});
    const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      log("no token configured, skipping");
      return;
    }
    const allowedIds = options.allowedIds ?? process.env.TELEGRAM_ALLOWED_IDS ?? "";

    // Single bot per service process. Plugin loads once per location, so the
    // first instance starts the bot and the last one to unload stops it.
    const g = globalThis;
    if (!g[KEY]) g[KEY] = { count: 0, stop: null };
    const refs = g[KEY];

    if (refs.stop) {
      refs.count += 1;
      log(`setup (already running) count=${refs.count}`);
      return () => {
        refs.count -= 1;
        log(`unload count=${refs.count}`);
      };
    }

    const bot = createBot(ctx, token, String(allowedIds));
    bot.start().catch((e) => log("bot error: " + (e?.message ?? e)));
    refs.stop = () => bot.stop().catch(() => {});
    refs.count = 1;
    log("bot started");

    return () => {
      refs.count -= 1;
      log(`unload count=${refs.count}`);
      if (refs.count <= 0 && refs.stop) {
        const stop = refs.stop;
        refs.stop = null;
        stop();
        log("bot stopped");
      }
    };
  },
});
