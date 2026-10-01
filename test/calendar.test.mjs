import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runNode, ics, vevent, tmpdir } from './helpers.mjs';

const ENV = { BRIEF_TZ: 'Asia/Hong_Kong', BRIEF_TODAY: '2026-09-30', BRIEF_EVENT_DAYS: '3', ICS_URLS: 'https://cal.example/a.ics' };
const run = (text, env = {}) => runNode('read-calendars.js', { env: { ...ENV, ...env }, http: async () => text });
const titles = (r, day) => r.events.filter((e) => (e.allDay ? e.startDay <= day && day < e.endDay : e.day <= day && day <= e.endDay)).map((e) => e.title);

test('weekly recurring class is expanded into the window', async () => {
  // Thursdays 09:00 HKT (01:00Z) from 2026-09-03: window is Wed 09-30 .. Sat 10-03 -> Thu 10-01 only
  const r = await run(ics(vevent({ uid: 'w', lines: ['SUMMARY:Weekly class', 'DTSTART:20260903T010000Z', 'DTEND:20260903T014500Z', 'RRULE:FREQ=WEEKLY'] })));
  assert.deepEqual(titles(r, '2026-10-01'), ['Weekly class']);
  assert.deepEqual(titles(r, '2026-09-30'), []);
  assert.equal(r.errors.length, 0);
});

test('an occurrence moved INTO the window from a far-away date is shown (review finding 4)', async () => {
  // original slot Thu 10-08 (outside the window) rescheduled to today 10:00 HKT
  const r = await run(ics(
    vevent({ uid: 'm', lines: ['SUMMARY:Moved class', 'DTSTART:20260903T010000Z', 'DTEND:20260903T014500Z', 'RRULE:FREQ=WEEKLY'] }),
    vevent({ uid: 'm', lines: ['SUMMARY:Moved class', 'RECURRENCE-ID:20261008T010000Z', 'DTSTART:20260930T020000Z', 'DTEND:20260930T024500Z'] })));
  assert.deepEqual(titles(r, '2026-09-30'), ['Moved class']);
});

test('an occurrence moved OUT of the window disappears from its original slot', async () => {
  // original slot Thu 10-01 moved to 10-15
  const r = await run(ics(
    vevent({ uid: 'o', lines: ['SUMMARY:Moved away', 'DTSTART:20260903T010000Z', 'DTEND:20260903T014500Z', 'RRULE:FREQ=WEEKLY'] }),
    vevent({ uid: 'o', lines: ['SUMMARY:Moved away', 'RECURRENCE-ID:20261001T010000Z', 'DTSTART:20261015T010000Z', 'DTEND:20261015T014500Z'] })));
  assert.deepEqual(titles(r, '2026-10-01'), []);
});

test('cancelled occurrences (EXDATE and STATUS:CANCELLED) are not shown', async () => {
  const r = await run(ics(
    vevent({ uid: 'x', lines: ['SUMMARY:Skipped', 'DTSTART:20260903T010000Z', 'DTEND:20260903T014500Z', 'RRULE:FREQ=WEEKLY', 'EXDATE:20261001T010000Z'] }),
    vevent({ uid: 'c', lines: ['SUMMARY:Cancelled once', 'STATUS:CANCELLED', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] })));
  assert.equal(r.events.length, 0);
});

test('a timed event spanning several days records its end day (review finding 14)', async () => {
  const r = await run(ics(vevent({ uid: 's', lines: ['SUMMARY:Camp', 'DTSTART:20260930T010000Z', 'DTEND:20261002T020000Z'] })));
  const e = r.events[0];
  assert.equal(e.day, '2026-09-30'); assert.equal(e.endDay, '2026-10-02');
});

test('all-day events keep an exclusive end date', async () => {
  const r = await run(ics(vevent({ uid: 'a', lines: ['SUMMARY:Holiday', 'DTSTART;VALUE=DATE:20261001', 'DTEND;VALUE=DATE:20261002'] })));
  assert.equal(r.events[0].allDay, true); assert.equal(r.events[0].startDay, '2026-10-01'); assert.equal(r.events[0].endDay, '2026-10-02');
});

test('the same event in two calendars is listed once', async () => {
  const one = vevent({ uid: 'd', lines: ['SUMMARY:Same', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] });
  const r = await run(ics(one), { ICS_URLS: 'https://cal.example/a.ics https://cal.example/b.ics' });
  assert.equal(r.events.length, 1);
});

test('a failing calendar is reported without the secret link and does not stop the others', async () => {
  const good = ics(vevent({ uid: 'g', lines: ['SUMMARY:Fine', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
  const http = async ({ url }) => { if (url.includes('bad')) throw new Error(`getaddrinfo ENOTFOUND ${url}`); return good; };
  const r = await runNode('read-calendars.js', { env: { ...ENV, ICS_URLS: 'https://secret.example/private-bad/basic.ics https://cal.example/ok.ics' }, http });
  assert.equal(r.events.length, 1);
  assert.equal(r.errors.length, 1);
  assert.doesNotMatch(r.errors[0], /secret\.example|private-bad/);
});

test('a temporary network failure is retried', { timeout: 20000 }, async () => {
  let calls = 0;
  const good = ics(vevent({ uid: 't', lines: ['SUMMARY:Retry', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
  const r = await runNode('read-calendars.js', { env: ENV, http: async () => { if (++calls < 2) throw new Error('ECONNRESET'); return good; } });
  assert.equal(calls, 2); assert.equal(r.events.length, 1); assert.equal(r.errors.length, 0);
});

test('BRIEF_TZ decides which calendar day an event belongs to', async () => {
  const text = ics(vevent({ uid: 'z', lines: ['SUMMARY:Late', 'DTSTART:20260930T163000Z', 'DTEND:20260930T170000Z'] })); // 00:30 next day in HKT
  assert.equal((await run(text, { BRIEF_TZ: 'Asia/Hong_Kong' })).events[0].day, '2026-10-01');
  assert.equal((await run(text, { BRIEF_TZ: 'America/New_York' })).events[0].day, '2026-09-30');
});

test('a "this and all future" change (RANGE=THISANDFUTURE) shifts every later instance (review: regression)', async () => {
  // weekly Thursday 09:00 HKT (01:00Z) from 09-03; from 10-01 on the class starts one hour later (10:00 HKT = 02:00Z)
  const r = await run(ics(
    vevent({ uid: 'r', lines: ['SUMMARY:Shifted series', 'DTSTART:20260903T010000Z', 'DTEND:20260903T014500Z', 'RRULE:FREQ=WEEKLY'] }),
    vevent({ uid: 'r', lines: ['SUMMARY:Shifted series', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261001T010000Z', 'DTSTART:20261001T020000Z', 'DTEND:20261001T024500Z'] })), { BRIEF_TODAY: '2026-10-07' });
  const e = r.events.find((x) => x.title === 'Shifted series');
  assert.ok(e, 'the 10-08 instance must exist'); assert.equal(e.day, '2026-10-08'); assert.equal(e.startHM, '10:00'); assert.equal(r.errors.length, 0);
});

test('the instance that carries the range change itself is shown once, at its own time', async () => {
  const r = await run(ics(
    vevent({ uid: 'q', lines: ['SUMMARY:Series', 'DTSTART:20260903T010000Z', 'DTEND:20260903T014500Z', 'RRULE:FREQ=WEEKLY'] }),
    vevent({ uid: 'q', lines: ['SUMMARY:Series', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20261001T010000Z', 'DTSTART:20261001T020000Z', 'DTEND:20261001T024500Z'] })));
  assert.equal(r.events.filter((x) => x.title === 'Series' && x.day === '2026-10-01').length, 1);
  assert.equal(r.events.find((x) => x.day === '2026-10-01').startHM, '10:00');
});

// ================= third-round additions =================
test('a "this and future" change that pulls instances EARLIER across the window boundary is found (review: negative offset)', async () => {
  // Sundays 00:30 HKT (Saturday 16:30Z) from 09-06; from 09-27 on the class is one hour earlier (23:30 HKT the night before).
  // The 10-04 instance therefore becomes Saturday 10-03 23:30, which is inside a window that ends on 10-03.
  const r = await run(ics(
    vevent({ uid: 'n', lines: ['SUMMARY:Early class', 'DTSTART:20260905T163000Z', 'DTEND:20260905T173000Z', 'RRULE:FREQ=WEEKLY'] }),
    vevent({ uid: 'n', lines: ['SUMMARY:Early class', 'RECURRENCE-ID;RANGE=THISANDFUTURE:20260926T163000Z', 'DTSTART:20260926T153000Z', 'DTEND:20260926T163000Z'] })));
  const e = r.events.find((x) => x.title === 'Early class' && x.day === '2026-10-03');
  assert.ok(e, `events: ${JSON.stringify(r.events.map((x) => [x.title, x.day, x.startHM]))}`); assert.equal(e.startHM, '23:30');
});

test('an exception written in UTC for a series written with a TZID does not show the original slot too (review N2)', async () => {
  const series = ['BEGIN:VTIMEZONE', 'TZID:Asia/Hong_Kong', 'BEGIN:STANDARD', 'DTSTART:19701101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'TZNAME:HKT', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
  const text = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n${series}\r\n` + [
    vevent({ uid: 'z', lines: ['SUMMARY:Thursday class', 'DTSTART;TZID=Asia/Hong_Kong:20260903T090000', 'DTEND;TZID=Asia/Hong_Kong:20260903T094500', 'RRULE:FREQ=WEEKLY'] }),
    // the 10-01 09:00 HKT instance (01:00Z) moved to 15:00 HKT (07:00Z); the exception names it in UTC
    vevent({ uid: 'z', lines: ['SUMMARY:Thursday class', 'RECURRENCE-ID:20261001T010000Z', 'DTSTART:20261001T070000Z', 'DTEND:20261001T074500Z'] })].join('\r\n') + '\r\nEND:VCALENDAR\r\n';
  const r = await run(text);
  const thursday = r.events.filter((x) => x.title === 'Thursday class' && x.day === '2026-10-01');
  assert.equal(thursday.length, 1, JSON.stringify(thursday.map((x) => x.startHM))); assert.equal(thursday[0].startHM, '15:00');
});

test('invalid settings never crash the calendar: they fall back and are reported (review H1)', async () => {
  const text = ics(vevent({ uid: 'a', lines: ['SUMMARY:X', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
  for (const [bad, expectedWarning] of [[{ BRIEF_TZ: 'Mars/Base' }, /BRIEF_TZ/], [{ BRIEF_EVENT_DAYS: 'abc' }, /BRIEF_EVENT_DAYS/], [{ BRIEF_EVENT_DAYS: '-2' }, /BRIEF_EVENT_DAYS/], [{ BRIEF_EVENT_DAYS: '400' }, /BRIEF_EVENT_DAYS/]]) {
    const r = await run(text, bad);
    assert.equal(r.events.length, 1); assert.match(r.warnings.join('|'), expectedWarning);
  }
  const ok = await run(text); assert.deepEqual(ok.warnings, []);
});

test('calendars are fetched in parallel, not one after another (review O3)', { timeout: 20000 }, async () => {
  const text = ics(vevent({ uid: 'a', lines: ['SUMMARY:X', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
  const t0 = Date.now();
  const r = await run(text.replace('SUMMARY:X', 'SUMMARY:X'), { ICS_URLS: 'https://a.example/1.ics https://a.example/2.ics https://a.example/3.ics https://a.example/4.ics' });
  // the default stub answers instantly, so measure with a slow one:
  const slow = async () => { await new Promise((res) => setTimeout(res, 400)); return text; };
  const t1 = Date.now();
  await runNode('read-calendars.js', { env: { ...ENV, ICS_URLS: 'https://a.example/1.ics https://a.example/2.ics https://a.example/3.ics https://a.example/4.ics' }, http: slow });
  assert.ok(Date.now() - t1 < 1200, `4 fetches of 400 ms took ${Date.now() - t1} ms`);
});

test('when a calendar server is down the last good copy is used, and the brief is told (review: delivery vs completeness)', async () => {
  const text = ics(vevent({ uid: 'c', lines: ['SUMMARY:Cached class', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
  const state = tmpdir('cal-state-');
  const env = { ...ENV, BRIEF_STATE_DIR: state };
  const first = await runNode('read-calendars.js', { env, http: async () => text });
  assert.equal(first.events.length, 1); assert.deepEqual(first.cached, []);
  const down = async () => { throw new Error('getaddrinfo ENOTFOUND calendar.example'); };
  const second = await runNode('read-calendars.js', { env, http: down });
  assert.equal(second.events.length, 1, 'served from the cache'); assert.equal(second.failed, 0); assert.equal(second.cached.length, 1); assert.ok(second.cached[0] >= 1);
});

test('no cache and a dead server: the failure is counted, so the brief can say the schedule is unknown', async () => {
  const r = await runNode('read-calendars.js', { env: { ...ENV, BRIEF_STATE_DIR: tmpdir('cal-state-') }, http: async () => { throw new Error('boom'); } });
  assert.equal(r.events.length, 0); assert.equal(r.failed, 1); assert.equal(r.calendars, 1);
});

test('a cache older than 48 hours is not used', async () => {
  const text = ics(vevent({ uid: 'c', lines: ['SUMMARY:Old', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
  const state = tmpdir('cal-state-'); const env = { ...ENV, BRIEF_STATE_DIR: state };
  await runNode('read-calendars.js', { env, http: async () => text });
  const dir = path.join(state, 'calendar-cache'); const f = path.join(dir, fs.readdirSync(dir)[0]); const old = new Date(Date.now() - 49 * 3600 * 1000); fs.utimesSync(f, old, old);
  const r = await runNode('read-calendars.js', { env, http: async () => { throw new Error('down'); } });
  assert.equal(r.events.length, 0); assert.equal(r.failed, 1);
});

// ================= round 4 =================
const good = () => ics(vevent({ uid: 'g', lines: ['SUMMARY:Good class', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }));
const cacheFiles = (state) => { const d = path.join(state, 'calendar-cache'); return fs.existsSync(d) ? fs.readdirSync(d).map((f) => path.join(d, f)) : []; };

test('a server that answers 200 with something that is not a calendar does not overwrite the last good copy; the good copy is used (review R4-08)', async () => {
  const state = tmpdir('cal-state-'); const env = { ...ENV, BRIEF_STATE_DIR: state };
  await runNode('read-calendars.js', { env, http: async () => good() });
  const before = fs.readFileSync(cacheFiles(state)[0], 'utf8');
  const r = await runNode('read-calendars.js', { env, http: async () => '<html><body>Please sign in</body></html>' });
  assert.equal(r.failed, 0, 'the cached copy stands in'); assert.equal(r.events.length, 1); assert.equal(r.cached.length, 1);
  assert.equal(fs.readFileSync(cacheFiles(state)[0], 'utf8'), before, 'the cache still holds the real calendar');
  const down = await runNode('read-calendars.js', { env, http: async () => { throw new Error('down'); } });
  assert.equal(down.events.length, 1, 'and it is still there when the network is down afterwards');
});
test('an error page with no cache behind it is a failure, and nothing is cached', async () => {
  const state = tmpdir('cal-state-'); const r = await runNode('read-calendars.js', { env: { ...ENV, BRIEF_STATE_DIR: state }, http: async () => '<html>404</html>' });
  assert.equal(r.failed, 1); assert.equal(r.events.length, 0); assert.deepEqual(cacheFiles(state), []);
});
test('an empty but valid calendar is accepted and replaces the cache (you may really have nothing on)', async () => {
  const state = tmpdir('cal-state-'); const env = { ...ENV, BRIEF_STATE_DIR: state };
  await runNode('read-calendars.js', { env, http: async () => good() });
  const r = await runNode('read-calendars.js', { env, http: async () => ics() });
  assert.equal(r.failed, 0); assert.equal(r.events.length, 0); assert.deepEqual(r.cached, []);
  const again = await runNode('read-calendars.js', { env, http: async () => { throw new Error('down'); } });
  assert.equal(again.events.length, 0, 'the empty calendar is what is remembered now');
});
test('the same link listed several times is downloaded once and counted once (review)', async () => {
  let calls = 0; const url = 'https://cal.example/a.ics';
  const r = await runNode('read-calendars.js', { env: { ...ENV, ICS_URLS: `${url} ${url}\n${url}` }, http: async () => { calls++; return good(); } });
  assert.equal(calls, 1); assert.equal(r.calendars, 1); assert.equal(r.events.length, 1);
});
const probe = (which, withZone) => { const r = spawnSync(process.execPath, [fileURLToPath(new URL('./tz-probe.mjs', import.meta.url)), which, withZone], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop()); };
for (const z of ['with', 'without']) {
  test(`a moved occurrence shows only its new time, ${z} a VTIMEZONE block in the feed (review F5; each case in its own process)`, () => {
    assert.deepEqual(probe('moved', z).events, ['2026-10-01 15:00 Moved class']);
  });
  test(`another time zone is converted correctly, before and after its clocks change, ${z} a VTIMEZONE block (review F5)`, () => {
    assert.deepEqual(probe('summer', z).events, ['2026-10-30 21:00 NY call']);
    assert.deepEqual(probe('winter', z).events, ['2026-11-02 22:00 NY call']);
  });
  test(`a weekly meeting in another zone keeps its wall time there across the change of clocks, ${z} a VTIMEZONE block`, () => {
    // Thursdays 09:00 New York: 10-15 and 10-22 and 10-29 (summer time, 21:00 HK); 11-05 is after the change (22:00 HK)
    assert.deepEqual(probe('weekly', z).events, ['2026-11-05 22:00 NY weekly']);
  });
}
test('a zone name that is not an IANA name is reported instead of guessed (review F5)', () => {
  const r = probe('windows', 'without'); assert.equal(r.failed, 0); assert.match(r.warnings.join(), /无法识别的时区/); assert.match(r.warnings.join(), /Beijing/);
});

// ================= final review =================
test('a calendar that parses but has a broken date deeper inside does not replace the last good copy, and that copy is used (review R5-06)', async () => {
  const state = tmpdir('cal-state-'); const env = { ...ENV, BRIEF_STATE_DIR: state };
  await runNode('read-calendars.js', { env, http: async () => good() });
  const before = fs.readFileSync(cacheFiles(state)[0], 'utf8');
  const broken = ics(vevent({ uid: 'b', lines: ['SUMMARY:Broken', 'DTSTART:INVALID', 'DTEND:20260930T020000Z'] }));
  const r = await runNode('read-calendars.js', { env, http: async () => broken });
  assert.equal(fs.readFileSync(cacheFiles(state)[0], 'utf8'), before, 'the good copy is kept');
  assert.equal(r.failed, 0); assert.deepEqual(r.events.map((e) => e.title), ['Good class']); assert.equal(r.cached.length, 1);
  const down = await runNode('read-calendars.js', { env, http: async () => { throw new Error('down'); } });
  assert.deepEqual(down.events.map((e) => e.title), ['Good class']);
});
test('a broken calendar never adds half of its events next to a good one', async () => {
  const half = ics(vevent({ uid: 'ok', lines: ['SUMMARY:Fine one', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] }), vevent({ uid: 'bad', lines: ['SUMMARY:Broken', 'DTSTART:INVALID'] }));
  const r = await runNode('read-calendars.js', { env: { ...ENV, BRIEF_STATE_DIR: tmpdir('cal-state-') }, http: async () => half });
  assert.equal(r.failed, 1); assert.equal(r.events.length, 0, 'all or nothing for one calendar');
});
test('the text "TZID=" inside a description is not taken for a time zone (review final, small)', async () => {
  const r = await run(ics(vevent({ uid: 'd', lines: ['SUMMARY:Talk', 'DESCRIPTION:set TZID=Nowhere/Land in your client', 'DTSTART:20260930T010000Z', 'DTEND:20260930T020000Z'] })));
  assert.equal(r.events.length, 1); assert.doesNotMatch(r.warnings.join(), /无法识别的时区/);
});

test('time properties written in lower case still get their time zone (review R6-06)', () => {
  assert.deepEqual(probe('lower', 'without').events, ['2026-10-01 16:00 London class']);
});

test('a time without a zone (floating) is that wall-clock time in BRIEF_TZ, whatever zone the process runs in', async () => {
  // two zones: at most one of them can be the zone of the machine running the test, so the other one checks the rule
  for (const tz of ['Asia/Hong_Kong', 'America/New_York']) {
    const r = await run(ics(vevent({ uid: 'fl', lines: ['SUMMARY:Floating', 'DTSTART:20261001T090000', 'DTEND:20261001T100000', 'RRULE:FREQ=DAILY;COUNT=5'] })), { BRIEF_TZ: tz });
    assert.deepEqual(r.events.map((e) => `${e.day} ${e.startHM}-${e.endHM}`).slice(0, 2), ['2026-10-01 09:00-10:00', '2026-10-02 09:00-10:00'], tz);
  }
});

test('a series too long to follow up to today is reported instead of silently missing; one that ended long ago is not', async () => {
  const r = await run(ics(vevent({ uid: 'old', lines: ['SUMMARY:Daily *standup*', 'DTSTART:19600101T010000Z', 'DTEND:19600101T013000Z', 'RRULE:FREQ=DAILY'] })));
  assert.equal(r.errors.length, 0);
  assert.ok(r.warnings.some((w) => /1 个重复日程开始得太早/.test(w) && w.includes('Daily  standup')), JSON.stringify(r.warnings));
  const ended = await run(ics(vevent({ uid: 'end', lines: ['SUMMARY:Old hourly', 'DTSTART:20100101T000000Z', 'DTEND:20100101T001000Z', 'RRULE:FREQ=HOURLY;UNTIL=20150101T000000Z'] })));
  assert.deepEqual(ended.warnings, []); assert.deepEqual(ended.events, []);
});
