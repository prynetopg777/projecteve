#!/usr/bin/env node
// Searchable long-term memory (SQLite full-text search) in data/memory.db. Usage:
//   node tools/memory.mjs add "fact or event" [--tag people]
//   node tools/memory.mjs search "words"      (best matches first)
//   node tools/memory.mjs list [n]            (newest first)
//   node tools/memory.mjs remove <id>
//   node tools/memory.mjs link "Mom" "sister of" "Aunt Ana"   (knowledge graph edge)
//   node tools/memory.mjs graph "Mom"        (everything connected to a name)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../src/config.mjs';

process.removeAllListeners('warning');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'memory.db'));
db.exec(`CREATE TABLE IF NOT EXISTS mem (id INTEGER PRIMARY KEY, ts TEXT, tag TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS edge (id INTEGER PRIMARY KEY, a TEXT COLLATE NOCASE, rel TEXT, b TEXT COLLATE NOCASE);
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(text, tag, content='mem', content_rowid='id');`);

const [cmd = '', ...rest] = process.argv.slice(2);
const ti = rest.indexOf('--tag');
const tag = ti >= 0 ? rest.splice(ti, 2)[1] || '' : '';
const arg = rest.join(' ').trim();
const quoted = rest.map((x) => x.trim());
const show = (r) => console.log(`#${r.id} [${r.ts.slice(0, 10)}${r.tag ? ' ' + r.tag : ''}] ${r.text}`);

if (cmd === 'add' && arg) {
  const { lastInsertRowid: id } = db.prepare('INSERT INTO mem (ts, tag, text) VALUES (?, ?, ?)').run(new Date().toISOString(), tag, arg);
  db.prepare('INSERT INTO mem_fts (rowid, text, tag) VALUES (?, ?, ?)').run(id, arg, tag);
  console.log(`Remembered #${id}.`);
} else if (cmd === 'search' && arg) {
  const q = arg.split(/\s+/).map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
  const rows = db.prepare('SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.rowid WHERE mem_fts MATCH ? ORDER BY bm25(mem_fts) LIMIT 10').all(q);
  rows.length ? rows.forEach(show) : console.log('Nothing found.');
} else if (cmd === 'list') {
  db.prepare('SELECT * FROM mem ORDER BY id DESC LIMIT ?').all(Number(arg) || 10).forEach(show);
} else if (cmd === 'remove' && arg) {
  const r = db.prepare('SELECT * FROM mem WHERE id = ?').get(Number(arg));
  if (!r) { console.log('No such memory.'); process.exit(1); }
  db.prepare("INSERT INTO mem_fts (mem_fts, rowid, text, tag) VALUES ('delete', ?, ?, ?)").run(r.id, r.text, r.tag);
  db.prepare('DELETE FROM mem WHERE id = ?').run(r.id);
  console.log(`Removed #${r.id}.`);
} else if (cmd === 'link' && quoted.length === 3) {
  db.prepare('INSERT INTO edge (a, rel, b) VALUES (?, ?, ?)').run(...quoted);
  console.log(`Linked: ${quoted[0]} -[${quoted[1]}]-> ${quoted[2]}`);
} else if (cmd === 'graph' && arg) {
  const rows = db.prepare('SELECT * FROM edge WHERE a = ? OR b = ?').all(arg, arg);
  rows.forEach((e) => console.log(`${e.a} -[${e.rel}]-> ${e.b}`));
  const notes = db.prepare('SELECT m.* FROM mem_fts f JOIN mem m ON m.id = f.rowid WHERE mem_fts MATCH ? LIMIT 5').all('"' + arg.replace(/"/g, '') + '"');
  notes.forEach(show);
  if (!rows.length && !notes.length) console.log('Nothing found.');
} else {
  console.log('Usage: add "text" [--tag x] | search "words" | list [n] | remove <id> | link "a" "relation" "b" | graph "name"');
}
