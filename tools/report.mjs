#!/usr/bin/env node
// Builds docs/eve-report.html: a self-contained page with live usage charts, project stats and an
// architecture diagram, for portfolio screenshots. Usage: node tools/report.mjs [days]  (default 30)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, DATA_DIR } from '../src/config.mjs';

const days = Math.max(1, Number(process.argv[2]) || 30);
const since = Date.now() - days * 86400000;
const rows = (fs.existsSync(path.join(DATA_DIR, 'usage.jsonl')) ? fs.readFileSync(path.join(DATA_DIR, 'usage.jsonl'), 'utf8').split('\n') : [])
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && Date.parse(r.ts) >= since);

const perDay = new Map();
const perModel = new Map();
for (const r of rows) {
  const d = new Date(r.ts).toLocaleDateString('en-CA');
  perDay.set(d, (perDay.get(d) || 0) + (r.total || 0));
  perModel.set(r.model, (perModel.get(r.model) || 0) + 1);
}
const turns = rows.length;
const totalTokens = rows.reduce((a, r) => a + (r.total || 0), 0);
const outTokens = rows.reduce((a, r) => a + (r.output || 0), 0);

const git = (...a) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } };
const selfUpdates = git('log', '--oneline', '--grep=^eve: self-update').split('\n').filter(Boolean).length;
const commits = git('rev-list', '--count', 'HEAD') || '0';
const srcFiles = ['src', 'tools', 'public', 'prompts'].flatMap((d) => {
  const dir = path.join(ROOT, d);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.(mjs|html|md|ps1)$/.test(f)).map((f) => path.join(dir, f)) : [];
});
const loc = srcFiles.reduce((a, f) => a + fs.readFileSync(f, 'utf8').split('\n').length, 0);

const bars = (map, color) => {
  const entries = [...map].sort();
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, v]) => `<div class="row"><span>${k}</span><div class="bar"><i style="width:${(v / max) * 100}%;background:${color}"></i></div><b>${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v}</b></div>`).join('') || '<p>No data yet.</p>';
};
const card = (n, l) => `<div class="card"><h2>${n}</h2><p>${l}</p></div>`;

const html = `<!doctype html><meta charset="utf-8"><title>EVE report</title>
<style>
body{background:#0b1220;color:#d8e6ff;font:15px system-ui;margin:0;padding:32px;max-width:900px;margin:auto}
h1{color:#5ee7ff;margin:0}.sub{color:#8aa0c4;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:28px}
.card{background:#121c33;border:1px solid #1f2f52;border-radius:12px;padding:16px}.card h2{margin:0;color:#5ee7ff;font-size:28px}.card p{margin:4px 0 0;color:#8aa0c4}
section{background:#121c33;border:1px solid #1f2f52;border-radius:12px;padding:18px;margin-bottom:20px}h3{margin-top:0}
.row{display:flex;align-items:center;gap:10px;margin:6px 0}.row span{width:90px;color:#8aa0c4}.bar{flex:1;background:#0b1220;border-radius:6px;height:14px}.bar i{display:block;height:100%;border-radius:6px}
.flow{display:flex;flex-direction:column;align-items:center;gap:6px}.node{background:#0b1220;border:1px solid #5ee7ff;border-radius:8px;padding:8px 16px;min-width:280px;text-align:center}.arrow{color:#5ee7ff}
.pair{display:flex;gap:12px}
</style>
<h1>E.V.E. — Evolving Virtual Entity</h1><div class="sub">Self-improving voice assistant for Windows · report generated ${new Date().toLocaleString('en-PH')}</div>
<div class="cards">${card(turns, `conversation turns (${days}d)`)}${card((totalTokens / 1e6).toFixed(2) + 'M', 'tokens used')}${card(turns ? Math.round(totalTokens / turns / 1000) + 'k' : '0', 'avg tokens / turn')}${card(outTokens.toLocaleString(), 'tokens spoken / written')}${card(selfUpdates, 'self-updates committed')}${card(commits, 'total commits')}${card(loc.toLocaleString(), 'lines of code & prompts')}</div>
<section><h3>Tokens per day</h3>${bars(perDay, '#5ee7ff')}</section>
<section><h3>Turns by model (lightest model that fits)</h3>${bars(perModel, '#b388ff')}</section>
<section><h3>Architecture</h3><div class="flow">
<div class="pair"><div class="node">Browser voice UI<br>speech in / out</div><div class="node">Desktop overlay<br>status pill</div></div><div class="arrow">⇅ HTTP + SSE</div>
<div class="node">Server: reminders · watchers · permission broker</div><div class="arrow">⇅ stream-json + permission checks</div>
<div class="node">Claude Code CLI (brain) · MCP connectors</div><div class="arrow">⇅</div>
<div class="node">Your PC: files · apps · web · screen</div><div class="arrow">↺</div>
<div class="node">Launcher: checkpoint → edit → restart → auto-rollback on crash</div></div></section>`;

fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
const out = path.join(ROOT, 'docs', 'eve-report.html');
fs.writeFileSync(out, html);
console.log(out);
