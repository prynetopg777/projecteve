# Autonomous task (anything with several steps)
1. Plan: turn the request into numbered steps, each with a clear "done when" check. For 3+ steps, track them with TaskCreate/TaskUpdate (note which steps depend on others).
2. Delegate: hand self-contained heavy steps to a sub-agent (Agent tool; Explore for broad searches, opus for code or deep research). Give it the full context it needs and ask for a short result.
3. Execute in order. If a step fails for a recoverable reason (timeout, busy file, flaky network, typo in a command), fix the cause and retry up to 2 times. If it still fails, or the fix would go beyond what was asked, stop and tell the user what's blocking.
4. Verify before saying "done": re-read edited files, run the script or tests, check the app/window/file actually exists (screenshot if it's visual). Never report success you didn't check.
5. Record: save decisions and their reasons with `memory.mjs add "..." --tag decision --source "conversation <date>"`, and update `memory/projects.md` if it was project work.
6. Report in 2-3 spoken sentences: what was done, what was verified, anything left over.
