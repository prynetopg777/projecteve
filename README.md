# E.V.E.

A personal voice assistant that uses your **Claude Code CLI** as her brain. She runs on your Claude subscription, so you don't need an API key, and she has no npm dependencies.

## Run her

```
npm start          # launcher: voice UI in Edge, desktop indicator, self-restart support
npm run chat       # text-only chat in the terminal
```

Or double-click `start-eve.bat`, or the **Eve** desktop shortcut (created on first start; recreate it with `npm run shortcut`).

Eve opens in her own app window: Edge (or Chrome) in app mode with a dedicated profile in `data/browser-profile`, so the microphone permission and window position are remembered and she starts listening without the Initialize click. If neither browser is found she opens in your default browser. Set `"appWindow": false` to use a normal browser tab, or set `"browser"` to `chrome` or a path to a browser exe.

Click **Initialize**, allow the microphone, then say **"Eve, what's the weather in Singapore?"**

| Action | How |
|---|---|
| Talk | Say "Hey Eve, …" in one go, or say just "Hey Eve", wait for her reply ("Yes, sir?"), then speak. You can also click the reactor/mic or press Ctrl+Space. |
| Interrupt | Anytime, even while she is talking or working: say "Eve, stop" (or "Eve, wait"), or just "stop". You can also press Esc or the Stop button. Saying "Eve, …" with a new request while she is busy cuts her off and switches to it. She stops instantly, without restarting. To keep the mic off while she talks, set `"bargeIn": false`. |
| Answer a permission request | Click Allow / Deny, or just say "yes" / "no" |
| Fresh conversation | New chat (long-term memory is kept) |

Use **Microsoft Edge**. It has the best speech recognition and the natural "Online (Natural)" voices. Eve picks a female voice automatically (Sonia, Libby, Aria, Jenny…). To choose one, set `"voice"` in `config.json` to part of its name.

## Desktop indicator

A small pill in the bottom-right corner shows that Eve is running and what she's doing:

| Dot | Meaning |
|---|---|
| Cyan, slow breathing | Idle and ready ("EVE - window closed" if the voice window isn't open) |
| Cyan, fast | Listening |
| Amber | Thinking |
| Violet | Speaking |
| Amber, blinking "Needs your OK" | Waiting for you to approve something |
| Grey "Offline" | Server not reachable |

Drag it anywhere. Double-click it to open Eve, and right-click it to hide it or quit Eve. It never takes focus and doesn't appear in Alt+Tab. To turn it off, set `"overlay": false`.

## Permissions

Eve's software enforces permissions; it isn't just a prompt instruction. Every tool call goes through `src/permissions.mjs`:

- **Runs freely:** reading files, web search and fetch, her reminder and self-management scripts, edits to her own notes in `workspace/`, and simple read-only commands (`Get-Date`, `git status`…).
- **Asks you first:** anything else, including other shell commands, file edits outside `workspace/`, and **any change to her own code**. A card shows exactly what will run, and Eve asks politely out loud ("Sir, may I open Spotify?"). Choose **Allow**, **Allow for this session** (for that same command or folder), or **Deny**. Unanswered requests are denied after 3 minutes, and so is everything when no Eve window is open.

## Choosing a model

Eve picks the lightest model that suits the task:

- **haiku**: chat, quick facts, simple actions.
- **sonnet**: the default for everyday work.
- **opus**: heavy coding, deep research, and improving herself.

She either hands one heavy task to an opus sub-agent, or switches her own model for a longer stretch (`node tools/eve.mjs model opus`) and switches back afterwards. The current model is shown next to her name in the UI.

## Self-improvement

Eve can improve her own code, but only after proposing the change and getting your yes. Each file edit also shows a permission prompt.

1. `tools/eve.mjs checkpoint`: she commits the current state to git (the repo is created on first use).
2. She makes the edits.
3. `tools/eve.mjs restart`: she syntax-checks all her code and refuses to restart if anything is broken. Then the launcher restarts her.
4. If the new code **crashes on startup, it's rolled back automatically** with `git stash`, and she tells you what happened. If it runs fine for 20 seconds, it's committed as `eve: self-update - …`.
5. `tools/eve.mjs undo` rolls back the last self-update, and `tools/eve.mjs status` shows the history.

Your personal data (`data/`, `workspace/memory/`) is git-ignored and never touched by rollbacks.

## How it works

```
Browser UI (speech in/out)      Desktop overlay (overlay/overlay.ps1)
        ⇅ HTTP + SSE                   ⇅ polls /api/status
src/server.mjs  ─ reminders, permission broker, status
        ⇅ stdin/stdout stream-json + permission control messages
claude -p  (one long-lived process, cwd = workspace/)
src/launcher.mjs supervises the server: restarts and crash rollback
```

| File | Purpose |
|---|---|
| `prompts/persona.md` | Personality, manners, model and self-improvement rules |
| `src/permissions.mjs` | What runs freely and what needs your OK |
| `workspace/memory/profile.md` | Long-term memory. Eve maintains it, and it's loaded into every conversation |
| `workspace/memory/todo.md` | To-do list |
| `tools/remind.mjs` | Reminders. They fire in the browser, or through Windows speech if the UI is closed |
| `tools/eve.mjs` | Model switching, checkpoints, restart, undo |

## Configuration (`config.json`)

| Key | Meaning |
|---|---|
| `model` | Default model: `haiku`, `sonnet` or `opus` |
| `honorific` | What Eve calls you |
| `wakeWord`, `wakeAliases` | `eve`, plus common mishearings |
| `speechLang` | Speech recognition language. `fil-PH` (default) understands Filipino, English and Taglish; use `en-US` for English only. Eve replies in English unless you ask for Filipino; Filipino replies use a Filipino voice when Edge has one |
| `speechPauseMs` | Silence (ms) after you stop talking before Eve acts on what you said (default 1800) |
| `autoRefresh` | Start a fresh conversation between turns once it gets heavy, to keep replies fast; memory files carry over (default true). Never happens mid-turn, during a permission prompt or an approved task. `POST /api/refresh` triggers it manually |
| `refreshTokens` | Refresh once a turn's prompt (input + cached tokens) reaches this size (default 60000) |
| `refreshTurns` | Refresh after this many turns in a conversation (default 40) |
| `overlay` | Show the desktop indicator |
| `autoAllow` | Tools that never need approval. Keep this to read-only tools. |
| `extraDirs` | Folders Eve may access besides `workspace/` (default: your home folder) |

The server only accepts requests from `localhost`, and it rejects requests from other websites.

## Requirements and limitations

- **Windows 10/11 only.** The overlay, Windows speech fallback and shortcut tooling use PowerShell.
- **Node 20+**, the **Claude Code CLI** signed in to your account, and **Microsoft Edge** (or Chrome) for speech recognition.
- **Cost:** Eve has no API key; every turn uses your own Claude plan. Run `node tools/usage.mjs` for a per-day token summary. Haiku for chat and sonnet by default keep this low; opus is only used for heavy work.
- **Voice:** uses your browser's voices, so how she sounds depends on the machine. Edge's "Online (Natural)" voices are best. Set `"voice"` to choose one.
- **Language:** `speechLang` defaults to `fil-PH` so Filipino, English and Taglish all work, at the cost of occasionally odd English spellings. Set `"speechLang": "en-US"` for cleaner English-only recognition.
- **Connectors (MCP)** are experimental. Only services that support automatic OAuth client registration sign in with one click; others (for example GitHub's hosted server) need a pre-made token.
- **Auto mode** skips approval prompts. Shutdown, disk wiping, uninstalling, registry deletions and edits to `permissions.mjs` / `config.json` still ask, and shell or file actions after reading web content always prompt.

## Tests

```
npm test
```

Covers the permission rules and reminder parsing. Run it after any change to `src/permissions.mjs`.

## What makes Eve different

Most voice assistants either run in the cloud with no control over your PC, or run local commands with no guardrails. Eve is:

- **Self-improving, safely:** she edits her own code only with your approval, syntax-checks it, and rolls back automatically if it crashes.
- **Permission-aware in software:** rules are enforced in code, not just in a prompt, and she asks once per task instead of once per step.
- **Transparent:** a usage log shows exactly what each conversation costs.

## Memory, skills and browsing

- **Searchable memory:** `tools/memory.mjs` stores events and details in a local SQLite database (`data/memory.db`, full-text search). Eve searches it before answering questions about your past or plans. Needs Node 22+.
- **Skills:** drop a `.md` recipe into `workspace/skills/` and Eve follows it when a request matches.
- **Browser automation:** the `browser` connector runs Playwright MCP so Eve can open and operate web pages. Every connector tool asks permission on first use.
- **Setup:** run `powershell -File setup.ps1` to check requirements, run tests and create the shortcut.
