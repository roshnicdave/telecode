---
name: telecode
description: Drive coding-agent sessions from Telegram using the telecode MCP server. Use when the user wants to list sessions, send prompts, or get updates on their phone via Telegram.
---

# Telecode

Telecode exposes a set of MCP tools backed by a shared, portable session store,
and runs a Telegram bot in the same process. Use these tools whenever the user
is driving work from Telegram, or wants progress sent to Telegram.

## Session store

Sessions live in the telecode store (not the host's native sessions). Treat the
store as the source of truth for the work the user drives from their phone. If
the host keeps its own sessions, mirror relevant state into the store with the
tools below.

## Tools

- `list_sessions` — list sessions (newest first), optionally filtered by `search`.
- `create_session` — create a session; returns its id.
- `get_session` — session metadata.
- `get_history` — message history (optionally `limit`).
- `send_prompt` — queue a user prompt as pending.
- `get_pending` — read pending prompts awaiting processing.
- `complete_response` — record an assistant response and clear pending prompts.
- `append_message` — append an arbitrary message (e.g. tool output).
- `interrupt` — set the interrupted flag for a session.
- `compact` — set the compact-requested flag for a session.
- `switch_model` — set the model for a session.
- `delete_session` — delete a session.
- `export_session` — export a session as JSON.
- `send_telegram` — send a message to a Telegram chat (`chatId` or `"me"`).
- `get_chat_ids` — list chat ids the bot has seen.

## Workflow

1. When starting a turn (or when idle), call `get_pending` to find prompts the
   user sent from Telegram.
2. For each pending prompt, read `get_history` for context, do the work, then
   call `complete_response` with the result.
3. Call `send_telegram` (chatId `"me"`) to deliver the answer to the user's phone.
4. If the user pressed ⏹ Interrupt, stop the current work as soon as it is safe.
   If they pressed 🧹 Compact, summarize and keep recent context.
5. Keep the store's session state consistent with whatever the host actually did.

## Pi auto-injection

In Pi, the `telecode-autopoll` extension injects queued Telegram prompts as user
messages prefixed with `[Telegram]`. Treat a `[Telegram]` message as a pending
prompt: process it and reply with `complete_response` + `send_telegram`.

## Notes

- The Telegram bot queues prompts into the store; it does not generate answers.
  This skill is what turns queued prompts into completed responses.
- Do not block indefinitely on `get_pending`; poll it at natural checkpoints.
