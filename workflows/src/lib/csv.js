// Shared by several Code nodes (inlined by the build script via the include marker).
const TASK_COLUMNS = ['状态', '分类', '任务', '截止日', '预估耗时', '来源', '添加时间', '备注'];
const REQUIRED_COLUMNS = ['状态', '任务', '截止日'];
const TEXT_COLUMNS = ['分类', '任务', '备注', '来源'];

// What the "状态" column means. Anything unknown is treated as active-but-suspicious by the callers, never silently hidden.
function statusKind(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (v === '进行中' || v === 'active' || v === 'doing') return 'active';
  if (v === '待确认' || v === 'pending') return 'pending';
  if (['完成', '已完成', 'done', 'completed', 'finished'].includes(v)) return 'done';
  if (['忽略', '已忽略', 'ignore', 'ignored', '取消', '已取消', 'cancelled', 'canceled'].includes(v)) return 'ignored';
  return v === '' ? 'pending' : 'unknown';
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

// Accepts what people and spreadsheets write: 2026-10-02, 2026/10/2, 2026.10.2 (optionally followed by a time).
// Returns YYYY-MM-DD, or '' when it is not a real calendar date.
function normalizeDate(s) {
  const m = String(s ?? '').trim().match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/);
  if (!m) return '';
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? '' : iso;
}

// Spreadsheet formula injection: text starting with = + - @ gets an apostrophe on write, removed again on read.
const neutralize = (v) => (/^[=+\-@\t\r]/.test(v) ? `'${v}` : v);
const restore = (v) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

// Throws when the header is not recognisable: callers must then leave the file alone instead of rewriting it.
function readTasks(file, fs) {
  const withColumns = (arr, cols) => { arr.columns = cols; return arr; }; // the column list travels with the rows, so a header-only file keeps its custom columns
  if (!fs.existsSync(file)) return withColumns([], [...TASK_COLUMNS]);
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return withColumns([], [...TASK_COLUMNS]);
  const head = rows[0].map((h) => h.trim());
  const missing = REQUIRED_COLUMNS.filter((c) => !head.includes(c));
  if (missing.length) throw new Error(`任务表表头无法识别（缺少列：${missing.join('、')}），程序不会改动这个文件。请恢复表头：${TASK_COLUMNS.join(',')}`);
  // Columns the user added themselves (for example "优先级") are carried along and written back untouched.
  const extra = head.filter((h, i) => h && !TASK_COLUMNS.includes(h) && head.indexOf(h) === i);
  return withColumns(rows.slice(1).map((r) => Object.fromEntries([...TASK_COLUMNS, ...extra].map((c) => {
    const v = (r[head.indexOf(c)] ?? '').trim();
    return [c, TEXT_COLUMNS.includes(c) ? restore(v) : v];
  }))), [...TASK_COLUMNS, ...extra]);
}

// options.backup (default true): keep the previous file as file.bak. A run that writes several times passes false after
// the first write, so the backup is always the file exactly as the user left it before the run.
function writeTasks(file, tasks, fs, options = {}) {
  const esc = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const cell = (t, c) => esc(TEXT_COLUMNS.includes(c) ? neutralize(String(t[c] ?? '')) : String(t[c] ?? ''));
  const extra = [];
  for (const c of tasks.columns || []) if (!TASK_COLUMNS.includes(c) && !extra.includes(c)) extra.push(c);
  for (const t of tasks) for (const k of Object.keys(t)) if (!TASK_COLUMNS.includes(k) && !extra.includes(k)) extra.push(k);
  const cols = [...TASK_COLUMNS, ...extra];
  const lines = [cols.map(esc).join(','), ...tasks.map((t) => cols.map((c) => cell(t, c)).join(','))];
  if (options.backup !== false && fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8'); // BOM so Excel shows Chinese correctly
  fs.renameSync(tmp, file);
}
