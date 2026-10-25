#!/usr/bin/env node
// Usage and performance dashboard from data/usage.jsonl (one line per turn, written by src/brain.mjs and tools/local.mjs). Usage:
//   node tools/usage.mjs [days]          (default: last 7 days; tokens, cost, cache, calls, speed, failures per day and model)
//   node tools/usage.mjs [days] --html   (same, as a page in the browser, plus system stats)
//   node tools/usage.mjs sys             (CPU, RAM, GPU/VRAM right now)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DATA_DIR } from '../src/config.mjs';

const FILE = path.join(DATA_DIR, 'usage.jsonl');
const argv = process.argv.slice(2);
const html = argv.includes('--html');
const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const usd = (n) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

function sys() {
  const cpus = os.cpus();
  const s = { cpu: cpus[0]?.model.trim(), cores: cpus.length, ramUsed: (os.totalmem() - os.freemem()) / 2 ** 30, ramTotal: os.totalmem() / 2 ** 30, gpus: [] };
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      "$l=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average; 'CPU|' + $l;" +
      "Get-CimInstance Win32_VideoController | ForEach-Object { 'GPU|' + $_.Name };" +
      "try { $u=(Get-Counter '\\GPU Adapter Memory(*)\\Dedicated Usage' -EA Stop).CounterSamples | Measure-Object CookedValue -Sum; 'VRAM|' + $u.Sum } catch {}"],
    { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split(/\r?\n/)) {
      const [key, val] = line.split('|');
      if (key === 'CPU') s.load = Number(val);
      if (key === 'GPU') s.gpus.push(val.trim());
      if (key === 'VRAM') s.vramUsed = Number(val) / 2 ** 30;
    }
  } catch {}
  return s;
}
const sysText = (s) => `CPU: ${s.cpu} (${s.cores} threads)${s.load != null ? `, ${s.load}% load` : ''}\n`
  + `RAM: ${s.ramUsed.toFixed(1)} / ${s.ramTotal.toFixed(1)} GB\n`
  + `GPU: ${s.gpus.join(', ') || 'unknown'}${s.vramUsed != null ? `, ${s.vramUsed.toFixed(1)} GB VRAM in use` : ''}`;

if (argv[0] === 'sys') { console.log(sysText(sys())); process.exit(0); }

const days = Math.max(1, Number(argv.find((a) => /^\d+$/.test(a))) || 7);
const since = Date.now() - days * 86400000;
const rows = (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf8').split('\n') : [])
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && Date.parse(r.ts) >= since);

if (!rows.length) {
  console.log(`No usage logged in the last ${days} day(s).`);
  process.exit(0);
}

// Group per day and model. Older log lines have tokens only; the rest (cost, timing, calls) is counted where present.
const blank = () => ({ turns: 0, ok: 0, err: 0, stop: 0, esc: 0, input: 0, cache_read: 0, cache_creation: 0, output: 0, total: 0, cost: 0, okCost: 0, calls: 0, tools: 0, ms: 0, msN: 0, ttft: 0, ttftN: 0, tps: 0, tpsN: 0 });
function add(g, r) {
  g.turns++;
  for (const f of ['input', 'cache_read', 'cache_creation', 'output', 'total']) g[f] += r[f] || 0;
  g.cost += r.cost_usd || 0;
  if (r.status === 'error') g.err++; else if (r.status === 'interrupted') g.stop++; else { g.ok++; g.okCost += r.cost_usd || 0; }
  if (r.escalated) g.esc++;
  g.calls += r.model_calls || 0;
  g.tools += r.tool_calls || 0;
  if (r.ms) { g.ms += r.ms; g.msN++; }
  if (r.ttft_ms) { g.ttft += r.ttft_ms; g.ttftN++; }
  if (r.tok_per_s) { g.tps += r.tok_per_s; g.tpsN++; }
}
const groups = new Map(), all = blank();
for (const r of rows) {
  const key = `${new Date(r.ts).toLocaleDateString('en-CA')}  ${r.model}`;
  if (!groups.has(key)) groups.set(key, blank());
  add(groups.get(key), r);
  add(all, r);
}
const cacheHit = (g) => { const p = g.input + g.cache_read + g.cache_creation; return p ? `${Math.round((g.cache_read / p) * 100)}%` : '-'; };
const avg = (sum, n, f) => (n ? f(sum / n) : '-');
const cols = ['date', 'model', 'turns', 'ok/err/stop', 'input', 'cacheRd', 'cacheWr', 'output', 'cache%', 'cost', '$/ok task', 'calls', 'tools', 'avg time', 'ttft', 'tok/s', 'escal'];
const line = (date, model, g) => [date, model, g.turns, `${g.ok}/${g.err}/${g.stop}`, k(g.input), k(g.cache_read), k(g.cache_creation), k(g.output), cacheHit(g),
  usd(g.cost), g.ok ? usd(g.okCost / g.ok) : '-', g.calls, g.tools, avg(g.ms, g.msN, sec), avg(g.ttft, g.ttftN, sec), avg(g.tps, g.tpsN, (n) => n.toFixed(1)), g.esc];
const table = [...groups].sort().map(([key, g]) => line(...key.split('  '), g));
const totals = line('all', '', all);
const summary = `${all.turns} turns, ${k(all.total)} tokens, ${usd(all.cost)} total, ${all.ok ? usd(all.okCost / all.ok) : '-'} per successful task, `
  + `cache hit ${cacheHit(all)}, failure rate ${Math.round((all.err / all.turns) * 100)}%, ${all.esc} escalations.`;

if (!html) {
  const width = cols.map((c, i) => Math.max(c.length, ...[...table, totals].map((r) => String(r[i]).length)));
  const fmt = (r) => r.map((v, i) => String(v)[i < 2 ? 'padEnd' : 'padStart'](width[i])).join('  ');
  console.log(`Usage, last ${days} day(s):`);
  console.log(fmt(cols));
  table.forEach((r) => console.log(fmt(r)));
  console.log(fmt(totals));
  console.log(`\n${summary}`);
  process.exit(0);
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const tr = (r, tag = 'td') => `<tr>${r.map((v) => `<${tag}>${esc(v)}</${tag}>`).join('')}</tr>`;
const daily = new Map();
for (const r of rows) { const d = new Date(r.ts).toLocaleDateString('en-CA'); daily.set(d, (daily.get(d) || 0) + (r.cost_usd || 0)); }
const maxDay = Math.max(...daily.values(), 0.001);
const bars = [...daily].sort().map(([d, c]) => `<div class="bar"><span>${d}</span><i style="width:${(c / maxDay) * 100}%"></i><b>${usd(c)}</b></div>`).join('');
const page = `<!doctype html><meta charset="utf-8"><title>Eve's usage dashboard</title>
<style>body{background:#0b0f1a;color:#e2e8f0;font:14px system-ui;margin:24px}h1{color:#7dd3fc;font-size:20px}h2{color:#94a3b8;font-size:15px;margin-top:28px}
table{border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:5px 10px;border-bottom:1px solid #1e293b;text-align:right}td:nth-child(-n+2),th:nth-child(-n+2){text-align:left}
th{color:#7dd3fc}tr:last-child td{font-weight:600}pre{background:#111827;padding:12px;border-radius:8px}
.bar{display:flex;align-items:center;gap:10px;margin:4px 0}.bar span{width:90px;color:#94a3b8}.bar i{display:block;height:14px;background:#38bdf8;border-radius:3px}.bar b{font-weight:400}</style>
<h1>Eve's usage dashboard &middot; last ${days} day(s)</h1><p>${esc(summary)}</p>
<h2>Cost per day</h2>${bars}
<h2>Per day and model</h2><table>${tr(cols, 'th')}${table.map((r) => tr(r)).join('')}${tr(totals)}</table>
<h2>This PC right now</h2><pre>${esc(sysText(sys()))}</pre>
<p style="color:#64748b">Generated ${new Date().toLocaleString()}. Older turns logged before 2026-10-25 have tokens only.</p>`;
const out = path.join(DATA_DIR, 'usage.html');
fs.writeFileSync(out, page);
console.log(`Dashboard written to ${out}.\n${summary}`);
spawn('cmd', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' }).unref();
