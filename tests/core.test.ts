import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSessionName, parseAllowedIds, splitTelegram, visibleText } from "../src/core.ts";

test("parseAllowedIds keeps safe positive IDs", () => assert.deepEqual([...parseAllowedIds("123, 456, nope, 0, -1")], [123, 456]));
test("visibleText hides reasoning and tools", () => assert.equal(visibleText([{ type: "reasoning", text: "secret" }, { type: "text", text: "hello" }, { type: "tool" }]), "hello"));
test("splitTelegram preserves long text", () => { const chunks = splitTelegram(`${"a".repeat(2500)}\n${"b".repeat(2500)}`); assert.deepEqual(chunks, ["a".repeat(2500), "b".repeat(2500)]); });
test("normalizeSessionName rejects empty/control text", () => { assert.equal(normalizeSessionName("  feature   work "), "feature work"); assert.equal(normalizeSessionName(""), undefined); assert.equal(normalizeSessionName("bad\nname"), undefined); });
