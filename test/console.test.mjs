// The local control console: access control, secrets never reach the page, settings/tasks/inbox writes follow the same
// rules as the shell scripts, and actions run the real scripts. Everything runs against throw-away folders.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { ROOT, DEPS_HOME, tmpdir, ics, vevent, holdLock, lockHeld } from './helpers.mjs';
import { makeContext, createServer, parseConfig, applyConfigChanges, validate } from '../scripts/console.mjs';

const SECRETS = { hook: 'https://discord.com/api/webhooks/1234/SECRET-HOOK-TOKEN', key: 'sk-THIS_KEY_MUST_NEVER_SHOW_1234', ics: 'https://calendar.google.com/calendar/ical/me/private-SECRETCALTOKEN/basic.ics', token: 'feedbeef'.repeat(6) };
const CONFIG = `# my settings\nDISCORD_WEBHOOK_URL='${SECRETS.hook}'\nAI_API_KEY='${SECRETS.key}'\nAI_BASE_URL='https://api.deepseek.com'\nAI_MODEL='deepseek-chat'\nICS_URLS='${SECRETS.ics} ${SECRETS.ics}'\nBRIEF_TOKEN='${SECRETS.token}'\nBRIEF_IGNORE="Recess|Lunch"\nBRIEF_SOMETHING='x'\nthis line is broken\n`;
const servers = [];
after(() => { for (const s of servers) s.close(); });

function sandbox({ config = CONFIG, scriptsDir } = {}) {
  const home = tmpdir('con-home-'); const inbox = tmpdir('con-inbox-'); const fakeHome = tmpdir('con-fh-');
  fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), '');
  fs.mkdirSync(path.join(home, 'data', 'state'), { recursive: true }); fs.mkdirSync(path.join(home, 'logs'));
  fs.writeFileSync(path.join(home, 'config.local.env'), config.replace(/BRIEF_TOKEN=/, `BRIEF_INBOX='${inbox}'\nBRIEF_TOKEN=`), { mode: 0o600 });
  const ctx = makeContext({ home, fakeHome, skipLaunchctl: true, skipPmset: true, skipNotify: true, label: 'test.console', scriptsDir: scriptsDir || path.join(ROOT, 'scripts') });
  const token = 'ab'.repeat(24);
  const server = createServer(ctx, { token, port: 0 }); servers.push(server);
  return new Promise((resolve) => server.on('listening', () => resolve({ home, inbox, ctx, token, port: server.address().port, server, fakeHome })));
}
function req(sb, method, p, { body, headers = {}, cookie = true, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = http.request({ host: '127.0.0.1', port: sb.port, method, path: p, headers: { Host: `127.0.0.1:${sb.port}`, ...(cookie ? { Cookie: `brief_console=${sb.token}` } : {}), ...(method !== 'GET' ? { 'X-Brief-Console': '1' } : {}), ...(data !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* html */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
const cfgText = (sb) => fs.readFileSync(path.join(sb.home, 'config.local.env'), 'utf8');
const envSh = (home) => spawnSync('bash', ['-c', `. "${ROOT}/scripts/env.sh"; printf '%s|%s|%s|%s' "$DISCORD_WEBHOOK_URL" "$BRIEF_TZ" "$BRIEF_NOTE" "$BRIEF_CONFIG_ERRORS"`], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpdir('fh-'), BRIEF_HOME: home } }).stdout;

// ================= access control =================
test('console: without the one-time link nothing is served; the link sets a strict cookie; the page carries a CSP', async () => {
  const sb = await sandbox();
  assert.equal((await req(sb, 'GET', '/', { cookie: false })).status, 403);
  assert.equal((await req(sb, 'GET', '/api/overview', { cookie: false })).status, 403);
  assert.equal((await req(sb, 'GET', `/?t=${'00'.repeat(24)}`, { cookie: false })).status, 403);
  const login = await req(sb, 'GET', `/?t=${sb.token}`, { cookie: false });
  assert.equal(login.status, 303); assert.match(login.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  const page = await req(sb, 'GET', '/'); assert.equal(page.status, 200); assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/); assert.equal(page.headers['x-frame-options'], 'DENY');
});
test('console: a request under another host name (DNS rebinding) is refused even with the right cookie', async () => {
  const sb = await sandbox();
  for (const host of [`evil.example:${sb.port}`, `127.0.0.1.nip.io:${sb.port}`, '127.0.0.1']) assert.equal((await req(sb, 'GET', '/api/overview', { headers: { Host: host } })).status, 421, host);
});
test('console: a change without the custom header (a plain form post from another page) is refused', async () => {
  const sb = await sandbox();
  const r = await req(sb, 'POST', '/api/settings', { body: { changes: { BRIEF_NOTE: 'x' } }, headers: { 'X-Brief-Console': '' } });
  assert.equal(r.status, 403); assert.doesNotMatch(cfgText(sb), /BRIEF_NOTE/);
});
test('console: it only listens on 127.0.0.1', async () => {
  const sb = await sandbox(); assert.equal(sb.server.address().address, '127.0.0.1');
});

// ================= secrets never reach the page =================
test('console: no secret value appears in ANY answer (settings, overview, logs), only harmless hints', async () => {
  const sb = await sandbox();
  fs.writeFileSync(path.join(sb.home, 'logs', `run-${new Date().toLocaleDateString('sv')}.log`), `2026-10-01 08:00:01 [x] FAIL: posting to ${SECRETS.hook} failed with key ${SECRETS.key}\n`);
  const all = [];
  for (const p of ['/api/settings', '/api/overview', '/api/logs?which=run', '/api/tasks', '/api/inbox']) all.push((await req(sb, 'GET', p)).text);
  const text = all.join('\n');
  for (const s of [...Object.values(SECRETS), 'SECRET-HOOK-TOKEN', 'SECRETCALTOKEN', 'THIS_KEY_MUST_NEVER_SHOW']) assert.ok(!text.includes(s), `leaked: ${s.slice(0, 20)}`);
  const settings = (await req(sb, 'GET', '/api/settings')).json;
  const f = (k) => settings.fields.find((x) => x.key === k);
  assert.equal(f('DISCORD_WEBHOOK_URL').set, true); assert.equal(f('DISCORD_WEBHOOK_URL').hint, 'discord.com');
  assert.match(f('ICS_URLS').hint, /1 个（另有 1 个重复）.*calendar\.google\.com/);
  assert.equal(f('AI_MODEL').value, 'deepseek-chat', 'plain settings are shown'); assert.equal(f('BRIEF_IGNORE').value, 'Recess|Lunch');
  assert.deepEqual(settings.errors, [11]); assert.deepEqual(settings.extra, ['BRIEF_SOMETHING']);
});

// ================= settings writes =================
test('console: the reader is the same as scripts/env.sh (same values, same unreadable lines)', () => {
  const home = tmpdir('con-parse-'); const text = "DISCORD_WEBHOOK_URL='a b'\nBRIEF_TZ=Asia/Hong_Kong\nexport BRIEF_NOTE=\"x\\\\y\"\r\nPATH='/evil'\nbad line\n# comment\n";
  fs.writeFileSync(path.join(home, 'config.local.env'), text);
  const p = parseConfig(text);
  assert.equal(envSh(home), `${p.values.DISCORD_WEBHOOK_URL}|${p.values.BRIEF_TZ}|${p.values.BRIEF_NOTE ?? ''}|${p.errors.join(',')}`);
});
test('console: invalid values are refused field by field and the file is not touched', async () => {
  const sb = await sandbox(); const before = cfgText(sb);
  const r = await req(sb, 'POST', '/api/settings', { body: { changes: { BRIEF_TZ: 'Mars/Base', BRIEF_EVENT_DAYS: '40', BRIEF_IGNORE: '(', BRIEF_BASE_DATE: '2026-02-30', BRIEF_NOTE: "it's", DISCORD_WEBHOOK_URL: 'ftp://x', N8N_PORT: '1234', BRIEF_TOKEN: 'x', PATH: '/evil' } } });
  assert.equal(r.status, 400);
  for (const k of ['BRIEF_TZ', 'BRIEF_EVENT_DAYS', 'BRIEF_IGNORE', 'BRIEF_BASE_DATE', 'BRIEF_NOTE', 'DISCORD_WEBHOOK_URL', 'N8N_PORT', 'BRIEF_TOKEN', 'PATH']) assert.ok(r.json.fieldErrors[k], k);
  assert.equal(cfgText(sb), before);
  assert.equal((await req(sb, 'POST', '/api/settings', { body: { changes: { DISCORD_WEBHOOK_URL: null } } })).status, 400, 'a required setting cannot be cleared');
  assert.equal((await req(sb, 'POST', '/api/settings', { body: { changes: { BRIEF_NOTE: 'a\nb' } } })).status, 400, 'no line breaks');
});
test('console: a good save keeps every other line, writes single-quoted values privately, keeps a private .bak, and the scripts read it back', async () => {
  const sb = await sandbox();
  const r = await req(sb, 'POST', '/api/settings', { body: { changes: { BRIEF_TZ: 'Asia/Shanghai', BRIEF_NOTE: '加油 & $HOME | (ok)', BRIEF_EVENT_DAYS: '5', BRIEF_AUTO_CONFIRM: '1', BRIEF_IGNORE: null, AI_API_KEY: 'sk-new-key-value-0000' } } });
  assert.equal(r.status, 200, r.text);
  const t = cfgText(sb);
  assert.match(t, /^# my settings$/m); assert.match(t, /^BRIEF_SOMETHING='x'$/m); assert.match(t, /^this line is broken$/m, 'lines it does not own are left alone');
  assert.match(t, /^BRIEF_NOTE='加油 & \$HOME \| \(ok\)'$/m); assert.doesNotMatch(t, /BRIEF_IGNORE/); assert.match(t, /^AI_API_KEY='sk-new-key-value-0000'$/m); assert.equal(t.match(/AI_API_KEY/g).length, 1);
  assert.equal((fs.statSync(path.join(sb.home, 'config.local.env')).mode & 0o777).toString(8), '600');
  assert.equal((fs.statSync(path.join(sb.home, 'config.local.env.bak')).mode & 0o777).toString(8), '600');
  assert.ok(fs.readFileSync(path.join(sb.home, 'config.local.env.bak'), 'utf8').includes(SECRETS.key), 'the backup is the file as it was');
  assert.equal(envSh(sb.home), `${SECRETS.hook}|Asia/Shanghai|加油 & $HOME | (ok)|9`, 'env.sh reads exactly what was saved');
  assert.ok(!r.text.includes('sk-new-key-value-0000'), 'the new secret is not echoed back');
});
test('console: calendar links: webcal:// becomes https://, duplicates are dropped, anything else is refused', () => {
  assert.deepEqual(validate('ICS_URLS', `webcal://a.example/x.ics\nhttps://a.example/x.ics  https://b.example/y.ics`), ['https://a.example/x.ics https://b.example/y.ics', null]);
  assert.equal(validate('ICS_URLS', 'http://a.example/x.ics')[0], null);
  assert.equal(validate('AI_BASE_URL', 'http://127.0.0.1:11434/v1')[0], 'http://127.0.0.1:11434/v1', 'a local model is allowed');
  assert.equal(validate('BRIEF_AUTO_CONFIRM', 'no')[0], '', 'off removes the line');
  assert.equal(applyConfigChanges("A='1'\nexport B='2'\n", { B: '3', C: null }), "A='1'\nB='3'\n");
});

// ================= tasks =================
const HEADER = '﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注,我的列\r\n';
test('console: tasks can be edited and added; the file is backed up and custom columns survive', async () => {
  const sb = await sandbox(); const file = path.join(sb.inbox, 'tasks.csv');
  fs.writeFileSync(file, `${HEADER}待确认,Math,PS 1,2026/10/9,,a.pdf,2026-09-30,,keep me\r\n进行中,Bio,Lab,2026-10-12,,b.pdf,2026-09-30,,\r\n`);
  const view = (await req(sb, 'GET', '/api/tasks')).json;
  assert.equal(view.rows.length, 2); assert.equal(view.rows[0]._due, '2026-10-09'); assert.equal(view.rows[0]._kind, 'pending');
  const r = await req(sb, 'POST', '/api/tasks', { body: { version: view.version, updates: [{ index: 0, fields: { '状态': '进行中', '截止日': '2026-10-10' } }], additions: [{ '任务': 'Read ch. 3', '分类': 'Hist', '截止日': '2026-10-15' }] } });
  assert.equal(r.status, 200, r.text);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /进行中,Math,PS 1,2026-10-10,,a\.pdf,2026-09-30,,keep me/); assert.match(text, /进行中,Hist,Read ch\. 3,2026-10-15,,控制台,/); assert.match(text.split('\r\n')[0], /我的列/);
  assert.ok(fs.readFileSync(`${file}.bak`, 'utf8').includes('待确认,Math'), 'the previous file is kept');
});
test('console: a task table that changed since it was opened is not overwritten (Excel, or the morning run)', async () => {
  const sb = await sandbox(); const file = path.join(sb.inbox, 'tasks.csv');
  fs.writeFileSync(file, `${HEADER}待确认,Math,PS 1,2026-10-09,,a.pdf,2026-09-30,,\r\n`);
  const v = (await req(sb, 'GET', '/api/tasks')).json.version;
  fs.appendFileSync(file, '待确认,Bio,New from AI,2026-10-11,,c.pdf,2026-10-01,,\r\n');
  const r = await req(sb, 'POST', '/api/tasks', { body: { version: v, updates: [{ index: 0, fields: { '状态': '忽略' } }] } });
  assert.equal(r.status, 409); assert.equal(r.json.conflict, true); assert.match(fs.readFileSync(file, 'utf8'), /New from AI/);
});
test('console: while a run holds the lock, task changes wait (nothing is written); bad dates and unknown columns are refused', async () => {
  const sb = await sandbox(); const file = path.join(sb.inbox, 'tasks.csv');
  fs.writeFileSync(file, `${HEADER}待确认,Math,PS 1,2026-10-09,,a.pdf,2026-09-30,,\r\n`);
  const v = (await req(sb, 'GET', '/api/tasks')).json.version;
  assert.equal((await req(sb, 'POST', '/api/tasks', { body: { version: v, updates: [{ index: 0, fields: { '截止日': 'next week' } }] } })).status, 400);
  assert.equal((await req(sb, 'POST', '/api/tasks', { body: { version: v, updates: [{ index: 0, fields: { '来源': 'x' } }] } })).status, 400);
  const holder = await holdLock(path.join(sb.home, 'data', 'state'), 'run-brief');
  try {
    const r = await req(sb, 'POST', '/api/tasks', { body: { version: v, updates: [{ index: 0, fields: { '状态': '进行中' } }] } });
    assert.equal(r.status, 409); assert.equal(r.json.busy, true); assert.match(fs.readFileSync(file, 'utf8'), /待确认,Math/); assert.ok(lockHeld(path.join(sb.home, 'data', 'state')), 'the run keeps its lock');
  } finally { await holder.release(); }
});
test('console: the console itself holds the lock only while writing, so the scheduled run is never blocked afterwards', async () => {
  const sb = await sandbox(); fs.writeFileSync(path.join(sb.inbox, 'tasks.csv'), `${HEADER}待确认,Math,PS 1,2026-10-09,,a.pdf,2026-09-30,,\r\n`);
  const v = (await req(sb, 'GET', '/api/tasks')).json.version;
  assert.equal((await req(sb, 'POST', '/api/tasks', { body: { version: v, updates: [{ index: 0, fields: { '状态': '完成' } }] } })).status, 200);
  assert.equal(lockHeld(path.join(sb.home, 'data', 'state')), false);
});

// ================= inbox =================
test('console: uploads land in the inbox under a safe name; anything that could escape the folder or clash is refused', async () => {
  const sb = await sandbox();
  const up = (name, data = 'hello') => req(sb, 'POST', '/api/inbox/upload', { raw: data, headers: { 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' } });
  for (const bad of ['../evil.txt', '/etc/passwd.txt', 'a/b.txt', '.hidden.txt', '~$lock.docx', 'tasks.csv', 'tasks.csv.txt', 'run.sh', 'x.exe', '']) assert.equal((await up(bad)).status, 400, bad);
  assert.equal((await up('Syllabus 2026.pdf', 'pdf bytes')).json.saved, 'Syllabus 2026.pdf');
  assert.equal((await up('Syllabus 2026.pdf', 'other')).json.saved, 'Syllabus 2026 (2).pdf', 'an existing file is never overwritten');
  assert.deepEqual(fs.readdirSync(sb.inbox).sort(), ['Syllabus 2026 (2).pdf', 'Syllabus 2026.pdf']);
  assert.equal(fs.readdirSync(path.dirname(sb.inbox)).includes('evil.txt'), false);
  const list = (await req(sb, 'GET', '/api/inbox')).json; assert.equal(list.files.length, 2);
});
test('console: ignore/retry go through the inbox tool (and its lock)', async () => {
  const sb = await sandbox(); fs.writeFileSync(path.join(sb.inbox, 'a.txt'), 'A course document with enough readable text to be processed.\n');
  const r = await req(sb, 'POST', '/api/inbox/action', { body: { action: 'ignore', name: 'a.txt' } });
  assert.equal(r.status, 200, r.text); assert.equal(r.json.files[0].state, 'ignored');
  assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'delete', name: 'a.txt' } })).status, 400);
  assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'retry', name: '../a.txt' } })).status, 400);
});

// ================= overview and history =================
test('console: the 14-day history reads the markers and logs (sent time, unknown, failure, missed)', async () => {
  const sb = await sandbox(); const st = path.join(sb.home, 'data', 'state');
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toLocaleDateString('sv'); };
  fs.writeFileSync(path.join(st, 'installed-at'), day(5));
  fs.writeFileSync(path.join(st, `sent-${day(1)}`), ''); fs.writeFileSync(path.join(sb.home, 'logs', `run-${day(1)}.log`), `${day(1)} 08:00:42 [a] OK: brief sent (engine: n8n, mode: normal)\n${day(1)} 08:20:01 [b] already sent today (x), skipping\n`);
  fs.writeFileSync(path.join(st, `pending-${day(2)}`), 'x');
  fs.writeFileSync(path.join(sb.home, 'logs', `run-${day(3)}.log`), `${day(3)} 08:00:42 [a] FAIL: Webhook 返回 HTTP 500 at ${SECRETS.hook}\n`);
  const o = (await req(sb, 'GET', '/api/overview')).json; const h = Object.fromEntries(o.history.map((d) => [d.date, d]));
  assert.equal(h[day(1)].state, 'sent'); assert.equal(h[day(1)].sentAt, '08:00:42'); assert.equal(h[day(1)].engine, 'n8n');
  assert.equal(h[day(2)].state, 'unknown'); assert.equal(h[day(3)].state, 'failed'); assert.match(h[day(3)].fails[0], /<链接>/);
  assert.equal(h[day(4)].state, 'missed'); assert.equal(h[day(8)].state, 'none', 'before installation');
  assert.equal(o.today.state, 'today');
  assert.ok(o.checks.some((c) => /第 11 行看不懂/.test(c.text)));
});
test('console: an empty installation does not break the overview, and says what is missing', async () => {
  const sb = await sandbox({ config: '' });
  const o = (await req(sb, 'GET', '/api/overview')).json; assert.equal(o.level, 'warn');
  assert.ok(o.checks.some((c) => /没有 Discord Webhook/.test(c.text))); assert.ok(o.checks.some((c) => /工作流还没有部署/.test(c.text)));
});

// ================= actions =================
test('console: actions run the real scripts one at a time, and their output is cleaned of links and secrets', async () => {
  const scripts = tmpdir('con-scripts-'); fs.cpSync(path.join(ROOT, 'scripts', 'console'), path.join(scripts, 'console'), { recursive: true });
  fs.writeFileSync(path.join(scripts, 'run-brief.sh'), `#!/bin/bash\necho "mode $1"; echo "sent to ${SECRETS.hook}"; sleep 1\n`);
  const sb = await sandbox({ scriptsDir: scripts });
  const started = await req(sb, 'POST', '/api/jobs', { body: { kind: 'preview' } }); assert.equal(started.status, 200);
  assert.equal((await req(sb, 'POST', '/api/jobs', { body: { kind: 'test' } })).status, 409, 'one at a time');
  let job; for (let i = 0; i < 50; i++) { job = (await req(sb, 'GET', '/api/jobs/current')).json; if (job.state !== 'running') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.state, 'done'); assert.match(job.output, /mode --dry-run/); assert.match(job.output, /<链接>/); assert.ok(!job.output.includes('SECRET-HOOK-TOKEN'));
  assert.equal((await req(sb, 'POST', '/api/jobs', { body: { kind: 'rm-rf' } })).status, 400);
  assert.equal((await req(sb, 'POST', '/api/jobs', { body: { kind: 'schedule', param: '25:00; rm -rf /' } })).status, 400);
});
test('console: changing the time runs install-launchd.sh from the runtime folder itself (nothing to sync, no error)', () => {
  const home = tmpdir('con-ld-'); const fakeHome = tmpdir('con-ldh-'); const bin = tmpdir('con-ldb-');
  fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime', ''), ''); fs.mkdirSync(path.join(home, 'logs'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(home, 'scripts'), { recursive: true }); fs.copyFileSync(path.join(ROOT, 'config.example.env'), path.join(home, 'config.example.env'));
  fs.writeFileSync(path.join(bin, 'launchctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const r = spawnSync('bash', [path.join(home, 'scripts', 'install-launchd.sh'), '09:15'], { encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}`, HOME: fakeHome, BRIEF_HOME: home, BRIEF_LABEL: 'test.console-ld' } });
  assert.equal(r.status, 0, r.stderr); assert.match(fs.readFileSync(path.join(fakeHome, 'Library', 'LaunchAgents', 'test.console-ld.plist'), 'utf8'), /<integer>9<\/integer><key>Minute<\/key><integer>15<\/integer>/);
});

// ================= starting it twice =================
test('console: when its port is busy (for example a console already open in another terminal) it uses the next free one; an explicit --port is not changed', async () => {
  const home = tmpdir('con-cli-'); fs.writeFileSync(path.join(home, '.n8n-morning-brief-runtime'), '');
  const blocker = http.createServer().listen(0, '127.0.0.1'); await new Promise((r) => blocker.on('listening', r));
  const busy = blocker.address().port;
  const startCli = (args) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'console.mjs'), '--no-open', ...args], { env: { PATH: process.env.PATH, HOME: tmpdir('con-cli-h-'), BRIEF_HOME: home, BRIEF_CONSOLE_PORT: String(busy) } });
    let out = ''; let done = false;
    const finish = (code) => { if (!done) { done = true; resolve({ p, out, code }); } };
    p.stdout.on('data', (d) => { out += d; if (/\/\?t=/.test(out)) finish(null); }); p.stderr.on('data', (d) => { out += d; }); p.on('exit', finish);
  });
  try {
    const auto = await startCli([]);
    try { assert.equal(auto.code, null, auto.out); assert.match(auto.out, new RegExp(`端口 ${busy} 被占用`)); assert.doesNotMatch(auto.out, new RegExp(`127\\.0\\.0\\.1:${busy}/`)); }
    finally { auto.p.kill(); }
    const explicit = await startCli([`--port=${busy}`]); assert.equal(explicit.code, 1); assert.match(explicit.out, /已被占用。换一个端口/);
  } finally { blocker.close(); }
});

// ================= inbox: undo ignore, move to Trash, read the text =================
test('console: an ignored file can be un-ignored, and any file can be moved to the Trash (not deleted)', async () => {
  const sb = await sandbox(); fs.writeFileSync(path.join(sb.inbox, 'a.txt'), 'A course document with enough readable text to be processed.\n');
  assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'ignore', name: 'a.txt' } })).json.files[0].state, 'ignored');
  const un = await req(sb, 'POST', '/api/inbox/action', { body: { action: 'unignore', name: 'a.txt' } });
  assert.equal(un.status, 200, un.text); assert.equal(un.json.files[0].state, 'new'); assert.match(un.json.message, /已取消忽略/);
  assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'unignore', name: 'a.txt' } })).status, 400, 'a file that is not ignored');
  const rm = await req(sb, 'POST', '/api/inbox/action', { body: { action: 'remove', name: 'a.txt' } });
  assert.equal(rm.status, 200, rm.text); assert.equal(rm.json.files.length, 0); assert.match(rm.json.message, /废纸篓/);
  assert.ok(fs.existsSync(path.join(sb.fakeHome, '.Trash', 'a.txt')), 'it is in the Trash, where it can be put back');
  // the same name again does not overwrite what is already in the Trash
  fs.writeFileSync(path.join(sb.inbox, 'a.txt'), 'second'); await req(sb, 'POST', '/api/inbox/action', { body: { action: 'remove', name: 'a.txt' } });
  assert.equal(fs.readdirSync(path.join(sb.fakeHome, '.Trash')).length, 2);
  for (const bad of ['../x.txt', 'tasks.csv', '-rf', '']) assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'remove', name: bad } })).status, 400, bad);
});
test('console: what the AI will read from a file can be shown, for text files and for extracted PDF/DOCX', async () => {
  const sb = await sandbox(); fs.writeFileSync(path.join(sb.inbox, 'notes.md'), '# Week 1\nRead chapter 1.');
  const t = (await req(sb, 'GET', '/api/inbox/text?name=notes.md')).json; assert.equal(t.ready, true); assert.match(t.text, /Read chapter 1/);
  fs.writeFileSync(path.join(sb.inbox, 'syl.pdf'), 'pdf bytes');
  assert.equal((await req(sb, 'GET', '/api/inbox/text?name=syl.pdf')).json.ready, false, 'not extracted yet');
  const hash = crypto.createHash('sha256').update('pdf bytes').digest('hex'); fs.mkdirSync(path.join(sb.home, 'data', 'state', 'extracted'), { recursive: true });
  fs.writeFileSync(path.join(sb.home, 'data', 'state', 'extracted', `${hash}.txt`), 'Extracted syllabus text');
  assert.match((await req(sb, 'GET', '/api/inbox/text?name=syl.pdf')).json.text, /Extracted syllabus/);
  for (const bad of ['../config.local.env', 'tasks.csv', 'nope.txt']) assert.equal((await req(sb, 'GET', `/api/inbox/text?name=${encodeURIComponent(bad)}`)).status, 400, bad);
});
test('console: the task table can be downloaded', async () => {
  const sb = await sandbox(); assert.equal((await req(sb, 'GET', '/api/tasks/download')).status, 404);
  fs.writeFileSync(path.join(sb.inbox, 'tasks.csv'), '﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注\r\n');
  const r = await req(sb, 'GET', '/api/tasks/download'); assert.equal(r.status, 200); assert.match(r.headers['content-disposition'], /attachment; filename="tasks-/); assert.match(r.text, /状态,分类/);
});

// ================= agenda =================
test('console: the agenda reads the CACHED calendar only (never the network) and lists deadlines from the task table', async () => {
  const sb = await sandbox(); const url = 'https://calendar.example/a.ics';
  const cfg = fs.readFileSync(path.join(sb.home, 'config.local.env'), 'utf8').replace(/^ICS_URLS=.*$/m, `ICS_URLS='${url}'`); fs.writeFileSync(path.join(sb.home, 'config.local.env'), cfg);
  fs.symlinkSync(path.join(DEPS_HOME, 'node_modules'), path.join(sb.home, 'node_modules'));
  const d = new Date(); const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(sb.home, 'data', 'state', 'calendar-cache'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 20)}.ics`), ics(vevent({ uid: 'x', lines: ['SUMMARY:Cached lecture', 'LOCATION:Room 101', `DTSTART;VALUE=DATE:${ymd}`, `DTEND;VALUE=DATE:${ymd}`.replace(/(\d{8})$/, (m) => { const t = new Date(d.getTime() + 86400000); return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`; })] })));
  const today = d.toLocaleDateString('sv'); const soon = new Date(d.getTime() + 2 * 86400000).toLocaleDateString('sv');
  fs.writeFileSync(path.join(sb.inbox, 'tasks.csv'), `﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注\r\n进行中,Math,PS 4,${soon},,a,${today},\r\n待确认,Math,Not yet,${soon},,a,${today},\r\n进行中,Bio,Far away,2099-01-01,,a,${today},\r\n`);
  const a = (await req(sb, 'GET', '/api/agenda')).json;
  assert.deepEqual(a.events.map((e) => [e.title, e.location, e.allDay]), [['Cached lecture', 'Room 101', true]]);
  assert.deepEqual(a.deadlines.map((x) => x.title), ['PS 4'], 'only active tasks due within 7 days');
  assert.ok(!JSON.stringify(a).includes('calendar.example'), 'the link is not in the answer');
});
test('console: without a calendar the agenda says so; the notification test runs as a job', async () => {
  const sb = await sandbox({ config: "DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/1/x'\n" });
  assert.equal((await req(sb, 'GET', '/api/agenda')).json.calendar, 'none');
  assert.equal((await req(sb, 'POST', '/api/jobs', { body: { kind: 'notify' } })).status, 200);
  let j; for (let i = 0; i < 20; i++) { j = (await req(sb, 'GET', '/api/jobs/current')).json; if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(j.state, 'done');
});

// ================= review round 6 =================
test('console: a secret split across two output chunks is still never shown (review R6-04)', async () => {
  const scripts = tmpdir('con-split-'); fs.cpSync(path.join(ROOT, 'scripts', 'console'), path.join(scripts, 'console'), { recursive: true });
  const key = SECRETS.key; const half = Math.floor(key.length / 2);
  fs.writeFileSync(path.join(scripts, 'run-brief.sh'), `#!/bin/bash\nprintf '%s' "key=${key.slice(0, half)}"; sleep 0.4; printf '%s\\n' "${key.slice(half)} done"; printf '%s' "${SECRETS.ics.slice(0, 30)}" >&2; sleep 0.3; printf '%s\\n' "${SECRETS.ics.slice(30)}" >&2\n`);
  const sb = await sandbox({ scriptsDir: scripts });
  await req(sb, 'POST', '/api/jobs', { body: { kind: 'preview' } });
  const seen = [];
  for (let i = 0; i < 40; i++) { const j = (await req(sb, 'GET', '/api/jobs/current')).json; seen.push(j.output); if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 60)); }
  const all = seen.join('\n');
  assert.ok(!all.includes(key), 'the AI key never appears, not even while the job is running');
  assert.ok(!all.includes('SECRETCALTOKEN'), 'the calendar link never appears');
  assert.match(seen[seen.length - 1], /key=<密钥> done/);
});
test('console: a failed diagnosis is shown as failed, not as a green "done" (Codex suggestion)', async () => {
  const sb = await sandbox({ config: "DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/1/x'\n" });
  await req(sb, 'POST', '/api/jobs', { body: { kind: 'checkai' } });
  let j; for (let i = 0; i < 20; i++) { j = (await req(sb, 'GET', '/api/jobs/current')).json; if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 50)); }
  assert.equal(j.state, 'failed'); assert.match(j.output, /没有配置 AI/);
});
test('console: impossible dates, odd row numbers and decomposed file names are handled (review small items)', async () => {
  const sb = await sandbox();
  const bad = await req(sb, 'POST', '/api/settings', { body: { changes: { BRIEF_BASE_DATE: '2026-13-01' } } });
  assert.equal(bad.status, 400); assert.ok(bad.json.fieldErrors.BRIEF_BASE_DATE);
  fs.writeFileSync(path.join(sb.inbox, 'tasks.csv'), '﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注\r\n待确认,M,T,2026-10-09,,a,2026-10-01,\r\n');
  const v = (await req(sb, 'GET', '/api/tasks')).json.version;
  for (const index of ['__proto__', -1, 1.5, '0']) assert.equal((await req(sb, 'POST', '/api/tasks', { body: { version: v, updates: [{ index, fields: { '状态': '进行中' } }] } })).status, 400, String(index));
  const nfd = 'Résumé.txt'; // é written as e + accent, as macOS file names can be
  const up = await req(sb, 'POST', '/api/inbox/upload', { raw: 'hello there', headers: { 'X-File-Name': encodeURIComponent(nfd), 'Content-Type': 'application/octet-stream' } });
  assert.equal(up.status, 200, up.text); assert.equal(up.json.saved, nfd.normalize('NFC'));
});
test('console: the page script is a separate file, scripts are not allowed inline, and the script also needs the session', async () => {
  const sb = await sandbox();
  const page = await req(sb, 'GET', '/'); assert.match(page.headers['content-security-policy'], /script-src 'self';/); assert.doesNotMatch(page.headers['content-security-policy'], /script-src[^;]*unsafe-inline/);
  assert.match(page.text, /<script src="\/app.js"><\/script>/); assert.doesNotMatch(page.text.replace('<script src="/app.js"></script>', ''), /<script/);
  assert.equal((await req(sb, 'GET', '/app.js')).status, 200); assert.equal((await req(sb, 'GET', '/app.js', { cookie: false })).status, 403);
});

// ================= review round 7 / v8 =================
test('console: while a job runs, not even the first part of a secret is shown (it is held back until its line is complete) (review R8-02)', async () => {
  const scripts = tmpdir('con-prefix-'); fs.cpSync(path.join(ROOT, 'scripts', 'console'), path.join(scripts, 'console'), { recursive: true });
  const key = SECRETS.key;
  fs.writeFileSync(path.join(scripts, 'run-brief.sh'), `#!/bin/bash\necho "first line"\nprintf '%s' "key=${key.slice(0, -1)}"; sleep 0.8; printf '%s\\n' "${key.slice(-1)} done"; echo "中文行"\n`);
  const sb = await sandbox({ scriptsDir: scripts });
  await req(sb, 'POST', '/api/jobs', { body: { kind: 'preview' } });
  const seen = []; let j;
  for (let i = 0; i < 60; i++) { j = (await req(sb, 'GET', '/api/jobs/current')).json; seen.push(j.output); if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 40)); }
  assert.ok(seen.some((o) => /first line/.test(o) && !/key=/.test(o)), 'complete lines are shown while running');
  for (const o of seen) assert.ok(!o.includes(key.slice(0, 12)), 'no prefix of the secret in any answer');
  assert.match(j.output, /key=<密钥> done\n中文行/);
});
test('console: "show text" never follows a symbolic link out of the inbox (review R8-03)', async () => {
  const sb = await sandbox(); const outside = path.join(tmpdir('con-outside-'), 'secret.txt'); fs.writeFileSync(outside, `top secret ${SECRETS.key}`);
  fs.symlinkSync(outside, path.join(sb.inbox, 'linked.txt')); fs.symlinkSync(path.dirname(outside), path.join(sb.inbox, 'dirlink.md'));
  for (const n of ['linked.txt', 'dirlink.md']) { const r = await req(sb, 'GET', `/api/inbox/text?name=${n}`); assert.equal(r.status, 400, n); assert.ok(!r.text.includes('top secret')); }
  const list = (await req(sb, 'GET', '/api/inbox')).json.files; const l = list.find((f) => f.name === 'linked.txt');
  assert.equal(l.state, 'unsupported'); assert.match(l.detail, /符号链接/);
  assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'retry', name: 'linked.txt' } })).status, 400);
  assert.equal((await req(sb, 'POST', '/api/inbox/action', { body: { action: 'remove', name: 'linked.txt' } })).status, 200, 'a link can be removed (only the link moves to the Trash)');
  assert.ok(fs.existsSync(outside), 'the file it pointed to is untouched');
});

test('console: the other stream\'s line break, a crash with an unfinished line, or no final newline never reveal a secret prefix (review R9-02)', async () => {
  const key = SECRETS.key;
  const cases = {
    crossStream: `printf '%s' "key=${key.slice(0, -1)}"; sleep 0.4; echo "a diagnostic line" >&2; sleep 0.6; printf '%s\\n' "${key.slice(-1)} done"`,
    crash: `echo "starting"; printf '%s' "key=${key.slice(0, -1)}"; sleep 0.3; exit 7`,
    noNewline: `echo "starting"; printf '%s' "the key is ${key}"`,
  };
  for (const [name, body] of Object.entries(cases)) {
    const scripts = tmpdir(`con-${name}-`); fs.cpSync(path.join(ROOT, 'scripts', 'console'), path.join(scripts, 'console'), { recursive: true });
    fs.writeFileSync(path.join(scripts, 'run-brief.sh'), `#!/bin/bash\n${body}\n`);
    const sb = await sandbox({ scriptsDir: scripts });
    await req(sb, 'POST', '/api/jobs', { body: { kind: 'preview' } });
    const seen = []; let j;
    for (let i = 0; i < 80; i++) { j = (await req(sb, 'GET', '/api/jobs/current')).json; seen.push(j.output); if (j.state !== 'running') break; await new Promise((r) => setTimeout(r, 30)); }
    for (const o of seen) assert.ok(!o.includes(key.slice(0, 8)), `${name}: no part of the secret in any answer`);
    if (name === 'crossStream') { assert.ok(seen.some((o) => /a diagnostic line/.test(o)), 'the other stream is still shown'); assert.match(j.output, /key=<密钥> done/); }
    if (name === 'crash') { assert.equal(j.state, 'failed'); assert.match(j.output, /starting/); assert.match(j.output, /key=<密钥…>/); }
    if (name === 'noNewline') assert.match(j.output, /the key is <密钥>/);
  }
});

// ================= first-run setup wizard =================
// A stand-in for Discord (GET on a webhook = its info) and an OpenAI-style model list, on this machine.
function fakeServices() {
  const seen = [];
  const srv = http.createServer((q, r) => {
    seen.push(`${q.method} ${q.url}`);
    const json = (code, o) => { r.writeHead(code, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (q.url === '/api/webhooks/1/good') return json(200, { id: '1', name: '我的简报频道', token: 'NEVER-SHOW-THIS' });
    if (q.url.startsWith('/api/webhooks/')) return json(404, { message: 'Unknown Webhook' });
    if (q.url === '/v1/models') {
      if (q.headers.authorization !== `Bearer ${SECRETS.key}`) return json(401, { error: 'bad key' });
      return json(200, { data: [{ id: 'deepseek-reasoner' }, { id: 'text-embedding-3-small' }, { id: 'deepseek-chat' }, { id: 'whisper-1' }] });
    }
    return json(404, {});
  }).listen(0, '127.0.0.1');
  servers.push(srv);
  return new Promise((resolve) => srv.on('listening', () => resolve({ base: `http://127.0.0.1:${srv.address().port}`, seen })));
}

test('setup wizard: the webhook check only READS the webhook, says what it found, and never echoes the address or its token', async () => {
  const sb = await sandbox(); const f = await fakeServices();
  const bad = await req(sb, 'POST', '/api/setup/webhook', { body: { url: 'https://example.com/hook' } });
  assert.equal(bad.json.ok, false); assert.match(bad.json.message, /discord\.com\/api\/webhooks/); assert.ok(!bad.text.includes('example.com/hook'));
  const ok = await req(sb, 'POST', '/api/setup/webhook', { body: { url: `${f.base}/api/webhooks/1/good` } });
  assert.equal(ok.json.ok, true); assert.equal(ok.json.name, '我的简报频道');
  assert.ok(!ok.text.includes('NEVER-SHOW-THIS') && !ok.text.includes('/api/webhooks/1/good'), 'nothing of the address or the token goes back');
  const gone = await req(sb, 'POST', '/api/setup/webhook', { body: { url: `${f.base}/api/webhooks/2/deleted` } });
  assert.equal(gone.json.ok, false); assert.match(gone.json.message, /不存在或已被删除/);
  assert.ok(f.seen.every((l) => l.startsWith('GET ')), `only GET requests reached "Discord": ${f.seen.join(', ')}`);
  assert.equal((await req(sb, 'POST', '/api/setup/webhook', { body: { url: `${f.base}/api/webhooks/1/good` }, headers: { 'X-Brief-Console': '' } })).status, 403, 'the same protection as every other change');
  assert.ok(!cfgText(sb).includes(f.base), 'checking saves nothing');
});

test('setup wizard: the model list uses the typed key or the saved one, leaves out models that cannot chat and suggests a fast one', async () => {
  const sb = await sandbox(); const f = await fakeServices();
  const wrong = await req(sb, 'POST', '/api/setup/models', { body: { base: `${f.base}/v1`, key: 'sk-wrong' } });
  assert.equal(wrong.json.ok, false); assert.match(wrong.json.message, /密钥不对/);
  const typed = await req(sb, 'POST', '/api/setup/models', { body: { base: `${f.base}/v1`, key: SECRETS.key } });
  assert.equal(typed.json.ok, true); assert.deepEqual(typed.json.models, ['deepseek-chat', 'deepseek-reasoner']); assert.equal(typed.json.suggested, 'deepseek-chat');
  const saved = await req(sb, 'POST', '/api/setup/models', { body: { base: `${f.base}/v1`, useSaved: true } });
  assert.equal(saved.json.ok, true, 'the key saved in the settings file is used');
  for (const r of [wrong, typed, saved]) assert.ok(!r.text.includes(SECRETS.key));
  assert.equal((await req(sb, 'POST', '/api/setup/models', { body: { base: 'ftp://x' } })).json.ok, false);
});

test('setup wizard: calendar links are checked before saving, and the overview says whether setup is still needed', async () => {
  const sb = await sandbox();
  const r = await req(sb, 'POST', '/api/setup/calendars', { body: { urls: 'http://insecure.example/cal.ics' } });
  assert.equal(r.json.ok, false); assert.match(r.json.message, /https/);
  assert.equal((await req(sb, 'POST', '/api/setup/calendars', { body: { urls: '' } })).json.ok, false);
  assert.equal((await req(sb, 'GET', '/api/overview')).json.setup.needed, false);
  const fresh = await sandbox({ config: "BRIEF_TOKEN='x'\n" });
  const o = (await req(fresh, 'GET', '/api/overview')).json.setup;
  assert.deepEqual([o.needed, o.discord, o.calendar, o.ai], [true, false, false, false]);
});

test('scripts started by the console get its own job label, so a console of another installation never touches this one\'s schedule', async () => {
  const sb = await sandbox();
  assert.equal(sb.ctx.childEnv().BRIEF_LABEL, 'test.console');
  assert.equal(makeContext({ home: sb.home }).childEnv().BRIEF_LABEL, process.env.BRIEF_LABEL || 'com.cc-workspace.n8n-morning-brief');
});
