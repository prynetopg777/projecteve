#!/usr/bin/env node
// Reminder CLI used by Eve (and you):
//   node tools/remind.mjs add --in 10m "Take the pizza out"
//   node tools/remind.mjs add --at "2026-10-22 15:30" "Call mom" [--repeat daily|weekly]
//   node tools/remind.mjs list
//   node tools/remind.mjs remove 3
import * as reminders from '../src/reminders.mjs';

const [cmd, ...rest] = process.argv.slice(2);

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const [, value] = rest.splice(i, 2);
  return value;
}

const fmt = (r) =>
  `#${r.id}  ${new Date(r.due).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}` +
  `${r.repeat ? ` (${r.repeat})` : ''}  ${r.text}`;

try {
  if (cmd === 'add') {
    const inStr = flag('in');
    const atStr = flag('at');
    const repeat = flag('repeat') || null;
    const text = rest.join(' ').trim();
    if (!text || (!inStr && !atStr)) throw new Error('usage: add (--in 10m | --at "YYYY-MM-DD HH:MM") [--repeat daily|weekly] "text"');
    const due = inStr ? new Date(Date.now() + reminders.parseDuration(inStr)) : reminders.parseAt(atStr);
    console.log('Added', fmt(reminders.add(text, due, repeat)));
  } else if (cmd === 'list') {
    const list = reminders.load().sort((a, b) => a.due.localeCompare(b.due));
    console.log(list.length ? list.map(fmt).join('\n') : 'No reminders.');
  } else if (cmd === 'remove') {
    const id = Number(rest[0]);
    console.log(reminders.remove(id) ? `Removed #${id}` : `No reminder #${id}`);
  } else {
    throw new Error('commands: add, list, remove');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
