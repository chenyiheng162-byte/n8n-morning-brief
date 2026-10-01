// Runs Ingest + Build brief outside n8n against a SAMPLE inbox (never your real inbox/state), real AI.
// Usage: node scripts/test-ingest.mjs <sample-dir> [--keep]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const home = process.env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(home, 'package.json'));
const arg = process.argv[2];
if (!arg || arg.startsWith('--') || !fs.existsSync(arg) || !fs.statSync(arg).isDirectory()) { console.error('usage: node scripts/test-ingest.mjs <sample-dir> [--approve]\n(refusing to guess: this script sends the folder\'s files to the AI)'); process.exit(1); }
const sample = path.resolve(arg);
const state = process.env.TEST_STATE || fs.mkdtempSync(path.join(os.tmpdir(), 'brief-state-'));
const env = { ...process.env, BRIEF_INBOX: sample, BRIEF_STATE_DIR: state };
for (const l of fs.readFileSync(path.join(home, 'config.local.env'), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !(m[1] in env && /^(BRIEF_)/.test(m[1]))) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
import { execFileSync } from 'node:child_process';
execFileSync(process.execPath, [path.join(here, 'extract-inbox.mjs')], { env, stdio: ['ignore', 'inherit', 'inherit'], cwd: home });
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const load = (f) => fs.readFileSync(path.join(here, '..', 'workflows', 'src', f), 'utf8')
  .replace(/^\/\/@include (\S+)$/gm, (_, i) => fs.readFileSync(path.join(here, '..', 'workflows', 'src', 'lib', i), 'utf8'));
const ctx = { helpers: { httpRequest: async ({ method, url, headers, body, json }) => {
  const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  return json ? r.json() : r.text(); } } };
const fakeCal = { today: process.env.TEST_TODAY || new Date().toISOString().slice(0, 10), days: 3, calendars: 0, events: [], errors: [] };
const $ = (name) => ({ first: () => ({ json: name === 'Webhook' ? { body: { missed: (process.env.TEST_MISSED || '').split(',').filter(Boolean) } } : fakeCal }) });

const ingest = await new AsyncFunction('require', '$env', '$', '$input', load('ingest-files.js')).call(ctx, require, env, $, {});
console.error('[ingest]', JSON.stringify(ingest[0].json.ingest));
if (process.argv.includes('--approve')) { // simulate the user flipping 待确认 -> 进行中
  const f = ingest[0].json.tasksFile; fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/待确认/g, '进行中'));
}
const out = await new AsyncFunction('require', '$env', '$', '$input', load('build-brief.js')).call(ctx, require, env, $, { first: () => ingest[0] });
console.log(out[0].json.message);
const pl = out[0].json.payload; const bad = [];   // Discord embed limits
let total = 0;
for (const e of pl.embeds) { total += (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length;
  if ((e.title || '').length > 256) bad.push('title>256'); if ((e.description || '').length > 4096) bad.push('description>4096');
  if ((e.fields || []).length > 25) bad.push('fields>25');
  for (const f of e.fields || []) { total += f.name.length + f.value.length; if (f.name.length > 256) bad.push('name>256'); if (f.value.length > 1024) bad.push(`value>1024 (${f.name})`); if (!f.value) bad.push('empty value'); } }
if (total > 6000) bad.push(`total ${total}>6000`); if (pl.embeds.length > 10) bad.push('embeds>10');
console.error(bad.length ? `[DISCORD LIMITS VIOLATED] ${bad.join(', ')}` : `[discord limits ok] embeds=${pl.embeds.length} chars=${total}`);
console.error('[stats]', JSON.stringify({ ...out[0].json, message: undefined }), `state=${state}`);
