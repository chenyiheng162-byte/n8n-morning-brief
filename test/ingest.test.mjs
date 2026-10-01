import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runNode, tmpdir } from './helpers.mjs';

const setup = (files = {}, env = {}) => {
  const inbox = tmpdir('inbox-'); const state = tmpdir('state-');
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(inbox, n), c);
  return { inbox, state, env: { BRIEF_INBOX: inbox, BRIEF_STATE_DIR: state, AI_BASE_URL: 'https://ai.example', AI_MODEL: 'm', AI_API_KEY: 'k', BRIEF_BASE_DATE: '2026-08-31', ...env } };
};
const nodes = { 'Read calendars': { today: '2026-09-30', events: [], errors: [], calendars: 0, days: 3 } };
const ai = (perCall) => { let i = 0; const seenBodies = []; const fn = async ({ body }) => { seenBodies.push(body); const t = perCall[Math.min(i++, perCall.length - 1)]; if (t instanceof Error) throw t; return { choices: [{ message: { content: JSON.stringify({ tasks: t }) } }] }; }; fn.bodies = seenBodies; return fn; };
const readCsv = (inbox) => fs.readFileSync(path.join(inbox, 'tasks.csv'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r\n/).slice(1);
const TEXT = 'A course document with enough readable text to be processed.\n';

test('same-named assignments in different courses are both kept (review finding 2)', async () => {
  const { inbox, state, env } = setup({ 'math.txt': TEXT + 'math', 'phys.txt': TEXT + 'phys' });
  const http = ai([[{ category: 'Math', title: 'Problem set 1', due: '2026-10-02' }], [{ category: 'Physics', title: 'Problem set 1', due: '2026-10-02' }]]);
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(readCsv(inbox).length, 2, readCsv(inbox).join('\n'));
  assert.equal(r.ingest.newTasks, 2);
  assert.match(readCsv(inbox).join('\n'), /可能与「.*」里的同名任务重复/);
});

test('a course the AI names differently on a re-read is KEPT and flagged, never silently dropped', async () => {
  const { inbox, state, env } = setup({ 'eng.txt': TEXT });
  await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'English 9', title: 'Essay', due: '2026-10-03' }]]) });
  fs.writeFileSync(path.join(inbox, 'eng.txt'), TEXT + 'edited'); // new content hash -> processed again
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'DEMO English 9', title: 'Essay', due: '2026-10-03' }]]) });
  assert.equal(readCsv(inbox).length, 2); assert.equal(r.ingest.newTasks, 1);
  assert.match(readCsv(inbox)[1], /可能与「eng\.txt」里的同名任务重复/);
});

test('an exactly repeated task (same course, title and date) is not added twice', async () => {
  const { inbox, env } = setup({ 'eng.txt': TEXT });
  const t = [{ category: 'English 9', title: 'Essay', due: '2026-10-03' }];
  await runNode('ingest-files.js', { env, nodes, http: ai([t]) });
  fs.writeFileSync(path.join(inbox, 'eng.txt'), TEXT + 'edited');
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([t]) });
  assert.equal(readCsv(inbox).length, 1); assert.equal(r.ingest.newTasks, 0);
});

test('two courses in the SAME file with a same-named, same-day task are both kept (review: original scenario)', async () => {
  const { inbox, env } = setup({ 'courses.txt': TEXT });
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'Mathematics', title: 'Problem set 1', due: '2026-10-02' }, { category: 'Physics', title: 'Problem set 1', due: '2026-10-02' }]]) });
  assert.equal(readCsv(inbox).length, 2); assert.equal(r.ingest.newTasks, 2);
});

test('course names that merely contain each other (English 1 / English 10, Physics / Physics Lab) are different courses', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT + 'a', 'b.txt': TEXT + 'b' });
  const http = ai([[{ category: 'English 1', title: 'Midterm' }, { category: 'Physics', title: 'Quiz', due: '2026-10-02' }], [{ category: 'English 10', title: 'Midterm' }, { category: 'Physics Lab', title: 'Quiz', due: '2026-10-02' }]]);
  await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(readCsv(inbox).length, 4);
});

test('one invalid date does not block the valid tasks after it (review finding 11)', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT });
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([[
    { category: 'C', title: 'Before', due: '2026-10-01' }, { category: 'C', title: 'Bad', due: '2026-13-01' }, { category: 'C', title: 'After', due: '2026-10-05' }]]) });
  const rows = readCsv(inbox);
  assert.equal(rows.length, 3); assert.equal(r.ingest.errors.length, 0);
  assert.match(rows.find((x) => x.includes('Bad')), /无法识别的日期/);
  assert.match(rows.find((x) => x.includes('After')), /2026-10-05/);
});

test('dates far from today and absurd week numbers are blanked with a note', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT });
  await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'C', title: 'Far', due: '2031-01-01' }, { category: 'C', title: 'Week99', week: 99, weekday: 1 }, { category: 'C', title: 'Week7', week: 7, weekday: 5 }]]) });
  const rows = readCsv(inbox);
  assert.match(rows.find((x) => x.includes('Far')), /超过一年/); assert.doesNotMatch(rows.find((x) => x.includes('Far')), /2031-01-01,/);
  assert.match(rows.find((x) => x.includes('Week99')), /待确认,C,Week99,,/);
  assert.match(rows.find((x) => x.includes('Week7')), /2026-10-16/); // 2026-08-31 + 6 weeks + 4 days
});

test('finished work is saved after every file, so a later failure loses nothing (review finding N1)', async () => {
  const { inbox, state, env } = setup({ 'a.txt': TEXT + 'a', 'b.txt': TEXT + 'b' });
  const http = ai([[{ category: 'A', title: 'From a', due: '2026-10-02' }], new Error('boom')]);
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(readCsv(inbox).length, 1);
  const seen = JSON.parse(fs.readFileSync(path.join(state, 'processed.json'), 'utf8'));
  assert.equal(Object.keys(seen.done).length, 1);
  assert.equal(Object.values(seen.failed)[0], 1);
  assert.equal(r.ingest.errors.length, 1);
});

test('the time budget stops new AI calls and leaves the remaining files for tomorrow (review finding 1)', async () => {
  const { inbox, state, env } = setup({ 'a.txt': TEXT + 'a', 'b.txt': TEXT + 'b', 'c.txt': TEXT + 'c' }, { BRIEF_INGEST_BUDGET_MS: '150' });
  const http = async () => { await new Promise((r) => setTimeout(r, 200)); return { choices: [{ message: { content: '{"tasks":[]}' } }] }; };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.ok(r.ingest.remaining >= 1, `remaining=${r.ingest.remaining}`);
  assert.match(r.ingest.errors.join(), /明天继续处理/);
  const seen = JSON.parse(fs.readFileSync(path.join(state, 'processed.json'), 'utf8'));
  assert.ok(Object.keys(seen.done).length < 3);
  assert.equal(Object.keys(seen.failed).length, 0, 'running out of budget is not a failure');
});

test('a long document is split into chunks and every chunk is read (review: truncation)', async () => {
  const para = 'Assignment line with some words in it.\n';
  const big = para.repeat(1500) + 'Final exam on 2026-11-20\n'; // > 24,000 characters, the exam sits at the very end
  const { inbox, env } = setup({ 'long.txt': big });
  const http = ai([[{ category: 'L', title: 'Early', due: '2026-10-02' }], [{ category: 'L', title: 'Final exam', due: '2026-11-20' }]]);
  await runNode('ingest-files.js', { env, nodes, http });
  assert.ok(http.bodies.length >= 2, `AI calls: ${http.bodies.length}`);
  assert.ok(http.bodies.some((b) => b.messages[1].content.includes('Final exam on 2026-11-20')), 'the end of the document must reach the AI');
  assert.equal(readCsv(inbox).length, 2);
});

test('a damaged task table blocks ingestion: no AI call, file untouched (review finding N3)', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT });
  fs.writeFileSync(path.join(inbox, 'tasks.csv'), '乱码,列\r\n进行中,Important\r\n');
  const http = ai([[{ category: 'C', title: 'X', due: '2026-10-02' }]]);
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(http.bodies.length, 0);
  assert.equal(fs.readFileSync(path.join(inbox, 'tasks.csv'), 'utf8'), '乱码,列\r\n进行中,Important\r\n');
  assert.match(r.ingest.errors.join(), /表头无法识别/);
});

test('our own files, backups and Office lock files are never treated as documents', async () => {
  const { inbox, env } = setup({ 'tasks.csv.bak': 'x', '~$tasks.csv': 'x', '.hidden.txt': TEXT, 'tasks.csv.tmp': 'x' });
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([[]]) });
  assert.equal(r.ingest.errors.length, 0, r.ingest.errors.join());
});

test('a local model without an API key works', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT }, { AI_API_KEY: '', AI_BASE_URL: 'http://127.0.0.1:11434/v1' });
  let headers; const http = async (o) => { headers = o.headers; return { choices: [{ message: { content: '{"tasks":[]}' } }] }; };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(headers.Authorization, undefined); assert.equal(r.ingest.errors.length, 0);
});

test('error messages never contain links (they can be secrets)', async () => {
  const { env } = setup({ 'a.txt': TEXT });
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([new Error('request to https://api.example/v1/chat?key=SECRET failed')]) });
  assert.doesNotMatch(r.ingest.errors.join(), /SECRET|https:\/\//);
});

// ---------- long documents: checkpoints and fairness ----------
test('a long document resumes at the next chunk after the budget ran out, and eventually completes (review: chunk checkpoint)', async () => {
  const para = 'Assignment line with some words in it.\n';
  const big = para.repeat(2200); // about 88,000 characters = 4 chunks of at most 24,000
  const { inbox, state, env } = setup({ 'long.txt': big }, { BRIEF_INGEST_BUDGET_MS: '100' });
  const mk = () => { const calls = []; const fn = async ({ body }) => { const part = body.messages[1].content.match(/Part (\d+) of (\d+)/)?.[1]; calls.push(part); await new Promise((r) => setTimeout(r, 70)); return { choices: [{ message: { content: JSON.stringify({ tasks: [{ category: 'L', title: `Task from part ${part}`, due: '2026-10-02' }] }) } }] }; }; fn.calls = calls; return fn; };
  const seenParts = [];
  let last;
  for (let round = 0; round < 6; round++) {
    const http = mk();
    last = await runNode('ingest-files.js', { env, nodes, http });
    seenParts.push(...http.calls);
    if (last.ingest.remaining === 0 && last.ingest.files === 1) break;
  }
  assert.deepEqual([...new Set(seenParts)].sort(), ['1', '2', '3', '4'], `parts requested: ${seenParts.join(',')}`);
  assert.equal(seenParts.length, 4, 'no chunk is ever read twice');
  assert.equal(last.ingest.files, 1);
  assert.equal(readCsv(inbox).length, 4);
  const seen = JSON.parse(fs.readFileSync(path.join(state, 'processed.json'), 'utf8'));
  assert.equal(Object.keys(seen.done).length, 1); assert.deepEqual(seen.partial, {});
});

test('a huge document cannot starve the small files behind it (small files are read first)', async () => {
  const big = 'Assignment line with some words in it.\n'.repeat(2200);
  const { inbox, env } = setup({ 'a-huge.txt': big, 'z-small.txt': TEXT }, { BRIEF_INGEST_BUDGET_MS: '100' });
  const http = async () => { await new Promise((r) => setTimeout(r, 70)); return { choices: [{ message: { content: JSON.stringify({ tasks: [{ category: 'C', title: `T${Math.random()}`, due: '2026-10-02' }] }) } }] }; };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  const seen = JSON.parse(fs.readFileSync(path.join(env.BRIEF_STATE_DIR, 'processed.json'), 'utf8'));
  assert.ok(Object.values(seen.done).some((d) => d.file === 'z-small.txt'), 'the small file must complete in the first run');
  assert.ok(r.ingest.remaining >= 1);
});

test('a text-extraction problem is waited out, not counted as a failed attempt, and the file recovers afterwards (review: cache vs failure count)', async () => {
  const { inbox, state, env } = setup({ 'doc.pdf': 'fake pdf bytes that are long enough to hash' });
  const dir = path.join(state, 'extracted'); fs.mkdirSync(dir, { recursive: true });
  const hash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(path.join(inbox, 'doc.pdf'))).digest('hex');
  fs.writeFileSync(path.join(dir, `${hash}.err`), 'parser exploded');
  for (let i = 0; i < 4; i++) await runNode('ingest-files.js', { env, nodes, http: ai([[]]) }); // more than MAX_ATTEMPTS
  const seen = JSON.parse(fs.readFileSync(path.join(state, 'processed.json'), 'utf8'));
  assert.equal(seen.failed[hash], undefined, 'waiting for extraction must not be counted as a failure');
  fs.rmSync(path.join(dir, `${hash}.err`)); fs.writeFileSync(path.join(dir, `${hash}.txt`), TEXT + ' recovered text');
  const http = ai([[{ category: 'C', title: 'Recovered task', due: '2026-10-05' }]]);
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(http.bodies.length, 1); assert.equal(r.ingest.newTasks, 1);
});

test('columns the user added to tasks.csv survive an ingestion', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT });
  fs.writeFileSync(path.join(inbox, 'tasks.csv'), '\uFEFF状态,分类,任务,截止日,预估耗时,来源,添加时间,备注,优先级\r\n进行中,Math,Old task,2026-10-09,,x.txt,2026-09-01,,高\r\n');
  await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'C', title: 'New', due: '2026-10-02' }]]) });
  const text = fs.readFileSync(path.join(inbox, 'tasks.csv'), 'utf8').replace(/^\uFEFF/, '');
  assert.match(text.split('\r\n')[0], /,优先级$/); assert.match(text, /Old task.*,高\r\n/);
});

test('the .bak is the file exactly as the user left it, even when one run writes several times', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT + 'a', 'b.txt': TEXT + 'b', 'c.txt': TEXT + 'c' });
  const original = '\uFEFF状态,分类,任务,截止日,预估耗时,来源,添加时间,备注\r\n进行中,Math,User row,2026-10-09,,x.txt,2026-09-01,\r\n';
  fs.writeFileSync(path.join(inbox, 'tasks.csv'), original);
  await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'A', title: 'a1', due: '2026-10-02' }], [{ category: 'B', title: 'b1', due: '2026-10-03' }], [{ category: 'C', title: 'c1', due: '2026-10-04' }]]) });
  assert.equal(fs.readFileSync(path.join(inbox, 'tasks.csv.bak'), 'utf8'), original);
  assert.equal(readCsv(inbox).length, 4);
});

// ================= third-round additions: AI robustness and state recovery =================
const okBody = JSON.stringify({ tasks: [{ category: 'C', title: 'Real task', due: '2026-10-05' }] });
const oneFile = (env = {}) => setup({ 'a.txt': TEXT }, env);
const stateOf = (s) => JSON.parse(fs.readFileSync(path.join(s, 'processed.json'), 'utf8'));

test('a reply with prose around the JSON is still understood (review H3)', async () => {
  const { inbox, env } = oneFile();
  const r = await runNode('ingest-files.js', { env, nodes, http: async () => ({ choices: [{ message: { content: `Sure! Here are the tasks:\n${okBody}\nHope that helps.` } }] }) });
  assert.equal(r.ingest.newTasks, 1); assert.equal(r.ingest.errors.length, 0); assert.equal(readCsv(inbox).length, 1);
});

test('a JSON reply wrapped in a code fence, or with a single task object instead of a list, is understood', async () => {
  const a = oneFile(); const fenced = await runNode('ingest-files.js', { env: a.env, nodes, http: async () => ({ choices: [{ message: { content: '```json\n' + okBody + '\n```' } }] }) });
  assert.equal(fenced.ingest.newTasks, 1);
  const b = oneFile(); const single = await runNode('ingest-files.js', { env: b.env, nodes, http: async () => ({ choices: [{ message: { content: JSON.stringify({ tasks: { category: 'C', title: 'Solo', due: '2026-10-06' } }) } }] }) });
  assert.equal(single.ingest.newTasks, 1);
});

test('a provider that rejects response_format is retried without it, and remembered (review H3)', async () => {
  const { inbox, state, env } = setup({ 'a.txt': TEXT + 'a', 'b.txt': TEXT + 'b' });
  const bodies = [];
  const http = async ({ body }) => { bodies.push(!!body.response_format); if (body.response_format) throw Object.assign(new Error('400 Bad Request: response_format is not supported'), { httpCode: 400 }); return { choices: [{ message: { content: JSON.stringify({ tasks: [{ category: 'C', title: `T${bodies.length}`, due: '2026-10-05' }] }) } }] }; };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(r.ingest.newTasks, 2); assert.equal(r.ingest.errors.length, 0);
  assert.deepEqual(bodies, [true, false, false], 'tried once with, then never again');
  assert.equal(stateOf(state).aiCaps.noJsonMode, env.AI_BASE_URL, 'remembered for THIS provider');
});

test('empty content from a reasoning model gives an actionable message', async () => {
  const { env } = oneFile();
  const r = await runNode('ingest-files.js', { env, nodes, http: async () => ({ choices: [{ message: { content: '', reasoning_content: 'thinking...' } }] }) });
  assert.match(r.ingest.errors.join(), /没有返回内容.*BRIEF_AI_TIMEOUT_MS/);
});

test('a rate limit (429) is retried with a back-off, and is not counted as a failed attempt', { timeout: 30000 }, async () => {
  const { state, env } = oneFile();
  let calls = 0;
  const http = async () => { if (++calls === 1) throw Object.assign(new Error('Too many requests'), { httpCode: 429 }); return { choices: [{ message: { content: okBody } }] }; };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(calls, 2); assert.equal(r.ingest.newTasks, 1); assert.deepEqual(stateOf(state).failed, {});
});

test('a timeout on a long chunk splits it in half instead of failing (review H3)', async () => {
  const para = 'Assignment line with some words in it.\n';
  const { inbox, env } = setup({ 'a.txt': para.repeat(500) });
  const sizes = [];
  const http = async ({ body }) => { const len = body.messages[1].content.length; sizes.push(len); if (sizes.length === 1) throw new Error('timeout of 90000ms exceeded'); return { choices: [{ message: { content: JSON.stringify({ tasks: [{ category: 'C', title: `Half ${sizes.length}`, due: '2026-10-05' }] }) } }] }; };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(sizes.length, 3, `calls: ${sizes}`); assert.ok(sizes[1] < sizes[0] * 0.7 && sizes[2] < sizes[0] * 0.7);
  assert.equal(r.ingest.newTasks, 2); assert.equal(r.ingest.errors.length, 0);
});

test('old state with failed=3 and no timestamp gets one recovery attempt, then is paced to one per day (review: legacy failed state)', async () => {
  const { inbox, state, env } = oneFile();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, 'a.txt'))).digest('hex');
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, failed: { [hash]: 3 } }));
  const good = ai([[{ category: 'C', title: 'Recovered', due: '2026-10-05' }]]);
  const r = await runNode('ingest-files.js', { env, nodes, http: good });
  assert.equal(good.bodies.length, 1); assert.equal(r.ingest.newTasks, 1); assert.equal(stateOf(state).failed[hash], undefined, 'success clears the failure record');
});

test('a file that keeps failing is retried once a day at most, and finally given up on with ONE message', async () => {
  const { inbox, state, env } = oneFile();
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, 'a.txt'))).digest('hex');
  const boom = ai([new Error('boom')]);
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, failed: { [hash]: 3 }, failedAt: { [hash]: Date.now() } }));
  await runNode('ingest-files.js', { env, nodes, http: boom }); assert.equal(boom.bodies.length, 0, 'cooling off: tried less than a day ago');
  const later = (n) => fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ ...stateOf(state), failed: { [hash]: n }, failedAt: { [hash]: Date.now() - 25 * 3600 * 1000 } }));
  later(3); await runNode('ingest-files.js', { env, nodes, http: boom }); assert.equal(boom.bodies.length, 1, 'a day later: one more try');
  later(6); const r1 = await runNode('ingest-files.js', { env, nodes, http: boom });
  assert.equal(boom.bodies.length, 1, 'gave up: no more calls'); assert.match(r1.ingest.errors.join(), /已放弃/);
  const r2 = await runNode('ingest-files.js', { env, nodes, http: boom }); assert.equal(r2.ingest.errors.length, 0, 'told only once');
});

test('a document whose text can never be extracted is given up on after 5 tries with one clear message (review N3)', async () => {
  const { inbox, state, env } = setup({ 'bad.pdf': 'not really a pdf but long enough to hash' });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, 'bad.pdf'))).digest('hex');
  const dir = path.join(state, 'extracted'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${hash}.err`), JSON.stringify({ n: 2, msg: 'parser exploded', at: Date.now() }));
  const early = await runNode('ingest-files.js', { env, nodes, http: ai([[]]) });
  assert.match(early.ingest.errors.join(), /第 2 次/);
  fs.writeFileSync(path.join(dir, `${hash}.err`), JSON.stringify({ n: 5, msg: 'parser exploded', at: Date.now() }));
  const gave = await runNode('ingest-files.js', { env, nodes, http: ai([[]]) });
  assert.match(gave.ingest.errors.join(), /已尝试 5 次.*移走/); assert.equal(gave.ingest.remaining, 0, 'not "continue tomorrow"');
  const again = await runNode('ingest-files.js', { env, nodes, http: ai([[]]) });
  assert.equal(again.ingest.errors.length, 0, 'silent afterwards');
});

test('a document longer than the chunk limit is flagged now and then only once a week (review: truncation reminder)', async () => {
  const big = 'Assignment line with some words in it.\n'.repeat(7000); // > 10 chunks
  const { inbox, state, env } = setup({ 'huge.txt': big }, { BRIEF_INGEST_BUDGET_MS: '100000' });
  const http = async () => ({ choices: [{ message: { content: '{"tasks":[]}' } }] });
  const first = await runNode('ingest-files.js', { env, nodes, http });
  assert.match(first.ingest.errors.join(), /太长.*拆分/);
  const hash = Object.keys(stateOf(state).truncated)[0];
  const second = await runNode('ingest-files.js', { env, nodes: { 'Read calendars': { ...nodes['Read calendars'], today: '2026-10-02' } }, http });
  assert.doesNotMatch(second.ingest.errors.join(), /太长/, 'not repeated the next day');
  const s = stateOf(state); s.truncated[hash].remindedAt = '2026-09-20'; fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify(s)); // the file stays DONE, exactly as in real life
  const weekLater = await runNode('ingest-files.js', { env, nodes, http });
  assert.match(weekLater.ingest.errors.join(), /太长/, 'reminded again after a week');
});

test('progress records of files that no longer exist are cleaned up', async () => {
  const { inbox, state, env } = oneFile();
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, partial: { deadbeef: 4 }, truncated: { deadbeef: { file: 'gone' } } }));
  await runNode('ingest-files.js', { env, nodes, http: ai([[]]) });
  assert.deepEqual(stateOf(state).partial, {}); assert.deepEqual(stateOf(state).truncated, {});
});

test('BRIEF_AUTO_CONFIRM: explicit dates go straight to 进行中, unclear ones and possible duplicates still wait for you', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT + 'a', 'b.txt': TEXT + 'b' }, { BRIEF_AUTO_CONFIRM: '1' });
  const http = ai([[{ category: 'M', title: 'Clear', due: '2026-10-05' }, { category: 'M', title: 'Vague', due: null, note: 'sometime' }, { category: 'M', title: 'Weekly', week: 3, weekday: 2 }], [{ category: 'P', title: 'Clear', due: '2026-10-05' }]]);
  await runNode('ingest-files.js', { env, nodes, http });
  const rows = readCsv(inbox);
  assert.match(rows.find((x) => x.includes(',M,Clear,')), /^进行中/); assert.match(rows.find((x) => x.includes('Vague')), /^待确认/);
  assert.match(rows.find((x) => x.includes('Weekly')), /^待确认/, 'a date computed from a week number is not "explicit"');
  assert.match(rows.find((x) => x.includes(',P,Clear,')), /^待确认/, 'a possible duplicate always waits');
  const off = setup({ 'a.txt': TEXT }, {}); await runNode('ingest-files.js', { env: off.env, nodes, http: ai([[{ category: 'M', title: 'Clear', due: '2026-10-05' }]]) });
  assert.match(readCsv(off.inbox)[0], /^待确认/, 'off by default');
});

test('the AI is told the course names already in the table, so it can reuse the spelling (review O4)', async () => {
  const { inbox, env } = setup({ 'a.txt': TEXT });
  fs.writeFileSync(path.join(inbox, 'tasks.csv'), '﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注\r\n进行中,English 9,Essay,2026-10-09,,x.txt,2026-09-01,\r\n');
  const http = ai([[]]); await runNode('ingest-files.js', { env, nodes, http });
  assert.match(http.bodies[0].messages[1].content, /Known course names.*English 9/);
  assert.match(http.bodies[0].messages[0].content, /exact spelling/);
});

test('a task table that has only a header keeps the user\'s own columns after the first ingestion (review: header-only)', async () => {
  const { inbox, env } = oneFile();
  fs.writeFileSync(path.join(inbox, 'tasks.csv'), '﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注,优先级,人工备注\r\n');
  await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'C', title: 'First', due: '2026-10-05' }]]) });
  const header = fs.readFileSync(path.join(inbox, 'tasks.csv'), 'utf8').replace(/^﻿/, '').split('\r\n')[0];
  assert.equal(header, '状态,分类,任务,截止日,预估耗时,来源,添加时间,备注,优先级,人工备注');
});

test('an out-of-range or unknown setting does not break ingestion (review H1)', async () => {
  const { inbox, env } = oneFile({ BRIEF_CHUNK_CHARS: 'huge', BRIEF_AI_TIMEOUT_MS: 'abc' });
  const r = await runNode('ingest-files.js', { env, nodes, http: ai([[{ category: 'C', title: 'Fine', due: '2026-10-05' }]]) });
  assert.equal(r.ingest.newTasks, 1);
});

// ================= round 4 =================
const errJson = (state, hash, n, msg = 'parser exploded') => { const dir = path.join(state, 'extracted'); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, `${hash}.err`), JSON.stringify({ n, msg })); };
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

test('files that can never be read, or are waiting for extraction, do not take the places of files that can (review R4-05)', async () => {
  const files = {}; for (let i = 0; i < 10; i++) files[`d${i}.pdf`] = `fake pdf number ${i}`;
  files['z-real.txt'] = TEXT + 'and a little more text so that it is the largest file of all';
  const { inbox, state, env } = setup(files);
  for (let i = 0; i < 10; i++) errJson(state, sha(path.join(inbox, `d${i}.pdf`)), i < 5 ? 5 : 2);   // five given up, five still waiting
  const http = ai([[{ category: 'C', title: 'Real one', due: '2026-10-05' }]]);
  for (let round = 1; round <= 3; round++) {
    const r = await runNode('ingest-files.js', { env, nodes, http });
    if (round === 1) { assert.equal(r.ingest.newTasks, 1, 'the readable file is processed in the very first run'); assert.match(r.ingest.errors.join(), /已尝试 5 次/); assert.doesNotMatch(r.ingest.errors.join(), /明天继续处理/); }
    else assert.doesNotMatch(r.ingest.errors.join(), /已尝试 5 次/, 'the give-up notice is sent only once');
  }
  assert.equal(http.bodies.length, 1);
});

// the text the AI was sent, without the header lines
const sentText = (body) => { const c = body.messages[1].content; return c.slice(c.indexOf('\n\n') + 2); };
const slowAi = (texts, ms) => async ({ body }) => { texts.push(sentText(body)); if (texts.length === 1 && ms) await new Promise((r) => setTimeout(r, ms)); return { choices: [{ message: { content: '{"tasks":[]}' } }] }; };
const longDoc = () => Array.from({ length: 420 }, (_, i) => `L${String(i).padStart(4, '0')} ${'x'.repeat(30)}`).join('\n'); // about 15,000 characters
for (const [first, second] of [['4000', '8000'], ['8000', '4000']]) {
  test(`changing the chunk size between runs (${first} -> ${second}) leaves no hole and no overlap in what the AI reads (review R4-06)`, async () => {
    const doc = longDoc(); const { state, env } = setup({ 'doc.txt': doc });
    const texts = [];
    await runNode('ingest-files.js', { env: { ...env, BRIEF_CHUNK_CHARS: first, BRIEF_INGEST_BUDGET_MS: '100' }, nodes, http: slowAi(texts, 200) });
    assert.equal(texts.length, 1, 'the first run only got through one chunk (time budget)');
    assert.ok(stateOf(state).offset[Object.keys(stateOf(state).partial)[0]] > 0, 'progress is stored as a character position');
    await runNode('ingest-files.js', { env: { ...env, BRIEF_CHUNK_CHARS: second, BRIEF_INGEST_BUDGET_MS: '100000' }, nodes, http: slowAi(texts, 0) });
    assert.equal(texts.join(''), doc.trim(), 'exactly the whole document, once');
    assert.equal(Object.keys(stateOf(state).done).length, 1);
  });
}
test('state written by the previous version (a chunk number, no character position) is read again from the start: its chunk size is unknown (review R5-04)', async () => {
  const doc = longDoc(); const { inbox, state, env } = setup({ 'doc.txt': doc }, { BRIEF_CHUNK_CHARS: '8000' });
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, partial: { [sha(path.join(inbox, 'doc.txt'))]: 1 } })); // written with 4000-character chunks
  const texts = []; await runNode('ingest-files.js', { env, nodes, http: slowAi(texts, 0) });
  assert.equal(texts.join(''), doc.trim(), 'every character is read; nothing is skipped by guessing');
  assert.equal(Object.keys(stateOf(state).done).length, 1);
});

test('a slow chunk read in two halves keeps the half that succeeded even when time runs out, and continues with the other half (review R5-05)', async () => {
  const doc = longDoc(); const { inbox, state, env } = setup({ 'doc.txt': doc }, { BRIEF_INGEST_BUDGET_MS: '100' });
  const seenTexts = [];
  const http = async ({ body }) => {
    const t = sentText(body); seenTexts.push(t);
    if (t.length === doc.trim().length) throw new Error('timeout of 90000ms exceeded'); // the whole chunk is too slow
    await new Promise((r) => setTimeout(r, 150));                                       // the first half works, but uses up the budget
    return { choices: [{ message: { content: JSON.stringify({ tasks: [{ category: 'C', title: `From ${t.slice(0, 5).trim()}`, due: '2026-10-05' }] }) } }] };
  };
  const day1 = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(seenTexts.length, 2, 'whole chunk, then the first half; the second half waits for tomorrow');
  assert.equal(day1.ingest.newTasks, 1, 'the first half\'s task is saved'); assert.equal(stateOf(state).offset[sha(path.join(inbox, 'doc.txt'))], seenTexts[1].length);
  const day2texts = []; const day2 = await runNode('ingest-files.js', { env: { ...env, BRIEF_INGEST_BUDGET_MS: '100000' }, nodes, http: async ({ body }) => { day2texts.push(sentText(body)); return { choices: [{ message: { content: '{"tasks":[]}' } }] }; } });
  assert.equal(seenTexts[1] + day2texts.join(''), doc.trim(), 'the next day reads exactly the rest');
  assert.equal(day2.ingest.newTasks, 0); assert.equal(readCsv(inbox).length, 1, 'the first half is not read (or added) again');
  assert.equal(Object.keys(stateOf(state).done).length, 1);
});

test('the time budget also stops the retries and the halving of a slow request, without counting the file as failed (review)', async () => {
  const { state, env } = oneFile({ BRIEF_INGEST_BUDGET_MS: '100' });
  fs.writeFileSync(path.join(env.BRIEF_INBOX, 'a.txt'), 'line of text\n'.repeat(1000)); // long enough to be halved on a timeout
  let calls = 0;
  const http = async () => { calls++; await new Promise((r) => setTimeout(r, 150)); throw new Error('timeout of 90000ms exceeded'); };
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(calls, 1, 'no second request after the budget is gone');
  assert.deepEqual(stateOf(state).failed, {}, 'running out of time is not a failure of the file'); assert.match(r.ingest.errors.join(), /明天继续处理/);
});

test('a file that failed three times is tried again after 20 hours, not after a full 24 (review F6)', async () => {
  const { inbox, state, env } = oneFile(); const h = sha(path.join(inbox, 'a.txt'));
  const put = (ageMs) => fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, failed: { [h]: 3 }, failedAt: { [h]: Date.now() - ageMs } }));
  put(19 * 3600 * 1000); let http = ai([[]]); await runNode('ingest-files.js', { env, nodes, http }); assert.equal(http.bodies.length, 0, 'too early');
  put(21 * 3600 * 1000); http = ai([[]]); await runNode('ingest-files.js', { env, nodes, http }); assert.equal(http.bodies.length, 1, 'one late retry');
});

test('"no JSON mode" is remembered for the provider that said so, and a different provider is asked for JSON mode again', async () => {
  const a = oneFile(); const bodies = [];
  const picky = async ({ body }) => { bodies.push(!!body.response_format); if (body.response_format) throw Object.assign(new Error('400 response_format unsupported'), { httpCode: 400 }); return { choices: [{ message: { content: okBody } }] }; };
  await runNode('ingest-files.js', { env: a.env, nodes, http: picky });
  fs.writeFileSync(path.join(a.inbox, 'b.txt'), TEXT + 'second'); bodies.length = 0;
  await runNode('ingest-files.js', { env: { ...a.env, AI_BASE_URL: 'https://other-ai.example' }, nodes, http: picky });
  assert.equal(bodies[0], true, 'a new provider is asked with response_format again');
});

test('reading a document half a chunk per day still stops at 10 chunks and never rereads text (review R6-05)', { timeout: 120000 }, async () => {
  const line = (i) => `L${String(i).padStart(5, '0')} ${'y'.repeat(40)}\n`;
  const doc = Array.from({ length: 2400 }, (_, i) => line(i)).join(''); // about 113,000 characters: 15 chunks of 8,000
  const { state, env } = setup({ 'big.txt': doc }, { BRIEF_CHUNK_CHARS: '8000', BRIEF_INGEST_BUDGET_MS: '100' });
  const read = [];
  const http = async ({ body }) => {
    const t = sentText(body);
    if (t.length > 6000) throw new Error('timeout of 90000ms exceeded');   // a whole chunk is always too slow
    await new Promise((r) => setTimeout(r, 120)); read.push(t);           // a half works, and uses up the day's budget
    return { choices: [{ message: { content: '{"tasks":[]}' } }] };
  };
  let days = 0;
  for (; days < 40; days++) { await runNode('ingest-files.js', { env, nodes, http }); if (Object.keys(stateOf(state).done).length) break; }
  const joined = read.join('');
  assert.ok(Object.keys(stateOf(state).done).length === 1, 'the file is finished');
  assert.equal(doc.trim().startsWith(joined), true, 'what was read is one continuous stretch from the start, nothing twice');
  const tenChunks = (() => { let rest = doc.trim(); let n = 0; for (let i = 0; i < 10; i++) { let cut = rest.lastIndexOf('\n', 8000); if (cut < 4000) cut = 8000; n += cut; rest = rest.slice(cut); } return n; })();
  assert.equal(joined.length, tenChunks, 'exactly ten logical chunks were read, not the whole document');
  const after = read.length; await runNode('ingest-files.js', { env, nodes, http }); assert.equal(read.length, after, 'nothing more once finished');
});

test('a symbolic link in the inbox is not read (it could point anywhere), and it is said once (review R8-03)', async () => {
  const { inbox, env } = setup({});
  const outside = path.join(tmpdir('ing-outside-'), 'private.txt'); fs.writeFileSync(outside, TEXT + 'private things');
  fs.symlinkSync(outside, path.join(inbox, 'link.txt'));
  const http = ai([[{ category: 'C', title: 'Should not exist', due: '2026-10-05' }]]);
  const r = await runNode('ingest-files.js', { env, nodes, http });
  assert.equal(http.bodies.length, 0, 'nothing was sent to the AI'); assert.match(r.ingest.errors.join(), /link\.txt 是符号链接/);
  const again = await runNode('ingest-files.js', { env, nodes, http }); assert.doesNotMatch(again.ingest.errors.join(), /符号链接/, 'said once');
});
test('progress written by earlier versions (a position without a version mark) is read again from the start, once (review R8-04)', async () => {
  const doc = longDoc(); const { inbox, state, env } = setup({ 'doc.txt': doc }, { BRIEF_CHUNK_CHARS: '4000' });
  const h = sha(path.join(inbox, 'doc.txt'));
  // what version 6 left behind after a day of half chunks: a position, no finished chunk, no chunk end, no version
  fs.writeFileSync(path.join(state, 'processed.json'), JSON.stringify({ done: {}, partial: {}, offset: { [h]: 12000 } }));
  const texts = []; await runNode('ingest-files.js', { env, nodes, http: slowAi(texts, 0) });
  assert.ok(texts.join('').startsWith(doc.trim().slice(0, 3000)), 'read again from the very beginning');
  assert.equal(stateOf(state).version, 2, 'the state now carries its format version');
  // a later run with version-2 state continues normally (no second restart)
  fs.writeFileSync(path.join(inbox, 'doc2.txt'), doc + '\nmore'); const t2 = []; await runNode('ingest-files.js', { env: { ...env, BRIEF_INGEST_BUDGET_MS: '100' }, nodes, http: slowAi(t2, 200) });
  const st = stateOf(state); const h2 = sha(path.join(inbox, 'doc2.txt'));
  const t3 = []; await runNode('ingest-files.js', { env, nodes, http: slowAi(t3, 0) });
  assert.ok(!t3.join('').startsWith(t2.join('').slice(0, 200)) || !t2.length, 'version-2 progress is continued, not restarted'); assert.ok(st.offset[h2] > 0 || st.done[h2]);
});

test('extract-inbox: the text of a document that left the inbox is deleted once it is a week old; files still there and recent ones are kept', async () => {
  const { spawnSync } = await import('node:child_process');
  const { ROOT } = await import('./helpers.mjs');
  const home = tmpdir('ex-home-'); const { inbox, state } = setup({ 'kept.pdf': 'pdf bytes' });
  const dir = path.join(state, 'extracted'); fs.mkdirSync(dir, { recursive: true });
  const h = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const f = { present: `${h('pdf bytes')}.txt`, goneOld: `${h('gone')}.txt`, goneOldErr: `${h('gone too')}.err`, goneRecent: `${h('recent')}.txt`, notOurs: 'notes.txt' };
  for (const n of Object.values(f)) fs.writeFileSync(path.join(dir, n), 'x');
  const eightDaysAgo = new Date(Date.now() - 8 * 86400000);
  for (const k of ['present', 'goneOld', 'goneOldErr', 'notOurs']) fs.utimesSync(path.join(dir, f[k]), eightDaysAgo, eightDaysAgo);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'extract-inbox.mjs')], { env: { ...process.env, BRIEF_HOME: home, BRIEF_INBOX: inbox, BRIEF_STATE_DIR: state }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /2 old cache file\(s\) of removed documents deleted/);
  const left = new Set(fs.readdirSync(dir));
  assert.ok(left.has(f.present), 'the file is still in the inbox'); assert.ok(left.has(f.goneRecent), 'taken out only recently');
  assert.ok(left.has(f.notOurs), 'only cache files are touched');
  assert.ok(!left.has(f.goneOld) && !left.has(f.goneOldErr), 'the old text of a removed document is gone');
});
