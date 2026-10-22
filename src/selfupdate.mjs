// Safety net for Eve editing her own code: git checkpoints, syntax checks, and crash rollback.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, ROOT } from './config.mjs';

export const PENDING_FILE = path.join(DATA_DIR, 'pending-update.json'); // restarted after an edit, not yet proven healthy
export const FAILED_FILE = path.join(DATA_DIR, 'update-failed.json'); // last update crashed and was rolled back
// A crash this soon after a self-update rolls it back (launcher); the server commits only after this has passed.
export const HEALTHY_AFTER_MS = 30000;
export const COMMIT_AFTER_MS = HEALTHY_AFTER_MS + 5000;
// Only Eve's own code and settings are staged/stashed, never unrelated files lying around.
const CODE_PATHS = ['src', 'tools', 'public', 'prompts', 'overlay', 'workspace', 'config.json', 'package.json', 'README.md', 'start-eve.bat'];
const codePaths = () => CODE_PATHS.filter((p) => fs.existsSync(path.join(ROOT, p)));

const git = (...args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function ensureRepo() {
  if (!fs.existsSync(path.join(ROOT, '.git'))) git('init', '-q');
  try {
    git('config', 'user.name');
  } catch {
    git('config', 'user.name', 'Eve');
    git('config', 'user.email', 'eve@localhost');
  }
}

export const isDirty = () => git('status', '--porcelain', '--', ...codePaths()) !== '';

/** Commit changes to Eve's code (CODE_PATHS; data/ and memory are gitignored). Returns the short hash, or null if nothing changed. */
export function commit(message) {
  ensureRepo();
  if (!isDirty()) return null;
  git('add', '-A', '--', ...codePaths());
  if (!git('diff', '--cached', '--name-only')) return null;
  git('commit', '-q', '-m', message);
  return git('rev-parse', '--short', 'HEAD');
}

/** Put uncommitted changes aside (recoverable with `git stash pop`). */
export function stash(message) {
  ensureRepo();
  if (!isDirty()) return false;
  git('stash', 'push', '-u', '-m', message, '--', ...codePaths());
  return true;
}

export const log = (n = 8) => {
  try {
    return git('log', '--oneline', `-${n}`);
  } catch {
    return '(no commits yet)';
  }
};
export const lastCommitMessage = () => git('log', '-1', '--format=%s');
export const revertHead = () => git('revert', '--no-edit', 'HEAD');

/** Syntax-check all of Eve's JavaScript, including the page's inline script. Returns a list of errors. */
export function syntaxCheck() {
  const errors = [];
  const check = (file, label = path.relative(ROOT, file)) => {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    } catch (e) {
      errors.push(`${label}:\n${String(e.stderr).trim().split('\n').slice(0, 6).join('\n')}`);
    }
  };
  for (const dir of ['src', 'tools']) {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) if (f.endsWith('.mjs')) check(path.join(ROOT, dir, f));
  }
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!scripts.length) errors.push('public/index.html: no <script> block found');
  scripts.forEach((script, i) => {
    const tmp = path.join(DATA_DIR, `page-check-${i}.js`);
    fs.writeFileSync(tmp, script.replace('/*CONFIG*/', () => '{}'));
    check(tmp, `public/index.html <script> #${i + 1}`);
    fs.rmSync(tmp, { force: true });
  });
  // A half-finished UI rewrite can be valid JS yet missing the app logic entirely.
  for (const needed of ['/*CONFIG*/', "new EventSource('/events')", 'function showPermission']) {
    if (!html.includes(needed)) errors.push(`public/index.html: missing \`${needed}\`; the UI would not work`);
  }
  return errors;
}
