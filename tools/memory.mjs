#!/usr/bin/env node
// Searchable long-term memory (SQLite full-text search) in data/memory.db. Usage:
//   node tools/memory.mjs add "fact or event" [--tag people] [--source "where from"] [--expires 30d|2026-12-01]
//   node tools/memory.mjs update <id> ["corrected text"] [--tag/--source/--expires]
//   node tools/memory.mjs expired [--purge]  (hidden from search once past their date)
//   node tools/memory.mjs search "words"      (best matches first)
//   node tools/memory.mjs list [n]            (newest first)
//   node tools/memory.mjs remove <id>
//   node tools/memory.mjs link "Mom" "sister of" "Aunt Ana"   (knowledge graph edge)
//   node tools/memory.mjs graph "Mom"        (everything connected to a name)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../src/config.mjs';

const GRAPH_HTML = `<!doctype html><meta charset="utf-8"><title>Eve's knowledge graph</title>
<style>html,body{margin:0;height:100%;background:#0b0f1a;overflow:hidden;font-family:system-ui,sans-serif}canvas{display:block}
#t{position:fixed;top:12px;left:16px;color:#7dd3fc;font-size:14px;opacity:.8}</style>
<div id="t">Eve's knowledge graph &middot; drag nodes to move them</div><canvas id="c"></canvas>
<script>
const edges=__EDGES__, c=document.getElementById('c'), x=c.getContext('2d');
const nodes=new Map(), key=(s)=>s.toLowerCase();
const node=(n)=>{const k=key(n);if(!nodes.has(k))nodes.set(k,{n,x:innerWidth/2+(Math.random()-.5)*300,y:innerHeight/2+(Math.random()-.5)*300,vx:0,vy:0,d:0});return nodes.get(k)};
const links=edges.map(e=>{const a=node(e.a),b=node(e.b);a.d++;b.d++;return{a,b,rel:e.rel}});
const list=[...nodes.values()];let drag=null;
function resize(){c.width=innerWidth;c.height=innerHeight}resize();onresize=resize;
function step(){
 for(const p of list)for(const q of list)if(p!==q){let dx=p.x-q.x,dy=p.y-q.y,d2=dx*dx+dy*dy+50,f=9000/d2,d=Math.sqrt(d2);p.vx+=dx/d*f;p.vy+=dy/d*f}
 for(const l of links){let dx=l.b.x-l.a.x,dy=l.b.y-l.a.y,d=Math.hypot(dx,dy)||1,f=(d-170)*.02;l.a.vx+=dx/d*f;l.a.vy+=dy/d*f;l.b.vx-=dx/d*f;l.b.vy-=dy/d*f}
 for(const p of list){p.vx+=(c.width/2-p.x)*.003;p.vy+=(c.height/2-p.y)*.003;if(p!==drag){p.x+=p.vx;p.y+=p.vy}p.vx*=.8;p.vy*=.8}
}
const r=(p)=>10+Math.min(p.d,8)*3;
function draw(){
 x.clearRect(0,0,c.width,c.height);x.font='12px system-ui';x.textAlign='center';
 for(const l of links){x.strokeStyle='#334155';x.lineWidth=1.5;x.beginPath();x.moveTo(l.a.x,l.a.y);x.lineTo(l.b.x,l.b.y);x.stroke();
  x.fillStyle='#94a3b8';x.fillText(l.rel,(l.a.x+l.b.x)/2,(l.a.y+l.b.y)/2-4)}
 for(const p of list){x.fillStyle=p.d>2?'#38bdf8':'#818cf8';x.beginPath();x.arc(p.x,p.y,r(p),0,7);x.fill();x.fillStyle='#e2e8f0';x.fillText(p.n,p.x,p.y+r(p)+14)}
}
(function loop(){step();draw();requestAnimationFrame(loop)})();
c.onmousedown=e=>{drag=list.find(p=>Math.hypot(p.x-e.clientX,p.y-e.clientY)<r(p)+4)||null};
onmousemove=e=>{if(drag){drag.x=e.clientX;drag.y=e.clientY}};onmouseup=()=>drag=null;
</script>`;

process.removeAllListeners('warning');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'memory.db'));
db.exec(`CREATE TABLE IF NOT EXISTS mem (id INTEGER PRIMARY KEY, ts TEXT, tag TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS edge (id INTEGER PRIMARY KEY, a TEXT COLLATE NOCASE, rel TEXT, b TEXT COLLATE NOCASE);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, tag, content='mem', content_rowid='id');`);
// Columns added later: where a memory came from, and when it stops being true.
const cols = db.prepare('PRAGMA table_info(mem)').all().map((c) => c.name);
if (!cols.includes('source')) db.exec("ALTER TABLE mem ADD COLUMN source TEXT DEFAULT ''");
if (!cols.includes('expires')) db.exec("ALTER TABLE mem ADD COLUMN expires TEXT DEFAULT ''");

const [cmd = '', ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest.splice(i, 2)[1] || '' : ''; };
const tag = flag('--tag');
const source = flag('--source');
const expires = toDate(flag('--expires'));
const arg = rest.join(' ').trim();
const quoted = rest.map((x) => x.trim());
const show = (r) => console.log(`#${r.id} [${r.ts.slice(0, 10)}${r.tag ? ' ' + r.tag : ''}] ${r.text}`
  + (r.source ? ` (source: ${r.source})` : '') + (r.expires ? ` (expires ${r.expires.slice(0, 10)})` : ''));
const live = "(m.expires = '' OR m.expires IS NULL OR m.expires > ?)";
const now = new Date().toISOString();

// "30d", "2w", "12h" from now, or an absolute date.
function toDate(s) {
  if (!s) return '';
  const m = /^(\d+)\s*([hdwm])$/i.exec(s);
  if (m) return new Date(Date.now() + Number(m[1]) * { h: 36e5, d: 864e5, w: 6048e5, m: 2592e6 }[m[2].toLowerCase()]).toISOString();
  const d = new Date(s);
  if (isNaN(d)) { console.log(`Couldn't read the date "${s}".`); process.exit(1); }
  return d.toISOString();
}
function drop(r) { db.prepare("INSERT INTO mem_fts (mem_fts, rowid, text, tag) VALUES ('delete', ?, ?, ?)").run(r.id, r.text, r.tag); }

if (cmd === 'add' && arg) {
  const { lastInsertRowid: id } = db.prepare('INSERT INTO mem (ts, tag, text, source, expires) VALUES (?, ?, ?, ?, ?)').run(now, tag, arg, source, expires);
  db.prepare('INSERT INTO mem_fts (rowid, text, tag) VALUES (?, ?, ?)').run(id, arg, tag);
  console.log(`Remembered #${id}.`);
} else if (cmd === 'update' && /^\d+$/.test(quoted[0] || '')) {
  // Correct a memory in place: new text and/or --tag/--source/--expires.
  const r = db.prepare('SELECT * FROM mem WHERE id = ?').get(Number(quoted[0]));
  if (!r) { console.log('No such memory.'); process.exit(1); }
  const text = quoted.slice(1).join(' ').trim() || r.text, t = tag || r.tag;
  drop(r);
  db.prepare('UPDATE mem SET ts = ?, tag = ?, text = ?, source = ?, expires = ? WHERE id = ?').run(now, t, text, source || r.source || '', expires || r.expires || '', r.id);
  db.prepare('INSERT INTO mem_fts (rowid, text, tag) VALUES (?, ?, ?)').run(r.id, text, t);
  console.log(`Updated #${r.id}.`);
} else if (cmd === 'search' && arg) {
  const q = arg.split(/\s+/).map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  const rows = db.prepare(`SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.rowid WHERE mem_fts MATCH ? AND ${live} ORDER BY bm25(mem_fts) LIMIT 10`).all(q, now);
  rows.length ? rows.forEach(show) : console.log('Nothing found.');
} else if (cmd === 'list') {
  db.prepare(`SELECT * FROM mem m WHERE ${live} ORDER BY id DESC LIMIT ?`).all(now, Number(arg) || 10).forEach(show);
} else if (cmd === 'expired') {
  // Expired memories are hidden from search; this lists them, and "expired --purge" deletes them.
  const rows = db.prepare(`SELECT * FROM mem m WHERE NOT ${live}`).all(now);
  rows.forEach(show);
  if (rest[0] === '--purge') { rows.forEach((r) => { drop(r); db.prepare('DELETE FROM mem WHERE id = ?').run(r.id); }); console.log(`Purged ${rows.length}.`); }
  else if (!rows.length) console.log('Nothing expired.');
} else if (cmd === 'remove' && arg) {
  const r = db.prepare('SELECT * FROM mem WHERE id = ?').get(Number(arg));
  if (!r) { console.log('No such memory.'); process.exit(1); }
  drop(r);
  db.prepare('DELETE FROM mem WHERE id = ?').run(r.id);
  console.log(`Removed #${r.id}.`);
} else if (cmd === 'link' && quoted.length === 3) {
  db.prepare('INSERT INTO edge (a, rel, b) VALUES (?, ?, ?)').run(...quoted);
  console.log(`Linked: ${quoted[0]} -[${quoted[1]}]-> ${quoted[2]}`);
} else if (cmd === 'unlink' && quoted.length === 3) {
  const { changes } = db.prepare('DELETE FROM edge WHERE a = ? AND rel = ? AND b = ?').run(...quoted);
  console.log(changes ? `Unlinked: ${quoted[0]} -[${quoted[1]}]-> ${quoted[2]}` : 'No such link.');
} else if (cmd === 'graph' && arg) {
  const rows = db.prepare('SELECT * FROM edge WHERE a = ? OR b = ?').all(arg, arg);
  rows.forEach((e) => console.log(`${e.a} -[${e.rel}]-> ${e.b}`));
  const notes = db.prepare('SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.rowid WHERE mem_fts MATCH ? LIMIT 5').all('"' + arg.replace(/"/g, '') + '"');
  notes.forEach(show);
  if (!rows.length && !notes.length) console.log('Nothing found.');
} else if (cmd === 'view') {
  // Standalone page (no server needed): a draggable force-directed picture of every edge. Opens in the browser.
  const edges = db.prepare('SELECT a, rel, b FROM edge').all();
  const file = path.join(DATA_DIR, 'graph.html');
  fs.writeFileSync(file, GRAPH_HTML.replace('__EDGES__', JSON.stringify(edges).replace(/</g, '\\u003c')));
  console.log(`Graph written to ${file} (${edges.length} links).`);
  if (rest[0] !== '--no-open') spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
} else {
  console.log('Usage: add "text" [--tag x] [--source where] [--expires 30d|date] | update <id> ["new text"] [--tag/--source/--expires]\n'
    + '  | search "words" | list [n] | expired [--purge] | remove <id> | link "a" "relation" "b" | unlink "a" "relation" "b" | graph "name" | view');
}
