import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, tmpdir } from './helpers.mjs';

// SAFETY: scripts under test run with a throw-away HOME and a fake `launchctl` first in PATH. An earlier version of this
// suite ran uninstall.sh with the real HOME and removed the user's real launchd job.
const REAL_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.cc-workspace.n8n-morning-brief.plist');
const hadRealPlist = fs.existsSync(REAL_PLIST);
const SAFE_BIN = tmpdir('safe-bin-');
fs.writeFileSync(path.join(SAFE_BIN, 'launchctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
const safeEnv = (env = {}) => ({ PATH: `${SAFE_BIN}:${process.env.PATH}`, HOME: tmpdir('safe-home-'), BRIEF_LABEL: 'test.safe', ...env });
const bash = (script, env = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: safeEnv(env) });
after(() => {
  if (hadRealPlist) assert.ok(fs.existsSync(REAL_PLIST), 'THE TEST SUITE REMOVED THE REAL LAUNCHD JOB');
});

// ---------- config library ----------
test('config values with shell metacharacters survive a write and a reload, and the file stays private', () => {
  const home = tmpdir('cfg-');
  const nasty = 'https://x.example/hook?wait=true&thread_id=1;rm -rf /|$(id) `id` "q" (a) $HOME';
  const r = bash(`. "${ROOT}/scripts/lib-config.sh"; config_set DISCORD_WEBHOOK_URL '${nasty}'; config_set BRIEF_IGNORE 'Recess|Lunch|^Reg\\s*\\(x\\)'; . "${ROOT}/scripts/env.sh"; printf '%s\\n%s' "$DISCORD_WEBHOOK_URL" "$BRIEF_IGNORE"`, { BRIEF_HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${nasty}\nRecess|Lunch|^Reg\\s*\\(x\\)`);
  assert.equal((fs.statSync(path.join(home, 'config.local.env')).mode & 0o777).toString(8), '600');
});

test('config_set rewrites an existing key instead of duplicating it, and keeps the others', () => {
  const home = tmpdir('cfg-');
  bash(`. "${ROOT}/scripts/lib-config.sh"; config_set A one; config_set B two; config_set A three`, { BRIEF_HOME: home });
  const text = fs.readFileSync(path.join(home, 'config.local.env'), 'utf8');
  assert.equal(text.match(/^A=/gm).length, 1); assert.match(text, /^A='three'$/m); assert.match(text, /^B='two'$/m);
});

test('a value containing a single quote is refused (it cannot be stored safely)', () => {
  const home = tmpdir('cfg-');
  const r = bash(`. "${ROOT}/scripts/lib-config.sh"; config_set A "it's"`, { BRIEF_HOME: home });
  assert.notEqual(r.status, 0);
});

test('the credential temp file is private even under a permissive umask (review finding 5)', () => {
  const home = tmpdir('cfg-');
  bash(`umask 022; . "${ROOT}/scripts/lib-config.sh"; config_set SECRET abc; ls -la "${home}" > "${home}/ls.txt"`, { BRIEF_HOME: home });
  const leftovers = fs.readdirSync(home).filter((n) => n.startsWith('.config.'));
  assert.deepEqual(leftovers, []);
  assert.equal((fs.statSync(path.join(home, 'config.local.env')).mode & 0o777).toString(8), '600');
});

// ---------- env.sh ----------
test('the timezone variables follow BRIEF_TZ from the config (review finding 9)', () => {
  const home = tmpdir('env-');
  fs.writeFileSync(path.join(home, 'config.local.env'), "BRIEF_TZ='America/New_York'\n");
  const r = bash(`. "${ROOT}/scripts/env.sh"; echo "$BRIEF_TZ $TZ $GENERIC_TIMEZONE"`, { BRIEF_HOME: home });
  assert.equal(r.stdout.trim(), 'America/New_York America/New_York America/New_York');
});

test('successful executions are not stored by n8n (they would keep your schedule forever)', () => {
  const home = tmpdir('env-');
  const r = bash(`. "${ROOT}/scripts/env.sh"; echo "$EXECUTIONS_DATA_SAVE_ON_SUCCESS $N8N_RUNNERS_TASK_TIMEOUT"`, { BRIEF_HOME: home });
  assert.equal(r.stdout.trim(), 'none 600');
});

test('BRIEF_EXEC_KEEP_DAYS must be a whole number (it goes into an SQL statement): anything else is reported and replaced by 3', () => {
  for (const [value, want, flagged] of [['7', '7', false], ['abc', '3', true], ['3 days', '3', true], ['', '3', false]]) {
    const home = tmpdir('env-'); fs.writeFileSync(path.join(home, 'config.local.env'), value ? `BRIEF_EXEC_KEEP_DAYS='${value}'\n` : '');
    const r = bash(`. "${ROOT}/scripts/env.sh"; echo "$BRIEF_EXEC_KEEP_DAYS|$BRIEF_CONFIG_ERRORS"`, { BRIEF_HOME: home });
    assert.equal(r.stdout.trim(), `${want}|${flagged ? 'BRIEF_EXEC_KEEP_DAYS' : ''}`, value);
  }
});

// ---------- folder guard ----------
test('rsync --delete and --purge refuse a folder this project did not create (review I)', () => {
  const home = tmpdir('guard-'); // no marker file
  const r = bash(`. "${ROOT}/scripts/lib-config.sh"; runtime_check`, { BRIEF_HOME: home });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing/);
  bash(`. "${ROOT}/scripts/lib-config.sh"; runtime_mark`, { BRIEF_HOME: home });
  assert.equal(bash(`. "${ROOT}/scripts/lib-config.sh"; runtime_check`, { BRIEF_HOME: home }).status, 0);
  const purge = spawnSync('bash', [path.join(ROOT, 'uninstall.sh'), '--purge'], { encoding: 'utf8', input: 'yes\n', env: safeEnv({ BRIEF_HOME: tmpdir('guard2-') }) });
  assert.notEqual(purge.status, 0);
});

// ---------- paths with spaces ----------
test('the scripts work when the project sits in a folder with spaces and non-ASCII characters (review finding 10)', () => {
  const dir = path.join(tmpdir('sp-'), '课程 folder with spaces');
  fs.cpSync(ROOT, dir, { recursive: true, filter: (src) => !/(^|\/)(node_modules|\.git)(\/|$)/.test(path.relative(ROOT, src)) }); // judge the path inside the project, not the temp folder above it
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'build-workflow.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('test-ingest.mjs refuses to run without an explicit folder (review finding 3)', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-ingest.mjs')], { encoding: 'utf8', cwd: ROOT, env: safeEnv({ BRIEF_HOME: tmpdir('ti-home-') }) }); // isolated: even if the guard regressed it could not read real config
  assert.notEqual(r.status, 0); assert.match(r.stderr, /usage/);
});

// ---------- launchd plist ----------
test('the launchd job carries BRIEF_HOME, the port and the inbox, and has retry slots (review findings 7 and C)', () => {
  const home = tmpdir('ld-'); const fakeHome = tmpdir('fakehome-'); const bin = tmpdir('bin-');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), '');
  for (const c of ['launchctl', 'rsync-noop']) fs.writeFileSync(path.join(bin, c), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.brief', N8N_PORT: '5811', BRIEF_INBOX: '/tmp/some inbox' } });
  assert.equal(r.status, 0, r.stderr);
  const plist = fs.readFileSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'test.brief.plist'), 'utf8');
  assert.match(plist, new RegExp(`<key>BRIEF_HOME</key><string>${home}</string>`));
  assert.match(plist, /<key>N8N_PORT<\/key><string>5811<\/string>/); assert.match(plist, /<key>BRIEF_INBOX<\/key><string>\/tmp\/some inbox<\/string>/);
  const slots = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(slots, ['8:0', '8:20', '8:40', '9:30']);
  assert.ok(fs.existsSync(path.join(home, 'scripts', 'run-brief.sh')));
});

test('retry slots never cross midnight (23:30 keeps only 23:30 and 23:50)', () => {
  const home = tmpdir('ld-'); const fakeHome = tmpdir('fakehome-'); const bin = tmpdir('bin-');
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 }); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), '');
  spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '23:30'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.late' } });
  const plist = fs.readFileSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'test.late.plist'), 'utf8');
  const slots = [...plist.matchAll(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(slots, ['23:30', '23:50']);
});

// ---------- lint ----------
test('no shell variable is directly followed by a non-ASCII character (bash reads it as part of the name; set -u then aborts silently)', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.sh')).map((f) => path.join(ROOT, 'scripts', f)), path.join(ROOT, 'install.sh'), path.join(ROOT, 'uninstall.sh')];
  const bad = [];
  for (const f of files) fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => { if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(l)) bad.push(`${path.basename(f)}:${i + 1}`); });
  assert.deepEqual(bad, []);
});

test('every shell script passes bash -n', () => {
  for (const f of [...fs.readdirSync(path.join(ROOT, 'scripts')).filter((n) => n.endsWith('.sh')).map((n) => path.join(ROOT, 'scripts', n)), path.join(ROOT, 'install.sh'), path.join(ROOT, 'uninstall.sh')]) {
    const r = spawnSync('bash', ['-n', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

// ---------- directory guard on the REAL entry points (review P1) ----------
const read2 = (p) => fs.readFileSync(p, 'utf8');
const lsBin = () => { const bin = tmpdir('bin-'); fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 }); return bin; };
const plantForeignFiles = () => { const home = tmpdir('foreign-'); for (const d of ['scripts', 'workflows']) { fs.mkdirSync(path.join(home, d)); fs.writeFileSync(path.join(home, d, 'precious.txt'), 'mine'); } return home; };

test('install-launchd.sh refuses an existing folder it did not create and deletes nothing', () => {
  const home = plantForeignFiles();
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${lsBin()}:${process.env.PATH}`, HOME: tmpdir('fh-'), BRIEF_HOME: home, BRIEF_LABEL: 'test.guard' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing/);
  assert.ok(fs.existsSync(path.join(home, 'scripts', 'precious.txt'))); assert.ok(fs.existsSync(path.join(home, 'workflows', 'precious.txt')));
  assert.equal(fs.existsSync(path.join(home, '.n8n-morning-brief-runtime')), false, 'the script must not adopt the folder by creating the marker');
});

test('deploy-workflow.sh refuses an existing folder it did not create and deletes nothing', () => {
  const home = plantForeignFiles();
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'deploy-workflow.sh')], { encoding: 'utf8', env: { PATH: `${lsBin()}:${process.env.PATH}`, HOME: tmpdir('fh-'), BRIEF_HOME: home, N8N_PORT: '5899' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Refusing/);
  assert.ok(fs.existsSync(path.join(home, 'scripts', 'precious.txt'))); assert.ok(fs.existsSync(path.join(home, 'workflows', 'precious.txt')));
  assert.equal(fs.existsSync(path.join(home, '.n8n-morning-brief-runtime')), false);
});

test('an installation from before the marker existed (our own run script + settings) is recognised and marked once', () => {
  const home = tmpdir('legacy-'); fs.writeFileSync(path.join(home, 'config.local.env'), "A='1'\n");
  fs.mkdirSync(path.join(home, 'scripts')); fs.copyFileSync(path.join(ROOT, 'scripts', 'run-brief.sh'), path.join(home, 'scripts', 'run-brief.sh'));
  const r = bash(`. "${ROOT}/scripts/lib-config.sh"; runtime_check && echo ok`, { BRIEF_HOME: home });
  assert.equal(r.stdout.trim(), 'ok'); assert.ok(fs.existsSync(path.join(home, '.n8n-morning-brief-runtime')));
});

test('ANOTHER n8n project (settings file + n8n binary + its own scripts) is never adopted, and its scripts are never deleted (review: P1 round 3)', () => {
  const home = tmpdir('other-n8n-'); fs.writeFileSync(path.join(home, 'config.local.env'), "SOMETHING='1'\n");
  fs.mkdirSync(path.join(home, 'node_modules', '.bin'), { recursive: true }); fs.writeFileSync(path.join(home, 'node_modules', '.bin', 'n8n'), '#!/bin/bash\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'scripts')); fs.writeFileSync(path.join(home, 'scripts', 'their-own.sh'), 'precious');
  const check = bash(`. "${ROOT}/scripts/lib-config.sh"; runtime_check`, { BRIEF_HOME: home });
  assert.notEqual(check.status, 0); assert.equal(fs.existsSync(path.join(home, '.n8n-morning-brief-runtime')), false);
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${lsBin()}:${process.env.PATH}`, HOME: tmpdir('fh-'), BRIEF_HOME: home, BRIEF_LABEL: 'test.other' } });
  assert.notEqual(r.status, 0); assert.equal(read2(path.join(home, 'scripts', 'their-own.sh')), 'precious'); assert.equal(fs.existsSync(path.join(home, 'logs')), false, 'nothing is created inside a folder that is refused');
});

test('install-launchd.sh no longer touches workflows/ (only deploy-workflow.sh may change it together with the n8n import)', () => {
  const home = tmpdir('nosync-'); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), ''); fs.mkdirSync(path.join(home, 'workflows')); fs.writeFileSync(path.join(home, 'workflows', 'BUILD'), 'keepme\n');
  spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${lsBin()}:${process.env.PATH}`, HOME: tmpdir('fh-'), BRIEF_HOME: home, BRIEF_LABEL: 'test.nosync' } });
  assert.equal(fs.readFileSync(path.join(home, 'workflows', 'BUILD'), 'utf8'), 'keepme\n');
});

// ---------- AI settings merge (review finding 5) ----------
const merged = (existing, base, model, key) => {
  const home = tmpdir('ai-'); if (existing) fs.writeFileSync(path.join(home, 'config.local.env'), existing);
  const r = bash(`. "${ROOT}/scripts/lib-config.sh"; ai_merge '${base}' '${model}' '${key}'; . "${ROOT}/scripts/env.sh"; printf '%s|%s|%s' "$AI_BASE_URL" "$AI_MODEL" "$AI_API_KEY"`, { BRIEF_HOME: home });
  return r.stdout;
};
const OLD = "AI_BASE_URL='https://private.example/v1'\nAI_MODEL='private-model'\nAI_API_KEY='oldkey'\n";
test('rotating only the API key keeps the saved provider and model', () => assert.equal(merged(OLD, '', '', 'newkey'), 'https://private.example/v1|private-model|newkey'));
test('changing only the model keeps provider and key', () => assert.equal(merged(OLD, '', 'better-model', ''), 'https://private.example/v1|better-model|oldkey'));
test('passing all three replaces all three', () => assert.equal(merged(OLD, 'https://other.example', 'm2', 'k2'), 'https://other.example|m2|k2'));
test('defaults apply only when nothing is saved yet, and passing nothing changes nothing', () => {
  assert.equal(merged('', '', '', 'firstkey'), 'https://api.deepseek.com|deepseek-chat|firstkey');
  assert.equal(merged(OLD, '', '', ''), 'https://private.example/v1|private-model|oldkey');
});

// ---------- launchd XML (review finding 9) ----------
test('a folder name with & < > produces a valid plist, and a failure leaves the existing job untouched', () => {
  const fakeHome = tmpdir('fh-'); const parent = tmpdir('amp-'); const home = path.join(parent, 'Research & <Study>');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true }); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), '');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${lsBin()}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.amp', BRIEF_INBOX: '/tmp/a & b' } });
  assert.equal(r.status, 0, r.stderr);
  const plist = path.join(fakeHome, 'Library', 'LaunchAgents', 'test.amp.plist');
  assert.match(fs.readFileSync(plist, 'utf8'), /Research &amp; &lt;Study&gt;/);
  assert.equal(spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' }).status, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(plist)).filter((n) => n.includes('.plist.')), [], 'no temp plist left behind');
});

test('port and inbox saved in the config reach the scheduled job even when the installer is re-run without them (review R3)', () => {
  const fakeHome = tmpdir('fh-'); const home = tmpdir('persist-'); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), ''); fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'config.local.env'), "N8N_PORT='5690'\nBRIEF_INBOX='/tmp/my inbox'\n");
  spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${lsBin()}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.persist' } });
  const plist = fs.readFileSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'test.persist.plist'), 'utf8');
  assert.match(plist, /<key>N8N_PORT<\/key><string>5690<\/string>/); assert.match(plist, /<key>BRIEF_INBOX<\/key><string>\/tmp\/my inbox<\/string>/);
});

// ================= round 4: install.sh uses the SAME ownership rule as every other entry point (review R4-01) =================
const claimable = (home) => bash(`. "${ROOT}/scripts/lib-config.sh"; runtime_claimable && echo yes || echo no`, { BRIEF_HOME: home }).stdout.trim();
test('install.sh may start in a folder that does not exist, is empty, or holds only what we write first', () => {
  assert.equal(claimable(path.join(tmpdir('cl-'), 'new-folder')), 'yes');
  assert.equal(claimable(tmpdir('cl-empty-')), 'yes');
  const cfg = tmpdir('cl-cfg-'); fs.writeFileSync(path.join(cfg, 'config.local.env'), "DISCORD_WEBHOOK_URL='x'\n"); fs.mkdirSync(path.join(cfg, 'logs'));
  assert.equal(claimable(cfg), 'yes', 'a settings file the user prepared in advance is fine');
});
test('install.sh may NOT start in a folder that holds anything else: a settings file next to foreign files is not proof of ownership', () => {
  const home = tmpdir('cl-foreign-'); fs.writeFileSync(path.join(home, 'config.local.env'), "SOMETHING='1'\n"); fs.mkdirSync(path.join(home, 'scripts')); fs.writeFileSync(path.join(home, 'scripts', 'their-own.sh'), 'precious');
  assert.equal(claimable(home), 'no');
  const tokenless = tmpdir('cl-pkg-'); fs.writeFileSync(path.join(tokenless, 'package.json'), '{"name":"someone-elses"}'); assert.equal(claimable(tokenless), 'no', 'their package.json would be overwritten by npm ci');
});
test('REAL install.sh on another n8n project: refused, nothing created, and the follow-up sync entry point still refuses and deletes nothing (chain: refuse -> failed install -> sync)', () => {
  const home = tmpdir('chain-'); fs.writeFileSync(path.join(home, 'config.local.env'), "SOMETHING='1'\n");
  fs.mkdirSync(path.join(home, 'node_modules', '.bin'), { recursive: true }); fs.writeFileSync(path.join(home, 'node_modules', '.bin', 'n8n'), '#!/bin/bash\n', { mode: 0o755 });
  fs.mkdirSync(path.join(home, 'scripts')); fs.writeFileSync(path.join(home, 'scripts', 'their-own.sh'), 'precious');
  const before = fs.readdirSync(home).sort().join();
  const inst = spawnSync('bash', [path.join(ROOT, 'install.sh'), '--yes', '--no-schedule', '--no-test-run'], { encoding: 'utf8', timeout: 60000, env: safeEnv({ BRIEF_HOME: home, DISCORD_WEBHOOK_URL: 'http://127.0.0.1:9/x', BRIEF_INBOX: tmpdir('chain-in-') }) });
  assert.notEqual(inst.status, 0); assert.match(inst.stderr, /was not created by this project/);
  assert.equal(fs.existsSync(path.join(home, '.n8n-morning-brief-runtime')), false, 'a refused install leaves no marker behind');
  assert.equal(fs.readdirSync(home).sort().join(), before, 'nothing was created or changed in the folder');
  const sync = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: safeEnv({ BRIEF_HOME: home, BRIEF_LABEL: 'test.chain' }) });
  assert.notEqual(sync.status, 0); assert.equal(read2(path.join(home, 'scripts', 'their-own.sh')), 'precious');
});

// ================= one lock: an operating-system file lock (review R6-01, R8-01) =================
const lockTry = (state, hold = 0) => spawnSync('bash', ['-c', `. "${ROOT}/scripts/lock.sh"; lock_take "${path.join(state, 'run.lockf')}" tester; rc=$?; echo "rc=$rc holder=$LOCK_HOLDER"; sleep ${hold}; lock_release`], { encoding: 'utf8', env: safeEnv() });
test('lock: free -> ours, and released again; the holder is named in the file', () => {
  const state = tmpdir('lk-'); const r = lockTry(state); assert.match(r.stdout, /rc=0/);
  assert.match(read2(path.join(state, 'run.lockf')), /^\d+ \d+ tester$/m);
  assert.match(lockTry(state).stdout, /rc=0/, 'released after use');
});
test('lock: while one process holds it, every other attempt is refused at once, whoever it is; it is free the moment the holder ends', async () => {
  const state = tmpdir('lk2-'); const { spawn } = await import('node:child_process');
  const holder = spawn('bash', ['-c', `. "${ROOT}/scripts/lock.sh"; lock_take "${path.join(state, 'run.lockf')}" first; echo got; sleep 30`], { env: safeEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => holder.stdout.once('data', r));
  for (let i = 0; i < 5; i++) assert.match(lockTry(state).stdout, /rc=1 holder=\d+ first/);
  holder.kill('SIGKILL'); await new Promise((r) => holder.on('exit', r));
  let r; for (let i = 0; i < 40; i++) { r = lockTry(state); if (/rc=0/.test(r.stdout)) break; await new Promise((x) => setTimeout(x, 100)); }
  assert.match(r.stdout, /rc=0/, 'a killed holder never leaves the lock behind (nothing has to be judged stale and deleted)');
});
test('lock: many processes racing for a free lock: exactly one gets it', async () => {
  const state = tmpdir('lk3-'); const { spawn } = await import('node:child_process');
  const runs = Array.from({ length: 8 }, () => new Promise((res) => { let out = ''; const c = spawn('bash', ['-c', `. "${ROOT}/scripts/lock.sh"; lock_take "${path.join(state, 'run.lockf')}" racer; rc=$?; echo "rc=$rc"; sleep 1; lock_release`], { env: safeEnv() }); c.stdout.on('data', (d) => { out += d; }); c.on('exit', () => res(out)); }));
  const outs = await Promise.all(runs);
  assert.equal(outs.filter((o) => /rc=0/.test(o)).length, 1, outs.join('|'));
});
test('lock: the Node tools use the same lock (a shell holder blocks the inbox tool and the console, and the other way round)', async () => {
  const state = tmpdir('lk4-'); const { acquireLock } = await import('../scripts/lock.mjs');
  const a = await acquireLock(state, 'console'); assert.equal(a.ok, true);
  assert.match(lockTry(state).stdout, /rc=1 holder=\d+ console/);
  const b = await acquireLock(state, 'inbox-tool'); assert.equal(b.ok, false);
  await a.release(); assert.match(lockTry(state).stdout, /rc=0/);
});

// ================= bridge to the old directory lock (review R9-01) =================
// test/fixtures/lock-v8.sh is the lock library of version 8, unchanged: what a console or tool started before the update runs.
const holdOld = async (state) => { const { spawn } = await import('node:child_process'); fs.mkdirSync(path.join(state, 'run.lock'), { recursive: true }); const p = spawn('bash', ['-c', 'exec -a run-brief-old sleep 30'], { stdio: 'ignore', detached: true }); p.unref(); fs.writeFileSync(path.join(state, 'run.lock', 'owner'), `${p.pid} 1\n`); return p; };
test('lock bridge: while a process of the OLD version holds the old lock, the new lock is refused (and left free)', async () => {
  const state = tmpdir('lkb-'); const old = await holdOld(state);
  try {
    assert.match(lockTry(state).stdout, /rc=1 holder=\d+ old version/);
    const { acquireLock } = await import('../scripts/lock.mjs'); const r = await acquireLock(state, 'console'); assert.equal(r.ok, false); assert.match(r.holder, /old version/);
    assert.equal(spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', path.join(state, 'run.lockf'), '/usr/bin/true']).status, 0, 'the new lock was given back');
  } finally { old.kill(); }
  assert.match(lockTry(state).stdout, /rc=0/, 'the old holder is gone: the new lock is ours, the dead old lock is taken over');
});
test('lock bridge: while the NEW lock is held, a process running the OLD lock code is refused too', async () => {
  const state = tmpdir('lkb2-'); const { spawn } = await import('node:child_process');
  const holder = spawn('bash', ['-c', `exec -a run-brief-new bash -c '. "${ROOT}/scripts/lock.sh"; lock_take "${path.join(state, 'run.lockf')}" run-brief; echo got; sleep 30; true'`], { env: safeEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((r) => holder.stdout.once('data', r));
  try {
    assert.ok(fs.existsSync(path.join(state, 'run.lock', 'owner')), 'the old lock is held as well');
    const oldTry = spawnSync('bash', ['-c', `. "${ROOT}/test/fixtures/lock-v8.sh"; lock_acquire "${path.join(state, 'run.lock')}" "run-brief|deploy-workflow|inbox-tool|inbox\\.sh|console\\.mjs"; echo "rc=$?"`], { encoding: 'utf8', env: safeEnv() });
    assert.match(oldTry.stdout, /rc=1/, 'the old code sees a live holder and waits');
  } finally { holder.kill('SIGKILL'); }
});
test('lock bridge: the old lock is given back on release', () => {
  const state = tmpdir('lkb3-'); assert.match(lockTry(state).stdout, /rc=0/);
  assert.equal(fs.existsSync(path.join(state, 'run.lock')), false);
});

// ================= the two ways friends start the install =================
// A stand-in project whose install.sh only records how it was started.
function fakeProject(dir, tag = 'v1') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'install.sh'), `echo "${tag} home=$HOME label=\${BRIEF_LABEL:-} port=\${N8N_PORT:-} args=$*" > "$HOME/ran.txt"\n`);
  fs.writeFileSync(path.join(dir, 'VERSION'), tag);
  return dir;
}
function tarball(tag) {
  const src = tmpdir('get-src-'); fakeProject(path.join(src, 'n8n-morning-brief-main'), tag);
  const tgz = path.join(tmpdir('get-tgz-'), 'main.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', src, 'n8n-morning-brief-main']).status, 0);
  return `file://${tgz}`;
}
const getSh = fs.readFileSync(path.join(ROOT, 'get.sh'), 'utf8');
const pipeGet = (home, url, script = getSh) => spawnSync('bash', [], { input: script, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, BRIEF_GET_URL: url, TMPDIR: tmpdir('get-tmp-') } });

test('one-line install: get.sh, piped into bash, downloads the project into ~/n8n-morning-brief and runs its install.sh', () => {
  const home = tmpdir('get-home-');
  const r = pipeGet(home, tarball('v1'));
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(home, 'ran.txt'), 'utf8'), /^v1 home=/);
  assert.equal(fs.readFileSync(path.join(home, 'n8n-morning-brief', 'VERSION'), 'utf8'), 'v1');
  // running it again updates the copy in place
  fs.writeFileSync(path.join(home, 'n8n-morning-brief', 'old-file'), 'x');
  assert.equal(pipeGet(home, tarball('v2')).status, 0);
  assert.equal(fs.readFileSync(path.join(home, 'n8n-morning-brief', 'VERSION'), 'utf8'), 'v2');
  assert.ok(!fs.existsSync(path.join(home, 'n8n-morning-brief', 'old-file')), 'the old copy is replaced as a whole');
  assert.ok(!fs.existsSync(path.join(home, 'n8n-morning-brief.old')));
});

test('one-line install: a folder of the same name that is not ours is left alone; a failed download or a cut-off script changes nothing', () => {
  const home = tmpdir('get-home-'); fs.mkdirSync(path.join(home, 'n8n-morning-brief')); fs.writeFileSync(path.join(home, 'n8n-morning-brief', 'mine.txt'), 'keep');
  const r = pipeGet(home, tarball('v1'));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /不是这个项目的文件夹/);
  assert.equal(fs.readFileSync(path.join(home, 'n8n-morning-brief', 'mine.txt'), 'utf8'), 'keep');
  const home2 = tmpdir('get-home-');
  const bad = pipeGet(home2, 'file:///nonexistent/main.tar.gz');
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /下载失败/); assert.ok(!fs.existsSync(path.join(home2, 'n8n-morning-brief')));
  const cut = pipeGet(home2, tarball('v1'), getSh.slice(0, Math.floor(getSh.length * 0.8)));
  assert.ok(!fs.existsSync(path.join(home2, 'n8n-morning-brief')) && !fs.existsSync(path.join(home2, 'ran.txt')), 'half a script runs nothing');
});

test('double-click install: the .command copies its folder to ~/n8n-morning-brief and starts install.sh there (a marked test folder plays home)', () => {
  const sandboxHome = tmpdir('dbl-home-'); fs.writeFileSync(path.join(sandboxHome, '.brief-sandbox-home'), '');
  const unpacked = fakeProject(path.join(sandboxHome, 'Library', 'WeChat', 'files', 'n8n-morning-brief'));
  fs.copyFileSync(path.join(ROOT, '双击安装.command'), path.join(unpacked, '双击安装.command'));
  const r = spawnSync('bash', [path.join(unpacked, '双击安装.command')], { input: '\n', encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir('dbl-realhome-') } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const ran = fs.readFileSync(path.join(sandboxHome, 'ran.txt'), 'utf8');
  assert.match(ran, new RegExp(`home=${sandboxHome}`)); assert.match(ran, /label=com\.cc-workspace\.n8n-morning-brief\.sandbox port=5790/);
  assert.ok(fs.existsSync(path.join(sandboxHome, 'n8n-morning-brief', 'install.sh')), 'copied to ~/n8n-morning-brief');
  assert.ok(fs.statSync(path.join(ROOT, '双击安装.command')).mode & 0o100, 'the file is executable, so double-clicking runs it');
});
