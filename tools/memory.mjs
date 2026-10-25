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
const force = rest.includes('--force') && !!rest.splice(rest.indexOf('--force'), 1);
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
// Semantic deduplication (lightweight): word-overlap similarity, so near-identical notes don't pile up or crowd search.
const STOP = new Set('a an the is are was were to of in on at for and or but with by it its this that be has have had i you user they them their my me as from'.split(' '));
const words = (s) => new Set((s.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !STOP.has(w)));
function similarity(a, b) {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}
const ftsAny = (s) => [...words(s)].map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
function drop(r) { db.prepare("INSERT INTO mem_fts (mem_fts, rowid, text, tag) VALUES ('delete', ?, ?, ?)").run(r.id, r.text, r.tag); db.prepare('DELETE FROM mem_vec WHERE id = ?').run(r.id); }

// Meaning-based memory: embeddings from the local Ollama model (free, private). If Ollama or the model isn't
// available, everything falls back to the word-overlap checks above.
const EMBED_MODEL = 'nomic-embed-text';
db.exec('CREATE TABLE IF NOT EXISTS mem_vec (id INTEGER PRIMARY KEY, vec TEXT)');
async function embed(text, kind = 'search_document') { // nomic models expect a task prefix
  try {
    const r = await fetch('http://127.0.0.1:11434/api/embed', { method: 'POST', body: JSON.stringify({ model: EMBED_MODEL, input: `${kind}: ${text}` }), signal: AbortSignal.timeout(5000) });
    return r.ok ? (await r.json()).embeddings?.[0] || null : null;
  } catch {
    return null;
  }
}
function cosine(a, b) {
  let dot = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}
const saveVec = (id, v) => v && db.prepare('INSERT OR REPLACE INTO mem_vec (id, vec) VALUES (?, ?)').run(id, JSON.stringify(v));
// Live notes ranked by meaning, best first: [{ ...row, score, vec }].
const byMeaning = (v) => db.prepare(`SELECT m.*, v.vec FROM mem m JOIN mem_vec v ON v.id = m.id WHERE ${live}`).all(now)
  .map((r) => ({ ...r, vec: JSON.parse(r.vec) })).map((r) => ({ ...r, score: cosine(v, r.vec) })).sort((a, b) => b.score - a.score);
const vecOf = (id) => { const r = db.prepare('SELECT vec FROM mem_vec WHERE id = ?').get(id); return r ? JSON.parse(r.vec) : null; };
// Same fact? Meaning when both notes have embeddings, word overlap otherwise.
const alike = (a, b, vecLimit, wordLimit) => (a.vec && b.vec ? cosine(a.vec, b.vec) >= vecLimit : similarity(a.text, b.text) >= wordLimit);

// The ontology (memory notes tagged "ontology") as rules: "Person dislikes Person; Person plays Game; ...".
function ontologyRules() {
  const note = db.prepare("SELECT text FROM mem WHERE tag = 'ontology' AND text LIKE 'ONTOLOGY rules:%'").get();
  if (!note) return [];
  return note.text.replace(/^ONTOLOGY rules:/, '').split(';').map((s) => /^\s*([A-Z]\w*) (.+?) ([A-Z]\w*)\s*\.?\s*$/.exec(s.split('.')[0]))
    .filter(Boolean).map(([, from, rel, to]) => ({ from, rel: rel.toLowerCase(), to }));
}
const classOf = (name) => db.prepare("SELECT b FROM edge WHERE a = ? AND rel IN ('is a', 'is an')").get(name)?.b || '';

if (cmd === 'add' && arg) {
  const q = ftsAny(arg);
  const v = await embed(arg);
  const near = (v && byMeaning(v).find((r) => r.score >= 0.92))
    || (q && db.prepare(`SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.rowid WHERE mem_fts MATCH ? AND ${live} ORDER BY bm25(mem_fts) LIMIT 5`).all(q, now)
      .find((r) => similarity(r.text, arg) >= 0.85));
  if (near && !force) { console.log(`Already remembered as #${near.id}: ${near.text}\n(use "update ${near.id} ..." to change it, or add --force to keep both)`); process.exit(0); }
  const { lastInsertRowid: id } = db.prepare('INSERT INTO mem (ts, tag, text, source, expires) VALUES (?, ?, ?, ?, ?)').run(now, tag, arg, source, expires);
  db.prepare('INSERT INTO mem_fts (rowid, text, tag) VALUES (?, ?, ?)').run(id, arg, tag);
  saveVec(id, v);
  console.log(`Remembered #${id}.`);
} else if (cmd === 'reindex') {
  // Give every note an embedding (after installing the embedding model, or to refresh them all).
  let done = 0;
  for (const r of db.prepare('SELECT id, text FROM mem').all()) { const v = await embed(r.text); if (!v) break; saveVec(r.id, v); done++; }
  console.log(done ? `Embedded ${done} notes.` : `Couldn't reach the embedding model (ollama pull ${EMBED_MODEL}); search uses words only.`);
} else if (cmd === 'update' && /^\d+$/.test(quoted[0] || '')) {
  // Correct a memory in place: new text and/or --tag/--source/--expires.
  const r = db.prepare('SELECT * FROM mem WHERE id = ?').get(Number(quoted[0]));
  if (!r) { console.log('No such memory.'); process.exit(1); }
  const text = quoted.slice(1).join(' ').trim() || r.text, t = tag || r.tag;
  drop(r);
  db.prepare('UPDATE mem SET ts = ?, tag = ?, text = ?, source = ?, expires = ? WHERE id = ?').run(now, t, text, source || r.source || '', expires || r.expires || '', r.id);
  db.prepare('INSERT INTO mem_fts (rowid, text, tag) VALUES (?, ?, ?)').run(r.id, text, t);
  saveVec(r.id, await embed(text));
  console.log(`Updated #${r.id}.`);
} else if (cmd === 'search' && arg) {
  const q = arg.split(/\s+/).map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  const byWords = db.prepare(`SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.rowid WHERE mem_fts MATCH ? AND ${live} ORDER BY bm25(mem_fts) LIMIT 25`).all(q, now);
  // Hybrid: notes that match by meaning (even with different words) and by words; notes matching both rank first.
  const v = await embed(arg, 'search_query');
  const meaning = v ? byMeaning(v).filter((r) => r.score >= 0.55).slice(0, 25) : [];
  const wordIds = new Set(byWords.map((r) => r.id)), meaningIds = new Set(meaning.map((r) => r.id));
  const found = [
    ...meaning.filter((r) => wordIds.has(r.id)),
    ...meaning.filter((r) => !wordIds.has(r.id)),
    ...byWords.filter((r) => !meaningIds.has(r.id)).map((r) => ({ ...r, vec: vecOf(r.id) })),
  ];
  // Fold near-duplicates into the best-ranked match; the folded ids stay visible so no evidence is lost.
  const rows = [];
  for (const r of found) {
    const twin = rows.find((k) => alike(k, r, 0.9, 0.7));
    if (twin) (twin.similar ||= []).push(r.id); else if (rows.length < 10) rows.push(r);
  }
  rows.length ? rows.forEach((r) => { show(r); if (r.similar) console.log(`   (+ similar: ${r.similar.map((i) => '#' + i).join(', ')})`); }) : console.log('Nothing found.');
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
  // Ontology check: a known relation must connect the classes its rule names ("Person plays Game").
  const [a, rel, b] = quoted;
  const rules = ontologyRules().filter((r) => r.rel === rel.toLowerCase());
  const ca = classOf(a), cb = classOf(b);
  if (rules.length && ca && cb && !rules.some((r) => r.from === ca && r.to === cb) && !force) {
    console.log(`That breaks the ontology: "${rel}" links ${rules.map((r) => `${r.from} -> ${r.to}`).join(' or ')}, but ${a} is a ${ca} and ${b} is a ${cb}.\n(fix the link, or add --force to store it anyway)`);
    process.exit(0);
  }
  db.prepare('INSERT INTO edge (a, rel, b) VALUES (?, ?, ?)').run(a, rel, b);
  console.log(`Linked: ${a} -[${rel}]-> ${b}`);
  const unknown = [!ca && !/^is an?$/i.test(rel) && a, !cb && !/^is an?$/i.test(rel) && b].filter(Boolean);
  if (rules.length && unknown.length) console.log(`Note: ${unknown.join(' and ')} ${unknown.length > 1 ? 'have' : 'has'} no class yet; add one with link "<name>" "is a" "<Class>".`);
  else if (!rules.length && ontologyRules().length && !/^is an?$/i.test(rel)) console.log(`Note: "${rel}" isn't in the ontology rules yet.`);
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
    + '  | search "words" | reindex | list [n] | expired [--purge] | remove <id> | link "a" "relation" "b" | unlink "a" "relation" "b" | graph "name" | view');
}
