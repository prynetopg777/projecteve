# E.V.E.

A personal voice assistant that uses your **Claude Code CLI** as her brain. She runs on your Claude subscription, so you don't need an API key, and she has no npm dependencies.

## Run her

```
npm start          # launcher: voice UI in Edge, desktop indicator, self-restart support
npm run chat       # text-only chat in the terminal
```

Or double-click `start-eve.bat`.

Click **Initialize**, allow the microphone, then say **"Eve, what's the weather in Singapore?"**

| Action | How |
|---|---|
| Talk | Say "Hey Eve, …" in one go, or say just "Hey Eve", wait for her reply ("Yes, sir?"), then speak. You can also click the reactor/mic or press Ctrl+Space. |
| Interrupt | Esc, the Stop button, or say "Eve, stop" |
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
| `overlay` | Show the desktop indicator |
| `autoAllow` | Tools that never need approval. Keep this to read-only tools. |
| `extraDirs` | Folders Eve may access besides `workspace/` (default: your home folder) |

The server only accepts requests from `localhost`, and it rejects requests from other websites.
