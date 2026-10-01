import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runNode, tmpdir } from './helpers.mjs';

const HEAD = '状态,分类,任务,截止日,预估耗时,来源,添加时间,备注';
const csv = (...rows) => { const f = path.join(tmpdir(), 'tasks.csv'); fs.writeFileSync(f, `\uFEFF${[HEAD, ...rows].join('\r\n')}\r\n`); return f; };
const cal = (o = {}) => ({ today: '2026-09-30', days: 3, calendars: 1, events: [], errors: [], ...o });
const brief = (input, env = {}) => runNode('build-brief.js', { env, input: { ingest: { newTasks: 0, errors: [] }, ...input } });
const text = (r) => r.message;

test('the default view is one compact card', async () => {
  const f = csv('进行中,Math,Homework,2026-10-01,,a.txt,2026-09-01,');
  const r = await brief({ ...cal(), tasksFile: f });
  assert.equal(r.payload.embeds.length, 1); assert.match(text(r), /Homework/);
});

test('dates written back by Excel (2026/10/2) still count (review finding N2)', async () => {
  const f = csv('进行中,Math,Excel dated,2026/10/2,,a.txt,2026-09-01,', '进行中,Math,Dotted,2026.10.3,,a.txt,2026-09-01,');
  const r = await brief({ ...cal(), tasksFile: f });
  assert.match(text(r), /Excel dated/); assert.match(text(r), /Dotted/); assert.doesNotMatch(text(r), /没有近期要交的任务/);
});

test('active tasks without a usable due date are announced, never silently dropped (review finding N2)', async () => {
  const f = csv('进行中,Math,Has date,2026-10-01,,a.txt,2026-09-01,', '进行中,Math,No date,,,a.txt,2026-09-01,', '进行中,Math,Garbage date,next friday,,a.txt,2026-09-01,');
  const r = await brief({ ...cal(), tasksFile: f });
  assert.match(text(r), /2 项进行中的任务没有可用的截止日/); assert.match(text(r), /1 项填了日期但无法识别/);
});

test('with only undated tasks the brief does not claim there is nothing to do', async () => {
  const f = csv('进行中,Math,No date,,,a.txt,2026-09-01,');
  const r = await brief({ ...cal(), tasksFile: f });
  assert.match(text(r), /没有可用的截止日/);
});

test('a damaged task table is reported, and the brief does not claim there is nothing to do (review finding R7)', async () => {
  const f = path.join(tmpdir(), 'tasks.csv'); fs.writeFileSync(f, '乱码,列\r\nx,y\r\n');
  for (const view of ['compact', 'full']) {
    const r = await brief({ ...cal(), tasksFile: f }, { BRIEF_VIEW: view });
    assert.match(text(r), /表头无法识别/); assert.match(text(r), /任务表读取失败/); assert.doesNotMatch(text(r), /没有近期要交的任务|没有到期的任务/, view);
  }
});

test('untrusted titles cannot become links, mentions or formatting (review J)', async () => {
  const f = csv('进行中,C,"[click](https://evil.example) @everyone **x**",2026-10-01,,a.txt,2026-09-01,');
  const r = await brief({ ...cal({ events: [{ title: '[phish](https://evil.example)', location: '_room_', allDay: false, day: '2026-09-30', endDay: '2026-09-30', startHM: '09:00', endHM: '10:00' }] }), tasksFile: f });
  for (const view of ['compact', 'full']) {
    const m = (await brief({ ...cal({ events: [{ title: '[phish](https://evil.example)', allDay: false, day: '2026-09-30', endDay: '2026-09-30', startHM: '09:00', endHM: '10:00' }] }), tasksFile: f }, { BRIEF_VIEW: view })).message;
    assert.doesNotMatch(m, /\[click\]\(|\[phish\]\(/, view);
  }
  assert.deepEqual(r.payload.allowed_mentions, { parse: [] });
});

test('links inside error messages are removed', async () => {
  const r = await brief({ ...cal({ errors: ['failed https://calendar.example/private-abc/basic.ics'] }) });
  assert.doesNotMatch(text(r), /private-abc|https:/);
});

test('a multi-day timed event shows on every day it covers (review finding 14)', async () => {
  const ev = { title: 'Camp', allDay: false, day: '2026-09-30', endDay: '2026-10-02', startHM: '09:00', endHM: '10:00', location: '' };
  const r = await brief({ ...cal({ events: [ev] }) }, { BRIEF_VIEW: 'full' });
  const fields = r.payload.embeds[0].fields.map((f) => `${f.name}\n${f.value}`).join('\n');
  assert.match(fields, /09:00 → 10-02 10:00/);
  assert.match(fields, /10-01/); assert.match(fields, /10-02/);
});

test('full view stays inside Discord limits even with a huge amount of content', async () => {
  const rows = Array.from({ length: 60 }, (_, i) => `进行中,Course ${i},Task number ${i} with a fairly long title to fill space,2026-10-${String(1 + (i % 25)).padStart(2, '0')},2h,a.txt,2026-09-01,`);
  const events = Array.from({ length: 80 }, (_, i) => ({ title: `Event ${i} `.repeat(6), allDay: false, day: '2026-09-30', endDay: '2026-09-30', startHM: '08:00', endHM: '09:00', location: 'Somewhere far away' }));
  for (const view of ['compact', 'full']) {
    const r = await brief({ ...cal({ events }), tasksFile: csv(...rows) }, { BRIEF_VIEW: view });
    let total = 0;
    for (const e of r.payload.embeds) {
      total += (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length;
      assert.ok((e.description || '').length <= 4096, `${view} description`);
      for (const f of e.fields || []) { total += f.name.length + f.value.length; assert.ok(f.value.length <= 1024 && f.value.length > 0, `${view} field ${f.name}`); }
    }
    assert.ok(total <= 6000, `${view} total ${total}`);
  }
});

test('missed days and pending confirmations are mentioned once each', async () => {
  const f = csv('待确认,C,New one,,,a.txt,2026-09-30,');
  const r = await runNode('build-brief.js', { env: {}, nodes: { Webhook: { body: { missed: ['2026-09-28'] } } }, input: { ...cal(), tasksFile: f, ingest: { newTasks: 1, errors: [] } } });
  assert.match(text(r), /09-28 漏发/); assert.match(text(r), /1 条任务待确认/);
});

test('line breaks in calendar titles and locations cannot start a new markdown line (review finding R8)', async () => {
  const ev = { title: 'Meeting\n# HEADING\n- item', location: 'Room\n> quote', allDay: false, day: '2026-09-30', endDay: '2026-09-30', startHM: '09:00', endHM: '10:00' };
  for (const view of ['compact', 'full']) {
    const m = (await brief({ ...cal({ events: [ev] }) }, { BRIEF_VIEW: view, BRIEF_VIEW_TITLE: '' })).message;
    assert.doesNotMatch(m, /^# HEADING/m, view); assert.doesNotMatch(m, /^> quote/m, view); assert.doesNotMatch(m, /^- item/m, view);
  }
});

// ================= third-round additions =================
test('forgotten old overdue tasks cannot push tomorrow\'s deadline off the page (review H2)', async () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push(`进行中,Old,Forgotten task ${i},2026-0${(i % 6) + 1}-1${i % 9},,a.txt,2026-01-01,`);
  rows.push('进行中,Math,Due tomorrow,2026-10-01,,a.txt,2026-09-01,', '进行中,Math,Due Friday,2026-10-02,,a.txt,2026-09-01,', '进行中,Math,Due today,2026-09-30,,a.txt,2026-09-01,');
  for (const view of ['compact', 'full']) {
    const r = await brief({ ...cal(), tasksFile: csv(...rows) }, { BRIEF_VIEW: view });
    assert.match(text(r), /Due tomorrow/, view); assert.match(text(r), /Due Friday/, view); assert.match(text(r), /Due today/, view);
    const shown = (text(r).match(/Forgotten task/g) || []).length; assert.ok(shown <= 3, `${view}: ${shown} overdue tasks shown`);
    assert.match(text(r), /另有 9 项逾期更久/, view); assert.match(text(r), /「完成」/, view);
  }
});

test('the overdue items that are shown are the most recent ones (the ones that can still be rescued)', async () => {
  const f = csv('进行中,C,Very old,2026-01-05,,a.txt,2026-01-01,', '进行中,C,Yesterday,2026-09-29,,a.txt,2026-01-01,', '进行中,C,Last week,2026-09-23,,a.txt,2026-01-01,', '进行中,C,Last month,2026-08-30,,a.txt,2026-01-01,', '进行中,C,Two weeks,2026-09-16,,a.txt,2026-01-01,');
  const m = text(await brief({ ...cal(), tasksFile: f }));
  assert.match(m, /Yesterday/); assert.match(m, /Last week/); assert.match(m, /Two weeks/); assert.doesNotMatch(m, /Very old/); assert.doesNotMatch(m, /Last month/);
});

test('finished and ignored tasks disappear; 完成 / done / 已完成 all count; unknown statuses are reported (review H2)', async () => {
  const f = csv('完成,C,Finished one,2026-10-01,,a.txt,2026-09-01,', 'done,C,Done in English,2026-10-01,,a.txt,2026-09-01,', '已完成,C,Finished too,2026-10-01,,a.txt,2026-09-01,', '忽略,C,Ignored one,2026-10-01,,a.txt,2026-09-01,', '进行中,C,Still to do,2026-10-01,,a.txt,2026-09-01,', '乱写的状态,C,Mystery,2026-10-01,,a.txt,2026-09-01,');
  const m = text(await brief({ ...cal(), tasksFile: f }));
  assert.match(m, /Still to do/); for (const gone of ['Finished one', 'Done in English', 'Finished too', 'Ignored one', 'Mystery']) assert.doesNotMatch(m, new RegExp(gone), gone);
  assert.match(m, /1 项任务的状态看不懂/);
});

test('when every calendar failed the brief says the schedule is unknown, never "no events" (review: delivery vs completeness)', async () => {
  for (const view of ['compact', 'full']) {
    const m = text(await brief({ ...cal({ calendars: 2, failed: 2, events: [] }), tasksFile: csv() }, { BRIEF_VIEW: view }));
    assert.match(m, /日程未知/, view); assert.doesNotMatch(m, /今天没有日程/, view);
  }
  const partial = text(await brief({ ...cal({ calendars: 2, failed: 1, events: [{ title: 'Class', allDay: false, day: '2026-09-30', endDay: '2026-09-30', startHM: '09:00', endHM: '10:00', location: '' }] }), tasksFile: csv() }));
  assert.match(partial, /Class/); assert.doesNotMatch(partial, /日程未知/);
});

test('a cached calendar is shown and labelled with its age', async () => {
  const m = text(await brief({ ...cal({ calendars: 1, failed: 0, cached: [5], events: [] }), tasksFile: csv() }));
  assert.match(m, /5 小时前的缓存/);
});

test('waiting tasks are listed by title so you can judge them without opening the table (review O5)', async () => {
  const f = csv('待确认,C,Alpha task,2026-10-05,,a.txt,2026-09-30,', '待确认,C,Beta *task*,,,a.txt,2026-09-30,', '待确认,C,Gamma,2026-10-07,,a.txt,2026-09-30,', '待确认,C,Delta,2026-10-08,,a.txt,2026-09-30,');
  const m = text(await brief({ ...cal(), tasksFile: f }));
  assert.match(m, /4 条任务待确认/); assert.match(m, /Alpha task（10-05）/); assert.match(m, /Beta \\\*task\\\*（无日期）/); assert.match(m, /还有 1 条/); assert.doesNotMatch(m, /Delta/);
});

test('invalid settings are reported in the brief and replaced by defaults (review H1)', async () => {
  const m = text(await brief({ ...cal(), tasksFile: csv() }, { BRIEF_VIEW: 'wide', BRIEF_IGNORE: '(', BRIEF_BASE_DATE: '2026-09-30' }));
  assert.match(m, /设置提示/); assert.match(m, /BRIEF_VIEW/); assert.match(m, /BRIEF_IGNORE/); assert.match(m, /BRIEF_BASE_DATE.*不是周一/);
});

test('warnings from earlier nodes are carried into the brief', async () => {
  const m = text(await brief({ ...cal({ warnings: ['BRIEF_TZ「x」不是有效的时区'] }), tasksFile: csv() }));
  assert.match(m, /设置提示：.*BRIEF_TZ/);
});

test('test mode labels the card so nobody mistakes it for the real morning brief', async () => {
  const on = await brief({ ...cal(), tasksFile: csv() }, { BRIEF_TEST: '1' }); assert.match(on.payload.embeds[0].title, /^🧪 测试/);
  const off = await brief({ ...cal(), tasksFile: csv() }); assert.doesNotMatch(off.payload.embeds[0].title, /测试/);
});

test('the brief reports how long each stage took (diagnostics, review O3)', async () => {
  const r = await brief({ ...cal({ timing: { totalMs: 1200 } }), tasksFile: csv(), ingest: { newTasks: 0, errors: [], metrics: { totalMs: 3400, aiCalls: 2 } } });
  assert.equal(r.timing.calendarMs, 1200); assert.equal(r.timing.ingestMs, 3400); assert.equal(r.timing.aiCalls, 2);
  const full = await brief({ ...cal({ timing: { totalMs: 1200 } }), tasksFile: csv(), ingest: { newTasks: 0, errors: [], metrics: { totalMs: 3400, aiCalls: 2 } } }, { BRIEF_VIEW: 'full' });
  assert.match(full.payload.embeds[0].footer.text, /读日历 1.2s.*入库 3.4s.*AI 2 次/);
});

// ================= the schedule is spelled out in the default view =================
const ev = (title, day, s1, e1, loc = '') => ({ title, location: loc, allDay: false, day, endDay: day, startHM: s1, endHM: e1, startMs: Date.parse(`${day}T${s1}:00+08:00`) });
test('the compact brief lists EVERY event today with time and place, tomorrow one per line, and later days briefly', async () => {
  const events = [ev('Linear algebra', '2026-09-30', '08:20', '09:50', 'Room 204'), ev('Group work', '2026-09-30', '11:00', '12:00'), ev('Chem lab', '2026-09-30', '14:00', '15:15', 'Lab B'),
    ev('Gym', '2026-09-30', '19:00', '20:00'), ev('Reading', '2026-09-30', '21:00', '22:00'), ev('Call home', '2026-09-30', '22:00', '22:30'),
    { title: 'Holiday', location: '', allDay: true, startDay: '2026-09-30', endDay: '2026-10-01' },
    ev('English writing', '2026-10-01', '09:30', '11:00', 'Room 110'), ev('Club meeting', '2026-10-02', '18:00', '19:30'), ev('Seminar', '2026-10-03', '10:00', '11:00')];
  const r = await brief({ ...cal({ events }), tasksFile: csv() });
  const t = text(r);
  assert.match(t, /今天 7 项日程/);
  for (const x of ['`08:20–09:50` Linear algebra · Room 204', '`14:00–15:15` Chem lab · Lab B', 'Call home', '全天', 'Holiday']) assert.ok(t.includes(x), x);
  assert.match(t, /明天 周四 · 1 项/); assert.ok(t.includes('`09:30–11:00` English writing · Room 110'));
  assert.match(t, /之后几天/); assert.match(t, /10-02 周五：18:00 Club meeting/); assert.match(t, /10-03 周六：10:00 Seminar/);
});
test('a day without events says so, and a very long day is capped with a count (stays inside Discord limits)', async () => {
  const none = await brief({ ...cal(), tasksFile: csv() }); assert.match(text(none), /今天没有日程/);
  const many = Array.from({ length: 30 }, (_, i) => ev(`Slot ${i}`, '2026-09-30', `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, '23:00'));
  const r = await brief({ ...cal({ events: many }), tasksFile: csv() });
  assert.match(text(r), /…还有 10 项/); assert.ok(r.payload.embeds[0].description.length <= 4000);
});

test('a very full day never pushes the warnings out of the card; long titles are shortened and the hidden count is exact (review R8-05)', async () => {
  const long = (i) => `${'Very long event title number '.repeat(4)}${i}`;
  const events = Array.from({ length: 20 }, (_, i) => ev(long(i), '2026-09-30', `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, '23:00', 'Building A, Room 1234, Some Street 56, Floor 7, Wing B, near the big hall'))
    .concat(Array.from({ length: 8 }, (_, i) => ev(long(100 + i), '2026-10-01', `${String(8 + i).padStart(2, '0')}:00`, '23:00', 'Another quite long place name, Room 99')));
  const r = await brief({ ...cal({ events, errors: ['日历读取失败：HTTP 503'], failed: 1, cached: [4] }), ingest: { newTasks: 0, errors: ['文件处理失败：a.pdf（AI 服务返回 401）'] }, tasksFile: csv() });
  const d = r.payload.embeds[0].description;
  assert.ok(d.length <= 3900, `length ${d.length}`);
  for (const must of [/日历读取失败：HTTP 503/, /AI 服务返回 401/, /4 小时前的缓存/]) assert.match(d, must);
  // count exactly: every section's shown lines plus its "…还有 N 项" must add up to the number in its heading
  const section = (head) => { const lines = d.split('\n'); const i = lines.findIndex((l) => head.test(l)); if (i < 0) return null; const out = []; for (let k = i + 1; k < lines.length && lines[k] !== ''; k++) out.push(lines[k]); return out; };
  for (const [head, total] of [[/今天 20 项日程/, 20], [/明天 .* · 8 项/, 8]]) {
    const sec = section(head); if (!sec) { assert.equal(total, 8, 'only tomorrow may be dropped entirely'); continue; }
    const shown = sec.filter((l) => l.startsWith('`')).length; const more = Number((sec.find((l) => /^…还有 \d+ 项$/.test(l)) || '…还有 0 项').match(/\d+/)[0]);
    assert.equal(shown + more, total, `${head}: ${shown} shown + ${more} hidden`);
  }
  assert.match(d, /…/, 'long titles or places are shortened with …');
  for (const l of d.split('\n')) assert.ok(!/\\$/.test(l), 'no line ends in a dangling escape');
});

test('with many long tasks, pending items, many errors and a cached calendar, every kind of warning is still in the card (review R9-03)', async () => {
  const t = (i) => `Task ${i} ${'x'.repeat(290)}`;
  const rows = Array.from({ length: 9 }, (_, i) => `进行中,C,${t(i)},2026-10-0${1 + (i % 5)},,a.txt,2026-09-01,`).concat(Array.from({ length: 3 }, (_, i) => `待确认,C,Pending ${i} ${'y'.repeat(190)},2026-10-05,,a.txt,2026-09-01,`));
  const events = Array.from({ length: 20 }, (_, i) => ev(`Event ${i} ${'z'.repeat(100)}`, '2026-09-30', `${String(6 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`, '23:00', 'Somewhere with a long address, Room 1'));
  const fileErrors = Array.from({ length: 10 }, (_, i) => `文件处理失败：f${i}.pdf（AI 服务返回 401）`);
  const r = await brief({ ...cal({ events, errors: ['日历读取失败：HTTP 503'], failed: 1, cached: [3], calendars: 2 }), ingest: { newTasks: 0, errors: fileErrors }, tasksFile: csv(...rows) });
  const d = r.payload.embeds[0].description;
  assert.ok(d.length <= 3900, `length ${d.length}`);
  assert.match(d, /11 个问题：日历读取失败：HTTP 503；文件处理失败：f0\.pdf/); assert.match(d, /另有 8 个，详见运行日志/);
  assert.match(d, /3 小时前的缓存/); assert.match(d, /3 条任务待确认/);
  assert.match(d, /今天 20 项日程/);
});
test('a single absurdly long task title written into the CSV by hand still gives a card Discord accepts (review R9-03)', async () => {
  const r = await brief({ ...cal(), tasksFile: csv(`进行中,C,${'A very long title '.repeat(300)},2026-10-01,,a.txt,2026-09-01,`) });
  const d = r.payload.embeds[0].description; assert.ok(d.length <= 4096, `length ${d.length}`); assert.match(d, /…/);
  for (const l of d.split('\n')) assert.ok(!/\\$/.test(l), 'no dangling escape');
});

// ================= found with the demo people (2026-10-01) =================
test('an overnight event is a continuation on the next day: shown with the time it ends, never with its start time again', async () => {
  const shift = (day, next) => ({ title: 'Night shift', allDay: false, day, endDay: next, startHM: '20:00', endHM: '08:00', location: '' });
  const r = await brief({ ...cal({ days: 4, events: [shift('2026-09-30', '2026-10-01'), shift('2026-10-02', '2026-10-03')] }) });
  const t = text(r);
  assert.match(t, /`20:00 → 10-01 08:00` Night shift/, 'today: starts tonight');
  assert.match(t, /明天[^\n]*\n`续 至 08:00` Night shift/, 'tomorrow: only the end of it');
  assert.match(t, /10-02 周五：20:00 Night shift/); assert.match(t, /10-03 周六：续至08:00 Night shift/);
  assert.doesNotMatch(t, /10-03 周六：20:00/);
  const camp = { title: 'Camp', allDay: false, day: '2026-09-30', endDay: '2026-10-02', startHM: '09:00', endHM: '10:00', location: '' };
  const full = (await brief({ ...cal({ events: [camp] }) }, { BRIEF_VIEW: 'full' })).payload.embeds[0].fields.map((f) => f.value).join('\n');
  assert.match(full, /`续 · 全天` Camp/); assert.match(full, /`续 至 10:00` Camp/);
});

test('tasks due in 8 to 30 days get one line in the compact card instead of disappearing', async () => {
  const f = csv('进行中,Law,Hearing prep,2026-10-20,,a.txt,2026-09-01,', '进行中,Law,Evidence list,2026-10-09,,a.txt,2026-09-01,', '进行中,Law,Far away,2026-12-31,,a.txt,2026-09-01,', '进行中,Law,Soon,2026-10-02,,a.txt,2026-09-01,');
  const t = text(await brief({ ...cal(), tasksFile: f }));
  assert.match(t, /Soon/); assert.match(t, /🟢 再往后 30 天内还有 2 项：Evidence list（10-09 · Law）、Hearing prep（10-20 · Law）/);
  assert.doesNotMatch(t, /Far away/);
});

test('the pending-tasks note says where to confirm them and never prints a path of this computer', async () => {
  const f = csv('待确认,Work,Check the pool size,,,a.txt,2026-09-01,');
  const t = text(await brief({ ...cal(), tasksFile: f }));
  assert.match(t, /1 条任务待确认（在控制台的「任务」页确认，或编辑收件夹里的 tasks.csv）/);
  assert.ok(!t.includes(path.dirname(f)), 'no local folder in the message');
});

test('a shortened title never ends inside a bracket it opened', async () => {
  const f = csv('进行中,English,提交《了不起的盖茨比》第1–5章阅读笔记（两页以内，手写）,2026-10-09,,a.txt,2026-09-01,', '进行中,English,《了不起的盖茨比》（The Great Gatsby）全书精读与批注,2026-10-12,,a.txt,2026-09-01,', '进行中,Code,Fix (the very long bug title here),2026-10-15,,a.txt,2026-09-01,');
  const line = text(await brief({ ...cal(), tasksFile: f })).split('\n').find((l) => l.startsWith('🟢'));
  assert.match(line, /提交《了不起的盖茨比》第1–5章阅读笔记…（10-09 · English）/);
  assert.ok(line.includes('《了不起的盖茨比》（The Great Gat…）（10-12 · English）'), 'an early bracket is closed after the … instead of leaving almost nothing');
  assert.ok(line.includes('Fix \\(the very long bug…\\)（10-15 · Code）'), 'an escaped bracket is closed with an escaped bracket');
});

test('each task line says which course or project it belongs to (four courses can all have an "Assignment 1")', async () => {
  const f = csv('进行中,STAT3612,Assignment 1,2026-10-01,,a.docx,2026-09-01,', '进行中,STAT3600,Assignment 1,2026-10-02,,b.txt,2026-09-01,', '进行中,,No course,2026-10-03,,c.txt,2026-09-01,', '进行中,A very long project name that goes on,Thing,2026-10-04,,d.txt,2026-09-01,');
  const t = text(await brief({ ...cal(), tasksFile: f }));
  assert.match(t, /\*\*Assignment 1\*\* · 明天|Assignment 1\*\* · 周四 · _STAT3612_/);
  assert.match(t, /Assignment 1\*\* · 周五 · _STAT3600_/);
  assert.match(t, /\*\*No course\*\* · 周六\n/, 'no empty label');
  assert.match(t, /Thing\*\* · 周日 · _A very long pro…_/);
});

test('a line break typed into a task cell (Excel Alt-Enter) cannot break the task line or start a heading, in either view', async () => {
  const f = csv('进行中,"Law\nSchool","Essay\n# Big heading",2026-10-01,"2\nh",a.txt,2026-09-01,', '待确认,Law,"Read\n- chapter 3",2026-10-20,,a.txt,2026-09-01,', '进行中,Law,"Later\n> quote",2026-10-15,,a.txt,2026-09-01,');
  for (const view of ['compact', 'full']) {
    const t = text(await brief({ ...cal(), tasksFile: f }, { BRIEF_VIEW: view }));
    assert.doesNotMatch(t, /\n# |\n- chapter|\n> quote|\nSchool|\nh\b/, view);
    assert.match(t, /Essay # Big heading/, view);
  }
});

test('the full view prints no empty course label for a task without one', async () => {
  const f = csv('进行中,,No course,2026-10-01,,a.txt,2026-09-01,', '进行中,,Later,2026-10-20,,a.txt,2026-09-01,');
  const t = text(await brief({ ...cal(), tasksFile: f }, { BRIEF_VIEW: 'full' }));
  assert.doesNotMatch(t, /__/); assert.match(t, /\*\*No course\*\* · 明天截止 · 还剩 1 天\n|\*\*No course\*\* · 10-01 周四 · 还剩 1 天\n/);
});

test('a long BRIEF_NOTE is shortened with … and never ends in half an escape', async () => {
  for (let n = 230; n < 240; n++) {
    const t = text(await brief({ ...cal() }, { BRIEF_NOTE: `${'x'.repeat(n)}*tail*` }));
    const line = t.split('\n').find((l) => l.startsWith('ℹ️ x'));
    assert.ok(line.length <= 240, `${n}: ${line.length}`); assert.ok(line.endsWith('…'), String(n)); assert.doesNotMatch(line, /\\…$/, String(n));
  }
});
