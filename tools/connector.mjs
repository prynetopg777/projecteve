// Manage connectors (MCP servers) that Eve can use. Stored in data/connectors.json; takes effect after a restart.
//   node tools/connector.mjs add <name> --url <https://...>          (remote HTTP server)
//   node tools/connector.mjs add <name> --cmd <command> [args...]    (local stdio server, e.g. npx -y @modelcontextprotocol/server-filesystem C:/path)
//   node tools/connector.mjs list | remove <name>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'connectors.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { mcpServers: {} }; } };
const save = (c) => fs.writeFileSync(FILE, JSON.stringify(c, null, 2));

const [cmd, name, ...rest] = process.argv.slice(2);
const c = load();
c.mcpServers ||= {};

if (cmd === 'add' && name) {
  if (rest[0] === '--url' && rest[1]) c.mcpServers[name] = { type: 'http', url: rest[1] };
  else if (rest[0] === '--cmd' && rest[1]) c.mcpServers[name] = { command: rest[1], args: rest.slice(2) };
  else { console.error('Usage: add <name> --url <url> | --cmd <command> [args...]'); process.exit(1); }
  save(c);
  console.log(`Added connector "${name}". Restart Eve to load it.`);
} else if (cmd === 'remove' && name) {
  delete c.mcpServers[name];
  save(c);
  console.log(`Removed "${name}". Restart Eve to apply.`);
} else if (cmd === 'list') {
  const names = Object.keys(c.mcpServers);
  console.log(names.length ? names.map((n) => `${n}: ${JSON.stringify(c.mcpServers[n])}`).join('\n') : 'No connectors.');
} else {
  console.error('Usage: add <name> --url <url> | --cmd <command> [args...] | list | remove <name>');
  process.exit(1);
}
