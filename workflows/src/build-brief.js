// n8n Code node ("Run Once for All Items"). Turns tasks + calendar events into a Discord embed payload.
const fs = require('fs');
//@include csv.js
//@include settings.js
const input = $input.first().json;
const { today, days, calendars } = input;
const S = loadSettings($env);
const ingest = input.ingest || { newTasks: 0, errors: [] };
const scrub = (m) => String(m).replace(/https?:\/\/\S+/g, '<链接>'); // links can be secrets
const errors = [...(input.errors || []), ...(ingest.errors || [])].map(scrub);
const warnings = [...new Set([...(input.warnings || []), ...S.warnings])].map(scrub);
const missed = ((() => { try { return $('Webhook').first().json.body.missed; } catch (e) { return []; } })() || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));

// Text from documents and shared calendars is untrusted: stop Discord from rendering it as markdown or links.
const oneLine = (s) => String(s).replace(/[\r\n\t]+/g, ' ').trim(); // a line break in a title would start a new markdown line (for example a heading)
const esc = (s) => String(s).replace(/([\\*_~|>`\[\]()])/g, '\\$1');
const clean = (s) => (S.strip ? String(s).replace(S.strip, '').replace(/\s{2,}/g, ' ').trim() : String(s));
const events = (input.events || []).filter((e) => !(S.ignore && S.ignore.test(e.title))).map((e) => ({ ...e, title: esc(oneLine(clean(e.title)) || '(无标题)'), location: e.location ? esc(oneLine(e.location)) : '' }));

const weekday = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('zh-CN', { weekday: 'short', timeZone: 'UTC' });
const shift = (d, n) => { const t = new Date(`${d}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
const short = (d) => `${d.slice(5)} ${weekday(d)}`;

// ---- tasks (status is edited by hand in tasks.csv) ----
let tasks = [];
let tableError = false;
try { if (input.tasksFile) tasks = readTasks(input.tasksFile, fs); } catch (e) { tableError = true; errors.push(`任务表读取失败：${scrub(e.message).slice(0, 200)}`); }
// A cell edited in Excel can hold a line break (Alt-Enter): in a title it would end the task line and could start a markdown
// heading or list on the next one. Every text that is printed is made one line here, once, for both views.
tasks = tasks.map((t) => ({ ...t, '任务': oneLine(t['任务'] || ''), '分类': oneLine(t['分类'] || ''), '预估耗时': oneLine(t['预估耗时'] || '') }));
const kind = (t) => statusKind(t['状态']);
const active = tasks.filter((t) => kind(t) === 'active');
const pendingTasks = tasks.filter((t) => kind(t) === 'pending');
const unknownStatus = tasks.filter((t) => kind(t) === 'unknown').length;
const dueOf = (t) => normalizeDate(t['截止日']); // accepts 2026-10-02, 2026/10/2 (what Excel writes back) and 2026.10.2
const withDue = active.filter((t) => dueOf(t)).map((t) => ({ t, due: dueOf(t), left: daysBetween(today, dueOf(t)) })).sort((a, b) => a.left - b.left);
const noDue = active.length - withDue.length;
const unreadable = active.filter((t) => t['截止日'] && !dueOf(t)).length;
const noDueNote = noDue ? `📌 ${noDue} 项进行中的任务没有可用的截止日${unreadable ? `（其中 ${unreadable} 项填了日期但无法识别）` : ''}` : '';
const dot = (left) => (left < 0 ? '🔴' : left <= 3 ? '🟠' : left <= 7 ? '🟡' : '🟢');
const taskLine = ({ t, due, left }) => {
  const when = left < 0 ? `逾期 ${-left} 天` : left === 0 ? '今天截止' : `${short(due)} · 还剩 ${left} 天`;
  return `${dot(left)} **${esc(t['任务'])}** · ${when}${t['预估耗时'] ? ` · 约 ${esc(t['预估耗时'])}` : ''}${t['分类'] ? ` · _${esc(t['分类'])}_` : ''}`;
};
// Old tasks nobody marked as done must not push tomorrow's deadline off the page: overdue items are capped (the most
// recent ones, which can still be saved, come first) and the rest is summarised with a hint how to clean them up.
const MAX_OVERDUE = 3;
const overdueAll = withDue.filter((x) => x.left < 0).sort((a, b) => b.left - a.left); // most recently overdue first
const overdueShown = overdueAll.slice(0, MAX_OVERDUE);
const overdueHidden = overdueAll.slice(MAX_OVERDUE);
const dueToday = withDue.filter((x) => x.left === 0);
const dueWeek = withDue.filter((x) => x.left > 0 && x.left <= 7);
const dueLater = withDue.filter((x) => x.left > 7 && x.left <= 30);
const overdueNote = overdueHidden.length ? `🧹 另有 ${overdueHidden.length} 项逾期更久（最久 ${-overdueHidden[overdueHidden.length - 1].left} 天）：做完的请在 tasks.csv 里改成「完成」，不要的改成「忽略」` : '';

// ---- calendar ----
const failedCals = Number(input.failed || 0);
const cachedAges = input.cached || [];
const calendarUnknown = calendars > 0 && failedCals >= calendars && events.length === 0; // every calendar failed: "no events" would be a lie
// On day d, a timed event that began on an earlier day (a night shift, a trip) is a continuation: it is shown with the time
// it ends that day, never again with its start time as if it began then.
const cont = (e, d) => !e.allDay && d && e.day < d;
const span = (e, d) => (cont(e, d) ? (e.endDay === d ? `\`续 至 ${e.endHM}\`` : '`续 · 全天`')
  : e.endDay && e.endDay !== e.day ? `\`${e.startHM} → ${e.endDay.slice(5)} ${e.endHM}\`` : `\`${e.startHM}–${e.endHM}\``);
const evLine = (e, d) => `${e.allDay ? '`  全天  `' : span(e, d)} ${e.title}${e.location ? ` · ${e.location}` : ''}`;
const onDay = (d) => events.filter((e) => (e.allDay ? e.startDay <= d && d < e.endDay : e.day <= d && d <= (e.endDay || e.day)));
const todayEvents = onDay(today);
const cachedNote = cachedAges.length ? `ℹ️ 有 ${cachedAges.length} 个日历没连上，日程来自 ${Math.max(...cachedAges)} 小时前的缓存` : '';

const bodyTest = (() => { try { return $('Webhook').first().json.body.test === true; } catch (e) { return false; } })(); // a single-run mode travels in the request, so it also works on a reused n8n whose environment we cannot change
const titlePrefix = (S.test || bodyTest) ? '🧪 测试 · ' : '';
// Shorten a (markdown-escaped) text to n characters, marking it with … and never leaving half an escape at the end, nor a
// bracket opened and never closed ("阅读笔记（两页…" reads badly): it ends before that bracket when enough is left,
// otherwise the bracket is closed after the ….
const OPENERS = '（(《「『【[“'; const CLOSERS = '）)》」』】]”';
const cutText = (x, n) => {
  const t = String(x); if (t.length <= n) return t;
  let c = t.slice(0, n - 1).replace(/\\+$/, '');
  let depth = 0; let open = -1;
  for (let i = c.length - 1; i >= 0; i--) {
    if (CLOSERS.includes(c[i])) depth++;
    else if (OPENERS.includes(c[i])) { if (depth) depth--; else { open = i; break; } }
  }
  if (open < 0) return `${c}…`;
  if (open >= n / 2) return `${c.slice(0, open).replace(/\\+$/, '')}…`;
  const closer = CLOSERS[OPENERS.indexOf(c[open])]; // opened early: keep the text and close the bracket after the …
  return `${c}…${')]'.includes(closer) ? '\\' : ''}${closer}`;
};
const notes = () => {
  const n = [];
  if (noDueNote) n.push(noDueNote);
  if (overdueNote) n.push(overdueNote);
  if (pendingTasks.length) {
    const list = pendingTasks.slice(0, 3).map((t) => `　• ${cutText(esc(t['任务']), 60)}${dueOf(t) ? `（${dueOf(t).slice(5)}）` : '（无日期）'}`);
    n.push(`🆕 ${pendingTasks.length} 条任务待确认（在控制台的「任务」页确认，或编辑收件夹里的 tasks.csv）\n${list.join('\n')}${pendingTasks.length > 3 ? `\n　…还有 ${pendingTasks.length - 3} 条` : ''}\n　把「待确认」改成「进行中」；不要的改成「忽略」`);
  }
  if (unknownStatus) n.push(`❓ ${unknownStatus} 项任务的状态看不懂（应为 待确认 / 进行中 / 完成 / 忽略）`);
  if (cachedNote) n.push(cachedNote);
  if (missed.length) n.push(`ℹ️ ${missed.map((d) => d.slice(5)).join('、')} 漏发，今天补上`);
  if ($env.BRIEF_NOTE) n.push(cutText(`ℹ️ ${esc(oneLine(scrub($env.BRIEF_NOTE)))}`, 240)); // e.g. "sent by the direct engine because n8n was unavailable"
  if (!calendars) n.push('ℹ️ 未配置日历');
  if (warnings.length) n.push(cutText(`⚙️ 设置提示：${warnings.join('；')}`, 500));
  // Problems are always reported, but summarised: the first three (shortened) and how many more there are.
  if (errors.length) n.push(`⚠️ ${errors.length > 1 ? `${errors.length} 个问题：` : ''}${errors.slice(0, 3).map((e) => cutText(e, 160)).join('；')}${errors.length > 3 ? `；另有 ${errors.length - 3} 个，详见运行日志` : ''}`);
  return n;
};

// ---- compact view (default): one card, one line per task, one summary line for the schedule ----
const buildCompact = () => {
  // The card has room for 3900 characters (Discord allows 4096). Everything competes for it: tasks, the schedule and the
  // notes. Notes (problems, cached data, pending tasks) are never dropped; long titles and places are shortened (…);
  // when it still does not fit, events and then tasks are left out from the end, each list saying exactly how many are
  // not shown. Only as a very last resort is the text cut, at a line end where possible.
  const LIMIT = 3900;
  const urgent = [...overdueShown, ...dueToday, ...dueWeek];
  // the course / project goes after the date: "Assignment 1" means little when you take four courses
  const cat = (t) => (oneLine(t['分类'] || '') ? ` · _${cutText(esc(oneLine(t['分类'])), 16)}_` : '');
  const taskLine = ({ t, due, left }) => `${dot(left)} **${cutText(esc(t['任务']), 80)}** · ${left < 0 ? `逾期 ${-left} 天` : left === 0 ? '今天' : left <= 6 ? weekday(due) : due.slice(5)}${cat(t)}`;
  const evShort = (d) => (e) => `${e.allDay ? '`  全天  `' : span(e, d)} ${cutText(e.title, 70)}${e.location ? ` · ${cutText(e.location, 40)}` : ''}`;
  const n = notes().map((x) => cutText(x, 600));
  const tomorrow = shift(today, 1);
  const tmr = onDay(tomorrow);
  const laterDays = [];
  for (let i = 2; i <= days; i++) { const d = shift(today, i); const evs = onDay(d); if (evs.length) laterDays.push([d, evs]); }
  const render = (maxTasks, maxToday, maxTmr, maxLater) => {
    const out = urgent.slice(0, maxTasks).map(taskLine);
    if (urgent.length > maxTasks) out.push(`…还有 ${urgent.length - maxTasks} 项`);
    if (!urgent.length) out.push(tableError ? '❓ 任务表读取失败，今天的任务清单不完整（原因见下）' : '✅ 没有近期要交的任务');
    // tasks due later (8-30 days) are not left out silently: one line with the nearest three and how many there are
    if (dueLater.length) out.push(`🟢 再往后 30 天内还有 ${dueLater.length} 项：${dueLater.slice(0, 3).map(({ t, due }) => `${cutText(esc(t['任务']), 24)}（${due.slice(5)}${oneLine(t['分类'] || '') ? ` · ${cutText(esc(oneLine(t['分类'])), 12)}` : ''}）`).join('、')}${dueLater.length > 3 ? ' 等' : ''}`);
    if (calendarUnknown) out.push('', '❓ 日历读取失败，今天的日程未知');
    else if (calendars) {
      out.push('', todayEvents.length ? `🗓 **今天 ${todayEvents.length} 项日程**` : '🗓 今天没有日程');
      out.push(...todayEvents.slice(0, maxToday).map(evShort(today)));
      if (todayEvents.length > maxToday) out.push(`…还有 ${todayEvents.length - maxToday} 项`);
      if (tmr.length) {
        out.push('', `🔜 **明天 ${weekday(tomorrow)} · ${tmr.length} 项**`, ...tmr.slice(0, maxTmr).map(evShort(tomorrow)));
        if (tmr.length > maxTmr) out.push(`…还有 ${tmr.length - maxTmr} 项`);
      }
      const shown = laterDays.slice(0, maxLater).map(([d, evs]) => `　${short(d)}：${evs.slice(0, 3).map((e) => `${e.allDay ? '' : cont(e, d) ? (e.endDay === d ? `续至${e.endHM} ` : '续 ') : `${e.startHM} `}${cutText(e.title, 30)}`).join('、')}${evs.length > 3 ? ` 等 ${evs.length} 项` : ''}`);
      if (shown.length) out.push('', '📆 之后几天', ...shown);
      if (laterDays.length > maxLater) out.push(`　…还有 ${laterDays.length - maxLater} 天有日程`);
    }
    if (n.length) out.push('', ...n);
    return out.join('\n');
  };
  let mk = 9, mt = 20, mm = 8, ml = laterDays.length;
  let description = render(mk, mt, mm, ml);
  while (description.length > LIMIT && (ml > 0 || mm > 0 || mt > 0 || mk > 0)) {
    if (ml > 0) ml--; else if (mm > 0) mm--; else if (mt > 0) mt--; else mk--;
    description = render(mk, mt, mm, ml);
  }
  if (description.length > LIMIT) { // notes alone are too long (should not happen): cut, at a line end if there is one
    const at = description.lastIndexOf('\n', LIMIT - 2);
    description = at > LIMIT / 2 ? `${description.slice(0, at)}\n…` : cutText(description, LIMIT);
  }
  return [{ title: `${titlePrefix}${+today.slice(5, 7)}月${+today.slice(8)}日 ${weekday(today)}`, description, color: overdueAll.length ? 0xe74c3c : urgent.some((x) => x.left <= 3) ? 0xe67e22 : urgent.length ? 0xf1c40f : 0x2ecc71 }];
};

// ---- full view (BRIEF_VIEW=full): grouped fields, upcoming days, later tasks, footer ----
const buildFull = () => {
  // ---- embed helpers (Discord limits: field value 1024, description 4096, total 6000) ----
  const fit = (lines, max = 1000) => {
    const out = [];
    let len = 0;
    for (let i = 0; i < lines.length; i++) {
      if (len + lines[i].length + 1 > max - 24) { out.push(`…还有 ${lines.length - i} 项`); break; }
      out.push(lines[i]); len += lines[i].length + 1;
    }
    return out.join('\n');
  };
  const fields = [];
  const add = (name, lines) => { if (lines.length) fields.push({ name, value: fit(lines), inline: false }); };
  const nowList = [...overdueShown, ...dueToday];
  add(`🔥 今天必做（${nowList.length}）`, nowList.map(taskLine));
  if (!nowList.length) fields.push({ name: '🔥 今天必做', value: tableError ? '❓ 任务表读取失败，清单不完整' : '没有到期的任务 ✅', inline: false });
  if (calendarUnknown) fields.push({ name: '🗓 今日日程', value: '❓ 日历读取失败，今天的日程未知', inline: false });
  else {
    add(`🗓 今日日程（${todayEvents.length}）`, todayEvents.map((e) => evLine(e, today)));
    if (!todayEvents.length) fields.push({ name: '🗓 今日日程', value: '今天没有日程 🎉', inline: false });
  }
  add(`⚠️ 本周要紧（${dueWeek.length}）`, dueWeek.map(taskLine));

  const upcoming = [];
  for (let i = 1; i <= days; i++) {
    const d = shift(today, i);
    const evs = onDay(d);
    if (!evs.length) continue;
    if (evs.length <= 3) { upcoming.push(`**${short(d)}**\n${evs.map((e) => evLine(e, d)).join('\n')}`); continue; }
    const timed = evs.filter((e) => !e.allDay);
    const range = timed.length ? ` · \`${timed[0].startHM}–${timed[timed.length - 1].endHM}\`` : '';
    const allDay = evs.filter((e) => e.allDay).map((e) => e.title);
    upcoming.push(`**${short(d)}** · ${evs.length} 项${range}${allDay.length ? `\n　全天：${allDay.join('、')}` : ''}`);
  }
  if (!calendarUnknown) add(`🔜 接下来 ${days} 天`, upcoming);
  add(`🗂 更远的（30 天内 ${dueLater.length} 项）`, dueLater.slice(0, 5).map(taskLine).concat(dueLater.length > 5 ? [`…还有 ${dueLater.length - 5} 项`] : []));

  const color = overdueAll.length ? 0xe74c3c : dueToday.length ? 0xe67e22 : dueWeek.length ? 0xf1c40f : 0x2ecc71;
  const summary = [
    nowList.length ? `🔥 **${nowList.length}** 项必做` : '',
    dueWeek.length ? `⚠️ **${dueWeek.length}** 项本周要紧` : '',
    todayEvents.length ? `🗓 **${todayEvents.length}** 项日程` : '',
  ].filter(Boolean).join('　·　') || '今天很清爽 ✨';
  const tm = input.timing || {};
  const im = ingest.metrics || {};
  const embeds = [{
    title: `${titlePrefix}📅 ${+today.slice(5, 7)}月${+today.slice(8)}日 ${weekday(today)} · 早安`,
    description: summary,
    color,
    fields,
    footer: { text: `${tasks.length ? `任务表 ${active.length} 项进行中` : '还没有任务'} · ${calendars} 个日历 · 读日历 ${Math.round((tm.totalMs || 0) / 100) / 10}s · 入库 ${Math.round((im.totalMs || 0) / 100) / 10}s${im.aiCalls ? `（AI ${im.aiCalls} 次）` : ''}` },
    timestamp: new Date().toISOString(),
  }];
  const n = notes();
  if (n.length) embeds.push({ description: n.join('\n').slice(0, 3800), color: 0x95a5a6 });
  return embeds;
};
const embeds = S.view === 'full' ? buildFull() : buildCompact();

// Keep the whole payload under Discord's 6000-character embed budget by dropping the least important fields.
const size = () => embeds.reduce((n, e) => n + (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length + (e.fields || []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
while (size() > 5800 && (embeds[0].fields || []).length > 2) embeds[0].fields.pop();

const payload = { embeds, allowed_mentions: { parse: [] } }; // never let task titles ping @everyone
const message = embeds.map((e) => [e.title, e.description, ...(e.fields || []).map((f) => `【${f.name}】\n${f.value}`)].filter(Boolean).join('\n\n')).join('\n\n');
return [{ json: { payload, message, eventCount: events.length, taskCount: active.length, newTasks: ingest.newTasks, errorCount: errors.length, timing: { calendarMs: (input.timing || {}).totalMs || 0, ingestMs: (ingest.metrics || {}).totalMs || 0, aiCalls: (ingest.metrics || {}).aiCalls || 0 } } }];
