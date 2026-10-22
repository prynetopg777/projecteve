// Local web server: serves the voice UI, relays brain events over SSE, fires reminders,
// brokers permission requests, and reports status to the desktop overlay.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Brain } from './brain.mjs';
import { loadConfig, ROOT } from './config.mjs';
import { startReminderLoop } from './reminders.mjs';
import * as su from './selfupdate.mjs';
import { speak } from './speak.mjs';
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
brain.on('tool', ({ name, input, sub }) => broadcast({ type: 'tool', name, sub, detail: describeTool(input) }));
brain.on('done', (text) => broadcast({ type: 'done', text }));
brain.on('error', (err) => broadcast({ type: 'error', message: err.message }));
brain.on('model', (model) => broadcast({ type: 'model', model }));
brain.on('task', (task, reason) => broadcast({ type: 'task', task, reason }));
brain.on('auto', (on) => { console.log(on ? '⚡ Auto mode ON: Eve acts without asking' : '🔐 Auto mode off'); broadcast({ type: 'auto', on }); });
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

// ---- Self-update bookkeeping (see src/launcher.mjs and tools/eve.mjs) ----
if (fs.existsSync(su.FAILED_FILE)) {
  const f = JSON.parse(fs.readFileSync(su.FAILED_FILE, 'utf8'));
  brain.note(`Your last self-update ("${f.reason}") crashed on startup and was rolled back (git stash "${f.stash}"). Error output:\n${f.error}\nTell the user briefly and apologise.`);
  fs.rmSync(su.FAILED_FILE);
}
if (fs.existsSync(su.PENDING_FILE)) {
  // Survived long enough: keep the update.
  setTimeout(() => {
    try {
      const { reason } = JSON.parse(fs.readFileSync(su.PENDING_FILE, 'utf8'));
      const hash = su.commit(`eve: self-update - ${reason}`);
      fs.rmSync(su.PENDING_FILE);
      console.log(`✅ Self-update committed${hash ? ` (${hash})` : ''}`);
    } catch (e) {
      console.error(`Could not commit self-update: ${e.message}`);
    }
  }, 20000);
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
  return { state, busy: brain.busy, model: brain.runningModel || brain.model, clients: clients.size, pending, reminder, task, auto: brain.autoMode };
}

const routes = {
  'POST /api/ask': async (req, res) => {
    const { text } = await readJson(req);
    if (!text?.trim()) return json(res, 400, { error: 'text required' });
    console.log(`\n🗣  ${text}`);
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
  'POST /api/stop': (req, res) => {
    brain.stop();
    json(res, 200, { ok: true });
  },
  'POST /api/reset': (req, res) => {
    brain.reset();
    broadcast({ type: 'reset' });
    json(res, 200, { ok: true });
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
};

const server = http.createServer(async (req, res) => {
  if (!isTrusted(req)) return json(res, 403, { error: 'forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/') {
    const html = readPage();
    const pageCfg = { wakeWord: cfg.wakeWord, wakeAliases: cfg.wakeAliases, wakeReplies: cfg.wakeReplies, speechPauseMs: cfg.speechPauseMs, voice: cfg.voice, honorific: cfg.honorific, uiHash: pageHash(html) };
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html.replace('/*CONFIG*/', () => JSON.stringify(pageCfg)));
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const hello = { type: 'hello', uiHash: pageHash(), model: brain.runningModel || brain.model, busy: brain.busy, pending: brain.pendingPermissions, task: brain.taskActive ? brain.task : null, auto: brain.autoMode };
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

function describeTool(input = {}) {
  const s = input.command || input.query || input.url || input.file_path || input.pattern || input.description || '';
  return String(s).slice(0, 160);
}
