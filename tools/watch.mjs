// Eve's helper for background watchers. Usage:
//   node tools/watch.mjs add <type> [--target X] [--text Y] [--every 5m] [--repeat] [--say "alert text"]
//   node tools/watch.mjs list | types | remove <id>
import { TYPES, add, load, remove } from '../src/watchers.mjs';
import { parseDuration } from '../src/reminders.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i === -1 ? undefined : rest[i + 1];
};

try {
  if (cmd === 'add') {
    const w = add({
      type: rest[0],
      target: flag('target') || '',
      text: flag('text') || '',
      message: flag('say') || '',
      everyMs: flag('every') ? parseDuration(flag('every')) : 60000,
      repeat: rest.includes('--repeat'),
    });
    console.log(`Watcher #${w.id} added (${w.type}, every ${w.everyMs / 1000}s${w.repeat ? ', repeating' : ', once'}).`);
  } else if (cmd === 'list') {
    const list = load();
    console.log(list.length ? list.map((w) => `#${w.id} ${w.type} ${w.target} ${w.text}`.trim()).join('\n') : 'No watchers.');
  } else if (cmd === 'remove') {
    console.log(remove(Number(rest[0])) ? 'Removed.' : 'No such watcher.');
  } else if (cmd === 'types') {
    console.log(Object.entries(TYPES).map(([k, v]) => `${k}: ${v}`).join('\n'));
  } else {
    console.log('Usage: add <type> [--target X] [--text Y] [--every 5m] [--repeat] [--say "..."] | list | types | remove <id>');
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
