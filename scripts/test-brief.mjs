// Runs the exact Code-node sources outside n8n, against the real calendar, and prints the result.
// Usage: node scripts/test-brief.mjs   (needs ~/.n8n-morning-brief/config.local.env)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const home = process.env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(home, 'package.json'));
const env = { ...process.env };
for (const l of fs.readFileSync(path.join(home, 'config.local.env'), 'utf8').split('\n')) {
  const m = l.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
env.BRIEF_STATE_DIR = env.BRIEF_STATE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'brief-state-')); // never write the real calendar cache from a test
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const load = (f) => fs.readFileSync(path.join(here, '..', 'workflows', 'src', f), 'utf8');
const ctx = { helpers: { httpRequest: async ({ url }) => (await fetch(url)).text() } };

const t0 = Date.now();
const read = new AsyncFunction('require', '$env', '$input', load('read-calendars.js'));
const items = await read.call(ctx, require, env, {});
const t1 = Date.now();
const build = new AsyncFunction('require', '$env', '$input', load('build-brief.js'));
const res = await build.call(ctx, require, env, { first: () => items[0] });
const j = items[0].json;
console.error(`[read ${t1 - t0}ms] tz=${j.tz} today=${j.today} calendars=${j.calendars} events=${j.events.length} errors=${j.errors.length}`);
console.log(res[0].json.message);
console.error(`[message ${res[0].json.message.length} chars]`);
