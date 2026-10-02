#!/usr/bin/env node
// Direct engine: runs the SAME Code-node sources as the n8n workflow (workflows/src/*.js) in plain Node and delivers the
// brief to Discord. No n8n is started. Used for
//   * `run-brief.sh --dry-run`  : build the brief and print it, sending nothing and writing no delivery markers,
//   * `run-brief.sh --ingest`   : read the inbox now (the console's 「现在读取」): only the ingest step, nothing is sent,
//   * the fallback in run-brief.sh when n8n cannot be started at all (before any request was accepted),
//   * tests.
// Usage: node brief.mjs [--dry-run | --ingest] [--test] [--run=ID] [--missed=2026-09-28,2026-09-29]
// Exit codes: 0 sent; 4 Discord clearly did not take it (refused, or never connected); 3 unknown (it may have been
// delivered); 1 failed before sending. Any other ending (a crash, a signal) is judged by run-brief.sh from the attempt record.
// Settings come from the environment (run-brief.sh sources scripts/env.sh first).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadSource(name, srcDir) {
  const dir = srcDir || process.env.BRIEF_SRC_DIR || path.join(here, '..', 'workflows', 'src');
  return fs.readFileSync(path.join(dir, name), 'utf8')
    .replace(/^\/\/@include (\S+)$/gm, (_, inc) => fs.readFileSync(path.join(dir, 'lib', inc), 'utf8'));
}

// The same contract as n8n's `this.helpers.httpRequest` for the options the nodes use.
export function makeHttp(fetchImpl = globalThis.fetch) {
  return async function httpRequest({ method = 'GET', url, headers = {}, body, json = false, timeout = 30000 }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const init = { method, headers: { ...headers }, signal: ctl.signal };
      if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); if (!init.headers['Content-Type'] && !init.headers['content-type']) init.headers['Content-Type'] = 'application/json'; }
      const res = await fetchImpl(url, init);
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${res.status} ${text.slice(0, 200)}`), { httpCode: res.status, retryAfter: Math.max(0, Number(res.headers && res.headers.get && res.headers.get('retry-after')) || 0) });
      return json ? JSON.parse(text) : text;
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error(`timeout of ${timeout}ms exceeded`);
      throw e;
    } finally { clearTimeout(timer); }
  };
}

export async function runBrief({ env = process.env, missed = [], dryRun = false, ingestOnly = false, test = false, run = '', fetchImpl = globalThis.fetch, srcDir, log = () => {} } = {}) {
  const home = env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');
  const req = createRequire(path.join(home, 'package.json')); // ical.js lives next to n8n in the runtime folder (or in .test-deps for tests)
  const nodeEnv = { ...env, ...(test || dryRun ? { BRIEF_TEST: '1' } : {}), ...(dryRun ? { BRIEF_DRY_RUN: '1' } : {}) }; // a preview is always labelled as a test
  const http = makeHttp(fetchImpl);
  const outputs = { Webhook: { body: { missed, run, ...(test ? { test: true } : {}) } } };
  const $ = (name) => ({ first: () => ({ json: outputs[name] ?? {} }), all: () => [{ json: outputs[name] ?? {} }] });
  const step = async (file, name, input = {}) => {
    const t = Date.now();
    const fn = new AsyncFunction('require', '$env', '$', '$input', loadSource(file, srcDir));
    const out = await fn.call({ helpers: { httpRequest: http } }, req, nodeEnv, $, { first: () => ({ json: input }), all: () => [{ json: input }] });
    outputs[name] = out[0].json;
    log(`${name}: ${Date.now() - t} ms`);
    return outputs[name];
  };
  if (ingestOnly) {
    // Reading the inbox needs no calendar, only today's date in BRIEF_TZ (or the pinned test date).
    let tz = env.BRIEF_TZ || undefined;
    try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch { tz = undefined; } // an invalid zone: the system's
    const today = /^\d{4}-\d{2}-\d{2}$/.test(env.BRIEF_TODAY || '') ? env.BRIEF_TODAY : new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    outputs['Read calendars'] = { today, days: 0, calendars: 0, events: [], errors: [], warnings: [] };
    const ing = await step('ingest-files.js', 'Ingest files', outputs['Read calendars']);
    return { status: 'ingested', ...ing.ingest };
  }
  const cal = await step('read-calendars.js', 'Read calendars');
  const ing = await step('ingest-files.js', 'Ingest files', cal);
  const brief = await step('build-brief.js', 'Build brief', ing);
  const metrics = { events: brief.eventCount, tasks: brief.taskCount, newTasks: brief.newTasks, errors: brief.errorCount, ...brief.timing };
  if (dryRun) return { status: 'dry-run', message: brief.message, payload: brief.payload, ...metrics };

  // The very same node as in n8n: it records the attempt before posting and never repeats a request that may have arrived.
  const sent = (await step('send-discord.js', 'Send to Discord', brief)).send || {};
  if (sent.status === 'sent') return { status: 'sent', engine: 'direct', ...metrics };
  throw Object.assign(new Error(sent.reason || 'not sent'), { outcomeUnknown: sent.status !== 'not_sent', notSent: sent.status === 'not_sent' });
}

// ---- command line ----
if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]))) {
  const args = process.argv.slice(2);
  const missedArg = (args.find((a) => a.startsWith('--missed=')) || '').slice(9);
  const runArg = (args.find((a) => a.startsWith('--run=')) || '').slice(6);
  const dryRun = args.includes('--dry-run');
  if (args.includes('--ingest')) {
    try {
      const r = await runBrief({ ingestOnly: true, log: (m) => process.stderr.write(`[brief] ${m}\n`) });
      const found = [r.newTasks ? `${r.newTasks} 条新任务` : '', r.newMilestones ? `${r.newMilestones} 个学习里程碑` : ''].filter(Boolean).join('、');
      if (!r.files && !r.remaining && !found) process.stdout.write('收件箱里没有要读的新文件。读过的文件不会再读；想重读一个，在收件箱里点它的「重新读」。\n');
      else process.stdout.write(`${r.files ? `读完 ${r.files} 个文件` : '这次没有读完的文件'}：${found ? `找到 ${found}（都是「待确认」，到「任务」页确认后才进简报）` : '没有找到新任务'}。\n`);
      if (r.remaining) process.stdout.write(`还有 ${r.remaining} 个文件没读完，下一次运行（或再点一次「现在读取」）继续。\n`);
      for (const e of r.errors || []) process.stdout.write(`· ${String(e).replace(/https?:\/\/\S+/g, '<link>')}\n`);
    } catch (e) {
      process.stderr.write(`brief.mjs failed: ${String(e.message || e).replace(/https?:\/\/\S+/g, '<link>')}\n`);
      process.exit(1);
    }
    process.exit(0);
  }
  try {
    const res = await runBrief({ dryRun, run: runArg, test: args.includes('--test') || dryRun, missed: missedArg.split(',').filter(Boolean), log: (m) => process.stderr.write(`[brief] ${m}\n`) });
    if (dryRun) { process.stdout.write(`${res.message}\n`); process.stderr.write(`[dry-run] nothing was sent; ${res.events} events, ${res.tasks} active tasks, ${res.errors} messages\n`); }
    else process.stdout.write(`${JSON.stringify(res)}\n`);
  } catch (e) {
    process.stderr.write(`brief.mjs failed: ${String(e.message || e).replace(/https?:\/\/\S+/g, '<link>')}\n`);
    process.exit(e && e.outcomeUnknown ? 3 : e && e.notSent ? 4 : 1);
  }
}
