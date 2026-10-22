// Which tool calls Eve may make on her own, and how to describe the rest when asking the user.
// Tools listed in config.autoAllow never reach this file (the CLI approves them itself).
//
// Three levels:
//   1. Always fine: read-only commands, opening apps/sites, her helper scripts, her own notes.
//   2. Task approval: once the user approves a plan (`tools/eve.mjs task "..."`), everything else
//      is allowed until the task ends, except the ALWAYS_ASK list below.
//   3. Otherwise each action asks individually.
import path from 'node:path';
import { ROOT, WORKSPACE } from './config.mjs';

const SHELLS = new Set(['Bash', 'PowerShell']);
const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const EVE_TOOL = path.join(ROOT, 'tools/eve.mjs');

// Her own helper scripts, and which subcommands are safe to run unasked.
// `task` is deliberately absent: running it IS the request for task approval.
const OWN_TOOLS = {
  [path.join(ROOT, 'tools/remind.mjs')]: null, // every subcommand
  [path.join(ROOT, 'tools/watch.mjs')]: null,
  [EVE_TOOL]: new Set(['model', 'status', 'checkpoint', 'restart', 'done']),
};

// Commands that only look at things. A command line is read-only if every piece of it
// (split on ; && || |) starts with one of these and nothing writes to a file.
const READ_ONLY =
  /^(Get-[A-Za-z]+|Select-Object|Where-Object|Sort-Object|Format-(Table|List)|Measure-Object|Select-String|Test-Path|Resolve-Path|Split-Path|Join-Path|Out-String|ls|dir|pwd|cd|whoami|hostname|date|echo|cat|type|head|tail|wc|grep|findstr|find|where|which|tasklist|systeminfo|ipconfig|ping|nslookup|Test-Connection|Resolve-DnsName|Write-(Output|Host)|ConvertTo-(Json|Csv)|node\s+(-v|--version|--check)|npm\s+(-v|--version|ls|list)|git\s+(status|log|diff|show|branch|ls-files))\b/i;
const WRITES = /(^|[^-])>|\$\(|`|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\bTee-Object\b\b|\bfind\b.*-(delete|exec)/i;

// Opening an app, file or website: `Start-Process spotify`, `start https://...`, `Invoke-Item x.pdf`.
const OPEN = /^(Start-Process(\s+-FilePath)?|start|Invoke-Item|ii|explorer(\.exe)?)\s+("[^"]+"|'[^']+'|[^\s;&|<>`$]+)(\s+-(ArgumentList|FilePath)\s+("[^"]+"|'[^']+'|[^\s;&|<>`$]+))?\s*$/i;

// Never covered by a task approval or a session grant: always shown to the user.
const ALWAYS_ASK =
  /\b(shutdown|Stop-Computer|Restart-Computer|format(-Volume)?|diskpart|Clear-Disk|Initialize-Disk|bcdedit|reg\s+delete|Remove-ItemProperty|Set-ExecutionPolicy|cipher\s+\/w|vssadmin|Disable-|Uninstall-)|\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|[A-Za-z]:\\?)\s*$|Remove-Item\b.*-Recurse.*\s([A-Za-z]:\\?|~|\$env:USERPROFILE|\$HOME)\s*$/i;
const PROTECTED_FILES = ['src/permissions.mjs', 'config.json', 'data/settings.json', 'data/task.json'].map((f) => path.join(ROOT, f));
// Shell commands touching the permission state files are always shown too.
const PROTECTED_SHELL = /\b(settings|task)\.json\b|permissions\.mjs|\/api\/(auto|permission)\b/i;

const stripQuotes = (cmd) => cmd.replace(/"[^"]*"|'[^']*'/g, '""');
const isSimple = (cmd) => !/[;&|<>`$\n]/.test(stripQuotes(cmd));

function isReadOnly(cmd) {
  const bare = stripQuotes(cmd);
  if (WRITES.test(bare)) return false;
  return bare.split(/&&|\|\||[;|\n]/).every((part) => !part.trim() || READ_ONLY.test(part.trim()));
}

// Several simple opens / read-only commands chained with ; or && ("open Spotify and Edge").
// Each piece must be simple on its own, with balanced quotes, so a separator inside quotes can't split it.
function isHarmlessChain(cmd) {
  const parts = cmd.split(/\s*(?:;|&&)\s*/).filter(Boolean);
  return parts.length > 1 && parts.every((p) =>
    p.split('"').length % 2 === 1 && p.split("'").length % 2 === 1 && isSimple(p) && (OPEN.test(p) || isOwnTool(p) || isReadOnly(p)));
}

function parseOwnTool(cmd) {
  const m = cmd.match(/^\s*node\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+(\w+)/);
  if (!m) return null;
  return { script: path.resolve(WORKSPACE, m[1] || m[2] || m[3]), sub: m[4] };
}

function isOwnTool(cmd) {
  const t = parseOwnTool(cmd);
  if (!t || !(t.script in OWN_TOOLS)) return false;
  const allowed = OWN_TOOLS[t.script];
  return !allowed || allowed.has(t.sub);
}

/** `node tools/eve.mjs task "plan"`: returns the plan text, or null. */
export function taskRequest(tool, input = {}) {
  if (!SHELLS.has(tool) || !isSimple(String(input.command || ''))) return null;
  const cmd = String(input.command);
  const t = parseOwnTool(cmd);
  if (!t || t.script !== EVE_TOOL || t.sub !== 'task') return null;
  const plan = cmd.slice(cmd.search(/\btask\b/) + 4).trim().replace(/^["']|["']$/g, '');
  return plan || '(no plan given)';
}

/** `node tools/eve.mjs auto on|off|status`: returns 'on' | 'off' | 'status', or null. */
export function autoModeRequest(tool, input = {}) {
  const cmd = String(input.command || '');
  if (!SHELLS.has(tool) || !isSimple(cmd)) return null;
  const t = parseOwnTool(cmd);
  if (!t || t.script !== EVE_TOOL || t.sub !== 'auto') return null;
  const m = cmd.match(/\bauto\s+(on|off|status)\s*$/i);
  return m ? m[1].toLowerCase() : 'status';
}

/** `node tools/eve.mjs done`: Eve reports the approved task finished. */
export function isTaskDone(tool, input = {}) {
  const t = SHELLS.has(tool) && isSimple(String(input.command || '')) && parseOwnTool(String(input.command));
  return !!t && t.script === EVE_TOOL && t.sub === 'done';
}

const inside = (file, dir) => {
  const rel = path.relative(dir, path.resolve(WORKSPACE, file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** Actions that must be confirmed individually even during an approved task. */
export function alwaysAsk(tool, input = {}) {
  if (SHELLS.has(tool)) {
    const cmd = String(input.command || '');
    if (autoModeRequest(tool, input) === 'on') return true; // Eve can't put herself into auto mode
    if (autoModeRequest(tool, input)) return false; // `auto off` / `auto status` are always fine
    return ALWAYS_ASK.test(cmd) || (PROTECTED_SHELL.test(cmd) && !isReadOnly(cmd));
  }
  if (FILE_TOOLS.has(tool)) return PROTECTED_FILES.includes(path.resolve(WORKSPACE, input.file_path || ''));
  return false;
}

/** Key used for "allow for this session" grants. */
export function grantKey(tool, input = {}) {
  if (SHELLS.has(tool)) return `${tool}:${String(input.command || '').trim().split(/\s+/)[0]}`;
  if (FILE_TOOLS.has(tool) && input.file_path) return `${tool}:${path.dirname(path.resolve(WORKSPACE, input.file_path))}`;
  return tool;
}

/**
 * @param {{ grants?: Set<string>, taskActive?: boolean }} ctx
 */
export function isAutoAllowed(tool, input = {}, { grants = new Set(), taskActive = false } = {}) {
  if (taskRequest(tool, input)) return false; // the task request itself is always shown
  if (alwaysAsk(tool, input)) return false;
  if (autoModeRequest(tool, input)) return true; // `auto off` / `status` (`auto on` was caught above)
  if (taskActive) return true;
  if (grants.has(grantKey(tool, input))) return true;
  if (SHELLS.has(tool)) {
    const cmd = String(input.command || '').trim();
    return (isSimple(cmd) && (isOwnTool(cmd) || OPEN.test(cmd))) || isReadOnly(cmd) || isHarmlessChain(cmd);
  }
  // Her notes, memory and to-dos live in workspace/. Her own source code does NOT, so editing it needs approval.
  if (FILE_TOOLS.has(tool)) return inside(input.file_path || input.notebook_path || '', WORKSPACE);
  return false;
}

const lcFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const shortPath = (p) => {
  const abs = path.resolve(WORKSPACE, p || '');
  return inside(abs, ROOT) ? path.relative(ROOT, abs).replaceAll('\\', '/') : abs;
};

/** { kind, title: reads as "May I <title>?", detail: what exactly will happen } */
export function describe(tool, input = {}, description = '') {
  const plan = taskRequest(tool, input);
  if (plan) return { kind: 'task', title: 'go ahead with this plan', detail: plan };
  if (autoModeRequest(tool, input) === 'on') {
    return { kind: 'action', title: 'turn on auto mode, so I can act without asking you each time', detail: 'Auto mode: Eve acts without permission prompts until you turn it off.\nShutdown, disk wipes, registry deletes, uninstalls and edits to her permission code still ask.' };
  }
  if (SHELLS.has(tool)) {
    const desc = input.description || description;
    return { kind: 'action', title: desc ? lcFirst(desc.replace(/\.$/, '')) : `run a ${tool} command`, detail: input.command };
  }
  if (tool === 'Edit') {
    const own = inside(input.file_path, ROOT) && !inside(input.file_path, WORKSPACE);
    return {
      kind: 'action',
      title: `edit ${own ? 'my own code in ' : ''}${shortPath(input.file_path)}`,
      detail: `- ${String(input.old_string).slice(0, 600)}\n+ ${String(input.new_string).slice(0, 600)}`,
    };
  }
  if (tool === 'Write') {
    return { kind: 'action', title: `write the file ${shortPath(input.file_path)}`, detail: String(input.content || '').slice(0, 800) };
  }
  return { kind: 'action', title: `use the ${tool} tool`, detail: JSON.stringify(input, null, 2).slice(0, 800) };
}
