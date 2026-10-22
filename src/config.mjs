import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
export const WORKSPACE = path.join(ROOT, 'workspace');

fs.mkdirSync(DATA_DIR, { recursive: true });

const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  cfg.extraDirs = (cfg.extraDirs || []).map(expandHome);
  cfg.claudePath = cfg.claudePath || findClaude();
  return cfg;
}

// Prefer the native claude.exe so we can spawn it without a shell (no quoting issues).
function findClaude() {
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'),
    path.join(os.homedir(), '.local/bin/claude.exe'),
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'claude';
}
