// Tests for the tools around the workflow: strict settings loader, direct engine, inbox tool, deploy, launchd, status.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ROOT, DEPS_HOME, tmpdir, ics, vevent, holdLock, lockHeld } from './helpers.mjs';
import { runBrief } from '../scripts/brief.mjs';

const SAFE_BIN = tmpdir('tools-bin-');
for (const c of ['launchctl']) fs.writeFileSync(path.join(SAFE_BIN, c), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
const safeEnv = (env = {}) => ({ PATH: `${SAFE_BIN}:${process.env.PATH}`, HOME: tmpdir('tools-home-'), BRIEF_LABEL: 'test.tools', ...env });
const bash = (script, env = {}) => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: safeEnv(env) });
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

// ================= strict settings loader (review M3) =================
const loadWith = (config, extraEnv = {}) => {
  const home = tmpdir('env-'); fs.writeFileSync(path.join(home, 'config.local.env'), config);
  const r = bash(`. "${ROOT}/scripts/env.sh"; printf 'webhook=[%s]|ics=[%s]|bad=[%s]|port=[%s]|broker=[%s]|tz=[%s]|tzbad=[%s]' "\${DISCORD_WEBHOOK_URL:-<unset>}" "\${ICS_URLS:-<unset>}" "$BRIEF_CONFIG_ERRORS" "$N8N_PORT" "$N8N_RUNNERS_BROKER_PORT" "$BRIEF_TZ" "$BRIEF_TZ_INVALID"`, { BRIEF_HOME: home, ...extraEnv });
  return Object.fromEntries(r.stdout.split('|').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 2, -1)]; }));
};
test('the settings file is parsed, never executed: a stray command line is skipped and does not run', () => {
  const marker = path.join(tmpdir('pwn-'), 'PWNED');
  const r = loadWith(`DISCORD_WEBHOOK_URL='x'\ntouch ${marker}\nICS_URLS='y'\n`);
  assert.equal(r.webhook, 'x'); assert.equal(r.ics, 'y'); assert.equal(r.bad, '2'); assert.equal(fs.existsSync(marker), false);
});
test('one typo does not erase the other settings (unbalanced quote, unquoted &)', () => {
  const a = loadWith("DISCORD_WEBHOOK_URL='https://d/1/abc\nICS_URLS='https://cal/x.ics'\n"); assert.equal(a.ics, 'https://cal/x.ics'); assert.equal(a.webhook, '<unset>'); assert.equal(a.bad, '1');
  const b = loadWith('DISCORD_WEBHOOK_URL=https://d/1/abc&thread_id=5\nICS_URLS=https://cal/x.ics\n'); assert.equal(b.ics, 'https://cal/x.ics'); assert.equal(b.bad, '1');
});
test('a settings file cannot set PATH or other non-setting variables', () => {
  const r = loadWith("PATH='/evil'\nLD_PRELOAD='/evil.dylib'\nDISCORD_WEBHOOK_URL='ok'\n"); assert.equal(r.webhook, 'ok'); assert.equal(r.bad, '1,2');
  const still = bash(`. "${ROOT}/scripts/env.sh"; echo "$PATH"`, { BRIEF_HOME: (() => { const h = tmpdir('env-'); fs.writeFileSync(path.join(h, 'config.local.env'), "PATH='/evil'\n"); return h; })() });
  assert.doesNotMatch(still.stdout, /^\/evil/);
});
test('older formats keep working: double quotes (with regex backslashes), unquoted simple values, CRLF, "export"', () => {
  const r = loadWith('export DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/abc\r\nICS_URLS="https://a.example/1.ics https://b.example/2.ics"\r\nBRIEF_STRIP="\\s*\\(Ext\\.?\\s*\\d+\\)"\r\n');
  assert.equal(r.webhook, 'https://discord.com/api/webhooks/1/abc'); assert.equal(r.ics, 'https://a.example/1.ics https://b.example/2.ics'); assert.equal(r.bad, '');
  const home = tmpdir('env-'); fs.writeFileSync(path.join(home, 'config.local.env'), 'BRIEF_STRIP="\\s*\\(Ext\\.?\\s*\\d+\\)"\nBRIEF_IGNORE="Recess|Lunch"\n');
  assert.equal(bash(`. "${ROOT}/scripts/env.sh"; printf '%s' "$BRIEF_STRIP"`, { BRIEF_HOME: home }).stdout, '\\s*\\(Ext\\.?\\s*\\d+\\)');
  assert.equal(bash(`. "${ROOT}/scripts/env.sh"; printf '%s' "$BRIEF_IGNORE"`, { BRIEF_HOME: home }).stdout, 'Recess|Lunch');
});
test('an invalid timezone or port falls back and is flagged, instead of breaking date or the run (review H1)', () => {
  const tz = loadWith("BRIEF_TZ='Mars/Base'\n"); assert.notEqual(tz.tz, 'Mars/Base'); assert.equal(tz.tzbad, 'Mars/Base');
  const port = loadWith("N8N_PORT='abc'\n"); assert.equal(port.port, '5690'); assert.equal(port.broker, '5691'); assert.match(port.bad, /N8N_PORT/);
});
test('the default port is uncommon and the task-runner port follows it (review M5)', () => {
  const d = loadWith(''); assert.equal(d.port, '5690'); assert.equal(d.broker, '5691');
  const c = loadWith("N8N_PORT='6100'\n"); assert.equal(c.port, '6100'); assert.equal(c.broker, '6101');
});

// ================= direct engine =================
const ICS_TEXT = ics(vevent({ uid: 'd', lines: ['SUMMARY:Direct class', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
const engineEnv = (extra = {}) => ({ BRIEF_HOME: DEPS_HOME, BRIEF_STATE_DIR: tmpdir('de-state-'), BRIEF_INBOX: tmpdir('de-inbox-'), BRIEF_TZ: 'Asia/Hong_Kong', BRIEF_TODAY: '2026-09-30', ICS_URLS: 'https://cal.example/a.ics', DISCORD_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/tok', AI_BASE_URL: 'https://ai.example', AI_MODEL: 'm', AI_API_KEY: 'k', ...extra });
const router = (log, { discord = async () => ({ id: '123' }), ai = async () => ({ choices: [{ message: { content: '{"tasks":[]}' } }] }) } = {}) => async (url, init) => {
  log.push({ url, init });
  const respond = (status, body, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  if (url.includes('cal.example')) return respond(200, ICS_TEXT);
  if (url.includes('ai.example')) { try { return respond(200, await ai(init)); } catch (e) { return respond(e.status || 500, { error: e.message }); } }
  if (url.includes('discord.example')) { try { return respond(200, await discord(init, url)); } catch (e) { return respond(e.status || 500, { error: e.message }, e.headers || {}); } }
  return respond(404, 'unexpected ' + url);
};
test('direct engine: a dry run builds the brief and sends and calls nothing else, even with a new file waiting', async () => {
  const log = []; const env = engineEnv(); fs.writeFileSync(path.join(env.BRIEF_INBOX, 'new.txt'), 'A course document with enough readable text to be processed.\n');
  const r = await runBrief({ env, dryRun: true, fetchImpl: router(log) });
  assert.equal(r.status, 'dry-run'); assert.match(r.message, /🧪 测试/); assert.match(r.message, /Direct class/); assert.match(r.message, /预览模式：1 个新文件没有被处理/);
  assert.equal(log.filter((l) => l.url.includes('discord')).length, 0); assert.equal(log.filter((l) => l.url.includes('ai.example')).length, 0, 'no AI call in a preview');
  assert.equal(fs.existsSync(path.join(env.BRIEF_INBOX, 'tasks.csv')), false); assert.equal(fs.existsSync(path.join(env.BRIEF_STATE_DIR, 'processed.json')), false, 'a preview writes no state');
});
test('direct engine: sends to the webhook with wait=true and requires a message id back', async () => {
  const log = []; const r = await runBrief({ env: engineEnv(), fetchImpl: router(log) });
  assert.equal(r.status, 'sent'); assert.equal(r.engine, 'direct'); assert.equal(r.events, 1);
  const post = log.find((l) => l.url.includes('discord')); assert.match(post.url, /\?wait=true$/); assert.equal(post.init.method, 'POST');
  const body = JSON.parse(post.init.body); assert.equal(body.embeds.length, 1); assert.deepEqual(body.allowed_mentions, { parse: [] });
  await assert.rejects(() => runBrief({ env: engineEnv(), fetchImpl: router([], { discord: async () => ({}) }) }), /without a message id/);
});
test('direct engine: a rate limit is retried; a missing webhook is a plain failure', { timeout: 30000 }, async () => {
  let n = 0; const limited = router([], { discord: async () => { if (++n === 1) throw Object.assign(new Error('rate limited'), { status: 429, headers: { 'retry-after': '0' } }); return { id: '9' }; } });
  assert.equal((await runBrief({ env: engineEnv(), fetchImpl: limited })).status, 'sent'); assert.equal(n, 2);
  await assert.rejects(() => runBrief({ env: engineEnv({ DISCORD_WEBHOOK_URL: '' }), fetchImpl: router([]) }), /DISCORD_WEBHOOK_URL/);
});
test('direct engine: a request that MAY have been delivered is never repeated and is marked as unknown (review R4-03)', async () => {
  let n = 0;
  const serverError = router([], { discord: async () => { n++; throw Object.assign(new Error('server error'), { status: 500 }); } });
  await assert.rejects(() => runBrief({ env: engineEnv(), fetchImpl: serverError }), (e) => e.outcomeUnknown === true);
  assert.equal(n, 1, 'one attempt only: a repeat could deliver a second copy');
  const base = router([]); n = 0;
  const reset = async (url, init) => { if (String(url).includes('discord.example')) { n++; throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); } return base(url, init); };
  await assert.rejects(() => runBrief({ env: engineEnv(), fetchImpl: reset }), (e) => e.outcomeUnknown === true);
  assert.equal(n, 1, 'a connection that broke after the request went out is not retried');
  // a clear refusal (4xx) is a plain failure, not "unknown"
  await assert.rejects(() => runBrief({ env: engineEnv(), fetchImpl: router([], { discord: async () => { throw Object.assign(new Error('bad webhook'), { status: 404 }); } }) }), (e) => !e.outcomeUnknown);
});
test('direct engine: a Discord answer without a message id is an unknown outcome too', async () => {
  await assert.rejects(() => runBrief({ env: engineEnv(), fetchImpl: router([], { discord: async () => ({}) }) }), (e) => e.outcomeUnknown === true);
});
test('direct engine: a NaN or negative Retry-After cannot turn the back-off into a busy loop (review)', async () => {
  const t0 = Date.now(); let n = 0;
  const f = router([], { discord: async () => { if (++n === 1) throw Object.assign(new Error('rl'), { status: 429, headers: { 'retry-after': 'soon' } }); return { id: '1' }; } });
  await runBrief({ env: engineEnv(), fetchImpl: f }); assert.ok(Date.now() - t0 >= 2500, 'waited at least the default back-off');
});
test('brief.mjs still runs when started through a symlinked path (for example /tmp -> /private/tmp)', () => {
  const link = path.join(tmpdir('lnk-'), 'scripts-link'); fs.symlinkSync(path.join(ROOT, 'scripts'), link);
  const env = engineEnv({ ICS_URLS: '' });
  const r = spawnSync(process.execPath, [path.join(link, 'brief.mjs'), '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /测试/);
});
test('direct engine: the fallback note and the missed days reach the brief', async () => {
  const r = await runBrief({ env: engineEnv({ BRIEF_NOTE: 'n8n 没能工作，这份简报由直连模式发送' }), missed: ['2026-09-28'], dryRun: true, fetchImpl: router([]) });
  assert.match(r.message, /这份简报由直连模式发送/); assert.match(r.message, /09-28 漏发/);
});
test('direct engine: one bad setting does not break it (review H1)', async () => {
  const r = await runBrief({ env: engineEnv({ BRIEF_TZ: 'Mars/Base', BRIEF_EVENT_DAYS: 'abc' }), dryRun: true, fetchImpl: router([]) });
  assert.match(r.message, /设置提示/); assert.match(r.message, /Direct class/);
});

// ================= inbox tool =================
const inboxTool = (env, ...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'inbox-tool.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
const inboxSetup = () => { const inbox = tmpdir('it-inbox-'); const state = tmpdir('it-state-'); return { inbox, state, env: { BRIEF_INBOX: inbox, BRIEF_STATE_DIR: state, BRIEF_HOME: tmpdir('it-home-'), AI_API_KEY: 'super-secret-key-value' } }; };
const hashOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
test('inbox tool: status shows every file with its state and never prints a secret', () => {
  const { inbox, state, env } = inboxSetup();
  const TEXT = 'A course document with enough readable text to be processed.\n';
  for (const n of ['new.txt', 'done.txt', 'part.txt', 'fail.txt', 'dead.txt']) fs.writeFileSync(path.join(inbox, n), TEXT + n);
  fs.writeFileSync(path.join(inbox, 'pic.png'), 'x');
  const h = (n) => hashOf(path.join(inbox, n));
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: { [h('done.txt')]: { file: 'done.txt', at: '2026-09-30' } }, partial: { [h('part.txt')]: 3 }, failed: { [h('fail.txt')]: 3, [h('dead.txt')]: 6 }, failedAt: { [h('fail.txt')]: Date.now() } }));
  const out = inboxTool(env, 'status').stdout;
  assert.match(out, /\[新文件\] new\.txt/); assert.match(out, /\[已处理\] done\.txt/); assert.match(out, /\[读到一半\] part\.txt — 读到第 3 段/); assert.match(out, /\[失败暂停\] fail\.txt/); assert.match(out, /\[已放弃\] dead\.txt/); assert.match(out, /\[不支持\] pic\.png/);
  assert.doesNotMatch(out, /super-secret-key-value/);
  const json = JSON.parse(inboxTool(env, 'status', '--json').stdout); assert.equal(json.files.length, 6);
});
test('inbox tool: retry forgets failures but keeps reading progress; --full starts over; the old state is backed up', () => {
  const { inbox, state, env } = inboxSetup(); fs.writeFileSync(path.join(inbox, 'a.txt'), 'A course document with enough readable text to be processed.\n');
  const h = hashOf(path.join(inbox, 'a.txt'));
  const put = () => fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, partial: { [h]: 2 }, failed: { [h]: 6 }, failedAt: { [h]: 1 }, gaveUp: { [h]: '2026-09-30' } }));
  put(); assert.equal(inboxTool(env, 'retry', 'a.txt').status, 0);
  let s = JSON.parse(read(path.join(state, 'processed.json'))); assert.equal(s.failed[h], undefined); assert.equal(s.gaveUp[h], undefined); assert.equal(s.partial[h], 2, 'progress kept');
  assert.ok(fs.readdirSync(state).some((f) => f.startsWith('processed.json.bak-')), 'the previous state is kept');
  put(); inboxTool(env, 'retry', 'a.txt', '--full'); s = JSON.parse(read(path.join(state, 'processed.json'))); assert.equal(s.partial[h], undefined);
});
test('inbox tool: ignore marks a file as handled without reading it; an unknown file name is refused', () => {
  const { inbox, state, env } = inboxSetup(); fs.writeFileSync(path.join(inbox, 'skip.txt'), 'A course document with enough readable text to be processed.\n');
  assert.equal(inboxTool(env, 'ignore', 'skip.txt').status, 0);
  assert.match(inboxTool(env, 'status').stdout, /\[已忽略\] skip\.txt/);
  const bad = inboxTool(env, 'retry', 'nope.txt'); assert.equal(bad.status, 2);
});

// ================= deploy: staging, rollback, version guard =================
function deploySandbox({ old = 'OLDBUILD', n8nVersion } = {}) {
  const src = tmpdir('dep-src-'); for (const d of ['scripts', 'workflows']) fs.cpSync(path.join(ROOT, d), path.join(src, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(src, 'package.json')); fs.copyFileSync(path.join(ROOT, 'config.example.env'), path.join(src, 'config.example.env'));
  const home = tmpdir('dep-home-'); const stub = tmpdir('dep-stub-');
  for (const d of ['.runtime/node/bin', 'node_modules/.bin', 'workflows', 'data/.n8n']) fs.mkdirSync(path.join(home, d), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(home, '.runtime', 'node', 'bin', 'node')); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), '');
  fs.writeFileSync(path.join(home, 'workflows', 'BUILD'), `${old}\n`); fs.writeFileSync(path.join(home, 'workflows', 'marker.txt'), 'old set'); fs.mkdirSync(path.join(home, 'scripts')); fs.writeFileSync(path.join(home, 'scripts', 'run-brief.sh'), '# old runtime script\n'); fs.writeFileSync(path.join(home, 'config.local.env'), "DISCORD_WEBHOOK_URL='x'\n");
  const expected = JSON.parse(read(path.join(ROOT, 'package.json'))).dependencies.n8n; const db = path.join(home, 'data', '.n8n', 'database.sqlite');
  assert.equal(spawnSync('sqlite3', [db, `create table workflow_entity(id text primary key, versionId text, activeVersionId text, active integer);
    create table workflow_published_version(workflowId text primary key, publishedVersionId text, createdAt text, updatedAt text);
    create table workflow_publication_outbox(id integer primary key autoincrement, workflowId text, publishedVersionId text, status text);
    create table webhook_entity(workflowId text, webhookPath text, method text, node text);
    insert into workflow_entity values('morningBriefTest01','v-old','v-old',1); insert into workflow_published_version values('morningBriefTest01','v-old','t','t');
    insert into webhook_entity values('morningBriefTest01','morning-brief','POST','Webhook'),('morningBriefTest01','morning-brief-${old}','POST','Webhook');`]).status, 0);
  fs.writeFileSync(path.join(home, 'node_modules', '.bin', 'n8n'), `#!/bin/bash
DB="$N8N_USER_FOLDER/.n8n/database.sqlite"
case "$1" in
  --version) echo "\${STUB_N8N_VERSION:-${expected}}" ;;
  unpublish:workflow) exit 0 ;;
  import:workflow) [ "\${STUB_FAIL:-}" = import ] && { echo "boom: cannot import" >&2; exit 1; }
    sqlite3 "$DB" "update workflow_entity set versionId='v-new', activeVersionId='v-old', active=0 where id='morningBriefTest01'; insert into workflow_publication_outbox(workflowId,publishedVersionId,status) values('morningBriefTest01','v-old','pending');"; echo "Successfully imported 1 workflow." ;;
  publish:workflow) [ "\${STUB_FAIL:-}" = publish ] && { echo "boom: cannot publish" >&2; exit 1; }
    echo "Publishing workflow"; ;;
esac
`, { mode: 0o755 });
  return { src, home, stub, db };
}
const deploy = (sb, env = {}) => spawnSync('bash', [path.join(sb.src, 'scripts', 'deploy-workflow.sh')], { encoding: 'utf8', env: safeEnv({ BRIEF_HOME: sb.home, N8N_PORT: '5897', ...env }) });
const sql = (db, q) => spawnSync('sqlite3', [db, q], { encoding: 'utf8' }).stdout.trim();
test('deploy: a good deploy patches the pointers, removes stale webhook rows, swaps the files last and keeps the previous set', () => {
  const sb = deploySandbox(); const r = deploy(sb);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const build = read(path.join(sb.src, 'workflows', 'BUILD')).trim();
  assert.equal(read(path.join(sb.home, 'workflows', 'BUILD')).trim(), build); assert.match(read(path.join(sb.home, 'workflows', 'DEPLOYED')), new RegExp(`build=${build}`));
  assert.equal(read(path.join(sb.home, 'workflows.prev', 'marker.txt')), 'old set');
  assert.equal(sql(sb.db, "select activeVersionId||'/'||active from workflow_entity;"), 'v-new/1'); assert.equal(sql(sb.db, 'select publishedVersionId from workflow_published_version;'), 'v-new');
  assert.equal(sql(sb.db, "select count(*) from workflow_publication_outbox where publishedVersionId!='v-new' and status!='completed';"), '0');
  assert.equal(sql(sb.db, 'select count(*) from webhook_entity;'), '0', 'stale rows for other paths are removed');
  assert.ok(fs.readdirSync(path.join(sb.home, 'data', 'backups')).some((f) => f.startsWith('database-pre-deploy-')), 'a backup was made');
  assert.equal(fs.existsSync(path.join(sb.home, 'workflows.next')), false); assert.equal(lockHeld(path.join(sb.home, 'data', 'state')), false);
  assert.ok(fs.existsSync(path.join(sb.home, 'scripts', 'run-brief.sh')), 'scripts are synced at the end');
});
test('deploy: a webhook token is created once, kept in the settings only, and reused by later deploys (review L)', () => {
  const sb = deploySandbox(); deploy(sb); const t1 = read(path.join(sb.home, 'config.local.env')).match(/BRIEF_TOKEN='([0-9a-f]{48})'/);
  assert.ok(t1, 'a 48-hex token is stored'); assert.equal((fs.statSync(path.join(sb.home, 'config.local.env')).mode & 0o777).toString(8), '600');
  deploy(sb); assert.equal(read(path.join(sb.home, 'config.local.env')).match(/BRIEF_TOKEN='([0-9a-f]{48})'/)[1], t1[1]);
  assert.doesNotMatch(read(path.join(sb.src, 'workflows', 'morning-brief.json')), new RegExp(t1[1]), 'never inside the workflow');
});
for (const failing of ['import', 'publish']) {
  test(`deploy: if the n8n ${failing} step fails, the database is restored and the old workflow files stay in place (review)`, () => {
    const sb = deploySandbox(); const before = sql(sb.db, "select group_concat(workflowId||publishedVersionId) from workflow_published_version;") + '|' + sql(sb.db, 'select count(*) from webhook_entity;');
    const r = deploy(sb, { STUB_FAIL: failing });
    assert.notEqual(r.status, 0); assert.match(r.stderr, /rolling back/); assert.match(r.stderr, /database restored/);
    assert.equal(read(path.join(sb.home, 'workflows', 'BUILD')).trim(), 'OLDBUILD', 'the old build is still the one on disk');
    assert.equal(sql(sb.db, "select group_concat(workflowId||publishedVersionId) from workflow_published_version;") + '|' + sql(sb.db, 'select count(*) from webhook_entity;'), before, 'database back to how it was');
    assert.equal(sql(sb.db, 'select versionId from workflow_entity;'), 'v-old');
    assert.equal(fs.existsSync(path.join(sb.home, 'workflows.next')), false); assert.equal(lockHeld(path.join(sb.home, 'data', 'state')), false);
  });
}
test('deploy: an n8n version other than the tested one is refused before anything is touched (review M4), unless overridden', () => {
  const sb = deploySandbox(); const r = deploy(sb, { STUB_N8N_VERSION: '2.99.0' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /only tested with/); assert.match(r.stderr, /BRIEF_ALLOW_N8N_MISMATCH/);
  assert.equal(sql(sb.db, 'select versionId from workflow_entity;'), 'v-old'); assert.equal(fs.existsSync(path.join(sb.home, 'data', 'backups')) ? fs.readdirSync(path.join(sb.home, 'data', 'backups')).length : 0, 0);
  assert.equal(deploy(sb, { STUB_N8N_VERSION: '2.99.0', BRIEF_ALLOW_N8N_MISMATCH: '1' }).status, 0);
});
test('deploy: only the newest three database backups are kept', () => {
  const sb = deploySandbox(); fs.mkdirSync(path.join(sb.home, 'data', 'backups'), { recursive: true });
  for (let i = 1; i <= 5; i++) { const f = path.join(sb.home, 'data', 'backups', `database-pre-deploy-2026010${i}-000000.sqlite`); fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(2026, 0, i), new Date(2026, 0, i)); }
  deploy(sb); assert.equal(fs.readdirSync(path.join(sb.home, 'data', 'backups')).length, 3);
});

// ================= launchd: restore the old schedule when loading the new one fails =================
test('launchd: if loading the new schedule fails, the previous one is put back (review: rollback)', () => {
  const fakeHome = tmpdir('ld-h-'); const home = tmpdir('ld-r-'); const stub = tmpdir('ld-s-'); const bin = tmpdir('ld-b-');
  fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), ''); fs.mkdirSync(path.join(home, 'logs'));
  const agents = path.join(fakeHome, 'Library', 'LaunchAgents'); fs.mkdirSync(agents, { recursive: true }); const plist = path.join(agents, 'test.rollback.plist'); fs.writeFileSync(plist, 'OLD-PLIST-CONTENT');
  fs.writeFileSync(path.join(bin, 'launchctl'), `#!/bin/bash\necho "$*" >> "${stub}/calls"\nif [ "$1" = bootstrap ] && [ ! -f "${stub}/failed-once" ]; then touch "${stub}/failed-once"; exit 1; fi\nexit 0\n`, { mode: 0o755 });
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.rollback' } });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /previous schedule was restored/);
  assert.equal(read(plist), 'OLD-PLIST-CONTENT'); assert.equal(read(path.join(stub, 'calls')).split('\n').filter((l) => l.startsWith('bootstrap')).length, 2, 'the old job was loaded again');
  assert.deepEqual(fs.readdirSync(agents).filter((n) => n.includes('.prev.') || n.includes('.plist.')), [], 'no temp files left');
});
test('launchd: if loading fails and there was no schedule before, no half-installed plist is left', () => {
  const fakeHome = tmpdir('ld-h-'); const home = tmpdir('ld-r-'); const bin = tmpdir('ld-b-'); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), ''); fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/bash\n[ "$1" = bootstrap ] && exit 1\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'install-launchd.sh'), '08:00'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.fresh' } });
  assert.notEqual(r.status, 0); assert.equal(fs.existsSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'test.fresh.plist')), false);
});

// ================= webhook token =================
const wf = JSON.parse(read(path.join(ROOT, 'workflows', 'morning-brief.json')));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const checkToken = async (env, headers) => new AsyncFunction('$env', '$', '$input', wf.nodes.find((n) => n.name === 'Check token').parameters.jsCode)(env, () => ({ first: () => ({ json: { headers } }) }), { all: () => [{ json: {} }] });
test('the workflow rejects a request without the right token, and accepts one with it (review L)', async () => {
  await assert.rejects(() => checkToken({ BRIEF_TOKEN: 'abc' }, {}), /unauthorized/);
  await assert.rejects(() => checkToken({ BRIEF_TOKEN: 'abc' }, { 'x-brief-token': 'wrong' }), /unauthorized/);
  assert.ok(await checkToken({ BRIEF_TOKEN: 'abc' }, { 'x-brief-token': 'abc' }));
  assert.ok(await checkToken({}, {}), 'no token configured (older install): not enforced');
});
test('the token check is the first node after the webhook and is part of the build hash', () => {
  assert.equal(wf.connections.Webhook.main[0][0].node, 'Check token'); assert.equal(wf.connections['Check token'].main[0][0].node, 'Read calendars');
});

// ================= status tool =================
test('status.sh lists setting NAMES only, reports what is wrong, and exits non-zero when something needs attention', () => {
  const home = tmpdir('st-'); fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.local.env'), "DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/123456/SECRET-TOKEN-VALUE'\nAI_API_KEY='sk-should-never-appear'\nthis line is broken\n");
  fs.writeFileSync(path.join(home, 'data', 'state', 'last-run.json'), JSON.stringify({ run: 'r', mode: 'normal', result: 'fail', reason: 'boom', engine: 'n8n', date: '2026-10-01', started: Math.floor(Date.now() / 1000) - 90, seconds: 12, events: 3, tasks: 1, newTasks: 0, aiCalls: 0, calendarMs: 1000, ingestMs: 20, waitNetSec: 0, waitReadySec: 5, execSec: 6 }));
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'status.sh')], { encoding: 'utf8', env: safeEnv({ BRIEF_HOME: home, BRIEF_INBOX: tmpdir('st-in-'), BRIEF_STATE_DIR: path.join(home, 'data', 'state') }) });
  assert.notEqual(r.status, 0); assert.doesNotMatch(r.stdout, /SECRET-TOKEN-VALUE|sk-should-never-appear/);
  assert.match(r.stdout, /设置项（只列名字）：.*DISCORD_WEBHOOK_URL.*AI_API_KEY/); assert.match(r.stdout, /看不懂的行：第 3 行/); assert.match(r.stdout, /原因：boom/); assert.match(r.stdout, /workflows\/BUILD/);
});

// ================= round 4: deploy rolls back from EVERY failure after the backup (review R4-04) =================
const real = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim();
function wrappers(sb) {
  const bin = tmpdir('dep-wrap-'); const sqlite = real('sqlite3'); const mv = real('mv'); const rsync = real('rsync');
  fs.writeFileSync(path.join(bin, 'sqlite3'), `#!/bin/bash\n[ "\${STUB_SQL_FAIL:-}" = query ] && [[ "$*" == *"select versionId from workflow_entity"* ]] && exit 1\nexec "${sqlite}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'mv'), `#!/bin/bash\n[ "\${STUB_MV_FAIL:-}" = 1 ] && [[ "$*" == *"workflows.next"* ]] && exit 1\n[ "\${STUB_MV_FAIL:-}" = scripts ] && [[ "$*" == *"scripts.next"* ]] && exit 1\nexec "${mv}" "$@"\n`, { mode: 0o755 });
  // "partial": copy ONE real script into the target first, then fail (what rsync does when the disk fills up halfway)
  fs.writeFileSync(path.join(bin, 'rsync'), `#!/bin/bash\nif [ "\${STUB_RSYNC_FAIL:-}" = partial ] && [[ "$*" == *"/scripts/"* ]]; then src="\${@: -2:1}"; t="\${@: -1}"; mkdir -p "$t"; cp "$src/run-brief.sh" "$t/run-brief.sh"; exit 23; fi\nexec "${rsync}" "$@"\n`, { mode: 0o755 });
  return bin;
}
const deployWith = (sb, env) => spawnSync('bash', [path.join(sb.src, 'scripts', 'deploy-workflow.sh')], { encoding: 'utf8', env: { ...safeEnv({ BRIEF_HOME: sb.home, N8N_PORT: '5897' }), PATH: `${wrappers(sb)}:${SAFE_BIN}:${process.env.PATH}`, ...env } });
const treeHash = (dir) => { if (!fs.existsSync(dir)) return 'none'; const h = crypto.createHash('sha256'); for (const f of fs.readdirSync(dir, { recursive: true }).sort()) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) h.update(`${f}\0${fs.readFileSync(p)}\0`); } return h.digest('hex').slice(0, 16); };
const snapshot = (sb) => [sql(sb.db, "select group_concat(workflowId||publishedVersionId) from workflow_published_version;"), sql(sb.db, 'select versionId||activeVersionId||active from workflow_entity;'), sql(sb.db, 'select count(*) from webhook_entity;'), read(path.join(sb.home, 'workflows', 'BUILD')).trim(), read(path.join(sb.home, 'workflows', 'marker.txt')), treeHash(path.join(sb.home, 'scripts'))].join('|');
for (const [name, env, what] of [
  ['a query fails after publishing', { STUB_SQL_FAIL: 'query' }, 'query'],
  ['the files cannot be switched (mv fails)', { STUB_MV_FAIL: '1' }, 'mv'],
  ['the scripts cannot be switched after the workflow files were (mv of scripts.next fails)', { STUB_MV_FAIL: 'scripts' }, 'mv-scripts'],
]) {
  test(`deploy: when ${name}, database AND files go back to exactly how they were (review R4-04)`, () => {
    const sb = deploySandbox(); const before = snapshot(sb);
    const r = deployWith(sb, env);
    assert.notEqual(r.status, 0, r.stdout + r.stderr); assert.match(r.stderr, /rolling back/, what); assert.match(r.stderr, /database restored/);
    assert.equal(snapshot(sb), before, 'database pointers, webhook rows, BUILD and files are all as before');
    assert.equal(fs.existsSync(path.join(sb.home, 'workflows.next')), false); assert.equal(fs.existsSync(path.join(sb.home, 'workflows.prev')), false, 'the moved copy was put back'); assert.equal(lockHeld(path.join(sb.home, 'data', 'state')), false);
  });
}
test('deploy: a stop signal in the middle rolls back too, and releases the lock', async () => {
  const sb = deploySandbox(); const before = snapshot(sb);
  const n8n = path.join(sb.home, 'node_modules', '.bin', 'n8n'); fs.writeFileSync(n8n, read(n8n).replace('echo "Publishing workflow"; ;;', `touch "${sb.stub}/publishing"; echo "Publishing workflow"; sleep 3 ;;`), { mode: 0o755 });
  const { spawn } = await import('node:child_process');
  const child = spawn('bash', [path.join(sb.src, 'scripts', 'deploy-workflow.sh')], { env: safeEnv({ BRIEF_HOME: sb.home, N8N_PORT: '5897' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; child.stderr.on('data', (d) => { err += d; });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(sb.stub, 'publishing')); i++) await new Promise((res) => setTimeout(res, 50)); // wait until it is really inside the publish step
  child.kill('SIGTERM');
  const code = await new Promise((res) => child.on('close', res));
  assert.notEqual(code, 0); assert.match(err, /rolling back/); assert.equal(snapshot(sb), before); assert.equal(lockHeld(path.join(sb.home, 'data', 'state')), false);
});
test('deploy: it does not start while another process holds the lock, and leaves that lock alone', async () => {
  const sb = deploySandbox(); const state = path.join(sb.home, 'data', 'state'); const holder = await holdLock(state, 'run-brief');
  try { const r = deploy(sb); assert.notEqual(r.status, 0); assert.match(r.stderr, /in progress/); assert.ok(lockHeld(state), 'the holder keeps its lock'); assert.equal(sql(sb.db, 'select versionId from workflow_entity;'), 'v-old', 'nothing deployed'); } finally { await holder.release(); }
});

// ================= round 4: the inbox tool and the run share one lock (review R4-07) =================
test('inbox tool: ignore/retry are refused while a run holds the lock, and change nothing', async () => {
  const { inbox, state, env } = inboxSetup(); fs.writeFileSync(path.join(inbox, 'b.txt'), 'A course document with enough readable text to be processed.\n');
  const holder = await holdLock(state, 'run-brief');
  try {
    for (const args of [['ignore', 'b.txt'], ['retry', 'b.txt']]) { const r = inboxTool(env, ...args); assert.equal(r.status, 3); assert.match(r.stderr, /正在运行简报/); }
    assert.equal(fs.existsSync(path.join(state, 'processed.json')), false, 'no state was written');
    assert.match(inboxTool(env, 'status').stdout, /\[新文件\] b\.txt/, 'reading the status needs no lock');
  } finally { await holder.release(); }
});
test('inbox tool: after it finished, the lock is free again; it works on the state as it is on disk', () => {
  const { inbox, state, env } = inboxSetup(); fs.writeFileSync(path.join(inbox, 'b.txt'), 'A course document with enough readable text to be processed.\n');
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: { other: { file: 'x', at: '2026-09-30' } } }));
  assert.equal(inboxTool(env, 'ignore', 'b.txt').status, 0);
  const st = JSON.parse(read(path.join(state, 'processed.json'))); assert.ok(st.done.other, 'what a run wrote before is kept'); assert.equal(Object.keys(st.done).length, 2);
  assert.equal(lockHeld(state), false, 'the lock is released');
});

// ================= round 4: the health screen =================
const statusRun = (config, extra = {}) => {
  const home = tmpdir('st-'); fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true }); fs.writeFileSync(path.join(home, 'config.local.env'), config);
  return spawnSync('bash', [path.join(ROOT, 'scripts', 'status.sh')], { encoding: 'utf8', env: safeEnv({ BRIEF_HOME: home, BRIEF_INBOX: tmpdir('st-in-'), BRIEF_STATE_DIR: path.join(home, 'data', 'state'), ...extra }) });
};
test('status.sh: a webhook that is present but empty is a problem, not "all fine" (review R4-10)', () => {
  for (const cfg of ["DISCORD_WEBHOOK_URL=''\n", "DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/1/abc\nICS_URLS='x'\n", '']) {
    const r = statusRun(cfg); assert.notEqual(r.status, 0); assert.match(r.stdout, /DISCORD_WEBHOOK_URL 没有值/); assert.doesNotMatch(r.stdout, /一切正常/);
  }
  assert.match(statusRun("DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/1/abc'\n").stdout, /已配置 Discord Webhook/);
});
test('status.sh: the same calendar link listed twice is pointed out, and no link is ever printed (review F / I4)', () => {
  const r = statusRun("DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/1/abc'\nICS_URLS='https://calendar.example/private-SECRETSECRET/basic.ics https://calendar.example/private-SECRETSECRET/basic.ics'\n");
  assert.match(r.stdout, /1 个重复的链接/); assert.doesNotMatch(r.stdout, /SECRETSECRET|calendar\.example/);
  assert.match(statusRun("DISCORD_WEBHOOK_URL='x'\nICS_URLS='https://a.example/1 https://b.example/2'\n").stdout, /日历链接 2 个/);
});
test('status.sh: scripts in the runtime folder that differ from the source are listed (review I4)', () => {
  const home = tmpdir('st-stale-'); fs.mkdirSync(path.join(home, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config.local.env'), "DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/1/abc'\n");
  fs.writeFileSync(path.join(home, 'scripts', 'run-brief.sh'), '# an older copy\n'); fs.copyFileSync(path.join(ROOT, 'scripts', 'status.sh'), path.join(home, 'scripts', 'status.sh'));
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'status.sh')], { encoding: 'utf8', env: safeEnv({ BRIEF_HOME: home, BRIEF_INBOX: tmpdir('st-in-'), BRIEF_STATE_DIR: path.join(home, 'data', 'state') }) });
  assert.match(r.stdout, /这些脚本和源码不一致：.*run-brief\.sh/); assert.doesNotMatch(r.stdout, /不一致：.*status\.sh/);
});

test('deploy: a scripts copy that fails halfway can never reach the runtime folder: it only ever writes into staging (review R5-03)', () => {
  const sb = deploySandbox(); fs.mkdirSync(path.join(sb.home, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(sb.home, 'scripts', 'run-brief.sh'), '# the old version\n');
  const before = snapshot(sb);
  const r = deployWith(sb, { STUB_RSYNC_FAIL: 'partial' });
  assert.notEqual(r.status, 0); assert.equal(snapshot(sb), before, 'database, workflows AND scripts exactly as before');
  assert.equal(read(path.join(sb.home, 'scripts', 'run-brief.sh')), '# the old version\n');
  assert.equal(fs.existsSync(path.join(sb.home, 'scripts.next')), false);
});
test('deploy: a good deploy switches the scripts as a whole and keeps the previous set as scripts.prev', () => {
  const sb = deploySandbox(); fs.mkdirSync(path.join(sb.home, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(sb.home, 'scripts', 'old-only.sh'), 'x');
  assert.equal(deploy(sb).status, 0);
  assert.equal(fs.existsSync(path.join(sb.home, 'scripts', 'old-only.sh')), false, 'no leftovers from the old set'); assert.ok(fs.existsSync(path.join(sb.home, 'scripts', 'run-brief.sh')));
  assert.ok(fs.existsSync(path.join(sb.home, 'scripts.prev', 'old-only.sh')));
});

test('inbox tool: unignore undoes ignore; remove moves the file to the Trash; plain names of real inbox files only', () => {
  const { inbox, state, env } = inboxSetup(); const trash = tmpdir('it-trash-'); env.BRIEF_TRASH_DIR = trash;
  fs.writeFileSync(path.join(inbox, 'a.txt'), 'A course document with enough readable text to be processed.\n');
  assert.equal(inboxTool(env, 'unignore', 'a.txt').status, 2, 'not ignored yet');
  inboxTool(env, 'ignore', 'a.txt'); assert.match(inboxTool(env, 'status').stdout, /\[已忽略\] a\.txt/);
  assert.equal(inboxTool(env, 'unignore', 'a.txt').status, 0); assert.match(inboxTool(env, 'status').stdout, /\[新文件\] a\.txt/);
  assert.equal(inboxTool(env, 'remove', 'a.txt').status, 0); assert.equal(fs.existsSync(path.join(inbox, 'a.txt')), false); assert.ok(fs.existsSync(path.join(trash, 'a.txt')));
  fs.writeFileSync(path.join(inbox, 'tasks.csv'), 'x'); fs.writeFileSync(path.join(path.dirname(inbox), 'outside.txt'), 'x');
  for (const bad of ['tasks.csv', '../outside.txt', path.join(inbox, 'tasks.csv')]) assert.equal(inboxTool(env, 'remove', bad).status, 2, bad);
  assert.ok(fs.existsSync(path.join(inbox, 'tasks.csv')));
  const backups = () => fs.readdirSync(state).filter((f) => f.startsWith('processed.json.bak-')).length;
  fs.writeFileSync(path.join(inbox, 'b.txt'), 'A course document with enough readable text to be processed.\n');
  for (let i = 0; i < 8; i++) inboxTool(env, i % 2 ? 'unignore' : 'ignore', 'b.txt');
  assert.ok(backups() <= 5, 'old state backups do not pile up');
});

test('inbox tool: undoing "ignore" really puts the file back in line, even one that had been given up on (Codex suggestion)', () => {
  const { inbox, state, env } = inboxSetup(); fs.writeFileSync(path.join(inbox, 'a.txt'), 'A course document with enough readable text to be processed.\n');
  const h = hashOf(path.join(inbox, 'a.txt'));
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, failed: { [h]: 6 }, failedAt: { [h]: Date.now() }, gaveUp: { [h]: '2026-09-30' } }));
  inboxTool(env, 'ignore', 'a.txt'); assert.equal(inboxTool(env, 'unignore', 'a.txt').status, 0);
  assert.match(inboxTool(env, 'status').stdout, /\[新文件\] a\.txt/, 'not "given up" any more');
});

test('deploy: an OLD-version process holding the old lock stops the deploy before anything is touched (review R9-01)', async () => {
  const sb = deploySandbox(); const state = path.join(sb.home, 'data', 'state'); fs.mkdirSync(path.join(state, 'run.lock'), { recursive: true });
  const { spawn } = await import('node:child_process'); const old = spawn('bash', ['-c', 'exec -a run-brief-old sleep 30'], { stdio: 'ignore', detached: true }); old.unref();
  fs.writeFileSync(path.join(state, 'run.lock', 'owner'), `${old.pid} 1\n`);
  try { const r = deploy(sb); assert.notEqual(r.status, 0); assert.match(r.stderr, /in progress.*old version/); assert.equal(sql(sb.db, 'select versionId from workflow_entity;'), 'v-old'); assert.equal(fs.existsSync(path.join(sb.home, 'data', 'backups')) ? fs.readdirSync(path.join(sb.home, 'data', 'backups')).length : 0, 0, 'not even a backup'); }
  finally { old.kill(); }
});
