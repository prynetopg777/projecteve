#!/usr/bin/env node
// Run a prompt on a local model (Ollama): free, private, offline. Good for classification, simple extraction,
// summarising private text and rewording. Not for hard reasoning or code. Usage:
//   node tools/local.mjs "prompt"                 (or pipe text on stdin; both are combined: prompt first)
//   node tools/local.mjs --model llama3.1:8b --max 300 --json "prompt"
//   node tools/local.mjs models                   (installed local models)
// Each run is logged to data/usage.jsonl as model "local:<name>" with its generation speed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from '../src/config.mjs';

const HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : fallback; };
const model = flag('--model', 'llama3.2');
const max = Number(flag('--max', 400));
const json = args.includes('--json') && args.splice(args.indexOf('--json'), 1);

async function api(p, body) {
  const res = await fetch(HOST + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

// Start the Ollama server if it isn't running, then wait up to ~10 s for it.
async function ensureServer() {
  try { return await api('/api/tags'); } catch {}
  spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { return await api('/api/tags'); } catch {}
  }
  console.log('Ollama is not running and could not be started. Use a Claude model instead.');
  process.exit(1);
}

const tags = await ensureServer();
if (args[0] === 'models') {
  tags.models.forEach((m) => console.log(`${m.name}  ${(m.size / 1e9).toFixed(1)} GB`));
  process.exit(0);
}

let stdin = '';
if (!process.stdin.isTTY) for await (const chunk of process.stdin) stdin += chunk;
const prompt = [args.join(' ').trim(), stdin.trim()].filter(Boolean).join('\n\n');
if (!prompt) { console.log('Usage: local.mjs [--model name] [--max tokens] [--json] "prompt" | models'); process.exit(1); }

const t0 = Date.now();
const r = await api('/api/generate', { model, prompt, stream: false, ...(json ? { format: 'json' } : {}), options: { num_predict: max } });
console.log(r.response.trim());
const tps = r.eval_duration ? r.eval_count / (r.eval_duration / 1e9) : 0;
console.error(`[local ${model}: ${r.prompt_eval_count || 0} in, ${r.eval_count || 0} out, ${tps.toFixed(1)} tok/s, ${((Date.now() - t0) / 1000).toFixed(1)} s]`);
try {
  fs.appendFileSync(path.join(DATA_DIR, 'usage.jsonl'), JSON.stringify({
    ts: new Date().toISOString(), model: `local:${model}`, input: r.prompt_eval_count || 0, cache_read: 0, cache_creation: 0,
    output: r.eval_count || 0, total: (r.prompt_eval_count || 0) + (r.eval_count || 0), cost_usd: 0, ms: Date.now() - t0,
    tok_per_s: Math.round(tps * 10) / 10, status: 'ok', local: true,
  }) + '\n');
} catch {}
