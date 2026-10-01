import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { loadSource, tmpdir } from './helpers.mjs';

// csv.js is plain function declarations: evaluate it in a context and pull the functions out.
const ctx = vm.createContext({});
vm.runInContext(loadSource('lib/csv.js') + '\nthis.api = { normalizeDate, readTasks, writeTasks, parseCsv, TASK_COLUMNS };', ctx);
const { normalizeDate, readTasks, writeTasks, TASK_COLUMNS } = ctx.api;

test('dates: accepts the formats Excel and people write, rejects impossible dates', () => {
  for (const [input, want] of [['2026-10-02', '2026-10-02'], ['2026/10/2', '2026-10-02'], ['2026.10.2', '2026-10-02'], ['2026-1-5', '2026-01-05'],
    ['2026/10/2 09:00', '2026-10-02'], [' 2026-10-02 ', '2026-10-02'], ['2026-13-01', ''], ['2026-02-30', ''], ['10/2/2026', ''], ['', ''], [undefined, ''],
    // Excel in other locales: day-first or month-first, accepted only when the order cannot be mistaken
    ['25/12/2026', '2026-12-25'], ['12/25/2026', '2026-12-25'], ['14/10/2026 09:00', '2026-10-14'], ['3/4/2026', ''], ['31/02/2026', ''], ['13/13/2026', '']]) {
    assert.equal(normalizeDate(input), want, `normalizeDate(${JSON.stringify(input)})`);
  }
});

test('a damaged header is an error, and the file is left untouched', () => {
  const dir = tmpdir(); const f = path.join(dir, 'tasks.csv');
  fs.writeFileSync(f, '乱码,列,名\r\n进行中,Final exam,2026-10-02\r\n');
  assert.throws(() => readTasks(f, fs), /表头无法识别/);
  assert.equal(fs.readFileSync(f, 'utf8'), '乱码,列,名\r\n进行中,Final exam,2026-10-02\r\n');
});

test('a semicolon-separated file (common in some locales) is also rejected instead of read as empty rows', () => {
  const dir = tmpdir(); const f = path.join(dir, 'tasks.csv');
  fs.writeFileSync(f, '状态;分类;任务;截止日\r\n进行中;Math;HW;2026-10-02\r\n');
  assert.throws(() => readTasks(f, fs), /表头无法识别/);
});

test('round trip keeps every column, Chinese text, commas, quotes and newlines', () => {
  const dir = tmpdir(); const f = path.join(dir, 'tasks.csv');
  const row = Object.fromEntries(TASK_COLUMNS.map((c) => [c, `${c},"x"\nline2`]));
  writeTasks(f, [row], fs);
  const [back] = readTasks(f, fs);
  assert.deepEqual(JSON.parse(JSON.stringify(back)), Object.fromEntries(TASK_COLUMNS.map((c) => [c, row[c].trim()]))); // JSON round trip: the vm context has its own Object prototype
});

test('formula text is neutralised on disk and restored on read', () => {
  const dir = tmpdir(); const f = path.join(dir, 'tasks.csv');
  writeTasks(f, [{ '状态': '待确认', '分类': '@cmd', '任务': '=HYPERLINK("http://evil","x")', '截止日': '2026-10-02', '备注': '+1', '来源': '-2' }], fs);
  const raw = fs.readFileSync(f, 'utf8');
  assert.match(raw, /'=HYPERLINK/); assert.doesNotMatch(raw, /(^|,)=HYPERLINK/m);
  const [t] = readTasks(f, fs);
  assert.equal(t['任务'], '=HYPERLINK("http://evil","x")'); assert.equal(t['分类'], '@cmd');
});

test('writing keeps a one-step backup of the previous file', () => {
  const dir = tmpdir(); const f = path.join(dir, 'tasks.csv');
  writeTasks(f, [{ '状态': '进行中', '任务': 'first' }], fs);
  writeTasks(f, [{ '状态': '进行中', '任务': 'second' }], fs);
  assert.match(fs.readFileSync(`${f}.bak`, 'utf8'), /first/);
});

test('status meanings: active, pending, done, ignored, unknown (and an empty status counts as waiting)', () => {
  const ctx2 = vm.createContext({}); vm.runInContext(loadSource('lib/csv.js') + '\nthis.k = statusKind;', ctx2);
  const k = ctx2.k;
  for (const [s, want] of [['进行中', 'active'], ['待确认', 'pending'], ['完成', 'done'], ['已完成', 'done'], ['Done', 'done'], ['忽略', 'ignored'], ['取消', 'ignored'], ['', 'pending'], ['whatever', 'unknown'], [' 进行中 ', 'active']]) assert.equal(k(s), want, s);
});

test('a header-only file keeps its custom columns through the reader and writer', () => {
  const dir = tmpdir(); const f = path.join(dir, 'tasks.csv');
  fs.writeFileSync(f, '﻿状态,分类,任务,截止日,预估耗时,来源,添加时间,备注,优先级\r\n');
  const rows = readTasks(f, fs); assert.equal(rows.length, 0); assert.ok(rows.columns.includes('优先级'));
  rows.push({ '状态': '待确认', '任务': 'x' }); writeTasks(f, rows, fs);
  assert.match(fs.readFileSync(f, 'utf8').replace(/^﻿/, '').split('\r\n')[0], /,优先级$/);
});
