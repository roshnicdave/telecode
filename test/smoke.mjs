import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import * as oc from "../src/opencode.js";
import { escapeHtml, relTime, textToBlocks, packBlocks } from "../src/format.js";

let passed = 0;
let failed = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    failed++;
  }
}

let testSessionId = null;

try {
  console.log("== format.js ==");
  await test("escapeHtml", () => {
    assert.equal(escapeHtml("<a>&"), "&lt;a&gt;&amp;");
  });
  await test("relTime", () => {
    assert.equal(relTime(Date.now() - 30_000), "30s ago");
    assert.equal(relTime(Date.now() - 5 * 60_000), "5m ago");
    assert.equal(relTime(null), "—");
  });
  await test("textToBlocks converts code + bold", () => {
    const blocks = textToBlocks("hello\n\n```js\nconst a = 1 < 2;\n```\n\nworld **bold**");
    assert.ok(blocks.some((b) => b.html.includes('<pre><code class="language-js">')));
    assert.ok(blocks.some((b) => b.html.includes("<b>bold</b>")));
    // must not leak raw < into html outside a tag
    assert.ok(!blocks.some((b) => b.html.includes("1 < 2")));
  });
  await test("packBlocks respects limit", () => {
    const blocks = Array.from({ length: 50 }, (_, i) => ({ html: "x".repeat(200) + i }));
    const chunks = packBlocks(blocks, 1000);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 1000, `chunk too long: ${c.length}`);
  });

  console.log("== opencode.js (read-only) ==");
  await test("listSessions", async () => {
    const { data } = await oc.listSessions({ limit: 5 });
    assert.ok(Array.isArray(data));
    console.log(`      ${data.length} session(s) visible`);
  });
  await test("listModels / listAgents", async () => {
    const models = await oc.listModels();
    const agents = await oc.listAgents();
    assert.ok(models.length > 0, "no models");
    assert.ok(agents.length > 0, "no agents");
    console.log(`      ${models.length} model(s), ${agents.length} agent(s)`);
  });

  console.log("== opencode.js (round-trip on a throwaway session) ==");
  await test("createSession + getSession + getMessages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "telecode-test-"));
    const s = await oc.createSession({ directory: dir });
    testSessionId = s.id;
    assert.match(s.id, /^ses/);
    const got = await oc.getSession(s.id);
    assert.equal(got.id, s.id);
    const msgs = await oc.getMessages(s.id, { limit: 5 });
    assert.ok(Array.isArray(msgs));
    console.log(`      ${s.id} (${msgs.length} msg(s))`);
  });
  await test("exportSession", async () => {
    const data = await oc.exportSession(testSessionId);
    assert.equal(data.data.info.id, testSessionId);
    assert.ok(Array.isArray(data.data.messages));
  });
  await test("prompt → assistant reply", async () => {
    const before = await oc.getMessages(testSessionId, { limit: 1, order: "desc" });
    const beforeId = before[0]?.id;
    const sentAt = Date.now();
    await oc.sendPrompt(testSessionId, "Reply with exactly the single word: PONG");
    const deadline = Date.now() + 180_000;
    let result = null;
    while (Date.now() < deadline) {
      const msgs = await oc.getMessages(testSessionId, { limit: 10, order: "desc" });
      for (const m of msgs) {
        if (m.id === beforeId) break;
        if (
          m.type === "assistant" &&
          m.finish &&
          m.finish !== "tool-calls" &&
          (m.time?.created ?? 0) >= sentAt
        ) {
          result = m;
          break;
        }
      }
      if (result) break;
      await sleep(1500);
    }
    assert.ok(result, "no assistant reply within timeout");
    const text = (result.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    console.log(`      reply: ${JSON.stringify(text.slice(0, 120))}`);
    assert.match(text.toLowerCase(), /pong/);
  });
  await test("switchModel / switchAgent", async () => {
    const models = await oc.listModels();
    const agents = await oc.listAgents();
    const m = models[0];
    const a = agents[0];
    await oc.switchModel(testSessionId, { id: m.id, providerID: m.providerID });
    await oc.switchAgent(testSessionId, a.id);
    const s = await oc.getSession(testSessionId);
    assert.equal(s.model.id, m.id);
    assert.equal(s.agent, a.id);
  });
  await test("compact", async () => {
    await oc.compact(testSessionId);
  });
  await test("removeSession", async () => {
    await oc.removeSession(testSessionId);
    testSessionId = null;
    await assert.rejects(() => oc.getSession("ses_this_does_not_exist"), /404|does not|Not Found/i);
  });

  console.log("== telegram ==");
  await test("getMe", async () => {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
    const me = await bot.api.getMe();
    assert.ok(me.is_bot);
    console.log(`      @${me.username} (${me.first_name})`);
  });
  await test("setMyCommands / getMyCommands", async () => {
    const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);
    const cmds = [
      { command: "start", description: "Home" },
      { command: "sessions", description: "List sessions" },
      { command: "new", description: "New session" },
      { command: "leave", description: "Leave active session" },
    ];
    await bot.api.setMyCommands(cmds);
    const got = await bot.api.getMyCommands();
    assert.equal(got.length, cmds.length);
    assert.equal(got[0].command, "start");
  });
} finally {
  if (testSessionId) {
    try {
      await oc.removeSession(testSessionId);
      console.log(`  (cleaned up leftover test session ${testSessionId})`);
    } catch {}
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
