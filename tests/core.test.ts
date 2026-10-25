import assert from "node:assert/strict";
import test from "node:test";
import { assistantText, normalizeSessionName, parseAllowedIds, splitTelegram } from "../extensions/index.ts";

test("parseAllowedIds keeps safe numeric IDs", () => {
  assert.deepEqual([...parseAllowedIds("123, 456, nope, 0, -1, ")], [123, 456]);
});

test("assistantText returns only visible assistant text", () => {
  assert.equal(assistantText({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "first" },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
      { type: "text", text: "second" },
    ],
  }), "first\nsecond");
  assert.equal(assistantText({ role: "user", content: [{ type: "text", text: "no" }] }), "");
});

test("splitTelegram preserves text within Telegram limits", () => {
  const text = `${"a".repeat(2500)}\n${"b".repeat(2500)}`;
  const chunks = splitTelegram(text, 4000);
  assert.deepEqual(chunks, ["a".repeat(2500), "b".repeat(2500)]);
  assert.ok(chunks.every((chunk) => chunk.length <= 4000));
});

test("normalizeSessionName accepts simple names and rejects unsafe input", () => {
  assert.equal(normalizeSessionName("  feature   work  "), "feature work");
  assert.equal(normalizeSessionName("release-1.2_main"), "release-1.2_main");
  assert.equal(normalizeSessionName(""), undefined);
  assert.equal(normalizeSessionName("../bad"), undefined);
  assert.equal(normalizeSessionName("x".repeat(51)), undefined);
});
