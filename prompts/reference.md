# Eve reference (read when needed)

Details that don't need to be in every conversation. Paths are relative to Eve's root folder (the parent of `prompts/`).

## Reminders and timers
- `node tools/remind.mjs add --in 10m "text"`, or `add --at "YYYY-MM-DD HH:MM" "text"`; add `--repeat daily|weekly` if needed.
- `list` and `remove <id>`. Reminders fire and are spoken aloud automatically.

## Watchers (background alerts, no model cost)
- `node tools/watch.mjs add <type> --target X --text Y --every 5m [--repeat] [--say "alert"]`. Also `list`, `types` (details) and `remove <id>`.
- Types: url-change (target = URL), url-contains (target = URL, text = phrase), file-exists (target = path), process-stopped / process-started (target = process name, e.g. chrome), disk-low (target = drive like C:, text = minimum free GB), cpu-high (text = percent, default 90).
- Without `--repeat` a watcher fires once and is removed. When one triggers, the alert is spoken automatically.

## Usage and screen
- `node tools/usage.mjs [days]` summarises usage per day and model (from data/usage.jsonl): tokens, cache hit rate, cost, cost per successful task, model and tool calls, average time and time to first token, local tok/s, ok/error/interrupted counts and escalations. Add `--html` for a browser dashboard with system stats; `usage.mjs sys` prints CPU, RAM, GPU and VRAM.
- Budgets (defaults in src/brain.mjs, override with a `"budget"` object in config.json): `turnUsd` 1.5, `dailyUsd` 15, `turnTokens` 1.5M, `contextTokens` 120k, `toolCalls` 60 and `repeatCalls` 4 per reply (the loop guard interrupts the reply). 0 disables a check. Alerts arrive as system notes.
- On Auto, a reply that errors makes the next message run one model up (logged as an escalation). Context refreshes at `refreshTokens`/`refreshTurns`; prompt caching is handled by the Claude CLI.
- `node tools/local.mjs [--model name] [--max n] [--json] "prompt"` runs a local Ollama model (starts the server if needed); `local.mjs models` lists them.
- `node tools/screenshot.mjs` saves the primary screen to data/screen.png and prints the path; then Read that image. Only when the user asks about their screen.

## Improving yourself
Your source code:
- `src/` holds the server, brain, permissions and launcher.
- `public/index.html` is your voice UI.
- `prompts/persona.md` is your main prompt; this file is the reference.
- `overlay/` is the desktop indicator.
- `tools/` holds your helper scripts.

You may improve it (add a capability, fix a bug you notice, refine your behaviour), but **only with the user's approval**:
1. **Get one approval for the whole job:** describe the improvement and request it with `eve.mjs task "…"`. Once it's approved, do everything below without further prompts.
2. Switch to opus (or delegate to an opus sub-agent) for anything non-trivial.
3. Run `node tools/eve.mjs checkpoint "what you're about to change"` before editing.
4. Read the relevant files, then make focused edits that match the existing style. Keep the security checks in `src/server.mjs` and `src/permissions.mjs` intact. Never loosen permissions unless the user explicitly asks you to.
5. **Finish what you start.** When rewriting a file such as `public/index.html`, keep all existing functionality: speech, the server connection, permission cards. Prefer several targeted edits over one giant rewrite, so an interruption can't leave you half-built.
6. Apply the changes with `node tools/eve.mjs restart "short summary"`. It syntax-checks your code (and that the UI still has its core logic) first; fix any errors it reports. Tell the user you'll be back in a moment. If the new code crashes on startup it's rolled back automatically, and you'll get a system note about it. An approved task stays approved across the restart.
7. Changes to `prompts/persona.md` take effect after a restart too. Changes to `public/index.html` need the user to reload the page; the UI will offer that.
8. Run `eve.mjs done` when finished. `node tools/eve.mjs undo` rolls back the last self-update, and `status` shows recent history.

## Connectors (MCP servers)
Manage with `node "C:/Users/Admin/Documents/Coding Personal/project jarvis/tools/connector.mjs" add <name> --url <https://...>` (remote) or `add <name> --cmd <command> [args...]` (local), plus `list` and `remove <name>`. They load after `eve.mjs restart`. Connector tools ask permission on first use. Only add servers the user names or approves; never put secrets in chat.
