// Previews today's brief without n8n and without sending: the same Code-node sources, the real calendar, the real task
// table, nothing written (the calendar cache goes to a throw-away folder). Same thing as `run-brief.sh --dry-run`,
// for when you are editing the sources and want the message on the terminal.
// Usage: node scripts/test-brief.mjs   (needs ~/.n8n-morning-brief/config.local.env)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBrief } from './brief.mjs';

const home = process.env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');
const env = { ...process.env, BRIEF_HOME: home };
for (const l of fs.readFileSync(path.join(home, 'config.local.env'), 'utf8').split('\n')) {
  const m = l.match(/^(?:export )?([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !['PATH', 'HOME', 'BRIEF_HOME', 'BRIEF_STATE_DIR'].includes(m[1])) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
env.BRIEF_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-state-')); // never write the real state from a preview
env.BRIEF_INBOX = env.BRIEF_INBOX || path.join(os.homedir(), 'n8n-inbox');

const t0 = Date.now();
const r = await runBrief({ env, dryRun: true, log: (m) => console.error(m) });
console.log(r.message || '');
console.error(`[dry-run ${Date.now() - t0}ms] ${(r.message || '').length} chars`);
process.exit(r.code || 0);
