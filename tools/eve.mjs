#!/usr/bin/env node
// Eve's self-management CLI (she runs it through Bash; you can too):
//   node tools/eve.mjs model [haiku|sonnet|opus]   show / switch her conversation model (applies from the next reply)
//   node tools/eve.mjs status                      model, recent self-updates, uncommitted changes
//   node tools/eve.mjs checkpoint "message"        commit the current state before editing her own code
//   node tools/eve.mjs restart "what changed"      syntax-check her code, then restart to load it
//   node tools/eve.mjs task "plan"                 ask the user once to approve a whole multi-step plan
//   node tools/eve.mjs done                        end the approved task (normal prompts resume)
//   node tools/eve.mjs auto on|off|status           auto mode: act without permission prompts ("on" asks the user)
//   node tools/eve.mjs undo                        roll back the last self-update (asks the user first)
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from '../src/config.mjs';
import * as su from '../src/selfupdate.mjs';

const MODELS = ['haiku', 'sonnet', 'opus'];
const HINT_FILE = path.join(DATA_DIR, 'model-hint.json'); // Eve's own pick while the dropdown is on Auto
const MODEL_FILE =path.join(DATA_DIR, 'model.json');
const cfg = loadConfig();
const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ').trim();

const currentModel = () => {
  try {
    return JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8')).model || cfg.model;
  } catch {
    return cfg.model;
  }
};

async function post(route, body = {}) {
  const res = await fetch(`http://127.0.0.1:${cfg.port}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {
    throw new Error(`Eve's server isn't reachable on port ${cfg.port}. Start it with start-eve.bat.`);
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

try {
  if (cmd === 'model') {
    if (!arg) {
      console.log(`Current model: ${currentModel()} (options: ${MODELS.join(', ')}; default: ${cfg.model})`);
    } else if (arg !== 'auto' && !MODELS.includes(arg)) {
      throw new Error(`Unknown model "${arg}". Options: auto, ${MODELS.join(', ')}`);
    } else if (arg !== 'auto' && currentModel() === 'auto') {
      // Auto stays on: this is Eve's own judgement for her next reply, overriding the keyword guess once.
      fs.writeFileSync(HINT_FILE, JSON.stringify({ model: arg }));
      console.log(`Noted: ${arg} for your next reply. Auto mode stays on.`);
    } else {
      const previous = currentModel();
      fs.writeFileSync(MODEL_FILE, JSON.stringify({ model: arg }, null, 2));
      console.log(`Model set to ${arg}. It takes effect from your next reply (this reply finishes on ${previous}).`);
    }
  } else if (cmd === 'task') {
    // Reaching this line means the user approved the plan in the permission prompt.
    if (!arg) throw new Error('usage: task "the full plan: what you will do, which files/apps you will touch"');
    console.log(`Plan approved by the user. Carry out the whole plan now without asking again (approval lasts ${cfg.taskMinutes || 45} minutes). Stay within it, and run \`node tools/eve.mjs done\` when finished.`);
  } else if (cmd === 'auto') {
    // `auto on` only runs after the user approved it in a permission prompt; `off` and `status` are always allowed.
    const mode = (rest[0] || 'status').toLowerCase();
    if (mode === 'on' || mode === 'off') {
      const { auto } = await post('/api/auto', { on: mode === 'on' });
      console.log(auto ? 'Auto mode is ON: act without asking (the always-ask list still prompts).' : 'Auto mode is OFF: normal permission prompts apply.');
    } else {
      const s = await fetch(`http://127.0.0.1:${cfg.port}/api/status`).then((r) => r.json()).catch(() => ({}));
      console.log(`Auto mode: ${s.auto ? 'on' : 'off'}`);
    }
  } else if (cmd === 'done') {
    console.log('Task closed. Normal permission prompts apply again.');
  } else if (cmd === 'status') {
    su.ensureRepo();
    console.log(`Model: ${currentModel()}\n\nRecent history:\n${su.log()}\n\nUncommitted changes: ${su.isDirty() ? 'yes' : 'none'}`);
  } else if (cmd === 'checkpoint') {
    const hash = su.commit(`eve: checkpoint - ${arg || 'before self-update'}`);
    console.log(hash ? `Checkpoint ${hash} saved.` : 'Nothing to checkpoint; the current state is already saved.');
    console.log(su.log(3));
  } else if (cmd === 'restart') {
    const errors = su.syntaxCheck();
    if (errors.length) throw new Error(`Not restarting: syntax errors found. Fix them first.\n\n${errors.join('\n\n')}`);
    if (su.isDirty()) fs.writeFileSync(su.PENDING_FILE, JSON.stringify({ reason: arg || 'self-update', at: new Date().toISOString() }));
    await post('/api/restart', { reason: arg });
    console.log('Syntax check passed. Restart scheduled: it happens right after this reply. If the new code crashes on startup it is rolled back automatically.');
  } else if (cmd === 'undo') {
    if (su.stash(`eve: undone changes ${new Date().toISOString()}`)) {
      console.log('Uncommitted changes were stashed (recover with `git stash pop`). Run restart to load the previous code.');
    } else if (su.lastCommitMessage().startsWith('eve: self-update')) {
      su.revertHead();
      console.log(`Reverted the last self-update.\n${su.log(3)}\nRun restart to load it.`);
    } else {
      throw new Error(`The last commit is not a self-update, so there's nothing to undo automatically.\n${su.log(5)}`);
    }
  } else {
    throw new Error('commands: model, status, task, done, auto, checkpoint, restart, undo');
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
