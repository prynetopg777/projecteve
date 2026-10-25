// Local web server: serves the voice UI, relays brain events over SSE, fires reminders,
// brokers permission requests, and reports status to the desktop overlay.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Brain, spentToday, readHistory } from './brain.mjs';
import { checkHealth, healthPage } from './health.mjs';
import { loadConfig, ROOT } from './config.mjs';
import * as reminders from './reminders.mjs';
import { startReminderLoop } from './reminders.mjs';
import * as su from './selfupdate.mjs';
import { speak } from './speak.mjs';
import { synthesize, ttsAvailable } from './tts.mjs';
import * as watchers from './watchers.mjs';
import { startWatcherLoop } from './watchers.mjs';
import { openWindow } from './window.mjs';

const cfg = loadConfig();
const brain = new Brain(cfg);
const clients = new Set();
const supervised = !!process.env.EVE_LAUNCHER; // started by src/launcher.mjs, which can restart us
let uiState = 'idle'; // what the browser reports: idle | listening | thinking | speaking
let reminderFlash = null; // { text, until } shown on the overlay
let restartRequested = false;

const broadcast = (event) => {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(data);
};

brain.on('delta', (text) => broadcast({ type: 'delta', text }));
brain.on('tool', ({ name, input, sub }) => broadcast({ type: 'tool', name, sub, label: toolLabel(name, input) }));
brain.on('done', (text) => broadcast({ type: 'done', text }));
let lastError = null; // shown on the health page until the next good reply
brain.on('error', (err) => { lastError = err.message.slice(0, 200); broadcast({ type: 'error', message: err.message }); });
brain.on('stats', (s) => { lastError = null; broadcast({ type: 'stats', ...s }); });
brain.on('model', (model) => broadcast({ type: 'model', model, pref: brain.modelPref }));
brain.on('task', (task, reason) => broadcast({ type: 'task', task, reason }));
brain.on('auto', (on) => { console.log(on ? '⚡ Auto mode ON: Eve acts without asking' : '🔐 Auto mode off'); broadcast({ type: 'auto', on }); });
brain.on('refreshed', () => { console.log('🧹 Context refreshed: fresh session (memory kept)'); broadcast({ type: 'refreshed' }); });
// Budget alerts reach Eve as a note on the next message; a loop-guard stop is also spoken now, since that reply was cut off.
brain.on('alert', (text) => { console.log(`💸 ${text}`); if (text.startsWith('Loop guard') && clients.size) broadcast({ type: 'reminder', text }); });
brain.on('permission-resolved', (ev) => broadcast({ type: 'permission-resolved', ...ev }));
brain.on('permission', (req) => {
  console.log(`🔐 Asking permission to ${req.title}`);
  if (!clients.size) return brain.respond(req.id, 'deny', "Nobody has Eve's window open to approve this. Ask the user to open it and try again.");
  broadcast({ type: 'permission', ...req });
});
brain.on('busy', (busy) => {
  broadcast({ type: 'busy', busy });
  if (!busy && restartRequested) restart();
});

startReminderLoop((r) => {
  console.log(`⏰ Reminder: ${r.text}`);
  reminderFlash = { text: r.text, until: Date.now() + 15000 };
  if (clients.size) broadcast({ type: 'reminder', text: r.text });
  else speak(`Reminder: ${r.text}`);
});

startWatcherLoop((w) => {
  console.log(`👁  Watcher #${w.id}: ${w.text}`);
  reminderFlash = { text: w.text, until: Date.now() + 15000 };
  if (clients.size) broadcast({ type: 'reminder', text: w.text });
  else speak(w.text);
});

// ---- Self-update bookkeeping (see src/launcher.mjs and tools/eve.mjs) ----
if (fs.existsSync(su.FAILED_FILE)) {
  try {
    const f = JSON.parse(fs.readFileSync(su.FAILED_FILE, 'utf8'));
    brain.note(`Your last self-update ("${f.reason}") failed (crashed on startup or failed the visual self-check) and was rolled back (git stash "${f.stash}"). Error output:\n${f.error}\nTell the user briefly and apologise.`);
  } catch {
    // corrupt file: just drop it
  }
  fs.rmSync(su.FAILED_FILE, { force: true });
}
if (fs.existsSync(su.PENDING_FILE)) {
  let reason = 'self-update';
  try {
    ({ reason } = JSON.parse(fs.readFileSync(su.PENDING_FILE, 'utf8')));
  } catch {
    // corrupt marker: generic reason
  }
  // Visual self-check once the server is up (page loads, no JS errors or stray text). Failing it rolls the update back.
  const checked = new Promise((resolve) => setTimeout(() => {
    execFile(process.execPath, [path.join(ROOT, 'tools/selfcheck.mjs')], { timeout: 90000, windowsHide: true }, (err, stdout) => {
      if (!err) { console.log('🔎 Self-check passed.'); return resolve(true); }
      const stash = `eve: failed self-check ${new Date().toISOString()}`;
      console.error(`\n⏪ Self-update "${reason}" failed the self-check. Rolling back (git stash: "${stash}").\n${stdout}`);
      try {
        su.stash(stash);
        fs.writeFileSync(su.FAILED_FILE, JSON.stringify({ reason, stash, error: `Self-check failed (tools/selfcheck.mjs):\n${String(stdout).slice(-1500)}` }, null, 2));
      } catch (e) {
        console.error(`Rollback failed: ${e.message}`);
      }
      fs.rmSync(su.PENDING_FILE, { force: true });
      resolve(false);
      if (supervised) restart(); // the launcher brings the previous code back up
    });
  }, 3000));
  // Survived long enough and passed the self-check: keep the update.
  setTimeout(async () => {
    if (!(await checked) || !fs.existsSync(su.PENDING_FILE)) return; // rolled back
    try {
      const hash = su.commit(`eve: self-update - ${reason}`);
      fs.rmSync(su.PENDING_FILE, { force: true });
      console.log(`✅ Self-update committed${hash ? ` (${hash})` : ''}`);
    } catch (e) {
      console.error(`Could not commit self-update: ${e.message}`);
    }
  }, su.COMMIT_AFTER_MS); // only once the launcher's crash-rollback window has passed
}

function restart() {
  console.log('♻️  Restarting to load updated code…');
  broadcast({ type: 'restarting' });
  brain.stop({ keepTask: true }); // an approved plan carries on after a self-restart
  setTimeout(() => process.exit(75), 300); // 75 = "restart me" for the launcher
}

// ---- HTTP ----
// The server can run commands on this PC, so only accept same-origin requests
// to localhost (blocks other websites and DNS-rebinding attacks).
const allowedHosts = new Set([`localhost:${cfg.port}`, `127.0.0.1:${cfg.port}`]);
function isTrusted(req) {
  if (!allowedHosts.has(req.headers.host)) return false;
  const origin = req.headers.origin;
  return !origin || allowedHosts.has(origin.replace(/^https?:\/\//, ''));
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c).length > 1e6 && req.destroy());
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const readPage = () => fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const pageHash = (html = readPage()) => createHash('sha1').update(html).digest('hex').slice(0, 10);

function status() {
  const pending = brain.pendingPermissions.length;
  const ui = clients.size ? uiState : 'idle';
  const state = pending ? 'permission' : ui === 'speaking' || ui === 'listening' ? ui : brain.busy ? 'thinking' : 'idle';
  const reminder = reminderFlash && reminderFlash.until > Date.now() ? reminderFlash.text : null;
  const task = brain.taskActive ? brain.task : null;
  return { state, busy: brain.busy, model: brain.runningModel || brain.model, pref: brain.modelPref, clients: clients.size, pending, reminder, task, auto: brain.autoMode };
}

const routes = {
  'POST /api/ask': async (req, res) => {
    const { text, interrupt } = await readJson(req);
    if (!text?.trim()) return json(res, 400, { error: 'text required' });
    console.log(`\n🗣  ${text}`);
    if (interrupt && brain.busy) brain.interrupt(); // a new request supersedes the one in progress
    broadcast({ type: 'user', text });
    brain.ask(text).then(
      (reply) => console.log(`🤖 ${reply}`),
      (err) => err.message !== 'stopped' && console.error(`⚠️  ${err.message}`),
    );
    json(res, 202, { ok: true });
  },
  'POST /api/permission': async (req, res) => {
    const { id, decision } = await readJson(req);
    if (!['allow', 'always', 'deny'].includes(decision)) return json(res, 400, { error: 'bad decision' });
    json(res, brain.respond(id, decision) ? 200 : 404, { ok: true });
  },
  'POST /api/tts': async (req, res) => {
    const { text } = await readJson(req);
    if (!text?.trim() || !ttsAvailable()) return json(res, 404, { error: 'no local voice' });
    try {
      const wav = await synthesize(String(text));
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length, 'Cache-Control': 'no-store' });
      res.end(wav);
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  },
  'GET /api/history': async (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    json(res, 200, { items: readHistory(Math.min(500, +q.get('n') || 100), { sinceReset: q.has('current') }) });
  },
  // "My things" panel: scheduled items, what Eve remembers about the user, and today's spend.
  'GET /api/things': (req, res) => {
    let profile = '';
    try { profile = fs.readFileSync(path.join(ROOT, 'workspace', 'memory', 'profile.md'), 'utf8'); } catch {}
    json(res, 200, {
      reminders: reminders.load().map((r) => ({ id: r.id, text: r.text, due: r.due, repeat: r.repeat })),
      watchers: watchers.load().map((w) => ({ id: w.id, type: w.type, target: w.target, text: w.text, message: w.message })),
      profile,
      spent: spentToday(),
      cap: brain.budget?.dailyHardUsd || 0,
    });
  },
  'POST /api/reminders/remove': async (req, res) => {
    const { id } = await readJson(req);
    json(res, 200, { ok: reminders.remove(Number(id)) });
  },
  'POST /api/watchers/remove': async (req, res) => {
    const { id } = await readJson(req);
    json(res, 200, { ok: watchers.remove(Number(id)) });
  },
  'POST /api/profile': async (req, res) => {
    const { text } = await readJson(req);
    if (typeof text !== 'string' || text.length > 20000) return json(res, 400, { error: 'Profile must be text under 20,000 characters.' });
    fs.writeFileSync(path.join(ROOT, 'workspace', 'memory', 'profile.md'), text);
    json(res, 200, { ok: true });
  },
  'POST /api/ui-state': async (req, res) => {
    const { state } = await readJson(req);
    if (['idle', 'listening', 'thinking', 'speaking'].includes(state)) uiState = state;
    json(res, 200, { ok: true });
  },
  'POST /api/auto': async (req, res) => {
    const { on } = await readJson(req);
    brain.setAutoMode(on);
    json(res, 200, { ok: true, auto: brain.autoMode });
  },
  'POST /api/model': async (req, res) => {
    const { model } = await readJson(req);
    try { brain.setModel(model); json(res, 200, { ok: true, model }); } catch (e) { json(res, 400, { error: e.message }); }
  },
  'POST /api/stop': (req, res) => {
    brain.interrupt(); // instant; keeps Claude warm (falls back to a hard stop)
    json(res, 200, { ok: true });
  },
  'POST /api/reset': (req, res) => {
    brain.reset();
    broadcast({ type: 'reset' });
    json(res, 200, { ok: true });
  },
  'POST /api/refresh': (req, res) => {
    json(res, 200, { ok: true, now: brain.refresh() }); // now=false: deferred until Eve is between turns
  },
  'POST /api/restart': (req, res) => {
    if (!supervised) return json(res, 409, { error: 'Eve is not running under the launcher, so she cannot restart herself. Ask the user to restart start-eve.bat.' });
    restartRequested = true;
    brain.holdTask = true; // keep an approved plan through the restart
    json(res, 200, { ok: true });
    if (!brain.busy) restart();
  },
  'POST /api/quit': (req, res) => {
    json(res, 200, { ok: true });
    console.log('👋 Shutting down.');
    brain.stop();
    setTimeout(() => process.exit(0), 200);
  },
  'POST /api/open-window': (req, res) => {
    openWindow(cfg, `http://localhost:${cfg.port}`); // double-click on the desktop overlay
    json(res, 200, { ok: true });
  },
  'GET /api/status': (req, res) => json(res, 200, status()),
  'GET /api/health': async (req, res) => json(res, 200, await checkHealth({ brain, cfg, clients: clients.size, lastError, spentToday })),
  'GET /health': async (req, res) => {
    const html = healthPage(await checkHealth({ brain, cfg, clients: clients.size, lastError, spentToday }));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  },
};

const server = http.createServer(async (req, res) => {
  if (!isTrusted(req)) return json(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = readPage();
    const pageCfg = { wakeWord: cfg.wakeWord, wakeAliases: cfg.wakeAliases, wakeReplies: cfg.wakeReplies, speechPauseMs: cfg.speechPauseMs, speechLang: cfg.speechLang, bargeIn: cfg.bargeIn, voice: cfg.voice, honorific: cfg.honorific, conversationSeconds: cfg.conversationSeconds, localVoice: cfg.tts !== 'browser' && ttsAvailable(), uiHash: pageHash(html) };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html.replace('/*CONFIG*/', () => JSON.stringify(pageCfg)));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const hello = { type: 'hello', uiHash: pageHash(), model: brain.runningModel || brain.model, pref: brain.modelPref, busy: brain.busy, pending: brain.pendingPermissions, task: brain.taskActive ? brain.task : null, auto: brain.autoMode };
    // retry: reconnect quickly after a restart, well inside the "is a window already open?" wait below.
    res.write(`retry: 1000\ndata: ${JSON.stringify(hello)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      if (!clients.size) uiState = 'idle';
    });
    return;
  }

  const route = routes[`${req.method} ${url.pathname}`];
  // POSTs must be JSON: browsers can't send that cross-site without a CORS preflight, which we never approve.
  if (route && (req.method === 'GET' || req.headers['content-type']?.startsWith('application/json'))) return route(req, res);
  json(res, 404, { error: 'not found' });
});

server.listen(cfg.port, '127.0.0.1', () => {
  const url = `http://localhost:${cfg.port}`;
  console.log(`EVE online at ${url}  (brain: ${cfg.claudePath}, model: ${brain.model})`);
  brain.start(); // warm up the Claude process so the first answer is fast
  const firstStart = !process.env.EVE_RESTARTED;
  if (firstStart && cfg.openBrowser && !process.env.EVE_NO_BROWSER && process.platform === 'win32') {
    // Give a window left open from a previous run a moment to reconnect, so we don't open a second one.
    setTimeout(() => clients.size || openWindow(cfg, url), 3500);
  }
});

// A plain phrase for the chat ("Reading my notes…"); raw commands and paths are never sent to the UI.
const BASH_LABELS = [
  [/memory.mjss+(add|update|remove|link|forget)/, 'Updating my notes…'], [/memory.mjs|memory[\/]/, 'Reading my notes…'],
  [/screenshot.mjs/, 'Looking at your screen…'], [/remind.mjs/, 'Checking reminders…'], [/watch.mjs/, 'Setting up a watcher…'],
  [/desktop.mjs/, 'Working with your desktop…'], [/eve.mjss+restart/, 'Restarting myself…'], [/eve.mjss+(task|checkpoint)/, 'Getting ready…'],
  [/eve.mjs/, 'Adjusting my settings…'], [/usage.mjs/, 'Checking usage…'], [/local.mjs/, 'Thinking locally…'], [/cache.mjs/, 'Checking my cache…'],
  [/eval.mjs|selfcheck.mjs/, 'Running checks…'], [/connector.mjs/, 'Managing connectors…'], [/git/, 'Checking my history…'],
  [/(start|Start-Process|explorer)/, 'Opening that…'], [/(curl|Invoke-WebRequest)/, 'Fetching from the web…'],
];
function toolLabel(name = '', input = {}) {
  const file = String(input.file_path || input.path || '');
  const mine = /memory[\/]|profile.md|session-state|recent.md|todo.md/i.test(file);
  switch (name) {
    case 'Bash': case 'PowerShell': {
      const cmd = String(input.command || '');
      return BASH_LABELS.find(([re]) => re.test(cmd))?.[1] || 'Working on it…';
    }
    case 'Read': return mine ? 'Reading my notes…' : /.(png|jpe?g|gif|webp)$/i.test(file) ? 'Looking at the image…' : 'Reading a file…';
    case 'Write': case 'Edit': case 'MultiEdit': return mine ? 'Updating my notes…' : 'Editing a file…';
    case 'Grep': case 'Glob': return mine ? 'Searching my notes…' : 'Searching files…';
    case 'Screenshot': return 'Looking at your screen…';
    case 'WebSearch': return 'Searching the web…';
    case 'WebFetch': return 'Reading a web page…';
    case 'Task': case 'Agent': return 'Asking a helper…';
    case 'TodoWrite': return 'Planning…';
    default: return name.startsWith('mcp__') ? `Using ${name.split('__')[1] || 'a connector'}…` : 'Working on it…';
  }
}
