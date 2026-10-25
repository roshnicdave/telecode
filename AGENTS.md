# Telecode development rules

- Keep Telecode a small Pi extension. Do not introduce a separate daemon, framework, database, or model-facing Telegram tool unless the existing process model cannot solve the requirement.
- One live Pi process owns Telegram polling; every live process exposes only its authenticated loopback control endpoint and session record.
- Telegram access remains deny-by-default through the numeric user allowlist. Keep credentials outside the repository and never log or echo them.
- Phone actions must target the explicitly selected live Pi session. Do not silently route to a different process when the target is stale or busy.
- Prefer direct, plain Telegram UX with no emojis or instructional clutter. Commands should acknowledge the concrete result or return a useful failure.
- Preserve terminal interactivity: never await the Telegram polling loop during Pi startup.
- For behavior changes, run `npm test`, `npm run typecheck`, `npm pack --dry-run`, and `git diff --check`. Exercise session routing, leadership failover, or model switching end to end when that surface changes.
- Do not publish the npm package or push Git changes unless the user explicitly requests it.
