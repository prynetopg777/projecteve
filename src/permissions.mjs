// Which tool calls Eve may make on her own, and how to describe the rest when asking the user.
// Tools listed in config.autoAllow never reach this file (the CLI approves them itself).
import path from 'node:path';
import { ROOT, WORKSPACE } from './config.mjs';

const SHELLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// Her own helper scripts, and which subcommands are safe to run unasked.
const OWN_TOOLS = {
  [path.join(ROOT, 'tools/remind.mjs')]: null, // every subcommand
  [path.join(ROOT, 'tools/eve.mjs')]: new Set(['model', 'status', 'checkpoint', 'restart']),
};

const READ_ONLY =
  /^\s*(Get-(ChildItem|Content|Date|Process|Location|Item|ComputerInfo|Volume|PSDrive|NetAdapter|Service)|ls|dir|pwd|whoami|hostname|date|tasklist|systeminfo|ipconfig|git\s+(status|log|diff|show))\b/i;

/** A command is "simple" if, outside quoted strings, it has no chaining, pipes, redirects or substitutions. */
const isSimple = (cmd) => !/[;&|<>`$\n]/.test(cmd.replace(/"[^"]*"|'[^']*'/g, ''));

function isOwnTool(cmd) {
  const m = cmd.match(/^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(\w+)/);
  if (!m) return false;
  const script = path.resolve(WORKSPACE, m[1] || m[2] || m[3]);
  if (!(script in OWN_TOOLS)) return false;
  const allowed = OWN_TOOLS[script];
  return !allowed || allowed.has(m[4]);
}

const inside = (file, dir) => {
  const rel = path.relative(dir, path.resolve(WORKSPACE, file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Key used for "allow for this session" grants. */
export function grantKey(tool, input = {}) {
  if (SHELLS.has(tool)) return `${tool}:${String(input.command || '').trim().split(/\s+/)[0]}`;
  if (FILE_TOOLS.has(tool) && input.file_path) return `${tool}:${path.dirname(path.resolve(WORKSPACE, input.file_path))}`;
  return tool;
}

export function isAutoAllowed(tool, input = {}, grants = new Set()) {
  if (grants.has(grantKey(tool, input))) return true;
  if (SHELLS.has(tool)) {
    const cmd = String(input.command || '');
    return isSimple(cmd) && (isOwnTool(cmd) || READ_ONLY.test(cmd));
  }
  // Her notes, memory and to-dos live in workspace/. Her own source code does NOT, so editing it always asks.
  if (FILE_TOOLS.has(tool)) return inside(input.file_path || input.notebook_path || '', WORKSPACE);
  return false;
}

const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const shortPath = (p) => {
  const abs = path.resolve(WORKSPACE, p || '');
  return inside(abs, ROOT) ? path.relative(ROOT, abs).replaceAll('\\', '/') : abs;
};

/** { title: "create directory foo" (reads as "May I <title>?"), detail: what exactly will happen } */
export function describe(tool, input = {}, description = '') {
  if (SHELLS.has(tool)) {
    const desc = input.description || description;
    return { title: desc ? lcFirst(desc.replace(/\.$/, '')) : `run a ${tool} command`, detail: input.command };
  }
  if (tool === 'Edit') {
    const own = inside(input.file_path, ROOT) && !inside(input.file_path, WORKSPACE);
    return {
      title: `edit ${own ? 'my own code in ' : ''}${shortPath(input.file_path)}`,
      detail: `- ${String(input.old_string).slice(0, 600)}\n+ ${String(input.new_string).slice(0, 600)}`,
    };
  }
  if (tool === 'Write') {
    return { title: `write the file ${shortPath(input.file_path)}`, detail: String(input.content || '').slice(0, 800) };
  }
  return { title: `use the ${tool} tool`, detail: JSON.stringify(input, null, 2).slice(0, 800) };
}
