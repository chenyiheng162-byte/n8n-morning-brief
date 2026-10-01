// The run lock for the Node tools (inbox tool, console): the same operating-system file lock as scripts/lock.sh, which
// explains it. The guard here is `cat` reading our stdin: when this process ends in any way its end of the pipe closes,
// cat ends, and the system releases the lock.
// acquireLock(stateDir, tag) -> Promise<{ ok: true, release(): Promise } | { ok: false, holder }>
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const lockFile = (stateDir) => path.join(stateDir, 'run.lockf');

// Bridge to the OLD directory lock STATE/run.lock (up to version 8), for processes still running old code: see lock.sh.
const LEGACY_LIVE = /run-brief|deploy-workflow|inbox-tool|inbox\.sh|console\.mjs/;
const ageMin = (p) => { try { return (Date.now() - fs.statSync(p).mtimeMs) / 60000; } catch { return 0; } };
function legacyAlive(dir) {
  let pid = 0; try { pid = Number(fs.readFileSync(path.join(dir, 'owner'), 'utf8').split(/\s+/)[0]) || 0; } catch { /* no owner */ }
  if (!pid) return { pid: 0, alive: false };
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return { pid, alive: false }; }
  return { pid, alive: LEGACY_LIVE.test(spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout || '') };
}
function legacyTake(stateDir, tag) {
  const dir = path.join(stateDir, 'run.lock'); const tk = `${dir}.takeover`;
  const make = () => { try { fs.mkdirSync(dir); } catch (e) { if (e.code === 'EEXIST') return false; throw e; } fs.writeFileSync(path.join(dir, 'owner'), `${process.pid} ${Math.floor(Date.now() / 1000)} ${tag}\n`); return true; };
  if (make()) return { ok: true, dir };
  try { fs.mkdirSync(tk); } catch (e) {
    if (e.code !== 'EEXIST' || ageMin(tk) <= 2) return { ok: false, holder: 'old version (taking over)' };
    fs.rmSync(tk, { recursive: true, force: true }); try { fs.mkdirSync(tk); } catch { return { ok: false, holder: 'old version (taking over)' }; }
  }
  try {
    const o = legacyAlive(dir);
    if (o.alive) return { ok: false, holder: `${o.pid} old version` };
    if (!o.pid && ageMin(dir) < 60) return { ok: false, holder: 'old version (just starting)' };
    fs.rmSync(dir, { recursive: true, force: true });
    return make() ? { ok: true, dir } : { ok: false, holder: 'old version' };
  } finally { try { fs.rmdirSync(tk); } catch { /* gone */ } }
}
function legacyRelease(dir) { try { if (Number(fs.readFileSync(path.join(dir, 'owner'), 'utf8').split(/\s+/)[0]) === process.pid) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } }
const holderOf = (file) => { try { const [pid, , tag] = fs.readFileSync(file, 'utf8').trim().split(/\s+/); return `${pid || '?'} ${tag || ''}`.trim(); } catch { return 'unknown'; } };

export function acquireLock(stateDir, tag = '') {
  const file = lockFile(stateDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.closeSync(fs.openSync(file, 'a'));
  return new Promise((resolve) => {
    const guard = spawn('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, '/bin/sh', '-c', 'echo locked; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'ignore'] });
    let done = false; let locked = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    guard.stdout.on('data', (d) => {
      if (locked || !String(d).includes('locked')) return;
      locked = true;
      fs.writeFileSync(file, `${process.pid} ${Math.floor(Date.now() / 1000)} ${tag}\n`);
      // The guard must not keep this process alive: when it ends (normally or not) its end of the pipe closes, the guard
      // reads end-of-file and the system releases the lock.
      guard.unref(); guard.stdout.unref?.(); guard.stdin.unref?.();
      // releasing keeps the process alive until the guard has really gone (at most 3 s)
      const releaseGuard = () => new Promise((r) => { if (guard.exitCode !== null) return r(); guard.ref(); const t = setTimeout(r, 3000); guard.once('exit', () => { clearTimeout(t); r(); }); guard.stdin.end(); });
      let legacy;
      try { legacy = legacyTake(stateDir, tag); } catch { legacy = { ok: false, holder: 'error' }; }
      if (!legacy.ok) { releaseGuard().then(() => finish({ ok: false, holder: legacy.holder })); return; }
      const release = async () => { legacyRelease(legacy.dir); await releaseGuard(); };
      process.once('exit', () => legacyRelease(legacy.dir)); // also when the process ends without releasing
      finish({ ok: true, release });
    });
    // (once we had the lock, the guard ending is our own release -- the outcome was decided above)
    guard.on('exit', (code) => { if (!locked) finish({ ok: false, holder: code === 75 ? holderOf(file) : 'error' }); });
    guard.on('error', () => finish({ ok: false, holder: 'error' }));
  });
}

// Is the lock held right now (by anyone)? For status screens only.
export function lockBusy(stateDir) {
  const file = lockFile(stateDir);
  if (fs.existsSync(file) && spawnSync('/usr/bin/lockf', ['-k', '-s', '-t', '0', file, '/usr/bin/true']).status === 75) return true;
  return legacyAlive(path.join(stateDir, 'run.lock')).alive; // or an old-version process holds the old lock
}
export const lockHolder = (stateDir) => holderOf(lockFile(stateDir));
