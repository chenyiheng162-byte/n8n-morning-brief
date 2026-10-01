// n8n Code node. Scans the inbox for new/changed files, extracts their text, asks the AI for tasks
// and appends them to tasks.csv (as "待确认", or "进行中" when BRIEF_AUTO_CONFIRM is on and the date is explicit).
// Dates are validated and resolved by code, never trusted blindly.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
//@include csv.js
//@include settings.js

const t0 = Date.now();
const cal = $('Read calendars').first().json;
const today = cal.today;
const S = loadSettings($env);
const inbox = $env.BRIEF_INBOX || path.join(os.homedir(), 'n8n-inbox');
const stateDir = $env.BRIEF_STATE_DIR || path.join($env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief'), 'data', 'state');
const tasksFile = path.join(inbox, 'tasks.csv');
const seenFile = path.join(stateDir, 'processed.json');
const MAX_FILES = 10, MAX_CHUNKS = 10, MAX_ATTEMPTS = 3, MAX_LATE_RETRIES = 3, RANGE_DAYS = 366, MAX_EXTRACT_ATTEMPTS = 5;
const LATE_RETRY_MS = 20 * 3600 * 1000; // a bit under a day: a run that starts a few seconds earlier than yesterday's must still count as the next day
const MAX_CHARS = S.chunkChars;
// The whole run must finish well inside the Code-node timeout and the caller's execution budget:
// no new AI call is started after the budget, and one call may take at most aiTimeoutMs.
const BUDGET_MS = S.ingestBudgetMs;
const AI_TIMEOUT_MS = S.aiTimeoutMs;
const SUPPORTED = ['.pdf', '.docx', '.txt', '.md'];
const baseDate = S.baseDate;

fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
let seen = {};
try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch (e) { seen = {}; }
for (const k of ['done', 'failed', 'failedAt', 'partial', 'offset', 'chunkEnd', 'truncated', 'gaveUp', 'aiCaps']) seen[k] = seen[k] || {};
const DRY = !!$env.BRIEF_DRY_RUN; // preview: report what would be processed, but call no AI and write nothing
// State format 2 (2026-10-01): a file in progress records the character position AND the end of the chunk being read.
// Older state recorded only a position, so how much of the 10-chunk allowance had been used is unknown: such files are
// read again from the start, once (exact duplicate tasks are not added again). Finished files are not touched.
const STATE_VERSION = 2;
if ((seen.version || 1) < STATE_VERSION) {
  for (const h of new Set([...Object.keys(seen.offset), ...Object.keys(seen.partial)])) { delete seen.offset[h]; delete seen.partial[h]; delete seen.chunkEnd[h]; }
  seen.version = STATE_VERSION;
}
const save = DRY ? () => {} : () => { fs.writeFileSync(`${seenFile}.tmp`, JSON.stringify(seen, null, 1)); fs.renameSync(`${seenFile}.tmp`, seenFile); };

const errors = [];
const stats = { files: 0, newTasks: 0, skipped: 0 };
const metrics = { aiCalls: 0, aiMs: 0 };
const safe = (m) => String(m || '').replace(/https?:\/\/\S+/g, '<链接>').slice(0, 120); // links can be secrets
const clip = (s, n) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const daysFromToday = (s) => daysBetween(today, s);
const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function resolveDue(t) {
  const note = clip(t.note, 300);
  const join = (a, b) => (b ? `${a}；${b}` : a);
  const explicit = normalizeDate(t.due);
  if (explicit) {
    return Math.abs(daysFromToday(explicit)) > RANGE_DAYS
      ? { due: '', note: join(`AI 给出的日期 ${explicit} 离今天超过一年，请核对`, note) }
      : { due: explicit, note, certain: true };
  }
  if (t.due) return { due: '', note: join(`无法识别的日期「${clip(t.due, 20)}」`, note) };
  const w = Number(t.week), wd = Number(t.weekday);
  if (Number.isInteger(w) && w >= 1 && w <= 60 && Number.isInteger(wd) && wd >= 1 && wd <= 7) {
    if (!baseDate) return { due: '', note: join(`第${w}周 周${wd}（缺少起始日 BRIEF_BASE_DATE，无法换算）`, note) };
    const due = addDays(baseDate, (w - 1) * 7 + (wd - 1));
    return Math.abs(daysFromToday(due)) > RANGE_DAYS
      ? { due: '', note: join(`第${w}周 周${wd} 换算出 ${due}，离今天超过一年，请核对`, note) }
      : { due, note: note || `第${w}周 周${wd}` };
  }
  return { due: '', note };
}

// PDF/DOCX are converted beforehand by scripts/extract-inbox.mjs (the Code-node sandbox breaks those parsers).
function extractText(file, hash) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.txt' || ext === '.md') return fs.readFileSync(file, 'utf8');
  const dir = path.join(stateDir, 'extracted');
  if (fs.existsSync(path.join(dir, `${hash}.txt`))) return fs.readFileSync(path.join(dir, `${hash}.txt`), 'utf8');
  // Extraction problems expire by themselves (extract-inbox.mjs retries after 6 hours), so they are never counted as
  // failed attempts. After MAX_EXTRACT_ATTEMPTS tries the file is given up on, with ONE clear message.
  const waiting = (msg, extra) => Object.assign(new Error(msg), { waiting: true }, extra);
  const errFile = path.join(dir, `${hash}.err`);
  if (fs.existsSync(errFile)) {
    const raw = fs.readFileSync(errFile, 'utf8');
    let info = { n: 1, msg: raw.slice(0, 200) };
    try { const j = JSON.parse(raw); info = { n: Number(j.n) || 1, msg: String(j.msg || '').slice(0, 200) }; } catch (e) { /* older plain-text format */ }
    if (info.n >= MAX_EXTRACT_ATTEMPTS) throw waiting(`${info.msg}`, { gaveUp: true });
    throw waiting(`文字提取失败，稍后自动重试（第 ${info.n} 次）：${info.msg}`);
  }
  throw waiting('文字尚未提取（PDF/DOCX 由 run-brief.sh 在启动前处理）');
}

// Where a PDF/DOCX stands BEFORE it is queued: a file that is waiting for extraction or has been given up on must not take
// one of the MAX_FILES places of files that can actually be read.
function extractionState(ext, hash) {
  if (ext === '.txt' || ext === '.md') return { ok: true };
  const dir = path.join(stateDir, 'extracted');
  if (fs.existsSync(path.join(dir, `${hash}.txt`))) return { ok: true };
  const errFile = path.join(dir, `${hash}.err`);
  if (!fs.existsSync(errFile)) return { waiting: '文字尚未提取（PDF/DOCX 由 run-brief.sh 在启动前处理）' };
  const raw = fs.readFileSync(errFile, 'utf8');
  let info = { n: 1, msg: raw.slice(0, 200) };
  try { const j = JSON.parse(raw); info = { n: Number(j.n) || 1, msg: String(j.msg || '').slice(0, 200) }; } catch (e) { /* older plain-text format */ }
  return info.n >= MAX_EXTRACT_ATTEMPTS ? { gaveUp: info.msg } : { waiting: `文字提取失败，稍后自动重试（第 ${info.n} 次）：${info.msg}` };
}

// Long documents are split at paragraph boundaries so nothing beyond the first chunk is silently ignored.
function chunks(text) {
  const out = [];
  let rest = text;
  while (rest.length > MAX_CHARS) {
    let cut = rest.lastIndexOf('\n', MAX_CHARS);
    if (cut < MAX_CHARS * 0.5) cut = MAX_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

const SYSTEM = `You extract actionable tasks (assignments, exams, submissions, deadlines, events that need preparation) from a document.
Reply with a single JSON object only: {"tasks":[{"category":string,"title":string,"due":"YYYY-MM-DD"|null,"week":number|null,"weekday":number|null,"hours":number|null,"note":string}]}
Rules:
- Never invent tasks or dates. Only include what the document states.
- A task is something the reader must do, prepare, submit, pay or decide. A schedule entry that is only attended (a work shift, a regular class, a routine meeting) is NOT a task; if it needs preparation, the preparation is the task.
- "due": only when the document gives a concrete calendar date. If the year is missing, use the year that makes the date closest to Today (given in the user message).
- If the deadline is given as a week number plus a weekday (e.g. "Friday of Week 4"), set "week" and "weekday" (1=Monday..7=Sunday) and leave "due" null.
- If the date is unclear, TBD, or relative to something unknown (e.g. "next Wednesday" in an undated document), leave due/week/weekday null and quote the original wording in "note".
- "category": the course or project name from the document (if a list of known course names is given and the document is about one of them, use that exact spelling). When the document has a short course code (e.g. "STAT3612"), use the code rather than the long course title; use the same category for every task of one course. "title": short. Keep the document's language.
- "hours": estimated effort only if the document states it, else null. "note": empty string unless needed.
- If there are no tasks, return {"tasks":[]}.`;

let knownCourses = [];
const isTimeout = (e) => /timeout|timed out|ETIMEDOUT|ESOCKETTIMEDOUT/i.test(String((e && e.message) || ''));
const httpCode = (e) => Number((e && (e.httpCode ?? e.statusCode ?? (e.response && e.response.status))) || ((String((e && e.message) || '').match(/\b([45]\d\d)\b/) || [])[1])) || 0;
const retryable = (e) => { const c = httpCode(e); return c === 429 || c >= 500 || /ECONNRESET|socket hang up|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|network/i.test(String((e && e.message) || '')); };

// Providers differ: some wrap the JSON in prose, some reject response_format, some rate-limit, reasoning models can be slow.
function extractJson(raw) {
  const s = String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(s); } catch (e) { /* fall through: look for the JSON object inside the text */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* fall through */ } }
  throw new Error(`AI 的回复不是有效的 JSON：${clip(s, 60)}`);
}

// canSplit: a request that times out on a long piece is reported as tooSlow, and the caller reads that piece in two halves.
async function askAI(name, text, part, parts, canSplit = true) {
  const known = knownCourses.length ? `\nKnown course names (reuse the exact spelling when the document is about the same course): ${knownCourses.join('; ')}` : '';
  const user = `Today: ${today}\nFilename: ${name}${parts > 1 ? `\nPart ${part} of ${parts}` : ''}${known}\n\n${text}`;
  const headers = { 'Content-Type': 'application/json' };
  if ($env.AI_API_KEY) headers.Authorization = `Bearer ${$env.AI_API_KEY}`;
  const post = (jsonMode) => this.helpers.httpRequest({
    method: 'POST', url: `${$env.AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, headers,
    body: { model: $env.AI_MODEL, temperature: 0, ...(jsonMode ? { response_format: { type: 'json_object' } } : {}), messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] },
    json: true, timeout: AI_TIMEOUT_MS,
  });
  let jsonMode = seen.aiCaps.noJsonMode !== $env.AI_BASE_URL; // remembered per provider: a new AI service is asked for JSON mode again
  let res;
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && Date.now() - t0 > BUDGET_MS) throw Object.assign(new Error('ingest time budget used up'), { budget: true }); // every retry obeys the same budget (the caller checks it before every piece)
    const ts = Date.now();
    try { metrics.aiCalls++; res = await post(jsonMode); metrics.aiMs += Date.now() - ts; break; } catch (e) {
      metrics.aiMs += Date.now() - ts;
      if (jsonMode && httpCode(e) === 400 && /response_format|json_object|json mode|unsupported/i.test(String(e.message))) { jsonMode = false; seen.aiCaps.noJsonMode = $env.AI_BASE_URL; save(); continue; } // this provider has no JSON mode: remember it
      if (isTimeout(e) && canSplit && text.length > 4000) throw Object.assign(e, { tooSlow: true }); // too slow for this much text: the caller halves it
      if (retryable(e) && attempt < 2 && Date.now() - t0 < BUDGET_MS) { await sleep(3000 * (attempt + 1)); continue; } // rate limit / server hiccup: back off
      throw e;
    }
  }
  const content = res && res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content;
  if (!content) throw new Error('AI 没有返回内容（推理模型可能只返回了思考过程：请换一个模型，或调大 BRIEF_AI_TIMEOUT_MS）');
  const parsed = extractJson(content);
  let list = parsed.tasks;
  if (list && !Array.isArray(list) && typeof list === 'object') list = [list];
  if (!Array.isArray(list)) throw new Error('AI 返回的 JSON 缺少 tasks 数组');
  return list.filter((x) => x && typeof x === 'object');
}

const names = fs.readdirSync(inbox).filter((n) => {
  if (n.startsWith('.') || n.startsWith('~$') || /^tasks\.csv(\.|$)/.test(n) || n.endsWith('.tmp')) return false; // our own files, hidden files, Office lock files
  const st = fs.lstatSync(path.join(inbox, n));
  // a symbolic link could point anywhere on the disk: only real files in the inbox are read (and sent to the AI)
  if (st.isSymbolicLink()) { if (!seen.done[`symlink:${n}`]) { errors.push(`${n} 是符号链接（替身），不会被读取：请把文件本身放进收件夹`); seen.done[`symlink:${n}`] = today; } return false; }
  return st.isFile();
});
const pending = [];
const present = new Set();
for (const n of names) {
  const ext = path.extname(n).toLowerCase();
  if (!SUPPORTED.includes(ext)) { if (!seen.done[`unsupported:${n}`]) { errors.push(`不支持的文件格式：${n}（支持 pdf、docx、txt、md）`); seen.done[`unsupported:${n}`] = today; } continue; }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, n))).digest('hex');
  present.add(hash);
  if (seen.done[hash]) {
    stats.skipped++;
    // a long file that was only read in part is mentioned once a week for as long as it stays in the inbox
    const tr = seen.truncated[hash];
    if (tr && !seen.done[hash].ignored && daysBetween(tr.remindedAt || '1970-01-01', today) >= 7) { errors.push(`${n} 太长（超过 ${MAX_CHUNKS} 段），只读了前 ${MAX_CHUNKS * MAX_CHARS} 个字符，后面的没读：请拆分后再放入`); tr.remindedAt = today; }
    continue;
  }
  const fails = seen.failed[hash] || 0;
  if (fails >= MAX_ATTEMPTS) {
    // After three quick failures a file gets one more try per day (at most MAX_LATE_RETRIES): a provider that was down
    // recovers by itself, a hopeless file eventually stops costing money. Older state without a timestamp is eligible at once.
    if (fails - MAX_ATTEMPTS >= MAX_LATE_RETRIES) { if (!seen.gaveUp[hash]) { errors.push(`${n} 多次处理失败，已放弃：请检查文件内容，或运行 scripts/inbox-tool.mjs retry 重新处理`); seen.gaveUp[hash] = today; } stats.skipped++; continue; }
    if (Date.now() - (seen.failedAt[hash] || 0) < LATE_RETRY_MS) { stats.skipped++; continue; }
  }
  const ex = extractionState(ext, hash);
  if (ex.gaveUp !== undefined) { if (!seen.gaveUp[hash]) { errors.push(`${n} 无法提取文字（已尝试 ${MAX_EXTRACT_ATTEMPTS} 次）：${safe(ex.gaveUp)}。请移走它，或重新导出为可复制文字的 PDF/DOCX`); seen.gaveUp[hash] = today; } stats.skipped++; continue; }
  if (ex.waiting) { errors.push(`${n}：${safe(ex.waiting)}`); stats.skipped++; continue; }
  pending.push({ n, hash, size: fs.statSync(path.join(inbox, n)).size });
}
for (const h of Object.keys(seen.partial)) if (!present.has(h)) { delete seen.partial[h]; delete seen.offset[h]; delete seen.chunkEnd[h]; } // the file changed or was removed
for (const h of Object.keys(seen.truncated)) if (!present.has(h)) delete seen.truncated[h];
// Small files first, so one huge document can never starve the others.
pending.sort((a, b) => a.size - b.size);

let remaining = 0;
if (DRY && pending.length) {
  errors.push(`预览模式：${pending.length} 个新文件没有被处理（真实运行时才会调用 AI 并写入任务表）`);
  remaining = pending.length;
} else if (pending.length && !($env.AI_BASE_URL && $env.AI_MODEL)) {
  errors.push(`收件夹里有 ${pending.length} 个新文件，但还没配置 AI（运行 scripts/set-ai-key.sh）`);
} else if (pending.length) {
  let tasks = null;
  try { tasks = readTasks(tasksFile, fs); } catch (e) { errors.push(safe(e.message)); }
  if (tasks === null) {
    remaining = pending.length; // a damaged task table blocks ingestion: nothing is sent to the AI, nothing is rewritten
  } else {
    knownCourses = [...new Set(tasks.map((t) => t['分类']).filter(Boolean))].slice(0, 30);
    // Same title + same due date is only a duplicate when the (normalised) course name is exactly the same too. Anything
    // less certain is KEPT and flagged in the note: a spare row can be ignored with one edit, a silently dropped task
    // is never noticed. (The AI does not always name a course the same way, so re-reading an edited file can flag rows.)
    const norm = (s) => String(s).toLowerCase().replace(/[\s_\-]+/g, '');
    const keyOf = (t, d) => `${norm(t)}|${d}`;
    const index = new Map();
    for (const t of tasks) { const k = keyOf(t['任务'], normalizeDate(t['截止日'])); index.set(k, [...(index.get(k) || []), t]); }

    const addTask = (raw, source) => {
      if (!raw || typeof raw !== 'object' || !clip(raw.title, 200)) return 0;
      const { due, note, certain } = resolveDue(raw);
      const category = clip(raw.category || path.basename(source, path.extname(source)), 80);
      const title = clip(raw.title, 200);
      const k = keyOf(title, due);
      const same = index.get(k) || [];
      if (same.some((r) => norm(r['分类']) === norm(category))) return 0;
      const hours = Number(raw.hours);
      // BRIEF_AUTO_CONFIRM (off by default): tasks whose date is explicit and that are not possible duplicates go straight to 进行中.
      const status = S.autoConfirm && certain && !same.length ? '进行中' : '待确认';
      const row = { '状态': status, '分类': category, '任务': title, '截止日': due, '预估耗时': hours > 0 && hours <= 200 ? `${hours}h` : '', '来源': source, '添加时间': today, '备注': same.length ? `${note ? `${note}；` : ''}可能与「${same[0]['来源']}」里的同名任务重复` : note };
      tasks.push(row);
      index.set(k, [...same, row]);
      return 1;
    };

    let budgetHit = false;
    let handled = 0;
    let backedUp = false; // tasks.csv.bak is taken once per run: the file exactly as the user left it
    const persistTasks = () => { writeTasks(tasksFile, tasks, fs, { backup: !backedUp }); backedUp = true; };
    for (const { n, hash } of pending.slice(0, MAX_FILES)) {
      if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; break; }
      let finished = false;
      try {
        const text = extractText(path.join(inbox, n), hash).trim();
        if (text.length < 20) throw new Error('文件里几乎没有可读文字（可能是扫描图片）');
        // Progress is recorded as the number of CHARACTERS already read, not as a chunk number, so changing the chunk size
        // between runs cannot skip or repeat any text. (Older state with only a chunk number is converted once.)
        let done = seen.partial[hash] || 0;
        let consumed = seen.offset[hash];
        // Older state recorded only a chunk NUMBER, and the chunk size it was read with is unknown (it may have changed):
        // guessing the position could skip text, so such a file is read again from the start. Tasks that are exactly the
        // same (course, title, date) are not added twice.
        if (consumed === undefined) { consumed = 0; done = 0; delete seen.chunkEnd[hash]; }
        // The document is read in logical chunks [start, end). A chunk that was only half read when time ran out is
        // FINISHED first (its end is stored), and only then is it counted, so resuming never resets the 10-chunk limit.
        const units = [];
        let pos = consumed;
        const openEnd = seen.chunkEnd[hash];
        if (openEnd > consumed && openEnd <= text.length) { units.push([consumed, openEnd]); pos = openEnd; }
        for (const c of chunks(text.slice(pos))) { units.push([pos, pos + c.length]); pos += c.length; }
        const use = units.slice(0, Math.max(0, MAX_CHUNKS - done)).map(([a, b]) => text.slice(a, b));
        const useEnds = units.slice(0, use.length).map(([, b]) => b);
        const parts = units;
        if (parts.length > use.length) {
          // Say it on the first day and then only once a week, so a long file is not nagged about every morning.
          const prev = seen.truncated[hash];
          const due = !prev || daysBetween(prev.remindedAt || '1970-01-01', today) >= 7;
          if (due) errors.push(`${n} 太长（超过 ${MAX_CHUNKS} 段），只读了前 ${MAX_CHUNKS * MAX_CHARS} 个字符，后面的没读：请拆分后再放入`);
          seen.truncated[hash] = { file: n, chunks: done + parts.length, read: MAX_CHUNKS, remindedAt: due ? today : prev.remindedAt };
        }
        const halves = (t) => { let cut = t.lastIndexOf('\n', Math.floor(t.length / 2)); if (cut < t.length * 0.25) cut = Math.floor(t.length / 2); return [t.slice(0, cut), t.slice(cut)]; };
        for (let i = 0; i < use.length && !budgetHit; i++) {
          // A chunk is read as one piece. A piece that is too slow is read as two halves instead (once). EVERY piece that
          // succeeds is saved at once, with the exact character position, so running out of time loses nothing.
          const pieces = [{ text: use[i], half: false }];
          seen.chunkEnd[hash] = useEnds[i]; // where this logical chunk ends, kept until it is complete
          while (pieces.length) {
            if (Date.now() - t0 > BUDGET_MS) { budgetHit = true; break; }
            let list;
            try { list = await askAI.call(this, n, pieces[0].text, done + i + 1, done + use.length, !pieces[0].half); } catch (e) {
              if (!e.tooSlow) throw e;
              pieces.splice(0, 1, ...halves(pieces[0].text).map((t) => ({ text: t, half: true })));
              continue;
            }
            let added = 0;
            for (const raw of list) added += addTask(raw, n);
            if (added) { persistTasks(); stats.newTasks += added; }
            consumed += pieces.shift().text.length;
            seen.offset[hash] = consumed; save();
          }
          if (!budgetHit) { seen.partial[hash] = done + i + 1; delete seen.chunkEnd[hash]; save(); }
        }
        finished = !budgetHit;
      } catch (e) {
        if ($env.BRIEF_DEBUG) console.error(e.stack);
        if (e.budget) budgetHit = true; // out of time, not a failure of the file: it continues tomorrow
        else if (e.gaveUp) {
          if (!seen.gaveUp[hash]) { errors.push(`${n} 无法提取文字（已尝试 ${MAX_EXTRACT_ATTEMPTS} 次）：${safe(e.message)}。请移走它，或重新导出为可复制文字的 PDF/DOCX`); seen.gaveUp[hash] = today; }
          handled++; // permanent: do not count it as "continue tomorrow"
        } else if (e.waiting) errors.push(`${n}：${safe(e.message)}`);
        else {
          seen.failed[hash] = (seen.failed[hash] || 0) + 1;
          seen.failedAt[hash] = Date.now();
          errors.push(`文件处理失败：${n}（${safe(e.message)}）${seen.failed[hash] >= MAX_ATTEMPTS ? '，暂停重试，之后每天最多再试一次' : ''}`);
          handled++;
        }
      }
      if (finished) { seen.done[hash] = { file: n, at: today }; delete seen.partial[hash]; delete seen.offset[hash]; delete seen.chunkEnd[hash]; delete seen.failed[hash]; delete seen.failedAt[hash]; stats.files++; handled++; }
      save();
    }
    remaining = pending.length - handled;
    if (remaining > 0) errors.push(`还有 ${remaining} 个文件明天继续处理${budgetHit ? '（本次时间预算已用完）' : ''}`);
  }
}
save();
return [{ json: { ...cal, ingest: { ...stats, errors, remaining, metrics: { ...metrics, totalMs: Date.now() - t0 } }, tasksFile, inbox } }];
