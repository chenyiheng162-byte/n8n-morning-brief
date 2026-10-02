#!/usr/bin/env node
// Local control console for the morning brief: health, history, settings, tasks, inbox, logs and actions in one page.
// Start it with scripts/console.sh. It listens on 127.0.0.1 only and prints a one-time link; nothing is reachable from
// other machines, and other web pages cannot use it (random session token, Host check, custom header on every change).
//
// Secrets (Discord webhook, calendar links, AI key, webhook token) are NEVER sent to the browser: the page only learns
// whether they are set and a harmless hint (for example the host name). Changes go through the same rules as the shell
// scripts: single-quoted values in a private (0600) file written atomically, the shared run lock for task and inbox
// changes, and the existing scripts for sending, previewing and scheduling.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { acquireLock, lockBusy, lockHolder } from './lock.mjs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
const env0 = process.env;
export const HOME_DIR = env0.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');

// ---------------------------------------------------------------- settings file ----------------------------------------
const ALLOWED_KEY = /^(DISCORD_WEBHOOK_URL|ICS_URLS|AI_\w+|BRIEF_\w+|N8N_\w+|EXECUTIONS_\w+)$/;
const RE_SINGLE = /^([A-Za-z_][A-Za-z0-9_]*)='([^']*)'$/;
const RE_DOUBLE = /^([A-Za-z_][A-Za-z0-9_]*)="((?:[^"$`\\]|\\[^"$`\\])*)"$/;
const RE_BARE = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:@%+,=?-]*)$/;

// The same strict reading as scripts/env.sh: returns the values and the numbers of the lines it could not use.
export function parseConfig(text) {
  const values = {}; const errors = [];
  String(text || '').split('\n').forEach((raw, i) => {
    let line = raw.replace(/\r$/, ''); if (line.startsWith('export ')) line = line.slice(7);
    if (line === '' || /^\s*#/.test(line)) return;
    const m = RE_SINGLE.exec(line) || RE_DOUBLE.exec(line) || RE_BARE.exec(line);
    if (!m || !ALLOWED_KEY.test(m[1]) || m[1] === 'BRIEF_HOME' || m[1] === 'BRIEF_STATE_DIR') { errors.push(i + 1); return; }
    values[m[1]] = m[2];
  });
  return { values, errors };
}

// Replace or remove keys, keep every other line exactly as it was. Values are written single-quoted, like config_set.
export function applyConfigChanges(text, changes) {
  const keys = new Set(Object.keys(changes));
  const kept = String(text || '').split('\n').filter((raw) => {
    const m = /^(?:export )?([A-Za-z_][A-Za-z0-9_]*)=/.exec(raw.replace(/\r$/, ''));
    return !(m && keys.has(m[1]));
  });
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  for (const [k, v] of Object.entries(changes)) if (v !== null) kept.push(`${k}='${v}'`);
  return `${kept.join('\n')}\n`;
}

function writePrivate(file, text) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file);
}

// Every setting the console knows. `secret`: never sent to the page. `readonly`: shown, changed elsewhere.
export const FIELDS = [
  { key: 'DISCORD_WEBHOOK_URL', group: '推送', label: 'Discord Webhook', type: 'url', secret: true, required: true, help: '频道设置 → 整合 → Webhook → 复制 URL。它等于发消息的钥匙。' },
  { key: 'ICS_URLS', group: '日历', label: '日历私人链接', type: 'urls', secret: true, help: 'Google 日历 → 设置 → 选日历 →「iCal 格式的私人地址」。可以有多个，每行一个。webcal:// 会自动换成 https://。' },
  { key: 'BRIEF_TZ', group: '日历', label: '时区', type: 'tz', help: '留空用系统时区。例如 Asia/Hong_Kong、Asia/Shanghai、America/New_York。' },
  { key: 'BRIEF_EVENT_DAYS', group: '日历', label: '往后看几天', type: 'int', min: 1, max: 14, placeholder: '3' },
  { key: 'BRIEF_IGNORE', group: '日历', label: '隐藏这些日程', type: 'regex', example: 'Recess|Lunch', help: '正则表达式，匹配标题就不显示。' },
  { key: 'BRIEF_STRIP', group: '日历', label: '标题里去掉', type: 'regex', example: '\\s*\\(Ext\\.?\\s*\\d+\\)', help: '正则表达式，从标题里删掉匹配的部分。' },
  { key: 'AI_BASE_URL', group: 'AI', label: '接口地址', type: 'url', example: 'https://api.deepseek.com', help: 'OpenAI 兼容接口。本机模型可以用 http://127.0.0.1:端口。' },
  { key: 'AI_MODEL', group: 'AI', label: '模型', type: 'text', example: 'deepseek-chat' },
  { key: 'AI_API_KEY', group: 'AI', label: 'API 密钥', type: 'text', secret: true, help: '本机模型可以留空。' },
  { key: 'BRIEF_AI_TIMEOUT_MS', group: 'AI', label: '单次请求超时（毫秒）', type: 'int', min: 10000, max: 600000, placeholder: '90000' },
  { key: 'BRIEF_BASE_DATE', group: '文件与任务', label: '第 1 周周一', type: 'date', help: '文件里写「第 N 周周 X」时用它换算日期。' },
  { key: 'BRIEF_AUTO_CONFIRM', group: '文件与任务', label: '日期明确的任务直接算「进行中」', type: 'bool', help: '默认关：AI 抽出的任务都先「待确认」。' },
  { key: 'BRIEF_MILESTONES', group: '文件与任务', label: '学习里程碑', type: 'select', options: ['1', '0'], labels: ['从课程大纲提取（推荐）', '不要'], placeholder: '1', help: '课程大纲里有每周进度时，生成「某天前学完某章」的学习目标（也会在考核前一周提醒学完它考的内容）。按周排的大纲要先填「第 1 周周一」。' },
  { key: 'BRIEF_CHUNK_CHARS', group: '文件与任务', label: '每段字符数', type: 'int', min: 4000, max: 60000, placeholder: '24000' },
  { key: 'BRIEF_INGEST_BUDGET_MS', group: '文件与任务', label: '读文件的时间预算（毫秒）', type: 'int', min: 20000, max: 500000, placeholder: '150000' },
  { key: 'BRIEF_VIEW', group: '简报外观', label: '样式', type: 'select', options: ['compact', 'full'], labels: ['精简', '完整（多显示耗时）'], placeholder: 'compact' },
  { key: 'BRIEF_NOTE', group: '简报外观', label: '固定附言', type: 'text', help: '每份简报末尾附一句话。' },
  { key: 'BRIEF_FALLBACK', group: '高级', label: 'n8n 起不来时', type: 'select', options: ['direct', 'none'], labels: ['改用直连模式发送', '不发送，只报警'], placeholder: 'direct' },
  { key: 'BRIEF_ENGINE', group: '高级', label: '引擎', type: 'select', options: ['n8n', 'direct'], labels: ['n8n（默认）', '直连（不启动 n8n）'], placeholder: 'n8n' },
  { key: 'BRIEF_EXEC_KEEP_DAYS', group: '高级', label: '失败记录保留天数', type: 'int', min: 1, max: 60, placeholder: '3' },
  { key: 'N8N_PORT', group: '高级', label: 'n8n 端口', type: 'int', readonly: true, help: '定时任务里也记着它，请用 install.sh 修改。' },
  { key: 'BRIEF_INBOX', group: '高级', label: '收件夹', type: 'text', readonly: true, help: '定时任务里也记着它，请用 install.sh 修改。' },
  { key: 'BRIEF_TOKEN', group: '高级', label: 'Webhook 令牌', type: 'text', secret: true, readonly: true, help: '部署时自动生成，只在本机。' },
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const SECRET_KEYS = FIELDS.filter((f) => f.secret).map((f) => f.key);

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };
function hintFor(key, value) {
  if (!value) return '';
  if (key === 'ICS_URLS') { const list = value.split(/\s+/).filter(Boolean); const uniq = new Set(list); const hosts = [...new Set(list.map(hostOf).filter(Boolean))]; return `${uniq.size} 个${list.length !== uniq.size ? `（另有 ${list.length - uniq.size} 个重复）` : ''} · ${hosts.join('、')}`; }
  if (key === 'DISCORD_WEBHOOK_URL') return hostOf(value) || '格式不像网址';
  return '只保存在本机';
}

const zoneExists = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { return false; } return fs.existsSync(path.join('/usr/share/zoneinfo', tz)); };
// Returns [normalisedValue, null] or [null, message]. An empty string means "remove the setting".
export function validate(key, raw) {
  const f = FIELD[key];
  if (!f) return [null, '未知的设置项'];
  if (f.readonly) return [null, '这个设置不能在控制台修改'];
  let v = String(raw ?? '');
  if (/[\r\n]/.test(v) && f.type !== 'urls') return [null, '不能包含换行'];
  if (v.includes("'")) return [null, '不能包含单引号 \''];
  v = f.type === 'urls' ? v : v.trim();
  if (v === '') return f.required ? [null, '这是必填项'] : ['', null];
  switch (f.type) {
    case 'url': if (!/^https:\/\/\S+$/.test(v) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/.test(v)) return [null, '应以 https:// 开头（本机服务可用 http://127.0.0.1）']; return [v, null];
    case 'urls': {
      const list = v.split(/\s+/).filter(Boolean).map((u) => (u.startsWith('webcal://') ? `https://${u.slice(9)}` : u));
      const bad = list.find((u) => !/^https:\/\/\S+$/.test(u));
      if (bad) return [null, '每个链接都应以 https:// 或 webcal:// 开头'];
      return [[...new Set(list)].join(' '), null];
    }
    case 'int': { if (!/^\d+$/.test(v)) return [null, '应为整数']; const n = Number(v); if (n < f.min || n > f.max) return [null, `应在 ${f.min} 到 ${f.max} 之间`]; return [String(n), null]; }
    case 'tz': return zoneExists(v) ? [v, null] : [null, '不是有效的时区名（例如 Asia/Hong_Kong）'];
    case 'regex': try { new RegExp(v, 'i'); return [v, null]; } catch { return [null, '不是有效的正则表达式']; }
    case 'date': { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v); const d = m && new Date(`${v}T00:00:00Z`); if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) return [null, '应为 YYYY-MM-DD 格式的日期']; return [v, null]; }
    case 'bool': return /^(1|true|yes)$/i.test(v) ? ['1', null] : ['', null];
    case 'select': return f.options.includes(v) ? [v, null] : [null, `应为 ${f.options.join(' 或 ')}`];
    default: if (v.length > 300) return [null, '太长了']; return [v, null];
  }
}
function settingNotes(key, v) {
  if (key === 'BRIEF_BASE_DATE' && v && new Date(`${v}T00:00:00Z`).getUTCDay() !== 1) return '这一天不是周一：它应该是第 1 周周一的日期';
  return '';
}

// ---------------------------------------------------------------- shared helpers ---------------------------------------
export function makeContext(opts = {}) {
  const home = opts.home || HOME_DIR;
  const cfgFile = path.join(home, 'config.local.env');
  const readCfg = () => { try { return fs.readFileSync(cfgFile, 'utf8'); } catch { return ''; } };
  const cfg = () => parseConfig(readCfg());
  const stateDir = opts.stateDir || env0.BRIEF_STATE_DIR || path.join(home, 'data', 'state');
  const inbox = () => cfg().values.BRIEF_INBOX || opts.inbox || env0.BRIEF_INBOX || path.join(os.homedir(), 'n8n-inbox');
  const label = opts.label || env0.BRIEF_LABEL || 'com.cc-workspace.n8n-morning-brief';
  const scriptsDir = opts.scriptsDir || here;
  const nodeBin = fs.existsSync(path.join(home, '.runtime', 'node', 'bin', 'node')) ? path.join(home, '.runtime', 'node', 'bin', 'node') : process.execPath;
  // Child scripts get a CLEAN environment: they read the settings file themselves, so a setting removed in the console
  // cannot linger in an inherited variable.
  const childEnv = () => ({ PATH: `${path.dirname(nodeBin)}:/usr/bin:/bin:/usr/sbin:/sbin:${opts.extraPath || ''}`, HOME: opts.fakeHome || os.homedir(), BRIEF_HOME: home, LANG: env0.LANG || 'en_US.UTF-8', TMPDIR: env0.TMPDIR || '/tmp', BRIEF_LABEL: label, ...(opts.childEnv || {}) }); // the label too: a console of another installation must not touch this one's job
  const secretsNow = () => { const v = cfg().values; return SECRET_KEYS.flatMap((k) => String(v[k] || '').split(/\s+/)).filter((s) => s.length >= 8); };
  const clean = (text, extra = []) => { let t = String(text || '').replace(/https?:\/\/\S+/g, '<链接>'); for (const s of [...new Set([...secretsNow(), ...extra])].sort((a, b) => b.length - a.length)) t = t.split(s).join('<密钥>'); return t; };
  return { home, cfgFile, readCfg, cfg, stateDir, inbox, label, scriptsDir, nodeBin, childEnv, clean, secretsNow, opts };
}

function loadCsvLib(scriptsDir) {
  const candidates = [path.join(scriptsDir, '..', 'workflows', 'src', 'lib', 'csv.js'), path.join(HOME_DIR, 'workflows', 'src', 'lib', 'csv.js')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return null;
  const ctx = vm.createContext({});
  vm.runInContext(`${fs.readFileSync(file, 'utf8')}\nthis.api = { readTasks, writeTasks, statusKind, normalizeDate };`, ctx);
  return ctx.api;
}

// The run lock shared with run-brief.sh, deploy-workflow.sh and the inbox tool (scripts/lock.mjs).
async function takeLock(stateDir) { const r = await acquireLock(stateDir, 'console'); return r.ok ? r.release : null; }

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const exists = (f) => fs.existsSync(f);
const fmtDay = (d) => { const t = new Date(d); return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`; };

// ---------------------------------------------------------------- overview ---------------------------------------------
function scheduleInfo(ctx) {
  const plist = path.join(ctx.opts.fakeHome || os.homedir(), 'Library', 'LaunchAgents', `${ctx.label}.plist`);
  const info = { plist: exists(plist), loaded: false, slots: [], env: {} };
  if (info.plist) {
    const j = spawnSync('plutil', ['-convert', 'json', '-o', '-', plist], { encoding: 'utf8' });
    try {
      const p = JSON.parse(j.stdout);
      const iv = [].concat(p.StartCalendarInterval || []);
      info.slots = iv.map((x) => `${String(x.Hour).padStart(2, '0')}:${String(x.Minute).padStart(2, '0')}`);
      info.env = { N8N_PORT: p.EnvironmentVariables?.N8N_PORT || '', BRIEF_INBOX: p.EnvironmentVariables?.BRIEF_INBOX ? '已设置' : '' };
    } catch { /* unreadable */ }
  }
  if (!ctx.opts.skipLaunchctl) info.loaded = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${ctx.label}`], { encoding: 'utf8' }).status === 0;
  const pm = ctx.opts.skipPmset ? '' : spawnSync('pmset', ['-g', 'sched'], { encoding: 'utf8' }).stdout || '';
  info.wake = pm.split('\n').filter((l) => /wake|poweron/i.test(l) && /every day|MTWRFSU|repeat/i.test(l)).map((l) => l.trim()).slice(0, 2);
  return info;
}

export function history(ctx, days = 14) {
  const out = [];
  const now = ctx.opts.now ? new Date(ctx.opts.now) : new Date();
  const installed = (() => { try { return fs.readFileSync(path.join(ctx.stateDir, 'installed-at'), 'utf8').trim(); } catch { return ''; } })();
  for (let i = days - 1; i >= 0; i--) {
    const d = fmtDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
    const rec = { date: d, sent: exists(path.join(ctx.stateDir, `sent-${d}`)), pending: exists(path.join(ctx.stateDir, `pending-${d}`)), sentAt: '', engine: '', tests: 0, fails: [], skipped: 0, beforeInstall: installed && d < installed };
    let log = ''; try { log = fs.readFileSync(path.join(ctx.home, 'logs', `run-${d}.log`), 'utf8'); } catch { /* none */ }
    for (const line of log.split('\n')) {
      const m = /^\S+ (\d\d:\d\d:\d\d) \[[^\]]+\] (.*)$/.exec(line); if (!m) continue;
      const ok = /^OK: brief sent \(engine: (\w+), mode: (\w+)\)/.exec(m[2]);
      if (ok) { if (ok[2] === 'normal') { if (!rec.sentAt) { rec.sentAt = m[1]; rec.engine = ok[1]; } } else rec.tests++; }
      else if (/^FAIL: /.test(m[2])) rec.fails.push(`${m[1]} ${ctx.clean(m[2].slice(6)).slice(0, 160)}`);
      else if (/already sent today|SKIP:/.test(m[2])) rec.skipped++;
    }
    rec.state = rec.sent ? 'sent' : rec.pending ? 'unknown' : rec.fails.length ? 'failed' : d === fmtDay(now) ? 'today' : rec.beforeInstall ? 'none' : 'missed';
    out.push(rec);
  }
  return out;
}

// When the scheduled job will next really try to send. While today's brief is still open (not sent, outcome not unknown)
// a later retry slot today counts; once it is sent, or its outcome is unknown, the remaining slots today only skip, so
// the next attempt is the first slot of tomorrow.
export function nextRun(slots, todayState, now = new Date()) {
  if (!slots.length) return null;
  const at = (slot, addDays) => { const [h, m] = slot.split(':').map(Number); const t = new Date(now); t.setDate(t.getDate() + addDays); t.setHours(h, m, 0, 0); return t; };
  if (todayState !== 'sent' && todayState !== 'unknown') {
    const later = slots.map((s) => at(s, 0)).filter((t) => t > now).sort((a, b) => a - b)[0];
    if (later) return later.toISOString();
  }
  return at(slots[0], 1).toISOString();
}

export function overview(ctx) {
  const { values, errors } = ctx.cfg();
  const checks = [];
  const add = (level, text, fix = '') => checks.push({ level, text, fix });
  const marker = exists(path.join(ctx.home, '.n8n-morning-brief-runtime'));
  add(marker ? 'ok' : 'warn', marker ? '运行目录由安装程序创建' : '运行目录没有标志文件', marker ? '' : '运行 install.sh');
  const build = (() => { try { return fs.readFileSync(path.join(ctx.home, 'workflows', 'BUILD'), 'utf8').trim(); } catch { return ''; } })();
  const deployed = (() => { try { return fs.readFileSync(path.join(ctx.home, 'workflows', 'DEPLOYED'), 'utf8').trim(); } catch { return ''; } })();
  add(build ? 'ok' : 'warn', build ? `工作流版本 ${build}` : '工作流还没有部署', build ? '' : '运行 deploy-workflow.sh');
  const n8nVer = readJson(path.join(ctx.home, 'node_modules', 'n8n', 'package.json'))?.version || '';
  const wantVer = readJson(path.join(ctx.home, 'package.json'))?.dependencies?.n8n || '';
  const engine = values.BRIEF_ENGINE || 'n8n';
  if (engine === 'n8n') add(n8nVer && n8nVer === wantVer ? 'ok' : 'warn', n8nVer ? `n8n ${n8nVer}${n8nVer !== wantVer ? `（测试过的是 ${wantVer}）` : ''}` : '找不到 n8n');
  if (errors.length) add('warn', `设置文件第 ${errors.join('、')} 行看不懂，已跳过`, '在「设置」里重新保存，或手动修正为 KEY=\'值\'');
  if (!values.DISCORD_WEBHOOK_URL) add('warn', '没有 Discord Webhook：简报发不出去', '在「设置 → 推送」里填写');
  if (!values.ICS_URLS) add('info', '没有配置日历，简报里不会有日程');
  else { const l = values.ICS_URLS.split(/\s+/).filter(Boolean); if (new Set(l).size !== l.length) add('info', `日历链接里有 ${l.length - new Set(l).size} 个重复（只会读一次）`, '想接多个不同的日历，在「设置 → 日历」里重填'); }
  if (!values.AI_BASE_URL || !values.AI_MODEL) add('info', '没有配置 AI：收件夹里的文件不会被读取');
  const sched = scheduleInfo(ctx);
  add(sched.loaded ? 'ok' : 'warn', sched.loaded ? `定时任务已加载：每天 ${sched.slots.join('、')}` : '定时任务没有加载', sched.loaded ? '' : '在「工具」里重新设置时间');
  add(sched.wake.length ? 'ok' : 'info', sched.wake.length ? `定时唤醒：${sched.wake[0]}` : '没有设置定时唤醒：Mac 睡着时要等你唤醒电脑后才补发', sched.wake.length ? '' : '在「工具」里复制唤醒命令，到终端执行');
  const sysTz = (() => { try { return fs.readlinkSync('/etc/localtime').replace(/.*\/zoneinfo\//, ''); } catch { return ''; } })();
  const tz = values.BRIEF_TZ || sysTz;
  if (values.BRIEF_TZ && sysTz && values.BRIEF_TZ !== sysTz) add('warn', `定时按系统时区（${sysTz}）触发，简报的"今天"按 ${values.BRIEF_TZ}`, '两者不同时，简报可能属于另一天');
  // the lock is an operating-system lock: it is either held right now or free, it can never be left behind
  const running = lockBusy(ctx.stateDir) ? { holder: lockHolder(ctx.stateDir) } : null;
  const hist = history(ctx);
  const today = hist[hist.length - 1];
  const lastRun = readJson(path.join(ctx.stateDir, 'last-run.json'));
  if (lastRun && ['fail', 'unknown'].includes(lastRun.result)) add('warn', `最近一次运行${lastRun.result === 'unknown' ? '结果不明' : '失败'}：${ctx.clean(lastRun.reason)}`, '看「日志」');
  if (today.pending && !today.sent) add('warn', '今天有一次发送结果不明，为避免重复不会自动重发', '没收到的话，在「工具」里发送一份');
  const alerts = Number((() => { try { return fs.readFileSync(path.join(ctx.stateDir, `alerts-${today.date}`), 'utf8'); } catch { return 0; } })()) || 0;
  if (alerts) add('warn', `今天已发出 ${alerts} 条报警`, '看「日志」');
  const db = path.join(ctx.home, 'data', '.n8n', 'database.sqlite');
  const dbSize = exists(db) ? fs.statSync(db).size : 0;
  const level = checks.some((c) => c.level === 'warn') ? 'warn' : 'ok';
  return {
    now: new Date().toISOString(), home: ctx.home.replace(os.homedir(), '~'), level, checks, running,
    today: { date: today.date, state: today.state, sentAt: today.sentAt, engine: today.engine, alerts },
    nextRun: nextRun(sched.slots, today.state, ctx.opts.now ? new Date(ctx.opts.now) : new Date()), schedule: sched, tz, engine, build, deployed, n8nVersion: n8nVer,
    lastRun: lastRun ? { ...lastRun, reason: ctx.clean(lastRun.reason) } : null, history: hist, dbSize, consoleOutdated: !!(ctx.outdated && ctx.outdated()),
    setup: { needed: !values.DISCORD_WEBHOOK_URL, discord: !!values.DISCORD_WEBHOOK_URL, calendar: !!values.ICS_URLS, ai: !!(values.AI_BASE_URL && values.AI_MODEL), sysTz },
  };
}

// ---------------------------------------------------------------- settings ---------------------------------------------
export function settingsView(ctx) {
  const { values, errors } = ctx.cfg();
  const fields = FIELDS.map((f) => {
    const v = values[f.key] || '';
    return { ...f, set: !!v, value: f.secret ? '' : v, hint: f.secret ? hintFor(f.key, v) : '', note: settingNotes(f.key, v) };
  });
  const extra = Object.keys(values).filter((k) => !FIELD[k]);
  return { fields, extra, errors };
}

export function saveSettings(ctx, changes) {
  if (!changes || typeof changes !== 'object') return { ok: false, fieldErrors: { _: '没有收到修改' } };
  const clean = {}; const errs = {};
  for (const [k, raw] of Object.entries(changes)) {
    if (raw === null) { if (FIELD[k]?.required) errs[k] = '这是必填项'; else if (FIELD[k]?.readonly || !FIELD[k]) errs[k] = '不能删除这个设置'; else clean[k] = null; continue; }
    const [v, e] = validate(k, raw);
    if (e) errs[k] = e; else clean[k] = v === '' ? null : v;
  }
  if (Object.keys(errs).length) return { ok: false, fieldErrors: errs };
  const before = ctx.readCfg();
  if (before) writePrivate(`${ctx.cfgFile}.bak`, before);
  writePrivate(ctx.cfgFile, applyConfigChanges(before, clean));
  return { ok: true, saved: Object.keys(clean), notes: Object.fromEntries(Object.entries(clean).map(([k, v]) => [k, settingNotes(k, v)]).filter(([, n]) => n)) };
}

// ---------------------------------------------------------------- tasks ------------------------------------------------
const EDITABLE = ['状态', '分类', '任务', '截止日', '预估耗时', '备注'];
const STATUSES = ['待确认', '进行中', '完成', '忽略'];
export function tasksView(ctx) {
  const lib = loadCsvLib(ctx.scriptsDir);
  const file = path.join(ctx.inbox(), 'tasks.csv');
  if (!lib) return { error: '找不到任务表工具（csv.js）' };
  if (!exists(file)) return { rows: [], columns: ['状态', '分类', '任务', '截止日', '预估耗时', '来源', '添加时间', '备注'], version: '', statuses: STATUSES };
  try {
    const raw = fs.readFileSync(file);
    const rows = lib.readTasks(file, fs);
    return { rows: rows.map((r, i) => ({ ...r, _i: i, _kind: lib.statusKind(r['状态']), _due: lib.normalizeDate(r['截止日']) || '' })), columns: rows.columns || Object.keys(rows[0] || {}), version: crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16), statuses: STATUSES };
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
}

export async function saveTasks(ctx, { version, updates = [], additions = [] } = {}) {
  const lib = loadCsvLib(ctx.scriptsDir);
  if (!lib) return { status: 500, body: { error: '找不到任务表工具（csv.js）' } };
  for (const u of updates) for (const k of Object.keys(u.fields || {})) if (!EDITABLE.includes(k)) return { status: 400, body: { error: `不能修改「${k}」` } };
  for (const t of [...updates.map((u) => u.fields || {}), ...additions]) {
    for (const [k, v] of Object.entries(t)) if (String(v).length > 300 || /[\r\n]/.test(String(v))) return { status: 400, body: { error: `「${k}」太长或含换行` } };
    if (t['截止日'] && !lib.normalizeDate(t['截止日'])) return { status: 400, body: { error: `截止日「${t['截止日']}」认不出来，请写成 2026-10-09` } };
  }
  for (const a of additions) if (!String(a['任务'] || '').trim()) return { status: 400, body: { error: '新任务要有名称' } };
  const release = await takeLock(ctx.stateDir);
  if (!release) return { status: 409, body: { error: '简报正在运行（或在部署），请一两分钟后再保存。你的修改还在页面上。', busy: true } };
  try {
    const file = path.join(ctx.inbox(), 'tasks.csv');
    const now = exists(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16) : '';
    if (now !== (version || '')) return { status: 409, body: { error: '任务表在你打开之后被改过（可能是早上的运行或 Excel）。请刷新后再改。', conflict: true } };
    const rows = exists(file) ? lib.readTasks(file, fs) : Object.assign([], { columns: ['状态', '分类', '任务', '截止日', '预估耗时', '来源', '添加时间', '备注'] });
    for (const u of updates) { if (!Number.isInteger(u.index) || u.index < 0) return { status: 400, body: { error: '行号不对，请刷新' } }; const r = rows[u.index]; if (!r) return { status: 400, body: { error: '有一行已经不存在了，请刷新' } }; Object.assign(r, u.fields); }
    const today = fmtDay(new Date());
    for (const a of additions) rows.push({ '状态': a['状态'] || '进行中', '分类': a['分类'] || '', '任务': a['任务'].trim(), '截止日': a['截止日'] ? lib.normalizeDate(a['截止日']) : '', '预估耗时': a['预估耗时'] || '', '来源': '控制台', '添加时间': today, '备注': a['备注'] || '' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    lib.writeTasks(file, rows, fs, { backup: exists(file) });
    return { status: 200, body: { ok: true, ...tasksView(ctx) } };
  } finally { await release(); }
}

// ---------------------------------------------------------------- inbox ------------------------------------------------
function runTool(ctx, args) {
  const r = spawnSync(ctx.nodeBin, [path.join(ctx.scriptsDir, 'inbox-tool.mjs'), ...args], { encoding: 'utf8', env: { ...ctx.childEnv(), BRIEF_INBOX: ctx.inbox(), BRIEF_STATE_DIR: ctx.stateDir }, timeout: 60000 });
  return r;
}
export function inboxView(ctx) {
  const r = runTool(ctx, ['status', '--json']);
  try { const j = JSON.parse(r.stdout); return { ...j, inbox: j.inbox.replace(os.homedir(), '~') }; } catch { return { error: ctx.clean(r.stderr || r.stdout).slice(0, 300) }; }
}
const SUPPORTED = ['.pdf', '.docx', '.txt', '.md'];
export function saveUpload(ctx, name, buf) {
  const raw = String(name || '');
  const base = path.basename(raw).normalize('NFC');
  if (!base || path.basename(raw) !== raw || base.startsWith('.') || base.startsWith('~$') || /[\/\\\0]/.test(base)) return { status: 400, body: { error: '文件名不合法' } };
  if (/^tasks\.csv/i.test(base)) return { status: 400, body: { error: '不能用这个文件名' } };
  if (!SUPPORTED.includes(path.extname(base).toLowerCase())) return { status: 400, body: { error: '只支持 pdf、docx、txt、md' } };
  const dir = ctx.inbox(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let target = path.join(dir, base); let n = 1;
  while (exists(target)) { const ext = path.extname(base); target = path.join(dir, `${path.basename(base, ext)} (${++n})${ext}`); }
  fs.writeFileSync(`${target}.tmp`, buf, { mode: 0o600 }); fs.renameSync(`${target}.tmp`, target);
  return { status: 200, body: { ok: true, saved: path.basename(target) } };
}

// ---------------------------------------------------------------- logs -------------------------------------------------
export function logsView(ctx, which, date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : fmtDay(new Date());
  const f = which === 'n8n' ? path.join(ctx.home, 'logs', 'n8n-run.log') : which === 'launchd' ? path.join(ctx.home, 'logs', 'launchd.log') : path.join(ctx.home, 'logs', `run-${d}.log`);
  let text = '';
  try { const st = fs.statSync(f); const fd = fs.openSync(f, 'r'); const len = Math.min(st.size, 200000); const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, st.size - len); fs.closeSync(fd); text = b.toString('utf8'); } catch { text = ''; }
  const days = (() => { try { return fs.readdirSync(path.join(ctx.home, 'logs')).map((n) => /^run-(\d{4}-\d{2}-\d{2})\.log$/.exec(n)?.[1]).filter(Boolean).sort().reverse(); } catch { return []; } })();
  return { which: which || 'run', date: d, days, text: ctx.clean(text).split('\n').slice(-800).join('\n') };
}

// ---------------------------------------------------------------- jobs (one at a time) ----------------------------------
// ---------------------------------------------------------------- agenda (calendar cache only, never the network) --------
const srcDirOf = (ctx) => [path.join(ctx.scriptsDir, '..', 'workflows', 'src'), path.join(ctx.home, 'workflows', 'src')].find((d) => exists(path.join(d, 'read-calendars.js')));
let agendaMemo = { at: 0, key: '', val: null };
export async function agendaView(ctx) {
  // expanding a large calendar takes about a second: keep the answer for a minute unless the cache or settings changed
  const cacheDir = path.join(ctx.stateDir, 'calendar-cache');
  const key = `${ctx.readCfg().length}|${exists(cacheDir) ? fs.readdirSync(cacheDir).map((f) => fs.statSync(path.join(cacheDir, f)).mtimeMs).join(',') : ''}|${exists(path.join(ctx.inbox(), 'tasks.csv')) ? fs.statSync(path.join(ctx.inbox(), 'tasks.csv')).mtimeMs : ''}`;
  if (agendaMemo.val && agendaMemo.key === key && Date.now() - agendaMemo.at < 60000) return agendaMemo.val;
  const val = await agendaCompute(ctx);
  agendaMemo = { at: Date.now(), key, val };
  return val;
}
async function agendaCompute(ctx) {
  const v = ctx.cfg().values;
  const out = { events: [], deadlines: [], calendar: v.ICS_URLS ? 'cache' : 'none' };
  // upcoming deadlines from the task table: overdue and the next 7 days, active tasks only
  const t = tasksView(ctx);
  const today = fmtDay(new Date());
  const in7 = fmtDay(new Date(Date.now() + 7 * 86400000));
  // (learning milestones, 类型 = 里程碑, are targets, not deadlines)
  if (t.rows) out.deadlines = t.rows.filter((r) => r._kind === 'active' && r._due && r._due <= in7 && r['类型'] !== '里程碑').sort((a, b) => a._due.localeCompare(b._due)).slice(0, 12).map((r) => ({ title: r['任务'], course: r['分类'], due: r._due, overdue: r._due < today }));
  if (!v.ICS_URLS) return out;
  const src = srcDirOf(ctx);
  if (!src) return { ...out, calendar: 'error', error: '找不到日历读取代码' };
  // The very same calendar node as the brief, with the network switched off: it falls back to the copy the last run cached.
  try {
    const code = fs.readFileSync(path.join(src, 'read-calendars.js'), 'utf8').replace(/^\/\/@include (\S+)$/gm, (_, inc) => fs.readFileSync(path.join(src, 'lib', inc), 'utf8'));
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const req = createRequire(path.join(ctx.home, 'package.json'));
    const env = { ...v, BRIEF_HOME: ctx.home, BRIEF_STATE_DIR: ctx.stateDir, BRIEF_EVENT_DAYS: '4' };
    const fn = new AsyncFunction('require', '$env', '$', '$input', code);
    const res = (await fn.call({ helpers: { httpRequest: async () => { throw new Error('offline'); } } }, req, env, () => ({ first: () => ({ json: {} }) }), { first: () => ({ json: {} }) }))[0].json;
    out.events = res.events.map((e) => ({ title: e.title, location: e.location || '', allDay: !!e.allDay, day: e.allDay ? e.startDay : e.day, endDay: e.endDay, start: e.startHM || '', end: e.endHM || '' }));
    out.cachedAgeH = res.cached && res.cached.length ? Math.max(...res.cached) : null;
    if (res.failed) { out.calendar = 'stale'; }
  } catch (e) { return { ...out, calendar: 'error', error: ctx.clean(String(e.message)).slice(0, 160) }; }
  return out;
}

// What the AI is going to read from one inbox file (txt/md as they are, PDF/DOCX as the extracted text cache).
export function inboxText(ctx, name) {
  const dir = ctx.inbox(); const file = path.join(dir, String(name || ''));
  if (!name || name !== path.basename(name) || name.startsWith('.') || /^tasks\.csv/i.test(name)) return { status: 400, body: { error: '没有这个文件' } };
  // Opened without following a symbolic link, and checked on the opened file itself: only a real file in the inbox is shown,
  // never what a link points to (and swapping the file for a link at the last moment does not help either).
  let buf;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (!fs.fstatSync(fd).isFile()) return { status: 400, body: { error: '没有这个文件' } }; buf = fs.readFileSync(fd); } finally { fs.closeSync(fd); }
  } catch { return { status: 400, body: { error: '没有这个文件（或者它是符号链接，不会被读取）' } }; }
  const ext = path.extname(name).toLowerCase();
  let text = null;
  if (ext === '.txt' || ext === '.md') text = buf.toString('utf8');
  else if (ext === '.pdf' || ext === '.docx') {
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const cache = path.join(ctx.stateDir, 'extracted', `${hash}.txt`);
    if (exists(cache)) text = fs.readFileSync(cache, 'utf8');
    else return { status: 200, body: { name, ready: false, note: '文字还没有提取：下一次运行开始前会自动提取。' } };
  } else return { status: 200, body: { name, ready: false, note: '这种格式不会被读取。' } };
  return { status: 200, body: { name, ready: true, length: text.length, text: text.slice(0, 6000), more: Math.max(0, text.length - 6000) } };
}

async function testNotification(ctx) {
  if (ctx.opts.skipNotify) return '（测试环境：不弹出通知）';
  const r = spawnSync('osascript', ['-e', 'display notification "如果你看到了这条，本机通知可以正常弹出。" with title "每日简报" subtitle "测试通知"'], { encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0) return `通知没有发出去：${(r.stderr || '').trim().slice(0, 160) || '原因不明'}`;
  return '已请求 macOS 弹出一条通知，请看屏幕右上角。\n没看到的话：系统设置 → 通知 → 找到「脚本编辑器」（或「osascript」）并允许通知。\n注意：这里是从控制台发出的；定时任务由 launchd 启动，权限可能不同，以早上失败时是否弹出为准。';
}

const JOBS = {
  preview: { label: '预览简报', args: ['run-brief.sh', '--dry-run'] },
  test: { label: '发送测试简报', args: ['run-brief.sh', '--test'] },
  force: { label: '补发今天的简报', args: ['run-brief.sh', '--force'] },
  status: { label: '完整自检', args: ['status.sh'] },
  schedule: { label: '修改发送时间', args: ['install-launchd.sh'] },
  ingest: { label: '读取收件箱', args: ['run-brief.sh', '--ingest'] },
  checkai: { label: '测试 AI 连接', internal: true },
  checkcal: { label: '测试日历链接', internal: true },
  notify: { label: '测试本机通知', internal: true },
};
export function makeJobs(ctx) {
  let current = null; let seq = 0;
  const start = (kind, param) => {
    const def = JOBS[kind];
    if (!def) return { status: 400, body: { error: '未知的操作' } };
    if (current && current.state === 'running') return { status: 409, body: { error: `「${current.label}」还在进行，请稍等` } };
    const job = { id: ++seq, kind, label: def.label, state: 'running', startedAt: Date.now(), output: '', code: null };
    current = job;
    // The output is cleaned as a WHOLE every time, never piece by piece: a secret split across two chunks of a stream would
    // otherwise pass each piece's check and be put back together in the page. The secrets known when the job started are
    // also removed, in case a setting is changed while it runs.
    // Each stream (stdout, stderr) has its own buffer, and only its COMPLETE lines are shown: an unfinished line could
    // be the first part of a secret that cannot be recognised until its last character has arrived (and a line break in
    // the other stream says nothing about this one). When the job ends, an unfinished last line is shown only after any
    // ending that looks like the start of a known secret has been hidden.
    const startSecrets = ctx.secretsNow();
    const lines = []; const tails = { out: '', err: '' };
    const secretsAll = () => [...new Set([...ctx.secretsNow(), ...startSecrets])];
    const maskTail = (t) => {
      for (const sec of secretsAll()) for (let k = Math.min(sec.length - 1, t.length); k >= 4; k--) if (t.endsWith(sec.slice(0, k))) return `${t.slice(0, -k)}<密钥…>`;
      return t;
    };
    const publish = (final) => {
      let text = lines.join('\n') + (lines.length ? '\n' : '');
      if (final) for (const k of ['out', 'err']) if (tails[k]) text += `${maskTail(tails[k])}\n`;
      job.output = ctx.clean(text, startSecrets).slice(-60000);
    };
    const feed = (stream, t) => {
      tails[stream] += String(t);
      const parts = tails[stream].split('\n'); tails[stream] = parts.pop();
      lines.push(...parts);
      if (lines.length > 4000) lines.splice(0, lines.length - 3000);
      publish(false);
    };
    const append = (t) => { lines.push(...String(t).replace(/\n$/, '').split('\n')); publish(false); }; // messages of our own (whole lines)
    const end = (state, code) => { publish(true); job.code = code; job.state = state; job.endedAt = Date.now(); };
    if (def.internal) {
      ({ checkai: checkAi, checkcal: checkCalendars, notify: testNotification })[kind](ctx).then((text) => { append(text); end('done', 0); }, (e) => { append(String(e.message)); end('failed', 1); });
      return { status: 200, body: job };
    }
    const args = [...def.args];
    if (kind === 'schedule') { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(param || ''))) { current = null; return { status: 400, body: { error: '时间应为 HH:MM（24 小时制）' } }; } args.push(param); }
    const child = spawn('/bin/bash', [path.join(ctx.scriptsDir, args[0]), ...args.slice(1)], { env: ctx.childEnv(), cwd: ctx.home });
    // decode as streams: a multi-byte character split between two chunks must not turn into garbage
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => feed('out', d)); child.stderr.on('data', (d) => feed('err', d));
    const timer = setTimeout(() => { child.kill('SIGTERM'); append('（超过 25 分钟，已停止）'); }, 25 * 60 * 1000);
    child.on('close', (code) => { clearTimeout(timer); end(code === 0 ? 'done' : 'failed', code); });
    child.on('error', (e) => { append(String(e.message)); end('failed', 1); });
    return { status: 200, body: job };
  };
  return { start, get: () => current };
}

async function checkAi(ctx) {
  const v = ctx.cfg().values;
  if (!v.AI_BASE_URL || !v.AI_MODEL) throw new Error('没有配置 AI 接口地址或模型。');
  const headers = { 'Content-Type': 'application/json', ...(v.AI_API_KEY ? { Authorization: `Bearer ${v.AI_API_KEY}` } : {}) };
  const t = Date.now();
  const res = await fetch(`${v.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers, signal: AbortSignal.timeout(30000), body: JSON.stringify({ model: v.AI_MODEL, max_tokens: 5, messages: [{ role: 'user', content: 'Reply with OK.' }] }) }).catch((e) => ({ error: e }));
  if (res.error) throw new Error(`连不上 AI 服务：${res.error.cause?.code || res.error.message}`);
  const body = await res.text();
  if (!res.ok) throw new Error(`AI 服务返回 HTTP ${res.status}：${body.slice(0, 160)}\n${res.status === 401 ? '密钥不对或已失效。' : res.status === 404 ? '接口地址或模型名可能不对。' : ''}`);
  return `✅ AI 可用：模型 ${v.AI_MODEL} 在 ${Date.now() - t} 毫秒内回答了。（这次测试用了极少量的额度）`;
}
async function checkCalendars(ctx) {
  const list = [...new Set(String(ctx.cfg().values.ICS_URLS || '').split(/\s+/).filter(Boolean))];
  if (!list.length) throw new Error('没有配置日历链接。');
  const lines = await calendarLines(list);
  const text = lines.join('\n');
  if (!lines.every((l) => l.startsWith('✅'))) throw new Error(text);
  return text;
}
// One line per link, naming only its host: the link itself is a secret.
async function calendarLines(list) {
  return Promise.all(list.map(async (u, i) => {
    const t = Date.now();
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
      const text = await r.text();
      if (!r.ok) return `日历 ${i + 1}（${hostOf(u)}）：HTTP ${r.status}`;
      if (!/BEGIN:VCALENDAR/.test(text)) return `日历 ${i + 1}（${hostOf(u)}）：返回的不是日历（可能是登录页或链接失效）`;
      return `✅ 日历 ${i + 1}（${hostOf(u)}）：${(text.match(/BEGIN:VEVENT/g) || []).length} 个日程条目，${Math.round(text.length / 1024)} KB，${Date.now() - t} 毫秒`;
    } catch (e) { return `日历 ${i + 1}（${hostOf(u)}）：连不上（${e.cause?.code || e.name}）`; }
  }));
}

// ---------------------------------------------------------------- first-run setup --------------------------------------
// Checks for the setup wizard. They work on what was TYPED (not saved yet) and never send it back: an answer only says
// whether it works and what was found (a webhook's name, a calendar's host and number of entries, a list of models).
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/\S*)?$/;
const WEBHOOK = /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+\/?$/;
export async function checkWebhook(url) {
  const u = String(url || '').trim();
  if (!WEBHOOK.test(u) && !LOOPBACK.test(u)) return { ok: false, message: '这不像 Discord Webhook 地址：它应该以 https://discord.com/api/webhooks/ 开头。请在 Discord 里点「复制 Webhook URL」后再粘贴。' };
  try {
    // reading a webhook returns its name and posts nothing to the channel
    const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => ({}));
    if ([401, 403, 404].includes(r.status)) return { ok: false, message: '这个 Webhook 不存在或已被删除：请回到 Discord 重新复制。' };
    if (!r.ok) return { ok: false, message: `Discord 暂时没有正常回答（HTTP ${r.status}），稍后再试。` };
    const name = String(body.name || '').replace(/[\r\n]/g, ' ').slice(0, 80);
    return { ok: true, name, message: name ? `找到了 Webhook「${name}」` : '找到了这个 Webhook' };
  } catch (e) { return { ok: false, message: `连不上 Discord（${e.cause?.code || e.name}）：检查一下网络。` }; }
}
export async function checkCalendarInput(raw) {
  const [v, err] = validate('ICS_URLS', raw);
  if (err) return { ok: false, message: err };
  if (!v) return { ok: false, message: '还没有填写链接' };
  const lines = await calendarLines(v.split(' '));
  return { ok: lines.every((l) => l.startsWith('✅')), lines };
}
// Models that cannot write text are left out of the list; the suggestion avoids slow reasoning models.
const NOT_CHAT = /embed|whisper|tts|audio|dall-e|image|moderation|transcribe|realtime|search|babbage|davinci/i;
export async function listModels(ctx, { base, key, useSaved } = {}) {
  const [b, err] = validate('AI_BASE_URL', base);
  if (err || !b) return { ok: false, message: err || '请填写接口地址' };
  const k = useSaved ? (ctx.cfg().values.AI_API_KEY || '') : String(key || '').trim();
  if (/['\s]/.test(k)) return { ok: false, message: '密钥里不能有空格或单引号：请重新复制' };
  try {
    const r = await fetch(`${b.replace(/\/$/, '')}/models`, { headers: k ? { Authorization: `Bearer ${k}` } : {}, signal: AbortSignal.timeout(20000) });
    if (r.status === 401 || r.status === 403) return { ok: false, message: '密钥不对或已失效：请到服务商网站重新复制。' };
    if (r.status === 404) return { ok: false, message: '这个地址没有模型列表：接口地址可能不对（通常以 /v1 结尾，DeepSeek 是 https://api.deepseek.com）。' };
    if (!r.ok) return { ok: false, message: `服务返回 HTTP ${r.status}，稍后再试。` };
    const ids = (((await r.json().catch(() => ({}))).data) || []).map((m) => String(m?.id || '')).filter((id) => id && id.length < 120);
    const models = [...new Set(ids.filter((id) => !NOT_CHAT.test(id)))].sort();
    if (!models.length) return { ok: false, message: '连上了，但没有找到可以用的对话模型。' };
    const suggested = models.find((m) => m === 'deepseek-chat') || models.find((m) => !/reason|r1|o1|o3|think/i.test(m)) || models[0];
    return { ok: true, models, suggested };
  } catch (e) { return { ok: false, message: `连不上这个地址（${e.cause?.code || e.name}）：检查地址和网络。` }; }
}

// ---------------------------------------------------------------- HTTP server -------------------------------------------
export function createServer(ctx, { token, port }) {
  const jobs = makeJobs(ctx);
  // The page is read ONCE, when the console starts: a console that keeps running while the files are updated keeps serving
  // the page that matches its own code (a newer page talking to an older server is what produced "bad request").
  const files = ['console.mjs', path.join('console', 'index.html'), path.join('console', 'app.js')].map((f) => path.join(ctx.scriptsDir, f));
  const stamp = () => files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join(',');
  const startedStamp = stamp();
  const pageHtml = fs.readFileSync(files[1], 'utf8');
  const appJs = fs.readFileSync(files[2], 'utf8');
  const page = () => pageHtml;
  ctx.outdated = () => stamp() !== startedStamp;
  const allowedHosts = () => [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`];
  const send = (res, status, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", ...extra });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
  const cookieToken = (req) => (/(?:^|;\s*)brief_console=([0-9a-f]+)/.exec(req.headers.cookie || '') || [])[1] || '';
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

  const server = http.createServer(async (req, res) => {
    try {
      // Only this machine, only under the exact host names we listen on (blocks DNS-rebinding pages).
      if (!allowedHosts().includes(req.headers.host || '')) return send(res, 421, { error: 'wrong host' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/' && url.searchParams.get('t')) {
        if (!same(url.searchParams.get('t'), token)) return send(res, 403, '链接无效：请用启动控制台时终端里打印的链接。', 'text/plain; charset=utf-8');
        return send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': `brief_console=${token}; HttpOnly; SameSite=Strict; Path=/` });
      }
      if (!same(cookieToken(req), token)) return send(res, 403, '<!doctype html><meta charset="utf-8"><title>每日简报控制台</title><body style="font:16px system-ui;padding:40px">请用启动控制台时终端里打印的链接打开（链接里带本次启动有效的口令）。</body>', 'text/html; charset=utf-8');
      if (url.pathname === '/') return send(res, 200, page(), 'text/html; charset=utf-8');
      if (url.pathname === '/app.js') return send(res, 200, appJs, 'text/javascript; charset=utf-8');
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      // Every change must carry a header that a form or a cross-site request cannot add.
      if (req.method !== 'GET' && req.headers['x-brief-console'] !== '1') return send(res, 403, { error: 'missing header' });
      const route = `${req.method} ${url.pathname}`;
      const json = async () => { const b = await readBody(req, 1_000_000); try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('bad json'), { status: 400 }); } };
      switch (route) {
        case 'GET /api/overview': return send(res, 200, overview(ctx));
        case 'GET /api/settings': return send(res, 200, settingsView(ctx));
        case 'POST /api/settings': { const r = saveSettings(ctx, (await json()).changes); return send(res, r.ok ? 200 : 400, { ...r, ...settingsView(ctx) }); }
        case 'GET /api/tasks': return send(res, 200, tasksView(ctx));
        case 'GET /api/tasks/download': {
          const f = path.join(ctx.inbox(), 'tasks.csv');
          if (!exists(f)) return send(res, 404, { error: '还没有任务表' });
          return send(res, 200, fs.readFileSync(f), 'text/csv; charset=utf-8', { 'Content-Disposition': `attachment; filename="tasks-${fmtDay(new Date())}.csv"` });
        }
        case 'GET /api/agenda': return send(res, 200, await agendaView(ctx));
        case 'POST /api/setup/webhook': return send(res, 200, await checkWebhook((await json()).url));
        case 'POST /api/setup/calendars': return send(res, 200, await checkCalendarInput((await json()).urls));
        case 'POST /api/setup/models': return send(res, 200, await listModels(ctx, await json()));
        case 'GET /api/inbox/text': { const r = inboxText(ctx, url.searchParams.get('name')); return send(res, r.status, r.body); }
        case 'POST /api/tasks': { const r = await saveTasks(ctx, await json()); return send(res, r.status, r.body); }
        case 'GET /api/inbox': return send(res, 200, inboxView(ctx));
        case 'POST /api/inbox/action': {
          const { action, name, full } = await json();
          if (!['retry', 'ignore', 'unignore', 'remove'].includes(action) || typeof name !== 'string' || !name || name.includes('/') || name.startsWith('-')) return send(res, 400, { error: 'bad request' });
          const r = runTool(ctx, [action, name, ...(action === 'retry' && full ? ['--full'] : [])]);
          if (r.status === 3) return send(res, 409, { error: '简报正在运行，请一两分钟后再试' });
          return send(res, r.status === 0 ? 200 : 400, { ok: r.status === 0, message: ctx.clean((r.stdout || r.stderr).trim()), ...inboxView(ctx) });
        }
        case 'POST /api/inbox/upload': { const r = saveUpload(ctx, decodeURIComponent(String(req.headers['x-file-name'] || '')), await readBody(req, 30_000_000)); return send(res, r.status, r.body); }
        case 'GET /api/logs': return send(res, 200, logsView(ctx, url.searchParams.get('which'), url.searchParams.get('date')));
        case 'POST /api/jobs': { const { kind, param } = await json(); const r = jobs.start(kind, param); return send(res, r.status, r.body); }
        case 'GET /api/jobs/current': return send(res, 200, jobs.get() || {});
        case 'POST /api/shutdown': send(res, 200, { ok: true }); setTimeout(() => process.exit(0), 200); return undefined;
        default: return send(res, 404, { error: 'not found' });
      }
    } catch (e) { return send(res, e.status || 500, { error: e.status ? e.message : ctx.clean(String(e.message)).slice(0, 200) }); }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

// ---------------------------------------------------------------- command line ------------------------------------------
if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) {
  const args = process.argv.slice(2);
  const asked = Number((args.find((a) => a.startsWith('--port=')) || '').slice(7)) || 0;   // an explicit --port is used as given
  const first = asked || Number(env0.BRIEF_CONSOLE_PORT) || 5698;
  const token = crypto.randomBytes(24).toString('hex');
  const ctx = makeContext();
  // dates in the page follow the brief's own time zone, like the markers written by run-brief.sh
  const tz = ctx.cfg().values.BRIEF_TZ; if (tz && zoneExists(tz)) process.env.TZ = tz;
  if (!exists(ctx.home)) { console.error(`没有找到运行目录 ${ctx.home}：请先运行 install.sh`); process.exit(1); }
  // Without an explicit port, a busy one (for example a console already open in another terminal) is not an error:
  // the next free one of ten ports is used.
  const start = (port, triesLeft) => {
    const server = createServer(ctx, { token, port });
    server.on('error', (e) => {
      if (e.code === 'EADDRINUSE' && triesLeft > 0) { server.close(); start(port + 1, triesLeft - 1); return; }
      console.error(e.code === 'EADDRINUSE' ? (asked ? `端口 ${port} 已被占用。换一个端口：console.sh --port=${port + 1}` : `${first} 起的 10 个端口都被占用了：可能已经开了很多个控制台，关掉一些再试`) : e.message);
      process.exit(1);
    });
    server.on('listening', () => {
      const link = `http://127.0.0.1:${server.address().port}/?t=${token}`;
      const note = port !== first ? `（端口 ${first} 被占用，可能另一个终端里已经开着一个控制台；这次用 ${port}）\n` : '';
      console.log(`${note}每日简报控制台已启动（只有这台电脑能访问）：\n\n  ${link}\n\n关闭：按 Ctrl-C，或在页面「工具」里点「关闭控制台」。`);
      if (!args.includes('--no-open') && !env0.BRIEF_CONSOLE_NO_OPEN) spawn('open', [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    });
  };
  start(first, asked ? 0 : 9);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
}
