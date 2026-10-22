// Terminal chat with Eve (text only). Commands: /new, /stop, /exit
import readline from 'node:readline';
import { Brain } from './brain.mjs';
import { loadConfig } from './config.mjs';
import { startReminderLoop } from './reminders.mjs';
import { speak } from './speak.mjs';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const amber = (s) => `\x1b[33m${s}\x1b[0m`;

const cfg = loadConfig();
const brain = new Brain(cfg);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: cyan('you › ') });
const permissionQueue = []; // permission requests waiting for a y/a/n answer

brain.on('delta', (t) => process.stdout.write(t));
brain.on('error', () => {}); // already surfaced via the rejected ask() below
brain.on('model', (m) => process.stdout.write(dim(`  [model: ${m}]\n`)));
brain.on('tool', ({ name, input }) => {
  const detail = input?.command || input?.query || input?.url || input?.file_path || '';
  process.stdout.write(dim(`\n  ⚙ ${name} ${String(detail).slice(0, 100)}\n`));
});
brain.on('permission', (req) => {
  permissionQueue.push(req);
  if (permissionQueue.length === 1) showPermission();
});

function showPermission() {
  const req = permissionQueue[0];
  if (!req) return;
  process.stdout.write(amber(`\n🔐 May I ${req.title}?\n`) + dim(`${req.detail || ''}\n`) + amber('   [y]es / [a]lways this session / [n]o › '));
}

startReminderLoop((r) => {
  process.stdout.write(`\n${amber(`⏰ Reminder: ${r.text}`)}\n`);
  speak(`Reminder: ${r.text}`);
  rl.prompt(true);
});

console.log(cyan('EVE online.') + dim('  /new = fresh conversation, /stop = interrupt, /exit = quit'));
brain.start();
rl.prompt();

rl.on('line', async (line) => {
  const text = line.trim();
  if (permissionQueue.length) {
    const req = permissionQueue.shift();
    const decision = /^a/i.test(text) ? 'always' : /^y/i.test(text) ? 'allow' : 'deny';
    brain.respond(req.id, decision);
    return showPermission();
  }
  if (!text) return rl.prompt();
  if (text === '/exit') return rl.close();
  if (text === '/stop') return brain.stop();
  if (text === '/new') {
    brain.reset();
    console.log(dim('Started a new conversation.'));
    return rl.prompt();
  }
  process.stdout.write(cyan('eve › '));
  try {
    await brain.ask(text);
  } catch (err) {
    if (err.message !== 'stopped') console.error(`\n⚠️  ${err.message}`);
  }
  permissionQueue.length = 0;
  process.stdout.write('\n');
  rl.prompt();
});

rl.on('close', () => {
  brain.stop();
  process.exit(0);
});
