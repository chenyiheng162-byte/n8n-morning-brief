// n8n Code node ("Run Once for All Items"). Fetches every ICS URL in $env.ICS_URLS (in parallel, falling back to a
// cached copy when a fetch fails), expands recurring events for [today 00:00, today + N days] in the user's timezone
// and returns ONE item.
const ICAL = require('ical.js');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
//@include csv.js
//@include settings.js
const t0 = Date.now();
const S = loadSettings($env);
const tz = S.tz;
const lookahead = S.eventDays;
const urls = [...new Set(String($env.ICS_URLS || '').split(/\s+/).filter(Boolean))]; // the same link listed twice is fetched once
const stateDir = $env.BRIEF_STATE_DIR || path.join($env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief'), 'data', 'state');
const cacheDir = path.join(stateDir, 'calendar-cache');
const CACHE_MAX_AGE_MS = 48 * 3600 * 1000;

function parts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return o;
}
function offsetMs(ms) {
  const p = parts(ms);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}
// The instant at which the clocks in tz show this wall time.
function zonedWall(y, m, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  return guess - offsetMs(guess - offsetMs(guess));
}
const zonedMidnight = (y, m, d) => zonedWall(y, m, d);
const dayStr = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
const hm = (ms) => { const p = parts(ms); return `${p.hour}:${p.minute}`; };
const pad = (n) => String(n).padStart(2, '0');
const icalDay = (t) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
const safe = (m) => String(m || '').replace(/https?:\/\/\S+/g, '<链接>').slice(0, 120); // calendar links are secrets
// A time without a zone ("floating", RFC 5545 §3.3.5) is that wall-clock time wherever you are: here, BRIEF_TZ. ical.js
// would read it in the zone of the process that runs this node, which need not be BRIEF_TZ (n8n's task runner, a test).
const msOf = (t) => (!t.isDate && (!t.zone || t.zone === ICAL.Timezone.localTimezone) ? zonedWall(t.year, t.month, t.day, t.hour, t.minute, t.second) : t.toJSDate().getTime());

// BRIEF_TODAY (YYYY-MM-DD) pins "today" for tests; otherwise use the real clock.
const pin = /^(\d{4})-(\d{2})-(\d{2})$/.exec($env.BRIEF_TODAY || '');
const nowMs = pin ? zonedMidnight(+pin[1], +pin[2], +pin[3]) + 12 * 3600000 : Date.now();
const nowParts = parts(nowMs);
const windowStart = zonedMidnight(+nowParts.year, +nowParts.month, +nowParts.day);
const endDate = new Date(Date.UTC(+nowParts.year, +nowParts.month - 1, +nowParts.day + lookahead + 1));
const windowEnd = zonedMidnight(endDate.getUTCFullYear(), endDate.getUTCMonth() + 1, endDate.getUTCDate());
const today = dayStr(windowStart);
const endDay = dayStr(windowEnd); // exclusive

const out = new Map();
const errors = [];
let failed = 0;
const cached = [];

function addOccurrence(title, location, start, end, sink = out) {
  if (start.isDate) {
    const s = icalDay(start);
    const e = icalDay(end);
    if (!(e > today && s < endDay)) return;
    sink.set(`${title}|${s}|${e}`, { title, location, allDay: true, startDay: s, endDay: e });
  } else {
    const sMs = msOf(start);
    const eMs = msOf(end);
    if (!(sMs < windowEnd && Math.max(eMs, sMs + 1) > windowStart)) return;
    const day = sMs < windowStart ? today : dayStr(sMs);
    sink.set(`${title}|${sMs}|${eMs}`, { title, location, allDay: false, day, endDay: dayStr(Math.max(eMs - 1, sMs)), startMs: sMs, endMs: eMs, startHM: hm(sMs), endHM: hm(eMs) });
  }
}

const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
async function fetchIcs(url) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await this.helpers.httpRequest({ method: 'GET', url, json: false, timeout: 20000 }); } catch (e) { last = e; if (attempt < 2) await sleep(3000); }
  }
  throw last;
}
// The last good copy of each calendar is kept, so a calendar server that is down for a few hours does not turn your
// day into "no events". The brief says so when it is showing a cached copy.
const cacheFile = (url) => path.join(cacheDir, `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 20)}.ics`);
function saveCache(url, text) {
  try { fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 }); fs.writeFileSync(cacheFile(url), text, { mode: 0o600 }); } catch (e) { /* the cache is a convenience, never a reason to fail */ }
}
function loadCache(url) {
  try {
    const f = cacheFile(url);
    const age = Date.now() - fs.statSync(f).mtimeMs;
    return age <= CACHE_MAX_AGE_MS ? { text: fs.readFileSync(f, 'utf8'), ageH: Math.max(1, Math.round(age / 3600000)) } : null;
  } catch (e) { return null; }
}
const cancelled = (e) => String(e.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED';
// An occurrence is identified by its UID and the exact instant of its RECURRENCE-ID, so it does not matter whether the
// series and its exception spell the time the same way (TZID in one, UTC in the other).
const idKey = (uid, t) => (t.isDate ? `${uid}|d|${icalDay(t)}` : `${uid}|t|${t.toUnixTime()}`);

// A time zone that the feed uses but does not define (some timetable systems omit the VTIMEZONE block) would be read by
// ical.js as a local time of THIS machine. Build a definition for real IANA names from the system's own time zone data;
// names that are not IANA (for example Windows names) are reported, and read like floating times (in BRIEF_TZ).
function synthTimezone(tzid) {
  let fmt;
  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: tzid, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (e) { return null; }
  const off = (ms) => { const o = {}; for (const p of fmt.formatToParts(new Date(ms))) o[p.type] = p.value; return Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour, +o.minute, +o.second) - Math.floor(ms / 1000) * 1000; };
  const hhmm = (ms) => { const a = Math.abs(ms) / 60000; return `${ms < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}${pad(Math.round(a % 60))}`; };
  const stamp = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`; };
  const DAY = 86400000;
  let ms = Date.UTC(2015, 0, 1);
  let cur = off(ms);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', `TZOFFSETFROM:${hhmm(cur)}`, `TZOFFSETTO:${hhmm(cur)}`, 'END:STANDARD'];
  for (; ms < Date.UTC(2040, 0, 1); ms += DAY) {
    const nxt = off(ms + DAY);
    if (nxt === cur) continue;
    let lo = ms, hi = ms + DAY; // the transition lies in (lo, hi]: find the minute
    while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 2 / 60000) * 60000; if (off(mid) === cur) lo = mid; else hi = mid; }
    lines.push(`BEGIN:${nxt > cur ? 'DAYLIGHT' : 'STANDARD'}`, `DTSTART:${stamp(hi + cur)}`, `TZOFFSETFROM:${hhmm(cur)}`, `TZOFFSETTO:${hhmm(nxt)}`, `END:${nxt > cur ? 'DAYLIGHT' : 'STANDARD'}`);
    cur = nxt;
  }
  lines.push('END:VTIMEZONE');
  return new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${lines.join('\r\n')}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone');
}
const unknownZones = new Set();
// A series is followed from its first instance. One that started long ago and repeats often (daily since the 1960s,
// hourly for years) can need more steps than are allowed before it reaches today: it is then reported, never just missing.
const MAX_STEPS = 20000;
const tooLong = new Set();
function parseCalendar(text) {
  const comp = new ICAL.Component(ICAL.parse(text));
  if (comp.name !== 'vcalendar') throw new Error('not an iCalendar file');
  const defined = new Set(comp.getAllSubcomponents('vtimezone').map((v) => v.getFirstPropertyValue('tzid')));
  // only the time properties are looked at (property and parameter names are case-insensitive, RFC 5545 §3.5), so a
  // DESCRIPTION that happens to contain the text TZID= is ignored
  for (const m of text.matchAll(/^(?:DTSTART|DTEND|DUE|RECURRENCE-ID|EXDATE|RDATE)[^:\r\n]*?;TZID=(?:"([^"\r\n]+)"|([^:;"\r\n]+))/gmi)) {
    const id = m[1] || m[2];
    if (defined.has(id) || ICAL.TimezoneService.has(id)) continue;
    defined.add(id);
    const v = synthTimezone(id);
    if (v) comp.addSubcomponent(v); else unknownZones.add(id.slice(0, 40));
  }
  return comp;
}

// Reads one calendar completely into its own list; any error rejects the whole calendar (nothing half-read is used).
function expandCalendar(comp) {
  const sink = new Map();
  for (const v of comp.getAllSubcomponents('vtimezone')) {
    const t = new ICAL.Timezone(v);
    if (!ICAL.TimezoneService.has(t.tzid)) ICAL.TimezoneService.register(t);
  }
  const masters = new Map();
  const exceptions = [];
  for (const v of comp.getAllSubcomponents('vevent')) {
    if (v.hasProperty('recurrence-id')) exceptions.push(v);
    else masters.set(v.getFirstPropertyValue('uid') || `nouid:${v.getFirstPropertyValue('summary') || ''}|${String(v.getFirstPropertyValue('dtstart') || '')}`, new ICAL.Event(v));
  }
  const overridden = new Set();
  const slack = new Map(); // uid -> how far EARLIER a "this and future" change can pull an instance (ms)
  for (const v of exceptions) {
    const uid = v.getFirstPropertyValue('uid');
    const rid = v.getFirstPropertyValue('recurrence-id');
    if (rid) overridden.add(idKey(uid, rid));
    const master = masters.get(uid);
    if (!master) continue;
    const x = new ICAL.Event(v);
    master.relateException(x);
    const isRange = String(v.getFirstProperty('recurrence-id').getParameter('range') || '').toUpperCase() === 'THISANDFUTURE';
    if (isRange && rid && x.startDate) {
      const shift = (x.startDate.isDate ? Date.UTC(x.startDate.year, x.startDate.month - 1, x.startDate.day) : msOf(x.startDate))
                  - (rid.isDate ? Date.UTC(rid.year, rid.month - 1, rid.day) : msOf(rid));
      if (shift < 0) slack.set(uid, Math.max(slack.get(uid) || 0, -shift));
    }
  }
  for (const [uid, ev] of masters) {
    if (!ev.isRecurring()) {
      if (!cancelled(ev) && ev.startDate) addOccurrence(ev.summary || '(无标题)', ev.location || '', ev.startDate, ev.endDate, sink);
      continue;
    }
    // Instances may be pulled earlier by a range change, so scan a little past the window and filter by real times.
    const scanEndMs = windowEnd + (slack.get(uid) || 0);
    const scanEndDay = dayStr(scanEndMs);
    const it = ev.iterator();
    let next;
    let steps = 0;
    while ((next = it.next())) {
      if (++steps > MAX_STEPS) {
        const until = (ev.component.getFirstPropertyValue('rrule') || {}).until; // a series that ended long ago is not worth a warning
        if (!(until && (until.isDate ? icalDay(until) < today : msOf(until) < windowStart))) tooLong.add(String(ev.summary || '(无标题)').replace(/[\\*_~|>`\[\]()\r\n]/g, ' ').trim().slice(0, 30));
        break;
      }
      const startMs = next.isDate ? Date.UTC(next.year, next.month - 1, next.day) : msOf(next);
      if (next.isDate ? icalDay(next) >= scanEndDay : startMs >= scanEndMs) break;
      if (overridden.has(idKey(uid, next))) continue; // this instance carries its own exception: placed below by its own times
      const d = ev.getOccurrenceDetails(next);          // instances shifted by a THISANDFUTURE change come back already shifted
      if (cancelled(d.item)) continue;
      addOccurrence(d.item.summary || '(无标题)', d.item.location || '', d.startDate, d.endDate, sink);
    }
  }
  for (const v of exceptions) {
    const x = new ICAL.Event(v);
    if (!cancelled(x) && x.startDate) addOccurrence(x.summary || '(无标题)', x.location || '', x.startDate, x.endDate, sink);
  }
  return sink;
}

const t1 = Date.now();
const fetched = await Promise.all(urls.map(async (url) => {
  let err;
  // A download replaces the cached copy only after the WHOLE calendar has been read and expanded: an error page, or a
  // file that parses but has a broken date deeper inside, must never overwrite the last good copy.
  try { const text = String(await fetchIcs.call(this, url)); const found = expandCalendar(parseCalendar(text)); saveCache(url, text); return { found }; } catch (e) { err = e; }
  const c = loadCache(url);
  if (c) { try { return { found: expandCalendar(parseCalendar(c.text)), cachedAgeH: c.ageH }; } catch (e) { /* a damaged cache is no help */ } }
  return { error: safe(err && err.message) };
}));
const t2 = Date.now();

for (const f of fetched) {
  if (f.error) { failed++; errors.push(`日历读取失败：${f.error}`); continue; }
  if (f.cachedAgeH !== undefined) cached.push(f.cachedAgeH);
  for (const [k, v] of f.found) out.set(k, v);
}

const events = [...out.values()].sort((a, b) => (a.allDay === b.allDay ? (a.startMs || 0) - (b.startMs || 0) : a.allDay ? -1 : 1));
const notes = [
  ...(unknownZones.size ? [`日历里有无法识别的时区「${[...unknownZones].join('、')}」，这些日程按 ${tz} 显示，时间可能不对`] : []),
  ...(tooLong.size ? [`日历里有 ${tooLong.size} 个重复日程开始得太早、重复太频繁（「${[...tooLong].slice(0, 3).join('」「')}」），没能展开到今天，简报里不会出现：请在日历里把它的开始日期改近一些`] : []),
];
return [{ json: { tz, today, days: lookahead, calendars: urls.length, events, errors, failed, cached, warnings: S.warnings.concat(notes), timing: { fetchMs: t2 - t1, parseMs: Date.now() - t2, totalMs: Date.now() - t0 } } }];
