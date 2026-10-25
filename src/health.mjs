// One page that shows every part of Eve green (fine), amber (degraded, still works) or red (broken).
// Served at /health (HTML) and /api/health (JSON).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.mjs';
import * as reminders from './reminders.mjs';
import * as su from './selfupdate.mjs';
import * as watchers from './watchers.mjs';

const OLLAMA = 'http://127.0.0.1:11434';
const run = (args) => new Promise((resolve) => execFile(process.execPath, args, { cwd: ROOT, windowsHide: true, timeout: 20000 }, (e, out) => resolve({ ok: !e, out: String(out || '') })));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const item = (name, level, detail) => ({ name, level, detail });

export async function checkHealth({ brain, cfg, clients, lastError, spentToday }) {
  const out = [];

  // Brain: the Claude CLI process (it starts on demand, so "not running" is fine).
  const cli = cfg.claudePath && (fs.existsSync(cfg.claudePath) || !/[\\/]/.test(cfg.claudePath));
  out.push(item('Brain (Claude CLI)', !cli ? 'red' : lastError ? 'amber' : 'green',
    `${brain.proc ? `running on ${brain.runningModel}` : 'starts on the next message'}${lastError ? `; last error: ${lastError}` : ''}`));
  out.push(item('Voice window', clients ? 'green' : 'amber', clients ? `${clients} connected` : 'not open'));

  // Spending against the soft alert and hard cap.
  const spent = spentToday(), b = brain.budget;
  out.push(item('Spending today', b.dailyHardUsd && spent >= b.dailyHardUsd ? 'red' : b.dailyUsd && spent >= b.dailyUsd ? 'amber' : 'green',
    `$${spent.toFixed(2)} (alert at $${b.dailyUsd}, hard cap $${b.dailyHardUsd})`));

  // Local models: routing, memory embeddings, cheap jobs.
  try {
    const tags = await (await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) })).json();
    const ps = await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(1500) })).json();
    const names = tags.models.map((m) => m.name), loaded = ps.models.map((m) => m.name);
    const router = cfg.routerModel || 'llama3.2';
    out.push(item('Local models (Ollama)', 'green', `${names.length} installed; loaded: ${loaded.join(', ') || 'none'}`));
    out.push(item('Smart routing', loaded.some((n) => n.startsWith(router)) ? 'green' : 'amber',
      loaded.some((n) => n.startsWith(router)) ? `${router} warm` : `${router} warms up on the next message; keyword routing meanwhile`));
    out.push(item('Memory by meaning', names.some((n) => n.startsWith('nomic-embed-text')) ? 'green' : 'amber',
      names.some((n) => n.startsWith('nomic-embed-text')) ? 'nomic-embed-text installed' : 'embedding model missing; word search only'));
  } catch {
    out.push(item('Local models (Ollama)', 'amber', 'not running; routing and memory fall back to keywords'));
  }

  // Memory database.
  const mem = await run(['tools/memory.mjs', 'list', '1']);
  out.push(item('Long-term memory', mem.ok ? 'green' : 'red', mem.ok ? (mem.out.trim() ? `latest: ${mem.out.trim().slice(0, 80)}` : 'empty') : 'database error'));
  for (const f of ['memory/profile.md', 'memory/recent.md', 'memory/projects.md']) {
    const p = path.join(ROOT, 'workspace', f);
    out.push(item(f, fs.existsSync(p) ? 'green' : 'amber', fs.existsSync(p) ? `${Math.round(fs.statSync(p).size / 1024 * 10) / 10} KB` : 'missing'));
  }

  // Background loops.
  try { out.push(item('Reminders', 'green', `${reminders.load().length} scheduled`)); } catch { out.push(item('Reminders', 'red', 'reminders.json unreadable')); }
  try { out.push(item('Watchers', 'green', `${watchers.load().length} active`)); } catch { out.push(item('Watchers', 'red', 'watchers.json unreadable')); }
  try { out.push(item('Tool cache', 'green', `${fs.readdirSync(path.join(DATA_DIR, 'cache')).length} entries`)); } catch { out.push(item('Tool cache', 'green', 'empty')); }
  const learned = Object.values(readJson(path.join(DATA_DIR, 'learned-permissions.json')) || {}).filter((n) => n >= 3).length;
  out.push(item('Learned permissions', 'green', `${learned} action${learned === 1 ? '' : 's'} no longer asked`));

  // Self-update state and offline tests.
  const failed = readJson(su.FAILED_FILE);
  let last = '';
  try { last = su.lastCommitMessage(); } catch {}
  out.push(item('Self-update', failed ? 'red' : 'green', failed ? `last update was rolled back: ${failed.error || failed.reason || 'crashed'}` : `last: ${last}`));
  const evals = await run(['tools/eval.mjs', 'checks']);
  const failing = evals.out.split('\n').filter((l) => /fail/i.test(l) && !/passed/i.test(l));
  out.push(item('Offline tests', evals.ok && !failing.length ? 'green' : 'red', evals.out.trim().split('\n').slice(-4).join(' · ') || 'could not run'));

  return { ok: !out.some((i) => i.level === 'red'), checked: new Date().toISOString(), items: out };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function healthPage(h) {
  const dot = { green: '#22c55e', amber: '#f59e0b', red: '#ef4444' };
  const rows = h.items.map((i) => `<tr><td><span style="color:${dot[i.level]}">●</span> ${esc(i.name)}</td><td>${esc(i.detail)}</td></tr>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>Eve health</title>
<style>body{background:#0b1020;color:#e2e8f0;font:15px system-ui;margin:2rem}h1{font-weight:500}td{padding:.45rem 1rem;border-bottom:1px solid #1e293b;vertical-align:top}td:first-child{white-space:nowrap}small{color:#64748b}a{color:#38bdf8}</style>
<h1>${h.ok ? 'All systems go' : 'Something needs attention'}</h1>
<table>${rows}</table><p><small>Checked ${esc(new Date(h.checked).toLocaleString())} · <a href="/health">refresh</a></small></p>`;
}
