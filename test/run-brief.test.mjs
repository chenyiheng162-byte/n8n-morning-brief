// Drives the real run-brief.sh against stub `n8n`, `curl` and `brief.mjs` programs (no network, no real n8n).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, tmpdir, holdLock, lockHeld } from './helpers.mjs';

const CURL = `#!/bin/bash
D="\${STUB_DIR:?}"; args="$*"
count() { n=$(( $(cat "$D/$1" 2>/dev/null || echo 0) + 1 )); echo $n > "$D/$1"; echo $n; }
if [[ "$args" == *"/healthz/readiness"* ]]; then
  # a freshly started stub n8n needs a moment before it has written its pid and environment; like the real one, answer only
  # then (and do not count those early calls, so the count below does not depend on how busy the machine is)
  if [ "\${STUB_PORT_BUSY:-}" != 1 ] && [ ! -s "$D/n8n.pid" ]; then printf '503'; exit 0; fi
  n=$(count ready)
  if [ "$SCENARIO" = notready ] && [ $n -lt 4 ]; then printf '503'; else printf '200'; fi
  exit 0
fi
if [[ "$args" == *"/healthz"* ]]; then [ "\${STUB_PORT_BUSY:-}" = 1 ] && exit 0; exit 7; fi
if [[ "$args" == *"/webhook/"* ]]; then
  hdr=$(cat); [ -n "$hdr" ] && echo "$hdr" >> "$D/headers"
  if [[ "$args" != *"/webhook/morning-brief-abc123"* ]]; then count wrongpath > /dev/null; printf '{"message":"not registered"}\\n404'; exit 0; fi
  n=$(count posts)
  echo "readycalls=$(cat "$D/ready" 2>/dev/null || echo 0)" >> "$D/at-post"
  prev=""; for a in "$@"; do [ "$prev" = "--data" ] && echo "$a" >> "$D/payloads"; prev="$a"; done
  good='{"status":"sent","events":3,"tasks":2,"newTasks":1,"aiCalls":1,"calendarMs":1200,"ingestMs":3400,"build":"abc123"}'
  case "$SCENARIO" in
    ok)       if [ $n -lt 3 ]; then printf '{"message":"not registered"}\\n404'; else printf '%s\\n200' "$good"; fi ;;
    notready) printf '%s\\n200' "$good" ;;
    refused)  if [ $n -lt 3 ]; then exit 7; else printf '%s\\n200' "$good"; fi ;;
    timeout)  exit 28 ;;
    hang)     sleep 30; exit 28 ;;
    never)    printf '{"message":"nope"}\\n404' ;;
    mismatch) printf '{"status":"sent","build":"old000"}\\n200' ;;
    late500)  run=$(printf '%s' "$args" | sed -n 's/.*"run":"\\([^"]*\\)".*/\\1/p'); touch "$BRIEF_HOME/data/state/attempt-$run"; printf '{"message":"Error in workflow"}\\n500' ;;
    notsent)  printf '{"status":"not_sent","reason":"Discord: 404 Unknown Webhook"}\\n200' ;;
    unknownv) printf '{"status":"unknown","reason":"Discord: 503 no answer"}\\n200' ;;
    reset)    printf '\\n000 512'; exit 56 ;;
    ctimeout) printf '\\n000 0'; exit 28 ;;
    error500) printf '{"message":"x"}\\n500' ;;
    garbage)  printf '{"hello":"world"}\\n200' ;;
  esac
  exit 0
fi
if [[ "$args" == *"-K -"* ]]; then cat > /dev/null; echo x >> "$D/alerts"; prev=""; for a in "$@"; do [ "$prev" = "--data" ] && echo "$a" >> "$D/alert-bodies"; prev="$a"; done; printf '204'; exit 0; fi   # an alert: the URL comes from stdin
exit 0
`;
const N8N = `#!/bin/bash
trap 'exit 0' TERM; env | grep -E '^BRIEF_TEST=' >> "$STUB_DIR/n8n.env"; echo $$ > "$STUB_DIR/n8n.pid"; while true; do sleep 0.2; done
`;
const DIRECT = `import fs from 'node:fs';
const d = process.env.STUB_DIR; fs.appendFileSync(d + '/direct.calls', process.argv.slice(2).join(' ') + '|note=' + (process.env.BRIEF_NOTE || '') + '\\n');
if (process.argv.includes('--dry-run')) { console.log('DRY-RUN PREVIEW TEXT'); process.exit(0); }
if (process.env.STUB_DIRECT === 'fail') { console.error('direct engine failed'); process.exit(1); }
if (process.env.STUB_DIRECT === 'killed') { const run = (process.argv.find((a) => a.startsWith('--run=')) || '').slice(6); fs.writeFileSync(process.env.BRIEF_HOME + '/data/state/attempt-' + run, 'x'); process.kill(process.pid, 'SIGKILL'); }
if (process.env.STUB_DIRECT === 'notsent') { console.error('brief.mjs failed: ' + (process.env.STUB_REASON || 'Discord: 404 Unknown Webhook')); process.exit(4); }
fs.appendFileSync(d + '/direct.state', (process.env.BRIEF_STATE_DIR || '') + '\\n');
if (process.env.STUB_DIRECT === 'unknown') { console.error('the request to Discord may have been delivered'); process.exit(3); }
console.log(JSON.stringify({ status: 'sent', engine: 'direct', events: 1, tasks: 0, newTasks: 0, aiCalls: 0 }));
`;

let last = null;
function sandbox({ build = 'abc123', config = '' } = {}) {
  const home = tmpdir('rb-home-'); const stub = tmpdir('rb-stub-'); const inbox = tmpdir('rb-inbox-');
  for (const d of ['scripts', 'workflows', '.runtime/node/bin', 'node_modules/.bin', 'data/.n8n']) fs.mkdirSync(path.join(home, d), { recursive: true });
  for (const f of ['run-brief.sh', 'env.sh', 'lock.sh', 'extract-inbox.mjs']) fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(home, 'scripts', f));
  fs.writeFileSync(path.join(home, 'scripts', 'brief.mjs'), DIRECT);
  fs.symlinkSync(process.execPath, path.join(home, '.runtime', 'node', 'bin', 'node'));
  fs.writeFileSync(path.join(home, 'package.json'), '{}');
  fs.writeFileSync(path.join(home, 'node_modules', '.bin', 'curl'), CURL, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'node_modules', '.bin', 'n8n'), N8N, { mode: 0o755 });
  fs.writeFileSync(path.join(home, 'workflows', 'BUILD'), `${build}\n`);
  fs.writeFileSync(path.join(home, 'config.local.env'), `DISCORD_WEBHOOK_URL='http://127.0.0.1:9/hook'\n${config}`);
  return (last = { home, stub, inbox, state: path.join(home, 'data', 'state') });
}
const today = () => new Date().toLocaleDateString('sv');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
function run(sb, scenario, extra = {}, args = []) {
  const t0 = Date.now();
  const r = spawnSync('bash', [path.join(sb.home, 'scripts', 'run-brief.sh'), ...args], { encoding: 'utf8', timeout: 90000,
    env: { PATH: process.env.PATH, HOME: tmpdir('rb-fakehome-'), BRIEF_HOME: sb.home, STUB_DIR: sb.stub, SCENARIO: scenario, BRIEF_INBOX: sb.inbox, N8N_PORT: '5799',
      BRIEF_NO_NOTIFY: '1', BRIEF_GRACE: '0', BRIEF_POLL: '0.2', BRIEF_READY_TIMEOUT: '3', BRIEF_EXEC_TIMEOUT: '5', BRIEF_FALLBACK: 'none', ...extra } });
  const n8nPid = Number(read(path.join(sb.stub, 'n8n.pid')).trim()) || 0;
  let alive = false; if (n8nPid) { try { process.kill(n8nPid, 0); alive = true; } catch { alive = false; } }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, secs: (Date.now() - t0) / 1000, log: read(path.join(sb.home, 'logs', `run-${today()}.log`)), posts: Number(read(path.join(sb.stub, 'posts')).trim() || 0),
    alerts: read(path.join(sb.stub, 'alerts')).split('\n').filter(Boolean).length, payloads: read(path.join(sb.stub, 'payloads')).split('\n').filter(Boolean), headers: read(path.join(sb.stub, 'headers')),
    marker: fs.existsSync(path.join(sb.state, `sent-${today()}`)), pending: fs.existsSync(path.join(sb.state, `pending-${today()}`)), n8nAlive: alive, n8nStarted: n8nPid > 0,
    lockLeft: lockHeld(sb.state), directCalls: read(path.join(sb.stub, 'direct.calls')), lastRun: (() => { try { return JSON.parse(read(path.join(sb.state, 'last-run.json'))); } catch { return null; } })() };
}

// ================= the scheduled run =================
test('normal run: waits for the webhook, sends once it is ready, marks the day and stops n8n', () => {
  const r = run(sandbox(), 'ok');
  assert.equal(r.status, 0, r.log); assert.equal(r.posts, 3); assert.ok(r.marker); assert.ok(!r.pending); assert.match(r.log, /OK: brief sent/); assert.equal(r.n8nAlive, false); assert.equal(r.lockLeft, false);
});

test('connection refused while n8n starts is retried like a 404', () => {
  const r = run(sandbox(), 'refused'); assert.equal(r.status, 0, r.log); assert.equal(r.posts, 3); assert.ok(r.marker);
});

test('the request goes to a webhook path that carries the deployed build hash and only after readiness (review)', () => {
  const sb = sandbox(); const r = run(sb, 'notready');
  assert.equal(r.status, 0, r.log); assert.equal(r.posts, 1); assert.match(read(path.join(sb.stub, 'at-post')), /readycalls=4/);
  assert.equal(fs.existsSync(path.join(sb.stub, 'wrongpath')), false, 'the unversioned path must never be used');
});

test('an execution timeout is reported as unknown, sent exactly once, never retried and never guessed (review)', () => {
  const r = run(sandbox(), 'timeout', { BRIEF_READY_TIMEOUT: '30' });
  assert.equal(r.status, 1); assert.equal(r.posts, 1, 'the workflow must not be triggered a second time');
  assert.match(r.log, /没有返回/); assert.match(r.log, /delivery state unknown/); assert.ok(!r.marker); assert.ok(r.pending, 'the unknown state is recorded'); assert.equal(r.n8nAlive, false); assert.equal(r.alerts, 1);
  assert.equal(r.lastRun.result, 'unknown');
});

test('after an unknown outcome the next scheduled slot does NOT send again by itself, but says so once (review: pending state)', () => {
  const sb = sandbox(); run(sb, 'timeout', {});
  const again = run(sb, 'ok');
  assert.equal(again.status, 0); assert.equal(again.posts, 1, 'no second delivery'); assert.match(again.log, /SKIP: a delivery attempt started earlier today/);
  const third = run(sb, 'ok'); assert.equal(third.alerts, again.alerts, 'the notice is sent only once');
  const manual = run(sb, 'ok', {}, ['--force']); assert.equal(manual.status, 0, manual.log); assert.equal(manual.posts, 3, 'the user can still resend by hand (the stub answers 404 twice before it accepts)');
});

test('a webhook that never registers means n8n cannot take the request; nothing was accepted, so no pending state remains', () => {
  const r = run(sandbox({ build: 'abc123' }), 'never');
  assert.equal(r.status, 1); assert.match(r.log, /Webhook 仍未注册/); assert.match(r.log, /abc123/); assert.match(r.log, /deploy-workflow\.sh/); assert.ok(!r.marker); assert.ok(!r.pending); assert.equal(r.n8nAlive, false); assert.ok(r.secs < 30);
});

test('if the brief was delivered but the reported build differs, it is marked sent FIRST and never retried', () => {
  const sb = sandbox(); const r = run(sb, 'mismatch');
  assert.equal(r.status, 0, r.log); assert.ok(r.marker, 'delivered => marked'); assert.equal(r.alerts, 1);
  const again = run(sb, 'mismatch'); assert.equal(again.posts, 1); assert.match(again.log, /already sent today/);
});

test('HTTP errors and unexpected bodies are failures that leave the day open', () => {
  for (const [scenario, pattern] of [['error500', /HTTP 500/], ['garbage', /异常内容/]]) { const r = run(sandbox(), scenario); assert.equal(r.status, 1); assert.match(r.log, pattern); assert.ok(!r.marker); assert.ok(!r.pending); }
});

test('the day is only sent once: a second scheduled run is a no-op', () => {
  const sb = sandbox(); run(sb, 'ok'); const second = run(sb, 'ok');
  assert.equal(second.status, 0); assert.match(second.log, /already sent today/); assert.equal(second.posts, 3, 'no additional trigger');
});

test('a failed early run leaves the day open, so a later scheduled slot can retry it', () => {
  const sb = sandbox(); assert.equal(run(sb, 'error500').status, 1);
  const retry = run(sb, 'ok'); assert.equal(retry.status, 0, retry.log); assert.ok(retry.marker);
});

test('at most two Discord alerts per day', () => {
  const sb = sandbox(); for (let i = 0; i < 4; i++) run(sb, 'error500');
  assert.equal(read(path.join(sb.stub, 'alerts')).split('\n').filter(Boolean).length, 2);
});

// ================= manual runs must never cancel the real morning brief (review N1 / O2) =================
test('--force and --test send now, write no markers, and are not blocked by them', () => {
  const sb = sandbox();
  const forced = run(sb, 'ok', {}, ['--force']); assert.equal(forced.status, 0, forced.log); assert.ok(!forced.marker); assert.ok(!forced.pending);
  const tested = run(sb, 'ok', {}, ['--test']); assert.equal(tested.status, 0, tested.log); assert.ok(!tested.marker);
  assert.match(read(path.join(sb.stub, 'n8n.env')), /BRIEF_TEST=1/, '--test labels the brief');
  const real = run(sb, 'ok'); assert.equal(real.status, 0, real.log); assert.ok(real.marker, 'the real scheduled run after manual checks still sends and marks');
  assert.equal(real.posts, 5, 'each of the three runs sent: nothing was skipped');
  fs.writeFileSync(path.join(sb.state, `sent-${today()}`), '');
  const afterMarker = run(sb, 'ok', {}, ['--force']); assert.equal(afterMarker.status, 0, 'a marker never blocks a manual run');
});

test('the 00:06 incident: a manual run after midnight does not cancel the morning brief', () => {
  const sb = sandbox(); run(sb, 'ok', {}, ['--force']);
  const scheduled = run(sb, 'ok'); assert.match(scheduled.log, /OK: brief sent/); assert.doesNotMatch(scheduled.log, /already sent today/);
});

test('--dry-run only builds and prints the brief: no n8n, no lock, no markers, no state, no alerts', () => {
  const sb = sandbox(); const r = run(sb, 'ok', {}, ['--dry-run']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /DRY-RUN PREVIEW TEXT/); assert.match(r.directCalls, /--dry-run/);
  assert.equal(r.n8nStarted, false); assert.equal(r.posts, 0); assert.ok(!r.marker); assert.ok(!r.pending); assert.equal(r.alerts, 0); assert.equal(r.lastRun, null);
});

test('an unknown option is rejected instead of being treated as a normal run', () => {
  const r = run(sandbox(), 'ok', {}, ['--frobnicate']); assert.equal(r.status, 2); assert.equal(r.posts, 0);
});

// ================= state safety (review: marker write failure, unwritable state) =================
test('if today\'s marker cannot be written AFTER a delivery, the failure is reported loudly instead of "OK" silence (review)', () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  fs.symlinkSync('/nonexistent-dir-for-test/x', path.join(sb.state, `sent-${today()}`)); // touch on this fails
  const r = run(sb, 'ok');
  assert.equal(r.status, 0); assert.equal(r.posts, 3); assert.match(r.log, /ERROR: the brief was delivered but the sent marker could not be written/); assert.ok(r.alerts >= 1);
  assert.ok(r.pending, 'the pending record stays: it is what stops the later slots (review R4-03)');
  const again = run(sb, 'ok'); assert.equal(again.posts, 3, 'the next slot must not send a second copy'); assert.match(again.log, /SKIP: a delivery attempt started earlier today/);
});

test('a state folder that cannot be written prevents the scheduled send altogether (nothing could stop a duplicate)', () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  const probe = path.join(sb.state, 'p'); try { fs.writeFileSync(probe, ''); fs.rmSync(probe); } catch { /* fine */ }
  fs.chmodSync(sb.state, 0o555);
  try {
    const r = run(sb, 'ok');
    if (r.status === 0 && r.posts > 0) return; // running as root ignores permissions: nothing to assert
    assert.equal(r.posts, 0); assert.notEqual(r.status, 0); assert.match(r.log, /无法创建运行锁|无法取得运行锁|状态目录不可写/);
  } finally { fs.chmodSync(sb.state, 0o755); }
});

// ================= locks and crashes (review M2) =================
test('an n8n left behind by a crashed run is stopped by the next run (the lock itself is never left behind)', async () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  const orphan = spawn('bash', ['-c', 'exec -a n8n-orphan sleep 60'], { stdio: 'ignore', detached: true }); orphan.unref();
  fs.writeFileSync(path.join(sb.state, 'n8n.pid'), `${orphan.pid} ${Math.floor(Date.now() / 1000)}`);
  const r = run(sb, 'ok');
  assert.equal(r.status, 0, r.log); assert.match(r.log, /left over from a crashed run/); assert.ok(r.marker);
  await new Promise((res) => setTimeout(res, 300));
  let alive = true; try { process.kill(orphan.pid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'the orphan n8n must be gone');
});

test('while another process holds the lock the run does not start, and when that process ends the lock is free at once (review R8-01)', async () => {
  const sb = sandbox(); const holder = await holdLock(sb.state, 'deploy-workflow');
  try { const r = run(sb, 'ok'); assert.equal(r.status, 0); assert.match(r.log, /held by another process of this project \(\d+ deploy-workflow/); assert.equal(r.posts, 0); assert.equal(r.n8nStarted, false); }
  finally { await holder.release(); }
  const after = run(sb, 'ok'); assert.equal(after.status, 0, after.log); assert.ok(after.marker, 'nothing to clean up, nothing to take over');
});

test('a run killed with SIGKILL leaves no lock behind: the next run starts straight away (review R8-01)', async () => {
  const sb = sandbox();
  const child = spawn('bash', [path.join(sb.home, 'scripts', 'run-brief.sh')], { env: { PATH: process.env.PATH, HOME: tmpdir('fh-'), BRIEF_HOME: sb.home, STUB_DIR: sb.stub, SCENARIO: 'hang', BRIEF_INBOX: sb.inbox, N8N_PORT: '5799', BRIEF_NO_NOTIFY: '1', BRIEF_POLL: '0.2', BRIEF_READY_TIMEOUT: '5', BRIEF_EXEC_TIMEOUT: '60', BRIEF_FALLBACK: 'none' }, stdio: 'ignore' });
  for (let i = 0; i < 60 && !fs.existsSync(path.join(sb.stub, 'posts')); i++) await new Promise((r) => setTimeout(r, 200));
  assert.ok(lockHeld(sb.state), 'held while running');
  child.kill('SIGKILL'); await new Promise((r) => child.on('exit', r));
  for (let i = 0; i < 60 && lockHeld(sb.state); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(lockHeld(sb.state), false, 'released by the system within seconds');
  const n8nPid = Number(read(path.join(sb.stub, 'n8n.pid')).trim()); try { process.kill(n8nPid); } catch { /* gone */ }
});

test('SIGTERM during a run: n8n is stopped, the lock is released, and an in-flight delivery is recorded as unknown', async () => {
  const sb = sandbox();
  const child = spawn('bash', [path.join(sb.home, 'scripts', 'run-brief.sh')], { env: { PATH: process.env.PATH, HOME: tmpdir('fh-'), BRIEF_HOME: sb.home, STUB_DIR: sb.stub, SCENARIO: 'hang', BRIEF_INBOX: sb.inbox, N8N_PORT: '5799', BRIEF_NO_NOTIFY: '1', BRIEF_GRACE: '0', BRIEF_POLL: '0.2', BRIEF_READY_TIMEOUT: '5', BRIEF_EXEC_TIMEOUT: '60', BRIEF_FALLBACK: 'none' }, stdio: 'ignore' });
  for (let i = 0; i < 60 && !fs.existsSync(path.join(sb.stub, 'posts')); i++) await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => setTimeout(r, 300)); const killedAt = Date.now(); child.kill('SIGTERM');
  await new Promise((r) => child.on('exit', r));
  const reacted = (Date.now() - killedAt) / 1000;
  assert.ok(reacted < 8, `the run must react to a stop signal within seconds even while waiting for a 60 s request (took ${reacted}s)`);
  await new Promise((r) => setTimeout(r, 1500));
  const n8nPid = Number(read(path.join(sb.stub, 'n8n.pid')).trim()); let alive = true; try { process.kill(n8nPid, 0); } catch { alive = false; }
  assert.equal(alive, false, 'n8n stopped'); assert.equal(lockHeld(sb.state), false, 'lock released');
  assert.ok(fs.existsSync(path.join(sb.state, `pending-${today()}`)), 'the interrupted delivery is recorded as unknown, not forgotten');
  assert.match(read(path.join(sb.home, 'logs', `run-${today()}.log`)), /interrupted by a signal/);
});

// ================= fallback engine and a foreign n8n (review: reuse, port, resilience) =================
test('when n8n cannot take the request, the direct engine delivers the brief and says so (nothing was accepted, so no duplicate is possible)', () => {
  const sb = sandbox(); const r = run(sb, 'never', { BRIEF_FALLBACK: 'direct' });
  assert.equal(r.status, 0, r.log); assert.match(r.log, /falling back to the direct engine/); assert.ok(r.marker); assert.ok(!r.pending);
  assert.match(r.directCalls, /note=n8n 没能工作/); assert.ok(r.alerts >= 1); assert.equal(r.lastRun.engine, 'direct');
});

test('fallback also covers "n8n exited during start" and a missing BUILD file', () => {
  const sb = sandbox(); fs.rmSync(path.join(sb.home, 'workflows', 'BUILD'));
  const r = run(sb, 'ok', { BRIEF_FALLBACK: 'direct' }); assert.equal(r.status, 0, r.log); assert.match(r.log, /BUILD/); assert.ok(r.marker); assert.equal(r.posts, 0);
});

test('a failing fallback leaves the day open and fails loudly', () => {
  const r = run(sandbox(), 'never', { BRIEF_FALLBACK: 'direct', STUB_DIRECT: 'fail' });
  assert.equal(r.status, 1); assert.match(r.log, /直连模式也失败了/); assert.ok(!r.marker); assert.ok(!r.pending);
});

test('after a TIMEOUT the direct engine is NOT used: the request may have been delivered (review: duplicates)', () => {
  const r = run(sandbox(), 'timeout', { BRIEF_FALLBACK: 'direct' }); assert.equal(r.status, 1); assert.equal(r.directCalls, '');
});

test('a port that is already answered by another program is refused, not talked to (review M5)', () => {
  const r = run(sandbox(), 'ok', { STUB_PORT_BUSY: '1' }); assert.equal(r.status, 1); assert.match(r.log, /已经被另一个程序/); assert.equal(r.posts, 0); assert.equal(r.n8nStarted, false);
  const withFallback = run(sandbox(), 'ok', { STUB_PORT_BUSY: '1', BRIEF_FALLBACK: 'direct' }); assert.equal(withFallback.status, 0, withFallback.log); assert.match(withFallback.directCalls, /note=/);
});

test('an n8n that is reused on purpose must also be ready before the single request (review finding 5)', () => {
  const sb = sandbox(); const r = run(sb, 'notready', { STUB_PORT_BUSY: '1', BRIEF_REUSE_N8N: '1' });
  assert.equal(r.status, 0, r.log); assert.match(read(path.join(sb.stub, 'at-post')), /readycalls=4/); assert.equal(r.n8nStarted, false, 'not ours, not stopped by us');
});

test('the webhook token from the settings is sent as a header, and never on the command line', () => {
  const sb = sandbox({ config: "BRIEF_TOKEN='s3cr3t-token-value'\n" }); const r = run(sb, 'ok');
  assert.match(r.headers, /x-brief-token: s3cr3t-token-value/);
});

// ================= bookkeeping =================
test('the latest run is summarised in last-run.json (for status.sh)', () => {
  const r = run(sandbox(), 'ok');
  assert.equal(r.lastRun.result, 'ok'); assert.equal(r.lastRun.mode, 'normal'); assert.equal(r.lastRun.engine, 'n8n'); assert.equal(r.lastRun.events, 3); assert.equal(r.lastRun.aiCalls, 1); assert.equal(r.lastRun.calendarMs, 1200); assert.ok(r.lastRun.seconds >= 0);
});

test('missed days are reported once, not on every following brief', () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('sv'); };
  fs.writeFileSync(path.join(sb.state, 'installed-at'), `${daysAgo(3)}\n`); fs.writeFileSync(path.join(sb.state, `sent-${daysAgo(1)}`), '');
  const first = run(sb, 'ok'); fs.rmSync(path.join(sb.state, `sent-${today()}`)); const second = run(sb, 'ok');
  assert.match(first.payloads[0], new RegExp(daysAgo(3))); assert.match(first.payloads[0], new RegExp(daysAgo(2))); assert.doesNotMatch(first.payloads[0], new RegExp(daysAgo(1)));
  assert.deepEqual(JSON.parse(second.payloads[second.payloads.length - 1]).missed, []);
});

test('old n8n executions (including leftovers stuck in "running") are pruned, recent failed ones kept, dependent rows cascade (review M1)', () => {
  const sb = sandbox(); const db = path.join(sb.home, 'data', '.n8n', 'database.sqlite');
  const sql = `PRAGMA foreign_keys=ON; create table execution_entity(id integer primary key, startedAt text, status text); create table execution_data(executionId integer references execution_entity(id) on delete cascade, data text);
    insert into execution_entity values (1, datetime('now','-10 days'), 'error'), (2, datetime('now','-1 hour'), 'error'), (3, datetime('now','-5 hours'), 'running'), (4, datetime('now','-2 days'), 'error');
    insert into execution_data values (1,'old schedule text'),(2,'recent'),(3,'stuck'),(4,'two days old');`;
  assert.equal(spawnSync('sqlite3', [db, sql]).status, 0);
  const r = run(sb, 'ok'); assert.equal(r.status, 0, r.log);
  const ids = spawnSync('sqlite3', [db, 'select group_concat(id) from execution_entity;'], { encoding: 'utf8' }).stdout.trim();
  const data = spawnSync('sqlite3', [db, 'select group_concat(executionId) from execution_data;'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(ids, '2,4'); assert.equal(data, '2,4');
});

test('the runtime folder and database are made private (review M1: permissions)', () => {
  const sb = sandbox(); fs.chmodSync(sb.home, 0o755); fs.writeFileSync(path.join(sb.home, 'data', '.n8n', 'database.sqlite'), ''); fs.chmodSync(path.join(sb.home, 'data', '.n8n', 'database.sqlite'), 0o644);
  run(sb, 'ok');
  assert.equal((fs.statSync(sb.home).mode & 0o777).toString(8), '700'); assert.equal((fs.statSync(path.join(sb.home, 'data', '.n8n', 'database.sqlite')).mode & 0o777).toString(8), '600'); assert.equal((fs.statSync(path.join(sb.home, 'config.local.env')).mode & 0o777).toString(8), '600');
});

test('logs older than 30 days and a huge n8n log are cleaned up after a successful run', () => {
  const sb = sandbox(); fs.mkdirSync(path.join(sb.home, 'logs'), { recursive: true });
  const oldLog = path.join(sb.home, 'logs', 'run-2020-01-01.log'); fs.writeFileSync(oldLog, 'x'); const past = new Date(Date.now() - 40 * 86400000); fs.utimesSync(oldLog, past, past);
  fs.writeFileSync(path.join(sb.home, 'logs', 'n8n-run.log'), 'y'.repeat(6 * 1024 * 1024));
  run(sb, 'ok'); assert.equal(fs.existsSync(oldLog), false); assert.ok(fs.statSync(path.join(sb.home, 'logs', 'n8n-run.log')).size <= 1048576 + 200);
});

test('the direct engine tidies old logs and day markers too (it ends the script before the n8n part does)', () => {
  const sb = sandbox(); fs.mkdirSync(path.join(sb.home, 'logs'), { recursive: true }); fs.mkdirSync(sb.state, { recursive: true });
  const past = new Date(Date.now() - 40 * 86400000);
  const oldLog = path.join(sb.home, 'logs', 'run-2020-01-01.log'); const oldMarker = path.join(sb.state, 'sent-2020-01-01');
  for (const f of [oldLog, oldMarker]) { fs.writeFileSync(f, 'x'); fs.utimesSync(f, past, past); }
  const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct' }); assert.equal(r.status, 0, r.log); assert.ok(r.marker);
  assert.equal(fs.existsSync(oldLog), false); assert.equal(fs.existsSync(oldMarker), false);
});

test('a Discord alert is valid JSON whatever its reason contains, and can never ping anyone', () => {
  const sb = sandbox(); const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', STUB_DIRECT: 'notsent', STUB_REASON: 'Discord: 400 "bad"\tfield @everyone \\ end' });
  assert.equal(r.status, 1, r.log); assert.equal(r.alerts, 1);
  const body = JSON.parse(read(path.join(sb.stub, 'alert-bodies')).trim().split('\n')[0]);
  assert.deepEqual(body.allowed_mentions, { parse: [] }); assert.match(body.content, /"bad" field @everyone \\ end/);
});

test('settings lines that are not understood are logged, and the run still uses the good ones (review M3)', () => {
  const sb = sandbox({ config: "this is not a setting\nPATH='/evil'\n" }); const r = run(sb, 'ok');
  assert.equal(r.status, 0, r.log); assert.match(r.log, /WARN: config\.local\.env: line\(s\) .* were not understood/);
});

// ================= round 4: one delivery state machine for every engine and every failure =================
test('a connection that breaks AFTER the request went out is an unknown outcome: pending stays and the next slot does not resend (review R4-03)', () => {
  const sb = sandbox(); const r = run(sb, 'reset');
  assert.equal(r.status, 1); assert.equal(r.posts, 1); assert.ok(r.pending); assert.ok(!r.marker); assert.equal(r.alerts, 1); assert.equal(r.lastRun.result, 'unknown'); assert.equal(r.n8nAlive, false);
  const next = run(sb, 'ok'); assert.equal(next.status, 0); assert.equal(next.posts, 1, 'no second delivery'); assert.match(next.log, /SKIP: a delivery attempt started earlier today/);
});
test('a timeout before a single byte was sent is NOT an unknown outcome: it is repeated like a connection refusal (review N4)', () => {
  const r = run(sandbox(), 'ctimeout', { BRIEF_READY_TIMEOUT: '2' });
  assert.equal(r.status, 1); assert.ok(r.posts >= 2, 'tried again'); assert.ok(!r.pending, 'nothing had been sent'); assert.match(r.log, /Webhook 仍未注册/);
});
test('direct engine, unknown outcome (exit 3): pending stays, one alert, no resend by the next slot (review R4-03)', () => {
  const sb = sandbox(); const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', STUB_DIRECT: 'unknown' });
  assert.equal(r.status, 1); assert.ok(r.pending); assert.ok(!r.marker); assert.equal(r.alerts, 1); assert.equal(r.lastRun.result, 'unknown'); assert.equal(r.directCalls.split('\n').filter(Boolean).length, 1);
  const next = run(sb, 'ok', { BRIEF_ENGINE: 'direct' }); assert.equal(next.status, 0); assert.equal(next.directCalls.split('\n').filter(Boolean).length, 1, 'the engine was not started again'); assert.match(next.log, /SKIP/);
});
test('direct engine, plain failure (exit 1): nothing may have been sent, so pending is removed and the next slot can try', () => {
  const sb = sandbox(); const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', STUB_DIRECT: 'fail' });
  assert.equal(r.status, 1); assert.ok(!r.pending); const next = run(sb, 'ok', { BRIEF_ENGINE: 'direct' }); assert.equal(next.status, 0, next.log); assert.ok(next.marker);
});
test('fallback to the direct engine keeps the same rule: an unknown outcome there keeps pending', () => {
  const sb = sandbox(); const r = run(sb, 'never', { BRIEF_FALLBACK: 'direct', STUB_DIRECT: 'unknown', BRIEF_READY_TIMEOUT: '1' });
  assert.equal(r.status, 1); assert.ok(r.pending); assert.equal(r.lastRun.result, 'unknown');
});
test('a failed pending write stops the send instead of sending without protection (review R4-03)', () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  fs.symlinkSync('/nonexistent-dir-for-test/x', path.join(sb.state, `pending-${today()}`)); // writing to it fails, reading it finds nothing
  const r = run(sb, 'ok'); assert.equal(r.status, 1); assert.equal(r.posts, 0, 'no request was made'); assert.match(r.log, /无法写入「发送中」记录/);
});

// ================= the record of the last run (review R4-09) =================
test('an expected skip is recorded as "skipped", so the health screen does not report a failure every morning (review R4-09)', () => {
  const sb = sandbox(); assert.equal(run(sb, 'ok').lastRun.result, 'ok');
  const second = run(sb, 'ok'); assert.equal(second.status, 0); assert.equal(second.lastRun.result, 'skipped'); assert.match(second.lastRun.reason, /already sent/);
});
test('a process that did not get the lock leaves the record of the one that holds it untouched (review R4-09)', async () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true }); fs.writeFileSync(path.join(sb.state, 'last-run.json'), '{"result":"ok","mode":"normal"}\n');
  const holder = await holdLock(sb.state);
  try { const r = run(sb, 'ok'); assert.equal(r.status, 0); assert.equal(read(path.join(sb.state, 'last-run.json')), '{"result":"ok","mode":"normal"}\n'); assert.ok(lockHeld(sb.state), 'and the holder keeps its lock'); } finally { await holder.release(); }
});

// ================= shared lock (review R4-02, R8-01) =================
for (const tag of ['deploy-workflow', 'inbox-tool', 'console']) {
  test(`a ${tag} holding the lock is respected: the scheduled run does not start`, async () => {
    const sb = sandbox(); const holder = await holdLock(sb.state, tag);
    try { const r = run(sb, 'ok'); assert.equal(r.posts, 0); assert.match(r.log, new RegExp(`held by another process of this project \\(\\d+ ${tag}`)); assert.ok(lockHeld(sb.state)); } finally { await holder.release(); }
  });
}
test('a pid number that now belongs to some other program is not mistaken for our n8n and is not killed (review: orphan check)', async () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  const stranger = spawn('bash', ['-c', 'exec -a n8n-lookalike sleep 30'], { stdio: 'ignore', detached: true }); stranger.unref();
  fs.writeFileSync(path.join(sb.state, 'n8n.pid'), `${stranger.pid} 1`); // recorded long before this process started
  try { const r = run(sb, 'ok'); assert.equal(r.status, 0, r.log); assert.match(r.log, /leaving it alone/); await new Promise((res) => setTimeout(res, 200)); process.kill(stranger.pid, 0); } finally { try { process.kill(stranger.pid); } catch { /* gone */ } }
});

// ================= reused n8n: its database is not ours (review) =================
test('with a reused n8n the database is not pruned, and --test still labels the brief through the request itself', () => {
  const sb = sandbox(); const db = path.join(sb.home, 'data', '.n8n', 'database.sqlite');
  spawnSync('sqlite3', [db, "create table execution_entity(id integer, startedAt text, status text); insert into execution_entity values(1,'2000-01-01 00:00:00','error');"]);
  const r = run(sb, 'ok', { STUB_PORT_BUSY: '1', BRIEF_REUSE_N8N: '1' }, ['--test']);
  assert.equal(r.status, 0, r.log); assert.match(r.log, /database is left alone/);
  assert.equal(spawnSync('sqlite3', [db, 'select count(*) from execution_entity;'], { encoding: 'utf8' }).stdout.trim(), '1', 'the old row is still there');
  assert.ok(r.payloads.some((p) => /"test":true/.test(p)), 'the request says it is a test');
  const plain = run(sandbox(), 'ok'); assert.ok(!plain.payloads.some((p) => /"test"/.test(p)), 'a normal run does not');
});
test('a workflow error (HTTP 500, also what a wrong token gives) names both possible causes and points to the log (review N2)', () => {
  const r = run(sandbox(), 'error500'); assert.match(r.log, /HTTP 500/); assert.match(r.log, /令牌/); assert.match(r.log, /n8n-run\.log/);
});

test('after a run, the stub rows of successful executions are removed at once (they hold the request headers), failed ones are kept for a few days (review N3)', () => {
  const sb = sandbox(); const db = path.join(sb.home, 'data', '.n8n', 'database.sqlite');
  spawnSync('sqlite3', [db, "create table execution_entity(id integer, startedAt text, status text); insert into execution_entity values(1,datetime('now'),'success'),(2,datetime('now'),'error'),(3,'2000-01-01 00:00:00','error'),(4,datetime('now'),'running'),(5,datetime('now'),'new');"]);
  const r = run(sb, 'ok'); assert.equal(r.status, 0, r.log);
  assert.equal(spawnSync('sqlite3', [db, "select group_concat(id) from execution_entity;"], { encoding: 'utf8' }).stdout.trim(), '2', 'n8n leaves a successful run as "running" when it saves nothing: those go too (review final F1/S1)');
});


// ================= final review: every way a run can end is classified (R5-01, R5-02) =================
test('a workflow that fails AFTER its send step recorded the attempt (HTTP 500) is UNKNOWN: pending stays, the next slot does not resend (review R5-01)', () => {
  const sb = sandbox(); const r = run(sb, 'late500');
  assert.equal(r.status, 1); assert.ok(r.pending); assert.ok(!r.marker); assert.equal(r.lastRun.result, 'unknown'); assert.match(r.log, /发送步骤开始之后出错/);
  const next = run(sb, 'ok'); assert.equal(next.posts, r.posts, 'no second request'); assert.match(next.log, /SKIP/);
  assert.deepEqual(fs.readdirSync(sb.state).filter((f) => f.startsWith('attempt-')), [], 'the attempt record is cleaned up');
});
test('a workflow that fails BEFORE sending (HTTP 500 without an attempt record) leaves the day open, as before', () => {
  const sb = sandbox(); const r = run(sb, 'error500'); assert.equal(r.status, 1); assert.ok(!r.pending); assert.match(r.log, /在发送之前出错/);
  const retry = run(sb, 'ok'); assert.equal(retry.status, 0, retry.log); assert.ok(retry.marker);
});
test('the send step\'s own verdicts are used: not_sent leaves the day open, unknown keeps pending', () => {
  const a = sandbox(); const r1 = run(a, 'notsent'); assert.equal(r1.status, 1); assert.ok(!r1.pending); assert.match(r1.log, /Discord 没有接受简报（Discord: 404/);
  const b = sandbox(); const r2 = run(b, 'unknownv'); assert.equal(r2.status, 1); assert.ok(r2.pending); assert.equal(r2.lastRun.result, 'unknown');
  assert.equal(run(b, 'ok').posts, r2.posts, 'not resent');
});
test('every request carries this run\'s id, so the send step can record its attempt under it', () => {
  const r = run(sandbox(), 'ok'); const p = JSON.parse(r.payloads[r.payloads.length - 1]); assert.match(p.run, /^\d{6}-\d+$/);
});
test('a direct-engine worker that is KILLED after it recorded its attempt is UNKNOWN, not a safe failure (review R5-02)', () => {
  const sb = sandbox(); const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', STUB_DIRECT: 'killed' });
  assert.equal(r.status, 1); assert.ok(r.pending); assert.equal(r.lastRun.result, 'unknown'); assert.match(r.log, /意外结束（退出码 137）/); assert.equal(r.lockLeft, false);
  const next = run(sb, 'ok', { BRIEF_ENGINE: 'direct' }); assert.equal(next.directCalls.split('\n').filter(Boolean).length, 1, 'not started again');
});
test('the user\'s own BRIEF_NOTE reaches the direct engine, and a fallback adds its reason after it instead of replacing it', () => {
  const own = run(sandbox(), 'ok', { BRIEF_ENGINE: 'direct', BRIEF_NOTE: '我的固定备注' }); assert.equal(own.status, 0, own.log);
  assert.match(own.directCalls, /note=我的固定备注\n/);
  const fb = run(sandbox(), 'ok', { STUB_PORT_BUSY: '1', BRIEF_FALLBACK: 'direct', BRIEF_NOTE: '我的固定备注' }); assert.equal(fb.status, 0, fb.log);
  assert.match(fb.directCalls, /note=我的固定备注 · n8n 没能工作/);
  const none = run(sandbox(), 'ok', { BRIEF_ENGINE: 'direct' }); assert.match(none.directCalls, /note=\n/);
});
test('the direct engine is told the run id', () => {
  const r = run(sandbox(), 'ok', { BRIEF_ENGINE: 'direct' }); assert.match(r.directCalls, /--run=\d{6}-\d+/);
});
test('a day whose outcome was unknown is not later called "missed" (it may well have been delivered) (review final F5)', () => {
  const sb = sandbox(); fs.mkdirSync(sb.state, { recursive: true });
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('sv'); };
  fs.writeFileSync(path.join(sb.state, 'installed-at'), `${daysAgo(2)}\n`); fs.writeFileSync(path.join(sb.state, `pending-${daysAgo(1)}`), 'x');
  const r = run(sb, 'ok'); const missed = JSON.parse(r.payloads[r.payloads.length - 1]).missed;
  assert.ok(missed.includes(daysAgo(2))); assert.ok(!missed.includes(daysAgo(1)));
});

// ================= review round 6 =================
test('direct engine, Discord clearly refused (exit 4): pending is removed and the next slot tries again (review R6-02 / G1)', () => {
  const sb = sandbox(); const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', STUB_DIRECT: 'notsent' });
  assert.equal(r.status, 1); assert.ok(!r.pending, 'nothing was delivered: the day stays open'); assert.notEqual(r.lastRun.result, 'unknown');
  const next = run(sb, 'ok', { BRIEF_ENGINE: 'direct' }); assert.equal(next.status, 0, next.log); assert.ok(next.marker, 'sent on the next slot');
});
test('the run tells everything it starts which state folder to use, so the attempt record is looked for where it is written (review R6-03)', () => {
  const sb = sandbox(); const custom = tmpdir('rb-custom-state-');
  const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', BRIEF_STATE_DIR: custom });
  assert.equal(r.status, 0, r.log); assert.equal(read(path.join(sb.stub, 'direct.state')).trim(), custom);
  assert.ok(fs.existsSync(path.join(custom, `sent-${today()}`)), 'markers go to the same folder');
});
test('the settings file cannot move the state folder (every tool must agree where it is) (review R6-03)', () => {
  const sb = sandbox({ config: `BRIEF_STATE_DIR='${tmpdir('rb-elsewhere-')}'\n` });
  const r = run(sb, 'ok'); assert.equal(r.status, 0, r.log); assert.ok(r.marker, 'the default folder is used'); assert.match(r.log, /were not understood/);
});

test('when the direct engine fails, its own reason reaches the alert and the run record (review H4)', () => {
  const sb = sandbox(); const r = run(sb, 'ok', { BRIEF_ENGINE: 'direct', STUB_DIRECT: 'notsent' });
  assert.match(r.log, /FAIL: 直连模式发送失败（Discord: 404 Unknown Webhook）/); assert.match(r.lastRun.reason, /Discord: 404/);
});

test('--test while another process holds the lock fails loudly (exit 75, a message) instead of exiting 0 as if sent', async () => {
  const sb = sandbox(); const holder = await holdLock(sb.state, 'console');
  try { const r = run(sb, 'ok', {}, ['--test']); assert.equal(r.status, 75); assert.match(r.stderr, /另一个进程在运行/); assert.equal(r.posts, 0); } finally { await holder.release(); }
});
