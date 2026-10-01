// Offline test helpers: run the workflow's Code-node sources exactly as n8n would, with stubbed HTTP and fixed dates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// ical.js is the only library the tests need. Prefer the small .test-deps/ (created by scripts/test.sh) so the suite runs on
// any machine; fall back to a full runtime folder. DEPS_HOME is the folder whose node_modules holds it.
const depCandidates = [path.join(ROOT, '.test-deps'), process.env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief')];
export let DEPS_HOME = null;
export let req = null;
for (const d of depCandidates) { try { const r = createRequire(path.join(d, 'package.json')); r.resolve('ical.js'); DEPS_HOME = d; req = r; break; } catch (e) { /* try the next one */ } }
if (!req) throw new Error('ical.js not found. Run scripts/test.sh (it installs ical.js into .test-deps/), or set BRIEF_HOME to an installed runtime.');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export const loadSource = (f) => fs.readFileSync(path.join(ROOT, 'workflows', 'src', f), 'utf8')
  .replace(/^\/\/@include (\S+)$/gm, (_, inc) => fs.readFileSync(path.join(ROOT, 'workflows', 'src', 'lib', inc), 'utf8'));

export const tmpdir = (prefix = 'brief-test-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// nodes: outputs of upstream nodes, keyed by node name, e.g. { 'Read calendars': {...} }
export async function runNode(file, { env: givenEnv = {}, nodes = {}, input = {}, http = async () => { throw new Error('unexpected http call'); } } = {}) {
  // SAFETY: nodes write caches and state. Unless a test names its own folders they get throw-away ones, never the real runtime folder.
  const env = { BRIEF_STATE_DIR: tmpdir('state-'), BRIEF_INBOX: tmpdir('inbox-'), ...givenEnv };
  const $ = (name) => ({ first: () => ({ json: nodes[name] ?? {} }), all: () => [{ json: nodes[name] ?? {} }] });
  const ctx = { helpers: { httpRequest: http } };
  const fn = new AsyncFunction('require', '$env', '$', '$input', loadSource(file));
  const out = await fn.call(ctx, req, env, $, { first: () => ({ json: input }), all: () => [{ json: input }] });
  return out[0].json;
}

export const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`;
export const vevent = (o) => ['BEGIN:VEVENT', `UID:${o.uid}`, 'DTSTAMP:20260101T000000Z', ...o.lines, 'END:VEVENT'].join('\r\n');

// The run lock is an operating-system file lock (scripts/lock.sh). holdLock() holds it from a separate process, as a
// run, a deployment or the console would; lockHeld() asks whether anyone holds it right now.
import { spawn as spawnProc, spawnSync as spawnSyncProc } from 'node:child_process';
export const lockHeld = (stateDir) => fs.existsSync(path.join(stateDir, 'run.lockf')) && spawnSyncProc('/usr/bin/lockf', ['-k', '-s', '-t', '0', path.join(stateDir, 'run.lockf'), '/usr/bin/true']).status === 75;
export async function holdLock(stateDir, tag = 'run-brief') {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'run.lockf');
  const p = spawnProc('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, '/bin/sleep', '60'], { stdio: 'ignore', detached: true }); p.unref();
  for (let i = 0; i < 100 && !lockHeld(stateDir); i++) await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(file, `${p.pid} ${Math.floor(Date.now() / 1000)} ${tag}\n`);
  return { pid: p.pid, release: async () => { try { process.kill(-p.pid); } catch { try { process.kill(p.pid); } catch { /* gone */ } } for (let i = 0; i < 100 && lockHeld(stateDir); i++) await new Promise((r) => setTimeout(r, 30)); } };
}
