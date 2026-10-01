#!/usr/bin/env node
// Inspect and repair what the ingest step knows about the files in your inbox. Makes no network calls and never prints
// a secret.
//   node inbox-tool.mjs status [--json]      every file: new / partly read / done / waiting / failed / given up / too long
//   node inbox-tool.mjs retry <file>         forget the failures of ONE file so it is processed again (keeps its reading progress)
//   node inbox-tool.mjs retry <file> --full  ... and start reading that file from the beginning
//   node inbox-tool.mjs ignore <file>        mark a file as handled without reading it
//   node inbox-tool.mjs unignore <file>      undo ignore: the file is read by the next run
//   node inbox-tool.mjs remove <file>        move the file to the Trash (~/.Trash), where you can still get it back
// Run it through `scripts/inbox.sh` so the settings (inbox folder, state folder) are loaded.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { acquireLock } from './lock.mjs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const home = env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');
const inbox = env.BRIEF_INBOX || path.join(os.homedir(), 'n8n-inbox');
const stateDir = env.BRIEF_STATE_DIR || path.join(home, 'data', 'state');
const seenFile = path.join(stateDir, 'processed.json');
const SUPPORTED = ['.pdf', '.docx', '.txt', '.md'];
const MAX_ATTEMPTS = 3, MAX_LATE_RETRIES = 3, LATE_RETRY_MS = 20 * 3600 * 1000, MAX_EXTRACT_ATTEMPTS = 5;

// the same CSV helpers the workflow uses
const srcDir = env.BRIEF_SRC_DIR || path.join(here, '..', 'workflows', 'src');
const ctx = vm.createContext({});
vm.runInContext(`${fs.readFileSync(path.join(srcDir, 'lib', 'csv.js'), 'utf8')}\nthis.api = { readTasks, statusKind };`, ctx);
const { readTasks, statusKind } = ctx.api;

const load = () => { try { return JSON.parse(fs.readFileSync(seenFile, 'utf8')); } catch (e) { return {}; } };
const seen = load();
for (const k of ['done', 'failed', 'failedAt', 'partial', 'offset', 'chunkEnd', 'truncated', 'gaveUp', 'aiCaps']) seen[k] = seen[k] || {};
// Hashes are remembered per file size and modification time: the console asks for the inbox status every half minute,
// and reading hundreds of megabytes of PDFs each time is not free. A changed file gets a new hash.
const hashCacheFile = path.join(stateDir, 'inbox-hashes.json');
const hashCache = (() => { try { return JSON.parse(fs.readFileSync(hashCacheFile, 'utf8')) || {}; } catch (e) { return {}; } })();
let hashCacheDirty = false;
const hashOf = (f) => {
  const st = fs.statSync(path.join(inbox, f)); const c = hashCache[f];
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs && /^[0-9a-f]{64}$/.test(c.hash)) return c.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, f))).digest('hex');
  hashCache[f] = { size: st.size, mtimeMs: st.mtimeMs, hash }; hashCacheDirty = true;
  return hash;
};
const saveHashCache = () => { if (!hashCacheDirty) return; try { for (const k of Object.keys(hashCache)) if (!fs.existsSync(path.join(inbox, k))) delete hashCache[k]; fs.mkdirSync(stateDir, { recursive: true }); const tmp = `${hashCacheFile}.tmp`; fs.writeFileSync(tmp, JSON.stringify(hashCache)); fs.renameSync(tmp, hashCacheFile); } catch (e) { /* a cache only */ } };
const listFiles = () => (fs.existsSync(inbox) ? fs.readdirSync(inbox).filter((n) => !n.startsWith('.') && !n.startsWith('~$') && !/^tasks\.csv(\.|$)/.test(n) && !n.endsWith('.tmp') && (() => { const st = fs.lstatSync(path.join(inbox, n)); return st.isFile() || st.isSymbolicLink(); })()) : []);
const isLink = (n) => fs.lstatSync(path.join(inbox, n)).isSymbolicLink();

function describe(name) {
  const ext = path.extname(name).toLowerCase();
  // a link could point anywhere on the disk: only real files in the inbox are read
  if (isLink(name)) return { name, state: 'unsupported', detail: '这是一个符号链接（替身），不会被读取：请把文件本身放进收件夹' };
  if (!SUPPORTED.includes(ext)) return { name, state: 'unsupported', detail: '格式不支持（支持 pdf、docx、txt、md）' };
  const hash = hashOf(name);
  const errFile = path.join(stateDir, 'extracted', `${hash}.err`);
  const fails = seen.failed[hash] || 0;
  const info = { name, hash: hash.slice(0, 10) };
  if (seen.done[hash]) return { ...info, state: seen.done[hash].ignored ? 'ignored' : 'done', detail: seen.done[hash].ignored ? '已标记为忽略' : `已处理（${seen.done[hash].at || ''}）`, truncated: !!seen.truncated[hash] };
  if (fails >= MAX_ATTEMPTS + MAX_LATE_RETRIES) return { ...info, state: 'gave-up', detail: `多次失败，已放弃（${fails} 次）。修复原因后运行：retry ${name}` };
  if (fails >= MAX_ATTEMPTS) { const next = new Date((seen.failedAt[hash] || 0) + LATE_RETRY_MS); return { ...info, state: 'failed', detail: `失败 ${fails} 次，暂停中，下次自动重试 ${seen.failedAt[hash] ? next.toLocaleString('zh-CN', { hour12: false }) : '下一次运行'}` }; }
  if (!['.txt', '.md'].includes(ext) && fs.existsSync(errFile)) {
    let e = { n: 1, msg: '' }; try { e = JSON.parse(fs.readFileSync(errFile, 'utf8')); } catch (x) { /* plain text */ }
    return { ...info, state: e.n >= MAX_EXTRACT_ATTEMPTS ? 'gave-up' : 'waiting-extraction', detail: `文字提取失败（第 ${e.n} 次）：${String(e.msg || '').slice(0, 80)}` };
  }
  if (seen.partial[hash]) return { ...info, state: 'partial', detail: `读到第 ${seen.partial[hash]} 段，下一次运行接着读`, truncated: !!seen.truncated[hash] };
  return { ...info, state: 'new', detail: fails ? `上次失败 ${fails} 次` : '等待处理' };
}

// Changing commands take the same lock as a run, so a retry or ignore can never be overwritten by a run that started
// earlier with an older copy of the state (and the other way round). Read-only `status` needs no lock.
let lockRelease = null;
const [cmd, arg, flag] = process.argv.slice(2);
const wantJson = process.argv.includes('--json');

if (cmd === 'status' || !cmd) {
  const files = listFiles().map(describe); saveHashCache();
  let tasks = null; try { const t = readTasks(path.join(inbox, 'tasks.csv'), fs); tasks = t.reduce((a, r) => { const k = statusKind(r['状态']); a[k] = (a[k] || 0) + 1; return a; }, {}); } catch (e) { tasks = { error: String(e.message).slice(0, 120) }; }
  if (wantJson) { console.log(JSON.stringify({ inbox, files, tasks, aiJsonMode: seen.aiCaps.noJsonMode ? 'off (provider has none)' : 'on' }, null, 2)); process.exit(0); }
  console.log(`收件夹：${inbox}`);
  if (!files.length) console.log('  （空）');
  const label = { new: '新文件', partial: '读到一半', done: '已处理', ignored: '已忽略', failed: '失败暂停', 'gave-up': '已放弃', 'waiting-extraction': '等待提取', unsupported: '不支持' };
  for (const f of files) console.log(`  [${label[f.state] || f.state}] ${f.name} — ${f.detail}${f.truncated ? '（太长，只读了前 10 段）' : ''}`);
  console.log(`任务表：${tasks && tasks.error ? tasks.error : Object.entries(tasks || {}).map(([k, v]) => `${{ active: '进行中', pending: '待确认', done: '完成', ignored: '忽略', unknown: '状态不明' }[k] || k} ${v}`).join('，') || '（空）'}`);
  if (seen.aiCaps.noJsonMode) console.log('AI：这个服务商没有 JSON 模式，已自动关闭 response_format');
} else if (['retry', 'ignore', 'unignore', 'remove'].includes(cmd)) {
  // only a plain file name of a file that is really in the inbox (never a path, never our own tasks.csv)
  if (!arg || arg !== path.basename(arg) || !listFiles().includes(arg)) { console.error(`用法：${cmd} <收件夹里的文件名>（当前没有这个文件：${arg || ''}）`); process.exit(2); }
  const lk = await acquireLock(stateDir, 'inbox-tool');
  if (!lk.ok) { console.error('现在正在运行简报（或在部署）：请一两分钟后再试。这样可以保证你的操作不会被正在运行的那一次覆盖。'); process.exit(3); }
  lockRelease = lk.release; // the lock also ends with this process
  // the state is read again now that we hold the lock: a run that has just finished may have changed it
  const fresh = load(); for (const k of Object.keys(seen)) delete seen[k]; Object.assign(seen, fresh);
  for (const k of ['done', 'failed', 'failedAt', 'partial', 'offset', 'chunkEnd', 'truncated', 'gaveUp', 'aiCaps']) seen[k] = seen[k] || {};
  if (cmd !== 'remove' && isLink(arg)) { console.error(`${arg} 是符号链接，不会被读取`); process.exit(2); }
  if (cmd === 'remove') {
    // Moved, not deleted: the Finder's Trash keeps it until you empty it. What was already read from it stays in the
    // task table; reading state is kept, so putting the same file back does not add its tasks twice.
    const trash = env.BRIEF_TRASH_DIR || path.join(os.homedir(), '.Trash');
    fs.mkdirSync(trash, { recursive: true });
    const ext = path.extname(arg); let dest = path.join(trash, arg); let n = 1;
    while (fs.existsSync(dest)) dest = path.join(trash, `${path.basename(arg, ext)} ${new Date().toISOString().slice(0, 10)}${n++ > 1 ? ` (${n - 1})` : ''}${ext}`);
    try { fs.renameSync(path.join(inbox, arg), dest); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(path.join(inbox, arg), dest); fs.unlinkSync(path.join(inbox, arg)); // another volume: copy, then remove
    }
    console.log(`已把 ${arg} 移到废纸篓（${path.basename(dest)}）`);
    process.exit(0);
  }
  const hash = hashOf(arg);
  fs.mkdirSync(stateDir, { recursive: true });
  if (cmd === 'unignore' && !(seen.done[hash] && seen.done[hash].ignored)) { console.error(`${arg} 没有被忽略`); process.exit(2); }
  if (fs.existsSync(seenFile)) fs.copyFileSync(seenFile, `${seenFile}.bak-${Date.now()}`); // never lose the old state
  // keep only the newest five of those backups
  for (const old of fs.readdirSync(stateDir).filter((f) => f.startsWith('processed.json.bak-')).sort().reverse().slice(5)) fs.rmSync(path.join(stateDir, old), { force: true });
  // undoing 'ignore' puts the file back in line for real: earlier failures that would keep it skipped are forgotten too
  if (cmd === 'unignore') { delete seen.done[hash]; delete seen.failed[hash]; delete seen.failedAt[hash]; delete seen.gaveUp[hash]; const errFile = path.join(stateDir, 'extracted', `${hash}.err`); if (fs.existsSync(errFile)) fs.rmSync(errFile); }
  else if (cmd === 'ignore') { seen.done[hash] = { file: arg, at: new Date().toISOString().slice(0, 10), ignored: true }; delete seen.partial[hash]; delete seen.offset[hash]; delete seen.chunkEnd[hash]; }
  else {
    delete seen.failed[hash]; delete seen.failedAt[hash]; delete seen.gaveUp[hash]; delete seen.done[hash]; delete seen.truncated[hash];
    if (flag === '--full') { delete seen.partial[hash]; delete seen.offset[hash]; delete seen.chunkEnd[hash]; }
    const errFile = path.join(stateDir, 'extracted', `${hash}.err`); if (fs.existsSync(errFile)) fs.rmSync(errFile);
  }
  fs.writeFileSync(`${seenFile}.tmp`, JSON.stringify(seen, null, 1)); fs.renameSync(`${seenFile}.tmp`, seenFile);
  console.log(cmd === 'unignore' ? `已取消忽略 ${arg}，下一次运行会读它` : cmd === 'ignore' ? `已忽略 ${arg}` : `已重置 ${arg} 的失败记录${flag === '--full' ? '（并将从头读起）' : '（保留已读进度）'}，下一次运行会重新处理它`);
  await lockRelease(); // free the lock right away (it would also go when this process ends)
} else { console.error('用法：status [--json] | retry <file> [--full] | ignore <file> | unignore <file> | remove <file>'); process.exit(2); }
