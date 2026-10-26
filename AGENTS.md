# Telecode development rules

- Keep Telecode a thin OpenCode client. OpenCode owns sessions, model execution, tools, permissions, and history.
- Do not add terminal scraping, tmux orchestration, polling locks, heartbeat files, or a second session database.
- Telegram access remains deny-by-default through the numeric user allowlist. Keep credentials outside the repository and never log or echo them.
- Phone actions target the explicitly selected OpenCode workspace and session.
- Prefer direct, plain Telegram UX with no emojis or instructional clutter.
- Pin the CLI and SDK to compatible versions and verify the authenticated HTTP API before updating either.
- For behavior changes, run `npm test`, `npm run typecheck`, `npm pack --dry-run`, and `git diff --check`.
- Do not publish the npm package. Only push where the current task's repository safety rules explicitly allow it.
