// The "brain": one long-lived `claude -p` process in stream-json mode.
// Each user turn is written to stdin; text deltas, tool calls and the final
// result are parsed from stdout and re-emitted as events. Permission requests
// arrive as `can_use_tool` control requests and are answered by our own policy
// or by asking the user.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR, ROOT, WORKSPACE } from './config.mjs';
import { alwaysAsk, describe, grantKey, isAutoAllowed, isTaskDone, taskRequest } from './permissions.mjs';
import { fastPath } from './fastpath.mjs';

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const TASK_FILE = path.join(DATA_DIR, 'task.json'); // the plan the user approved; survives self-restarts
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json'); // { autoMode }
const MODEL_FILE = path.join(DATA_DIR, 'model.json'); // written by tools/eve.mjs when Eve switches models
const HINT_FILE = path.join(DATA_DIR, 'model-hint.json'); // Eve's own one-shot model pick while on Auto
const BRIEFING_FILE = path.join(DATA_DIR, 'briefing.json'); // { date } of the last morning offer
const LEARNED_FILE = path.join(DATA_DIR, 'learned-permissions.json'); // { grantKey: times approved } (-1 = declined once: never learn)
const LEARN_AFTER = 3; // approve the exact same action this many times and Eve stops asking for it
const OLLAMA = 'http://127.0.0.1:11434';
const ROUTER_PROMPT = 'Rate how hard this request is for an AI assistant. SIMPLE = chit-chat, a quick fact, or one simple PC action. '
  + 'NORMAL = everyday tasks, web lookups, a few steps. HARD = writing or fixing code, deep research, careful planning, long analysis. '
  + 'Answer with one word: SIMPLE, NORMAL or HARD.\n\nRequest: ';
export const MODELS = ['haiku', 'sonnet', 'opus'];
const PERMISSION_TIMEOUT_MS = 3 * 60 * 1000;
const USAGE_FILE = path.join(DATA_DIR, 'usage.jsonl'); // one line per turn; summarised by tools/usage.mjs
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch']);
const isWebTool = (name) => WEB_TOOLS.has(name) || name.startsWith('mcp__browser__'); // the browser connector reads pages too
// Budget alerts (override any of these with a "budget" object in config.json). 0 turns a check off.
const BUDGET = { turnUsd: 1.5, dailyUsd: 15, turnTokens: 1500000, contextTokens: 120000, toolCalls: 60, repeatCalls: 4, agents: 6, dailyHardUsd: 30 };

export class Brain extends EventEmitter {
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.proc = null;
    this.runningModel = null;
    this.turn = null; // { resolve, reject, text, messages }
    this.queue = Promise.resolve();
    this.sessionId = readJson(SESSION_FILE).sessionId || null;
    this.pending = new Map(); // permission request id -> { req, input, timer }
    this.grants = new Set(); // "allow for this session" keys
    this.notes = []; // system notes prepended to the next user message
    const task = readJson(TASK_FILE);
    this.task = task.until > Date.now() ? task : null; // { plan, until }
    this.autoMode = !!readJson(SETTINGS_FILE).autoMode; // act without permission prompts (except the always-ask list)
    this.turns = 0; // turns since this conversation (re)started in this run
    this.refreshDue = false; // context got heavy: start a fresh session at the next quiet moment
    this.budget = { ...BUDGET, ...(cfg.budget || {}) };
    this.escalate = null; // on Auto: a failed turn bumps the next one up a model
  }

  /**
   * Start a fresh conversation to keep replies fast, but only between turns, with no
   * permission prompt waiting and no approved plan running. Memory files carry over.
   */
  #maybeRefresh() {
    if (!this.refreshDue || this.turn || this.pending.size || this.holdTask || this.taskActive) return false;
    this.refreshDue = false;
    this.#kill();
    this.sessionId = null;
    writeJson(SESSION_FILE, { sessionId: null });
    this.turns = 0;
    this.compactNoted = false;
    this.note('Your conversation was refreshed to stay fast; your memory notes are intact. Read memory/recent.md and memory/session-state.md now (silently) to pick up where you and the user left off.');
    this.emit('refreshed');
    return true;
  }

  /** Manually request a refresh; it happens now if idle, otherwise after the current turn. */
  refresh() {
    this.refreshDue = true;
    return this.#maybeRefresh();
  }

  setAutoMode(on) {
    this.autoMode = !!on;
    writeJson(SETTINGS_FILE, { ...readJson(SETTINGS_FILE), autoMode: this.autoMode });
    this.emit('auto', this.autoMode);
    // Switching on also approves whatever is waiting right now (unless it's on the always-ask list).
    if (this.autoMode) {
      for (const [id, p] of [...this.pending]) {
        if (p.req.id && isAutoAllowed(p.req.tool, p.input, { taskActive: true, webTainted: !!this.turn?.webTainted })) this.respond(id, 'allow');
      }
    }
  }

  get busy() {
    return !!this.turn;
  }

  /** An approved plan lets Eve act without further prompts until it's done or expires. */
  get taskActive() {
    if (this.task && this.task.until <= Date.now()) this.endTask('expired');
    return !!this.task;
  }

  #startTask(plan) {
    this.task = { plan, until: Date.now() + (this.cfg.taskMinutes || 45) * 60000 };
    writeJson(TASK_FILE, this.task);
    this.emit('task', this.task);
  }

  endTask(reason = 'done') {
    if (!this.task) return;
    this.task = null;
    fs.rmSync(TASK_FILE, { force: true });
    this.emit('task', null, reason);
  }

  /** The model Eve has chosen (falls back to config.model). */
  get model() {
    const m = readJson(MODEL_FILE).model;
    if (this.capped) return 'haiku'; // over the hard daily spending cap
    if (m === 'auto') return this.autoPick || 'sonnet';
    return MODELS.includes(m) ? m : this.cfg.model;
  }

  /** What the user selected: 'auto' or a fixed model. */
  get modelPref() {
    const m = readJson(MODEL_FILE).model;
    return m === 'auto' || MODELS.includes(m) ? m : this.cfg.model;
  }

  /** Switch the conversation model (or 'auto'); the process restarts on it at the next reply. */
  setModel(m) {
    if (m !== 'auto' && !MODELS.includes(m)) throw new Error(`Unknown model "${m}"`);
    writeJson(MODEL_FILE, { model: m });
    this.emit('model', this.runningModel || this.model);
  }

  /** Eve's own one-shot model choice (tools/eve.mjs model X while on Auto); it beats the keyword guess. */
  #takeHint() {
    const m = readJson(HINT_FILE).model;
    fs.rmSync(HINT_FILE, { force: true });
    return MODELS.includes(m) ? m : null;
  }

  /** Auto mode: clear-cut messages are routed by keywords; returns null when it's a judgement call. */
  #pickModel(text) {
    const t = text.toLowerCase();
    const heavy = /\b(code|script|program|implement|refactor|debug|improve yourself|upgrade yourself|rewrite|research|analy[sz]e|essay|architecture|optimi[sz]e|step by step)\b/;
    const simple = /\b(hi|hello|hey|thanks|thank you|okay|ok|yes|no|open|play|pause|volume|mute|time|date|weather|remind|timer|alarm|joke|how are you|what'?s up|good (morning|night))\b/;
    if (this.taskActive || text.length > 350 || heavy.test(t)) return 'opus';
    if (text.length <= 90 && simple.test(t)) return 'haiku';
    return null;
  }

  /**
   * Judgement calls go to a small local model (free, ~0.2 s when warm). If it isn't loaded yet it is warmed up
   * in the background for next time and this message gets sonnet, so routing never makes a reply slow.
   */
  async #classify(text) {
    if (this.cfg.localRouter === false) return null;
    const model = this.cfg.routerModel || 'llama3.2';
    try {
      const ps = await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(300) })).json();
      if (!ps.models?.some((m) => m.name.startsWith(model))) {
        fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model, keep_alive: '30m' }) }).catch(() => {});
        return null;
      }
      const body = { model, prompt: ROUTER_PROMPT + text.slice(0, 500), stream: false, keep_alive: '30m', options: { temperature: 0, num_predict: 4 } };
      const r = await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(1500) });
      const word = String((await r.json()).response || '').toUpperCase();
      return word.includes('HARD') ? 'opus' : word.includes('SIMPLE') ? 'haiku' : word.includes('NORMAL') ? 'sonnet' : null;
    } catch {
      return null; // Ollama not running or too slow: the default is fine
    }
  }

  /** Approved the exact same action LEARN_AFTER times (and never declined it)? Then stop asking. */
  #learned(tool, input) {
    if (this.cfg.learnPermissions === false || alwaysAsk(tool, input) || taskRequest(tool, input)) return false;
    return (readJson(LEARNED_FILE)[grantKey(tool, input)] || 0) >= LEARN_AFTER;
  }

  #learn(key, allowed) {
    if (this.cfg.learnPermissions === false || !key) return;
    const all = readJson(LEARNED_FILE);
    if (all[key] === -1) return;
    all[key] = allowed ? (all[key] || 0) + 1 : -1;
    writeJson(LEARNED_FILE, all);
  }

  start() {
    const persona = fs
      .readFileSync(path.join(ROOT, 'prompts/persona.md'), 'utf8')
      .replaceAll('{{honorific}}', this.cfg.honorific)
      .replaceAll('{{root}}', ROOT.replaceAll('\\', '/'));

    this.runningModel = this.model;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--strict-mcp-config',
      '--disable-slash-commands', // skip the skills listing: a smaller prompt means a faster first token
      '--effort', this.runningModel === 'opus' ? 'high' : 'low', // quick replies for everyday chat; Opus keeps its depth
      '--model', this.runningModel,
      '--append-system-prompt', persona,
      '--allowedTools', this.cfg.autoAllow.join(','),
      '--permission-prompt-tool', 'stdio',
    ];
    for (const dir of this.cfg.extraDirs) args.push('--add-dir', dir);
    // Connectors: MCP servers the user added with tools/connector.mjs. Their tools prompt before each first use.
    const connectors = path.join(DATA_DIR, 'connectors.json');
    try { if (Object.keys(JSON.parse(fs.readFileSync(connectors, 'utf8')).mcpServers || {}).length) args.push('--mcp-config', connectors); } catch {}
    if (this.sessionId) args.push('--resume', this.sessionId);

    const shell = !this.cfg.claudePath.endsWith('.exe') && process.platform === 'win32';
    this.proc = spawn(this.cfg.claudePath, args, { cwd: WORKSPACE, shell, windowsHide: true });
    this.emit('model', this.runningModel);

    const proc = this.proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
    // Writing to a CLI that just died raises EPIPE on stdin; the 'exit' handler below deals with the death.
    proc.stdin.on('error', () => {});
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    // Ignore exits of processes we killed on purpose (stop / model switch): they're no longer this.proc.
    proc.on('error', (err) => this.proc === proc && this.#fail(new Error(`Could not start Claude CLI (${this.cfg.claudePath}): ${err.message}`)));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.#clearPending(); // nobody is left to answer them
      // A stale/deleted session makes --resume fail on startup; drop it so the next try starts fresh.
      if (code && /session|conversation/i.test(stderr) && this.sessionId) {
        this.sessionId = null;
        writeJson(SESSION_FILE, { sessionId: null });
      }
      this.#fail(new Error(`Claude CLI exited (code ${code}). ${stderr.trim().slice(-500)}`));
    });
  }

  /** Send one user message; resolves with Eve's full reply text. Turns run one at a time. */
  ask(text) {
    const run = () =>
      new Promise(async (resolve, reject) => {
        // Eve switched models during the last turn: restart the process on the new model, same conversation.
        const fast = fastPath(text, this.cfg);
        if (fast?.reply) return this.#fastReply(text, fast, resolve);
        const image = fast?.image ? fs.readFileSync(fast.image).toString('base64') : null; // screenshot fast path: one model step
        this.#maybeRefresh();
        const capped = !!this.budget.dailyHardUsd && spentToday() >= this.budget.dailyHardUsd;
        if (capped && !this.capped) this.note(`Hard spending cap: today passed $${this.budget.dailyHardUsd}, so you're on haiku until midnight. Tell the user once, briefly; they can raise budget.dailyHardUsd in config.json.`);
        this.capped = capped;
        let escalated = false, routedBy = 'fixed';
        const started = Date.now();
        if (readJson(MODEL_FILE).model === 'auto') {
          const hint = this.#takeHint(), keyword = hint ? null : this.#pickModel(text);
          const local = hint || keyword ? null : await this.#classify(text);
          const pick = hint || keyword || local || 'sonnet';
          routedBy = hint ? 'own pick' : keyword ? 'keywords' : local ? 'local model' : 'default';
          escalated = !!this.escalate && MODELS.indexOf(this.escalate) > MODELS.indexOf(pick);
          if (escalated) routedBy = 'escalated';
          this.autoPick = escalated ? this.escalate : pick;
          this.escalate = null;
        }
        if (this.capped) routedBy = 'spending cap';
        try { // the executor is async (local routing), so errors must be passed on by hand
          if (this.proc && this.runningModel !== this.model) this.#kill();
          if (!this.proc) this.start();
          this.turn = { resolve, reject, text: '', messages: 0, userText: text, started, firstToken: 0, tools: 0, sigs: new Map(), escalated, routedBy };
          this.emit('busy', true);
          this.#briefingNote();
          const notes = this.notes.splice(0).map((n) => `[System note: ${n}]\n`).join('');
          const content = `[${timestamp()} · model: ${this.runningModel} · auto mode: ${this.autoMode ? 'on' : 'off'}]\n${notes}${text}`;
          const body = image
            ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }, { type: 'text', text: `${content}
[System note: fast path "${fast.name}": ${fast.ask}]` }]
            : content;
          if (image) this.emit('tool', { name: 'Screenshot', input: {}, sub: false });
          this.#send({ type: 'user', message: { role: 'user', content: body } });
        } catch (err) {
          reject(err);
        }
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** First chat of the morning: nudge Eve to offer a briefing (costs nothing unless the user says yes). */
  #briefingNote() {
    const hour = new Date().getHours();
    const today = new Date().toDateString();
    if (hour < 4 || hour >= 12 || readJson(BRIEFING_FILE).date === today) return;
    writeJson(BRIEFING_FILE, { date: today });
    this.note(
      'First chat of the morning. After handling the user\'s message, briefly offer a morning briefing. If they accept, gather it quickly: ' +
        'weather for their city (see memory/profile.md; web search), reminders (`node tools/remind.mjs list`), unfinished items in memory/todo.md, ' +
        'and at most 3 top headlines. Speak it in under 30 seconds, no lists.',
    );
  }

  /** Queue a note for Eve that arrives with the next user message. */
  note(text) {
    this.notes.push(text);
  }

  /** Answer a pending permission request: 'allow' | 'always' | 'deny'. */
  respond(id, decision, message) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    const allow = decision === 'allow' || decision === 'always';
    if (allow && p.req.kind === 'task') this.#startTask(p.req.detail);
    else if (decision === 'always') this.grants.add(p.req.key);
    if (p.req.id && p.req.kind !== 'task' && !message) this.#learn(p.req.key, allow); // the user's own answer, not a timeout
    this.#send({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: allow
          ? { behavior: 'allow', updatedInput: p.input }
          : { behavior: 'deny', message: message || "The user declined this. Don't retry it; acknowledge politely and offer an alternative if there is one." },
      },
    });
    if (p.req.id) this.emit('permission-resolved', { id, decision }); // auto-allowed requests were never shown
    return true;
  }

  get pendingPermissions() {
    return [...this.pending.values()].map((p) => p.req);
  }

  /**
   * Cut the current reply short, instantly, keeping the Claude process warm (no restart delay).
   * Pending permission prompts are cancelled. Falls back to a hard stop if the CLI doesn't respond.
   */
  interrupt() {
    const turn = this.turn;
    if (!turn) return this.endTask('stopped'); // nothing running: keep the warm process
    if (!this.proc) return this.stop();
    if (turn.interrupted) return;
    turn.interrupted = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.#send({ type: 'control_response', response: { subtype: 'success', request_id: id, response: { behavior: 'deny', message: 'The user interrupted you.' } } });
      this.emit('permission-resolved', { id, decision: 'cancelled' });
    }
    this.pending.clear();
    this.#send({ type: 'control_request', request_id: `interrupt-${Date.now()}`, request: { subtype: 'interrupt' } });
    this.endTask('stopped');
    setTimeout(() => this.turn === turn && this.stop(), 3000);
  }

  /** Abort the current turn by killing the process. The conversation is kept; the process restarts on the next ask. */
  stop({ keepTask = false } = {}) {
    this.#kill();
    this.#fail(new Error('stopped'));
    if (!keepTask) this.endTask('stopped'); // interrupting Eve also withdraws the plan approval
  }

  /** Forget the current conversation (long-term memory files are kept). */
  reset() {
    this.stop();
    this.sessionId = null;
    writeJson(SESSION_FILE, { sessionId: null });
    this.turns = 0;
    this.refreshDue = false;
  }

  #kill() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill();
    this.#clearPending();
  }

  #clearPending() {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      this.emit('permission-resolved', { id, decision: 'cancelled' });
    }
    this.pending.clear();
  }

  #send(obj) {
    this.proc?.stdin.write(JSON.stringify(obj) + '\n');
  }

  #onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.session_id && msg.session_id !== this.sessionId) {
      this.sessionId = msg.session_id;
      writeJson(SESSION_FILE, { sessionId: this.sessionId });
    }
    if (msg.type === 'control_request') return this.#onControl(msg);

    const turn = this.turn;
    if (!turn) return;

    if (msg.type === 'stream_event') {
      if (turn.interrupted) return; // drop text still in flight from a reply the user cut off
      const ev = msg.event;
      // Separate text from consecutive assistant messages (e.g. before/after a tool call).
      if (ev.type === 'message_start' && !msg.parent_tool_use_id && turn.messages++ > 0 && turn.text) {
        this.#delta('\n\n');
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && !msg.parent_tool_use_id) {
        turn.firstToken ||= Date.now();
        this.#delta(ev.delta.text);
      }
    } else if (msg.type === 'assistant') {
      if (!msg.parent_tool_use_id && msg.message?.usage) turn.usage = msg.message.usage; // latest prompt size
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use' && isWebTool(block.name)) turn.webTainted = true;
        if (block.type === 'tool_use') {
          this.emit('tool', { name: block.name, input: block.input, sub: !!msg.parent_tool_use_id });
          this.#loopGuard(turn, block);
        }
      }
    } else if (msg.type === 'result') {
      this.turn = null;
      // Context heaviness: the prompt size of the last turn (incl. cached tokens) or the number of turns.
      const u = turn.usage || {}; // not msg.usage: that sums every API call in the turn
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (this.cfg.autoRefresh !== false && (tokens >= (this.cfg.refreshTokens || 60000) || ++this.turns >= (this.cfg.refreshTurns || 40))) {
        this.refreshDue = true;
      }
      const failed = !turn.interrupted && (msg.is_error || msg.subtype !== 'success');
      const entry = logUsage(this.runningModel, msg.usage, {
        cost_usd: msg.total_cost_usd || 0,
        ms: Date.now() - turn.started,
        ttft_ms: turn.firstToken ? turn.firstToken - turn.started : 0,
        api_ms: msg.duration_api_ms || 0,
        model_calls: msg.num_turns || 0,
        tool_calls: turn.tools,
        context: tokens,
        auto: readJson(MODEL_FILE).model === 'auto',
        escalated: !!turn.escalated,
        status: turn.interrupted ? 'interrupted' : failed ? 'error' : 'ok',
      });
      this.#checkBudget(entry);
      this.emit('stats', { model: this.runningModel, routedBy: turn.routedBy, ms: Date.now() - turn.started, ttft_ms: turn.firstToken ? turn.firstToken - turn.started : 0, cost_usd: msg.total_cost_usd || 0, tools: turn.tools });
      // Compaction: before the context gets refreshed, have Eve write down what must survive it.
      if (this.cfg.autoRefresh !== false && !this.compactNoted && tokens >= 0.75 * (this.cfg.refreshTokens || 60000)) {
        this.compactNoted = true;
        this.note('Context is getting long and will be refreshed soon. In this reply, also overwrite memory/session-state.md (silently) with: unresolved tasks and next steps, decisions made and why, exact error messages, ids, paths and code that still matter (verbatim), and finished work as one line each. Keep it under 40 lines.');
      }
      // Auto routing: a failed turn on a lighter model retries the next message one model up.
      if (failed && readJson(MODEL_FILE).model === 'auto') this.escalate = MODELS[Math.min(MODELS.indexOf(this.runningModel) + 1, MODELS.length - 1)];
      setImmediate(() => this.#maybeRefresh()); // after this turn settles; skipped if another turn already started
      // A plan approval covers one reply. The exception is a self-restart, after which the plan may carry on.
      if (!this.holdTask) this.endTask('done');
      this.emit('busy', false);
      if (turn.interrupted) {
        turn.reject(new Error('stopped')); // interrupted by the user: not an error
      } else if (msg.is_error || msg.subtype !== 'success') {
        const err = new Error(msg.result || msg.errors?.join('; ') || `Claude returned ${msg.subtype}`);
        this.emit('error', err);
        turn.reject(err);
      } else {
        const text = turn.text || msg.result || '';
        saveRecent(turn.userText, text);
        this.emit('done', text);
        turn.resolve(text);
      }
    }
  }

  #onControl(msg) {
    const { request_id: id, request } = msg;
    if (request?.subtype !== 'can_use_tool') {
      this.#send({ type: 'control_response', response: { subtype: 'error', request_id: id, error: `unsupported: ${request?.subtype}` } });
      return;
    }
    const { tool_name: tool, input, description } = request;
    if (isTaskDone(tool, input)) this.endTask('done');
    if (this.turn && isWebTool(tool)) this.turn.webTainted = true;
    // After reading the web this turn, auto mode / the task approval no longer cover shell or file actions.
    const webTainted = !!this.turn?.webTainted;
    const learned = !webTainted && this.#learned(tool, input);
    if (learned || isAutoAllowed(tool, input, { grants: this.grants, taskActive: this.autoMode || this.taskActive, taskPlan: this.task?.plan, webTainted })) {
      this.pending.set(id, { req: {}, input });
      return this.respond(id, 'allow');
    }
    const req = { id, tool, key: grantKey(tool, input), ...describe(tool, input, description) };
    const timer = setTimeout(() => this.respond(id, 'deny', 'The user did not answer the permission request in time.'), PERMISSION_TIMEOUT_MS);
    this.pending.set(id, { req, input, timer });
    this.emit('permission', req);
  }

  /** Stop runaway turns: too many tool calls, or the same call over and over. */
  #loopGuard(turn, block) {
    if (turn.interrupted || turn.guarded) return;
    turn.tools++;
    const sig = block.name + JSON.stringify(block.input || {});
    const seen = (turn.sigs.get(sig) || 0) + 1;
    turn.sigs.set(sig, seen);
    if (block.name === 'Agent' || block.name === 'Task') turn.agents = (turn.agents || 0) + 1;
    const { toolCalls, repeatCalls, agents } = this.budget;
    const why = agents && turn.agents > agents ? `started more than ${agents} sub-agents in one reply`
      : repeatCalls && seen >= repeatCalls ? `called ${block.name} with the same input ${seen} times`
      : toolCalls && turn.tools >= toolCalls ? `made ${turn.tools} tool calls in one reply` : '';
    if (!why) return;
    turn.guarded = true;
    this.note(`Loop guard: your last reply was stopped because it ${why}. Tell the user briefly what you were trying to do and where it got stuck, and ask how to proceed instead of repeating it.`);
    this.emit('alert', `Loop guard stopped a reply: it ${why}.`);
    this.interrupt();
  }

  /** Spending and context alerts, passed to Eve as a note so she can mention them. */
  #checkBudget(e) {
    if (!e) return;
    const b = this.budget, alerts = [];
    if (b.turnUsd && e.cost_usd >= b.turnUsd) alerts.push(`that reply cost about $${e.cost_usd.toFixed(2)} (limit $${b.turnUsd})`);
    if (b.turnTokens && e.total >= b.turnTokens) alerts.push(`that reply used ${Math.round(e.total / 1000)}k tokens`);
    if (b.contextTokens && e.context >= b.contextTokens) alerts.push(`the conversation context is at ${Math.round(e.context / 1000)}k tokens`);
    if (b.dailyUsd) {
      const today = spentToday();
      const prev = today - e.cost_usd;
      if (today >= b.dailyUsd && prev < b.dailyUsd) alerts.push(`today's spending passed $${b.dailyUsd} (now about $${today.toFixed(2)})`);
    }
    if (!alerts.length) return;
    const text = `Budget alert: ${alerts.join('; ')}.`;
    this.note(`${text} Mention it to the user in one short sentence, and prefer lighter models and fewer tool calls for a while.`);
    this.emit('alert', text);
  }

  /** Reply to a fast-path request without the model; Eve hears about it with the next message. */
  #fastReply(text, fast, resolve) {
    const t0 = Date.now();
    this.emit('busy', true);
    this.emit('delta', fast.reply);
    saveRecent(text, fast.reply);
    this.note(`Handled without you (fast path "${fast.name}"): the user said "${text}" and was told "${fast.reply}".`);
    logUsage('fast', {}, { cost_usd: 0, ms: Date.now() - t0, status: 'ok', fast: fast.name });
    this.emit('stats', { model: 'instant', routedBy: `fast path: ${fast.name}`, ms: Date.now() - t0, ttft_ms: 0, cost_usd: 0, tools: 0 });
    this.emit('done', fast.reply);
    this.emit('busy', false);
    resolve(fast.reply);
  }

  #delta(text) {
    this.turn.text += text;
    this.emit('delta', text);
  }

  #fail(err) {
    const turn = this.turn;
    if (!turn) return;
    this.turn = null;
    this.emit('busy', false);
    if (err.message !== 'stopped') this.emit('error', err);
    turn.reject(err);
  }
}

// The last few exchanges, kept in a markdown file so a refreshed session can pick up the thread.
const RECENT_FILE = path.join(WORKSPACE, 'memory/recent.md');
const RECENT_KEEP = 10;
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl'); // every exchange, for the History view

export function readHistory(n = 100) {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-n).map((l) => JSON.parse(l)).reverse();
  } catch {
    return [];
  }
}
const RECENT_HEADER = '# Recent conversation (auto-saved, newest last)\n';
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s).trim();

function saveRecent(user, reply) {
  try {
    const old = fs.existsSync(RECENT_FILE) ? fs.readFileSync(RECENT_FILE, 'utf8').split('\n## ').slice(1) : [];
    const entry = `${timestamp().replace(/^Now: /, '')}\nUser: ${clip(String(user), 400)}\nEve: ${clip(reply, 600)}\n`;
    const kept = [...old, entry].slice(-RECENT_KEEP);
    fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FILE, `${RECENT_HEADER}\n## ${kept.join('\n## ')}`);
    fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), user: clip(String(user), 1000), eve: clip(reply, 3000) }) + '\n');
  } catch {
    // best effort: never break a reply over the log
  }
}

// Token usage of a whole turn (all API calls in it) plus cost, timing and call counts, appended to data/usage.jsonl.
function logUsage(model, u = {}, extra = {}) {
  try {
    const input = u.input_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheCreation = u.cache_creation_input_tokens || 0;
    const output = u.output_tokens || 0;
    const entry = { ts: new Date().toISOString(), model, input, cache_read: cacheRead, cache_creation: cacheCreation, output, total: input + cacheRead + cacheCreation + output, ...extra };
    fs.appendFileSync(USAGE_FILE, JSON.stringify(entry) + '\n');
    return entry;
  } catch {
    return null; // best effort
  }
}

// Dollars spent since local midnight, from the usage log.
export function spentToday() {
  try {
    const today = new Date().toDateString();
    return fs.readFileSync(USAGE_FILE, 'utf8').split('\n').reduce((sum, l) => {
      try { const r = JSON.parse(l); return new Date(r.ts).toDateString() === today ? sum + (r.cost_usd || 0) : sum; } catch { return sum; }
    }, 0);
  } catch {
    return 0;
  }
}

function timestamp() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const local = new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' });
  return `Now: ${local} (${tz})`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
