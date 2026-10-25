import { Plugin } from "@opencode/plugin";
import { createBot } from "./src/bot.js";

const KEY = "__telecode";

export default Plugin.define({
  id: "telecode",
  async setup(ctx) {
    const options = ctx.options ?? {};
    const token = options.token || process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return;

    // One bot per service process. Plugins load once per location, so the first
    // instance starts the bot and the last one to unload stops it.
    const g = globalThis;
    if (!g[KEY]) g[KEY] = { count: 0, stop: null };
    const refs = g[KEY];

    if (refs.stop) {
      refs.count += 1;
      return () => {
        refs.count -= 1;
      };
    }

    const bot = createBot(ctx, token, String(options.allowedIds ?? process.env.TELEGRAM_ALLOWED_IDS ?? ""));
    bot.start().catch((e) => console.error("[telecode]", e?.message ?? e));
    refs.stop = () => bot.stop().catch(() => {});
    refs.count = 1;

    return () => {
      refs.count -= 1;
      if (refs.count <= 0 && refs.stop) {
        refs.stop();
        refs.stop = null;
      }
    };
  },
});
