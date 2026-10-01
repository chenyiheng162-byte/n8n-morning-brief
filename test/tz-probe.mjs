// Helper for calendar.test.mjs: runs the calendar node for ONE case in its own process (ical.js keeps registered time zones
// for the life of a process, and n8n starts a fresh process for every run, so each case must be isolated).
import { runNode, ics, vevent } from './helpers.mjs';
const [which, withZone] = process.argv.slice(2);
const VTZ_NY = ['BEGIN:VTIMEZONE', 'TZID:America/New_York', 'BEGIN:DAYLIGHT', 'DTSTART:19700308T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'TZNAME:EDT', 'END:DAYLIGHT', 'BEGIN:STANDARD', 'DTSTART:19701101T020000', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'TZNAME:EST', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
const cases = {
  // property names written in lower case (RFC 5545 says they are case-insensitive); 09:00 London = 16:00 Hong Kong
  lower: { today: '2026-10-01', text: ics(vevent({ uid: 'l1', lines: ['dtstart;tzid=Europe/London:20261001T090000', 'dtend;tzid=Europe/London:20261001T100000', 'SUMMARY:London class'] })) },
  // a weekly class whose Oct 1 instance was moved; the exception names its instant in UTC, the series uses a TZID
  moved: { today: '2026-09-30', text: ics(
    vevent({ uid: 'u1', lines: ['DTSTART;TZID=Asia/Hong_Kong:20260903T090000', 'DTEND;TZID=Asia/Hong_Kong:20260903T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:Thursday class'] }),
    vevent({ uid: 'u1', lines: ['RECURRENCE-ID:20261001T010000Z', 'DTSTART;TZID=Asia/Hong_Kong:20261001T150000', 'DTEND;TZID=Asia/Hong_Kong:20261001T160000', 'SUMMARY:Moved class'] })) },
  // 09:00 in New York: 21:00 in Hong Kong while New York is on summer time ...
  summer: { today: '2026-10-30', text: ics(vevent({ uid: 'n1', lines: ['DTSTART;TZID=America/New_York:20261030T090000', 'DTEND;TZID=America/New_York:20261030T100000', 'SUMMARY:NY call'] })), tz: VTZ_NY },
  // ... and 22:00 once New York is back on standard time (2026-11-01)
  winter: { today: '2026-11-02', text: ics(vevent({ uid: 'n2', lines: ['DTSTART;TZID=America/New_York:20261102T090000', 'DTEND;TZID=America/New_York:20261102T100000', 'SUMMARY:NY call'] })), tz: VTZ_NY },
  // a weekly NY meeting that crosses the change of clocks: the wall time stays 09:00 in New York
  weekly: { today: '2026-11-05', text: ics(vevent({ uid: 'n3', lines: ['DTSTART;TZID=America/New_York:20261015T090000', 'DTEND;TZID=America/New_York:20261015T100000', 'RRULE:FREQ=WEEKLY', 'SUMMARY:NY weekly'] })), tz: VTZ_NY },
  // a zone name that is not an IANA name (as some Windows-based systems write it)
  windows: { today: '2026-09-30', text: ics(vevent({ uid: 'w1', lines: ['DTSTART;TZID="(UTC+08:00) Beijing, Hong Kong":20260930T090000', 'DTEND;TZID="(UTC+08:00) Beijing, Hong Kong":20260930T100000', 'SUMMARY:Odd zone'] })) },
};
const c = cases[which];
let text = c.text;
if (withZone === 'with' && c.tz) text = text.replace('BEGIN:VEVENT', `${c.tz}\r\nBEGIN:VEVENT`);
const r = await runNode('read-calendars.js', { env: { BRIEF_TZ: 'Asia/Hong_Kong', BRIEF_TODAY: c.today, BRIEF_EVENT_DAYS: '3', ICS_URLS: 'https://cal.example/a.ics' }, http: async () => text });
console.log(JSON.stringify({ events: r.events.map((e) => `${e.day} ${e.startHM} ${e.title}`), warnings: r.warnings, failed: r.failed }));
