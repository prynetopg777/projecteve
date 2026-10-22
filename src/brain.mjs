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
import { describe, grantKey, isAutoAllowed, isTaskDone } from './permissions.mjs';

const SESSION_FILE = path.join(DATA_DIR, 'session.json');
const TASK_FILE = path.join(DATA_DIR, 'task.json'); // the plan the user approved; survives self-restarts
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json'); // { autoMode }
const MODEL_FILE = path.join(DATA_DIR, 'model.json'); // written by tools/eve.mjs when Eve switches models
export const MODELS = ['haiku', 'sonnet', 'opus'];
const PERMISSION_TIMEOUT_MS = 3 * 60 * 1000;

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
  }

  setAutoMode(on) {
    this.autoMode = !!on;
    writeJson(SETTINGS_FILE, { ...readJson(SETTINGS_FILE), autoMode: this.autoMode });
    this.emit('auto', this.autoMode);
    // Switching on also approves whatever is waiting right now (unless it's on the always-ask list).
    if (this.autoMode) {
      for (const [id, p] of [...this.pending]) {
        if (p.req.id && isAutoAllowed(p.req.tool, p.input, { taskActive: true })) this.respond(id, 'allow');
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
    return MODELS.includes(m) ? m : this.cfg.model;
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
    if (this.sessionId) args.push('--resume', this.sessionId);

    const shell = !this.cfg.claudePath.endsWith('.exe') && process.platform === 'win32';
    this.proc = spawn(this.cfg.claudePath, args, { cwd: WORKSPACE, shell, windowsHide: true });
    this.emit('model', this.runningModel);

    const proc = this.proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d).length > 4000 && (stderr = stderr.slice(-4000)));
    // Ignore exits of processes we killed on purpose (stop / model switch): they're no longer this.proc.
    proc.on('error', (err) => this.proc === proc && this.#fail(new Error(`Could not start Claude CLI (${this.cfg.claudePath}): ${err.message}`)));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
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
      new Promise((resolve, reject) => {
        // Eve switched models during the last turn: restart the process on the new model, same conversation.
        if (this.proc && this.runningModel !== this.model) this.#kill();
        if (!this.proc) this.start();
        this.turn = { resolve, reject, text: '', messages: 0 };
        this.emit('busy', true);
        const notes = this.notes.splice(0).map((n) => `[System note: ${n}]\n`).join('');
        const content = `[${timestamp()} · model: ${this.runningModel} · auto mode: ${this.autoMode ? 'on' : 'off'}]\n${notes}${text}`;
        this.#send({ type: 'user', message: { role: 'user', content } });
      });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
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
  }

  #kill() {
    if (!this.proc) return;
    const proc = this.proc;
    this.proc = null;
    proc.kill();
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
        this.#delta(ev.delta.text);
      }
    } else if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_use') this.emit('tool', { name: block.name, input: block.input, sub: !!msg.parent_tool_use_id });
      }
    } else if (msg.type === 'result') {
      this.turn = null;
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
    if (isAutoAllowed(tool, input, { grants: this.grants, taskActive: this.autoMode || this.taskActive })) {
      this.pending.set(id, { req: {}, input });
      return this.respond(id, 'allow');
    }
    const req = { id, tool, key: grantKey(tool, input), ...describe(tool, input, description) };
    const timer = setTimeout(() => this.respond(id, 'deny', 'The user did not answer the permission request in time.'), PERMISSION_TIMEOUT_MS);
    this.pending.set(id, { req, input, timer });
    this.emit('permission', req);
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
