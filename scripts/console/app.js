// Page script of the local console (served as /app.js so the page can forbid inline scripts in its CSP).
'use strict';
// Icons: Lucide (https://lucide.dev), ISC License, Copyright (c) Lucide Icons and Contributors. Embedded so the page works offline.
const LUCIDE = {"activity": "<path d=\"M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2\" />", "arrow-up-right": "<path d=\"M7 7h10v10\" /><path d=\"M7 17 17 7\" />", "bell-ring": "<path d=\"M10.268 21a2 2 0 0 0 3.464 0\" /><path d=\"M22 8c0-2.3-.8-4.3-2-6\" /><path d=\"M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326\" /><path d=\"M4 2C2.8 3.7 2 5.7 2 8\" />", "book-open": "<path d=\"M12 5v16\" /><path d=\"M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z\" />", "calendar-clock": "<path d=\"M16 14v2.2l1.6 1\" /><path d=\"M16 2v3\" /><path d=\"M21 7.338V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h2.338\" /><path d=\"M3 9h5.859\" /><path d=\"M8 2v3\" /><circle cx=\"16\" cy=\"16\" r=\"6\" />", "calendar-days": "<path d=\"M8 2v3\" /><path d=\"M16 2v3\" /><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"2\" /><path d=\"M3 9h18\" /><path d=\"M8 13h.01\" /><path d=\"M12 13h.01\" /><path d=\"M16 13h.01\" /><path d=\"M8 17h.01\" /><path d=\"M12 17h.01\" /><path d=\"M16 17h.01\" />", "check": "<path d=\"M20 6 9 17l-5-5\" />", "chevron-right": "<path d=\"m9 18 6-6-6-6\" />", "circle-check": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"m16 9-5.5 5.5L8 12\" />", "circle-help": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3\" /><path d=\"M12 17h.01\" />", "circle-x": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"m15 9-6 6\" /><path d=\"m9 9 6 6\" />", "clock-3": "<circle cx=\"12\" cy=\"12\" r=\"10\" /><path d=\"M12 6v6h4\" />", "command": "<path d=\"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3\" />", "download": "<path d=\"M12 15V3\" /><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" /><path d=\"m7 10 5 5 5-5\" />", "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\" /><circle cx=\"12\" cy=\"12\" r=\"3\" />", "file-text": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /><path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /><path d=\"M10 9H8\" /><path d=\"M16 13H8\" /><path d=\"M16 17H8\" />", "file-up": "<path d=\"M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z\" /><path d=\"M14 2v5a1 1 0 0 0 1 1h5\" /><path d=\"M12 12v6\" /><path d=\"m15 15-3-3-3 3\" />", "flame": "<path d=\"M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4\" />", "inbox": "<polyline points=\"22 12 16 12 14 15 10 15 8 12 2 12\" /><path d=\"M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z\" />", "layout-dashboard": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\" /><rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\" /><rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\" /><rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\" />", "list-checks": "<path d=\"M13 5h8\" /><path d=\"M13 12h8\" /><path d=\"M13 19h8\" /><path d=\"m3 17 2 2 4-4\" /><path d=\"m3 7 2 2 4-4\" />", "map-pin": "<path d=\"M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0\" /><circle cx=\"12\" cy=\"10\" r=\"3\" />", "moon": "<path d=\"M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401\" />", "plus": "<path d=\"M5 12h14\" /><path d=\"M12 5v14\" />", "power": "<path d=\"M12 2v10\" /><path d=\"M18.4 6.6a9 9 0 1 1-12.77.04\" />", "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" /><path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\" /><path d=\"M8 16H3v5\" />", "rotate-cw": "<path d=\"M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8\" /><path d=\"M21 3v5h-5\" />", "scroll-text": "<path d=\"M15 12h-5\" /><path d=\"M15 8h-5\" /><path d=\"M19 17V5a2 2 0 0 0-2-2H4\" /><path d=\"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3\" />", "search": "<path d=\"m21 21-4.34-4.34\" /><circle cx=\"11\" cy=\"11\" r=\"8\" />", "send": "<path d=\"M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z\" /><path d=\"m21.854 2.147-10.94 10.939\" />", "settings-2": "<path d=\"M14 17H5\" /><path d=\"M19 7h-9\" /><circle cx=\"17\" cy=\"17\" r=\"3\" /><circle cx=\"7\" cy=\"7\" r=\"3\" />", "sparkles": "<path d=\"M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z\" /><path d=\"M20 2v4\" /><path d=\"M22 4h-4\" /><circle cx=\"4\" cy=\"20\" r=\"2\" />", "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\" /><path d=\"M12 2v2\" /><path d=\"M12 20v2\" /><path d=\"m4.93 4.93 1.41 1.41\" /><path d=\"m17.66 17.66 1.41 1.41\" /><path d=\"M2 12h2\" /><path d=\"M20 12h2\" /><path d=\"m6.34 17.66-1.41 1.41\" /><path d=\"m19.07 4.93-1.41 1.41\" />", "sunrise": "<path d=\"M12 2v8\" /><path d=\"m4.93 10.93 1.41 1.41\" /><path d=\"M2 18h2\" /><path d=\"M20 18h2\" /><path d=\"m19.07 10.93-1.41 1.41\" /><path d=\"M22 22H2\" /><path d=\"m8 6 4-4 4 4\" /><path d=\"M16 18a4 4 0 0 0-8 0\" />", "timer": "<line x1=\"10\" x2=\"14\" y1=\"2\" y2=\"2\" /><line x1=\"12\" x2=\"15\" y1=\"14\" y2=\"11\" /><circle cx=\"12\" cy=\"14\" r=\"8\" />", "trash-2": "<path d=\"M10 11v6\" /><path d=\"M14 11v6\" /><path d=\"M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6\" /><path d=\"M3 6h18\" /><path d=\"M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2\" />", "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\" /><path d=\"M12 9v4\" /><path d=\"M12 17h.01\" />", "undo-2": "<path d=\"M9 14 4 9l5-5\" /><path d=\"M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11\" />", "upload": "<path d=\"M12 3v12\" /><path d=\"m17 8-5-5-5 5\" /><path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\" />", "wrench": "<path d=\"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z\" />", "x": "<path d=\"M18 6 6 18\" /><path d=\"m6 6 12 12\" />"};
// ---------------------------------------------------------------- helpers (DOM always built with textContent) --------
const $ = (s, r = document) => r.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
function icon(name, cls = '') { const s = document.createElementNS(SVGNS, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', `i ${cls}`); s.setAttribute('aria-hidden', 'true'); s.innerHTML = LUCIDE[name] || ''; return s; }
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
function s(tag, attrs, ...kids) { const el = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) if (v != null) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v); } for (const c of kids.flat(Infinity)) if (c != null && c !== false && c !== '') el.append(c.nodeType ? c : document.createTextNode(String(c))); return el; }
async function api(p, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'X-Brief-Console': '1', ...(opts.headers || {}) } };
  if (opts.body !== undefined) { if (opts.raw) init.body = opts.body; else { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; } }
  const r = await fetch(p, init);
  let data = {}; try { data = await r.json(); } catch { /* empty */ }
  if (!r.ok) { const msg = (data.error === 'bad request' || data.error === 'not found') ? '控制台不认识这个操作：可能控制台是在更新之前启动的，请关闭后重新运行 console.sh' : (data.error || `HTTP ${r.status}`); const e = new Error(msg); e.status = r.status; e.data = data; throw e; }
  return data;
}
function toast(msg, kind = 'ok') { const t = h('div', { class: `toast ${kind}` }, icon(kind === 'bad' ? 'circle-x' : 'circle-check'), h('div', {}, msg)); $('#toasts').append(t); setTimeout(() => { t.style.transition = 'opacity .25s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 260); }, kind === 'bad' ? 7000 : 3600); }
function confirmBox(title, text, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    const close = (v) => { bg.remove(); document.removeEventListener('keydown', key); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') close(false); if (e.key === 'Enter') close(true); };
    const ok = h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => close(true) }, okLabel);
    const bg = h('div', { class: 'overlay', onclick: (e) => { if (e.target === bg) close(false); } }, h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' }, h('h3', {}, title), h('p', {}, text), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => close(false) }, '取消'), ok)));
    $('#modalHost').append(bg); document.addEventListener('keydown', key); setTimeout(() => ok.focus(), 0);
  });
}
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
function ago(sec) { const x = Math.max(0, Math.round(Date.now() / 1000 - sec)); if (x < 90) return `${x} 秒前`; if (x < 5400) return `${Math.round(x / 60)} 分钟前`; if (x < 172800) return `${Math.round(x / 3600)} 小时前`; return `${Math.round(x / 86400)} 天前`; }
function hms(sec) { sec = Math.max(0, sec); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`; }
function relDay(d) { if (!d) return ''; const n = Math.round((new Date(`${d}T00:00:00`) - new Date(`${todayStr()}T00:00:00`)) / 86400000); if (n === 0) return '今天'; if (n === 1) return '明天'; if (n === 2) return '后天'; if (n < 0) return `逾期 ${-n} 天`; return `${n} 天后`; }
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const fmtBytes = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.round(b / 1e3)} KB`);
const toMin = (hm) => { const [a, b] = String(hm).split(':').map(Number); return a * 60 + (b || 0); };
const fromMin = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(Math.round(m % 60))}`;

// ---------------------------------------------------------------- theme ------------------------------------------------
function isDark() { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; }
function paintThemeBtn() { $('#themeBtn').replaceChildren(icon(isDark() ? 'sun' : 'moon')); }
(() => { let saved = null; try { saved = localStorage.getItem('brief-theme'); } catch { /* private mode */ } if (saved) document.documentElement.dataset.theme = saved; })();
function toggleTheme() { const next = isDark() ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('brief-theme', next); } catch { /* ignore */ } paintThemeBtn(); }
$('#themeBtn').addEventListener('click', toggleTheme);
$('#markIco').append(icon('sunrise', 'lg'));
$('#refreshBtn').append(icon('refresh-cw'));
$('#cmdkBtn').append(icon('search'), '搜索或执行…', h('kbd', {}, '⌘K'));

// ---------------------------------------------------------------- navigation -------------------------------------------
const VIEWS = { setup: ['设置向导', 'sparkles', '开始'], overview: ['总览', 'layout-dashboard', '概览'], tasks: ['任务', 'list-checks', '内容'], inbox: ['收件箱', 'inbox', '内容'], settings: ['设置', 'settings-2', '系统'], logs: ['日志', 'scroll-text', '系统'], tools: ['工具', 'wrench', '系统'] };
let current = (location.hash || '#overview').slice(1); if (!VIEWS[current]) current = 'overview';
let OV = null; let dirtyGuard = null;
function renderNav() {
  const groups = {};
  for (const [k, [label, ic, g]] of Object.entries(VIEWS)) (groups[g] ||= []).push(h('button', { class: k === current ? 'on' : '', type: 'button', onclick: () => go(k) }, icon(ic), label, k === 'tasks' && OV?._pending ? h('span', { class: 'count' }, OV._pending) : null, k === 'inbox' && OV?._newFiles ? h('span', { class: 'count' }, OV._newFiles) : null));
  $('#nav').replaceChildren(...Object.entries(groups).map(([g, items]) => h('div', { class: 'navgroup' }, h('span', {}, g), items)));
}
async function go(k) {
  if (k === current) return render();
  if (dirtyGuard && dirtyGuard() && !(await confirmBox('有没保存的修改', '离开这一页会丢掉还没保存的修改。', '离开', true))) return;
  dirtyGuard = null; current = k; history.replaceState(null, '', `#${k}`); renderNav(); render();
}
window.addEventListener('hashchange', () => { const k = location.hash.slice(1); if (VIEWS[k] && k !== current) go(k); });
window.addEventListener('beforeunload', (e) => { if (dirtyGuard && dirtyGuard()) { e.preventDefault(); e.returnValue = ''; } });
const skeleton = () => h('div', { class: 'grid' }, h('div', { class: 'skel', style: 'height:150px' }), h('div', { class: 'grid g-kpi' }, [1, 2, 3, 4].map(() => h('div', { class: 'skel', style: 'height:92px' }))), h('div', { class: 'skel', style: 'height:260px' }));
async function render() {
  $('#title').textContent = VIEWS[current][0]; $('#subtitle').textContent = '';
  const view = $('#view'); view.replaceChildren(skeleton());
  view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
  try { await ({ setup: viewSetup, overview: viewOverview, tasks: viewTasks, inbox: viewInbox, settings: viewSettings, logs: viewLogs, tools: viewTools })[current](view); }
  catch (e) { view.replaceChildren(h('div', { class: 'card empty' }, h('div', { class: 'ico' }, icon('triangle-alert', 'lg')), '读取失败：', e.message)); }
}
$('#refreshBtn').addEventListener('click', () => { refreshOverview(); render(); });

// ---------------------------------------------------------------- health / shared data --------------------------------
async function refreshOverview() {
  try {
    OV = await api('/api/overview');
    const warn = OV.checks.filter((c) => c.level === 'warn').length;
    const hb = $('#health'); hb.className = `badge ${warn ? 't-warn' : 't-ok'}`; hb.replaceChildren(h('span', { class: 'dot' }), warn ? `${warn} 项需要注意` : '一切正常');
    $('#homeLabel').textContent = `运行目录 ${OV.home}`;
    $('#footStatus').replaceChildren(h('span', { class: `badge ${OV.schedule.loaded ? 't-ok' : 't-warn'}` }, h('span', { class: 'dot' }), OV.schedule.loaded ? (OV.schedule.slots[0] ? `每天 ${OV.schedule.slots[0]} 发送` : '定时已加载') : '定时未加载'));
    try { const t = await api('/api/tasks'); OV._pending = (t.rows || []).filter((r) => r._kind === 'pending').length; } catch { OV._pending = 0; }
    try { const i = await api('/api/inbox'); OV._newFiles = (i.files || []).filter((f) => ['new', 'failed', 'gave-up'].includes(f.state)).length; } catch { OV._newFiles = 0; }
    renderNav();
  } catch { const hb = $('#health'); hb.className = 'badge t-bad'; hb.replaceChildren(h('span', { class: 'dot' }), '控制台连不上'); }
  return OV;
}
setInterval(() => { if (document.hidden) return; refreshOverview().then(() => { if (current === 'overview') viewOverview($('#view'), true); }); }, 30000);

// ---------------------------------------------------------------- view: overview ---------------------------------------
const STATE_TEXT = { sent: '已送达', unknown: '结果不明', failed: '失败', missed: '没发出', none: '安装前', today: '等待中' };
function healthRing(okN, total) {
  const pct = total ? okN / total : 1; const r = 30; const c = 2 * Math.PI * r;
  const color = pct === 1 ? 'var(--ok)' : pct >= 0.75 ? 'var(--warn)' : 'var(--bad)';
  return s('svg', { viewBox: '0 0 74 74', class: 'ring' }, s('circle', { cx: 37, cy: 37, r, fill: 'none', stroke: 'var(--bg-2)', 'stroke-width': 7 }),
    s('circle', { cx: 37, cy: 37, r, fill: 'none', stroke: color, 'stroke-width': 7, 'stroke-linecap': 'round', 'stroke-dasharray': `${c * pct} ${c}`, transform: 'rotate(-90 37 37)' }),
    s('text', { x: 37, y: 42, 'text-anchor': 'middle', style: 'font: 650 16px var(--font); fill: var(--fg)' }, `${okN}/${total}`));
}
function deliveryChart(history, slot, width) {
  // How far each day's brief was from the planned time: a stem from the plan line to the moment it arrived.
  // Days without a known time get a symbol in the status row underneath, so nothing is drawn at a misleading height.
  const W = Math.max(320, Math.round(width || 760)), H = 236, L = 52, R = 16, T = 16, PB = 62;
  const plotBottom = H - PB; const statusY = H - 40; const labelY = H - 12;
  const target = toMin(slot || '08:00');
  const times = history.filter((d) => d.sentAt).map((d) => toMin(d.sentAt.slice(0, 5)));
  const lo = Math.min(target - 20, ...times.map((t) => t - 10)); const hi = Math.max(target + 40, ...times.map((t) => t + 10));
  const y = (m) => T + (plotBottom - T) * (1 - (m - lo) / (hi - lo));
  const step = (W - L - R) / history.length;
  const tickStep = hi - lo > 120 ? 60 : hi - lo > 60 ? 30 : 15;
  const ticks = []; for (let m = Math.ceil(lo / tickStep) * tickStep; m <= hi; m += tickStep) if (Math.abs(m - target) > tickStep / 3) ticks.push(m);
  const svgEl = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', width: W, height: H, role: 'img', 'aria-label': '最近 14 天每天的送达时间' },
    ticks.map((m) => [s('line', { x1: L, x2: W - R, y1: y(m), y2: y(m), class: 'grid-l' }), s('text', { x: L - 10, y: y(m) + 4, 'text-anchor': 'end' }, fromMin(m))]),
    s('line', { x1: L, x2: W - R, y1: y(target), y2: y(target), class: 'target' }),
    s('text', { x: L - 10, y: y(target) + 4, 'text-anchor': 'end', style: 'fill: var(--accent-ink); font-weight: 700' }, slot || '08:00'),
    s('line', { x1: L, x2: W - R, y1: plotBottom + 6, y2: plotBottom + 6, stroke: 'var(--line)' }));
  const tip = h('div', { class: 'tip hidden' }); document.body.append(tip);
  history.forEach((d, i) => {
    const cx = L + step * i + step / 2; const dd = new Date(`${d.date}T00:00:00`); const isToday = d.date === todayStr();
    const g = s('g', { class: 'col' });
    g.append(s('rect', { class: 'hit', x: cx - step / 2 + 2, y: T - 6, width: step - 4, height: H - T, fill: 'transparent', rx: 8 }));
    if (d.sentAt) {
      const m = toMin(d.sentAt.slice(0, 5)); const late = m > target + 10; const col = late ? '#f59e0b' : '#22c55e';
      g.append(s('line', { x1: cx, x2: cx, y1: y(target), y2: y(m), stroke: col, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: '.55' }),
        s('circle', { cx, cy: y(m), r: 6, fill: col, stroke: 'var(--card)', 'stroke-width': 2 }));
      if (late) g.append(s('text', { x: cx, y: y(m) - 11, 'text-anchor': 'middle', style: 'fill: var(--warn); font-weight: 600' }, d.sentAt.slice(0, 5)));
      g.append(s('path', { d: `M${cx - 4} ${statusY} l3 3 l6 -6`, stroke: 'var(--ok)', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    } else if (d.state === 'sent') {
      g.append(s('circle', { cx, cy: statusY, r: 7, fill: 'var(--ok-soft)', stroke: 'var(--ok)', 'stroke-width': 1.5 }), s('path', { d: `M${cx - 3.5} ${statusY} l2.5 2.5 l5 -5`, stroke: 'var(--ok)', 'stroke-width': 2, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    } else if (d.state === 'failed' || d.state === 'missed') {
      g.append(s('path', { d: `M${cx - 4} ${statusY - 4} l8 8 M${cx + 4} ${statusY - 4} l-8 8`, stroke: 'var(--bad)', 'stroke-width': 2.2, 'stroke-linecap': 'round' }));
    } else if (d.state === 'unknown') {
      g.append(s('circle', { cx, cy: statusY, r: 7, fill: 'var(--warn-soft)', stroke: 'var(--warn)', 'stroke-width': 1.5 }), s('text', { x: cx, y: statusY + 4, 'text-anchor': 'middle', style: 'fill: var(--warn); font-weight: 700' }, '?'));
    } else if (isToday) {
      g.append(s('circle', { cx, cy: statusY, r: 5, fill: 'none', stroke: 'var(--faint)', 'stroke-width': 1.5, 'stroke-dasharray': '2 2' }));
    } else g.append(s('circle', { cx, cy: statusY, r: 2, fill: 'var(--line-2)' }));
    g.append(s('text', { x: cx, y: labelY, 'text-anchor': 'middle', style: isToday ? 'fill: var(--fg); font-weight: 700' : '' }, isToday ? '今天' : `${dd.getDate()}`));
    const text = [`${d.date}（周${WEEK[dd.getDay()]}）· ${STATE_TEXT[d.state]}`, d.sentAt ? `送达 ${d.sentAt} · ${d.engine === 'direct' ? '直连模式' : 'n8n'}${toMin(d.sentAt.slice(0, 5)) > target + 10 ? ` · 比计划晚 ${toMin(d.sentAt.slice(0, 5)) - target} 分钟` : ''}` : d.state === 'sent' ? '已送达（这一天的日志里没有正式发送的时间）' : '', d.tests ? `测试 / 补发 ${d.tests} 次` : '', ...d.fails.slice(0, 2)].filter(Boolean).join('\n');
    g.addEventListener('mousemove', (e) => { tip.textContent = text; tip.classList.remove('hidden'); tip.style.left = `${Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8)}px`; tip.style.top = `${e.clientY + 14}px`; });
    g.addEventListener('mouseleave', () => tip.classList.add('hidden'));
    svgEl.append(g);
  });
  return svgEl;
}
async function viewOverview(view, quiet = false) {
  const o = quiet && OV ? OV : await refreshOverview();
  if (!o) throw new Error('读不到状态');
  document.querySelectorAll('.tip').forEach((t) => t.remove());
  $('#subtitle').textContent = `${new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })} · 时区 ${o.tz || '系统'} · 引擎 ${o.engine === 'direct' ? '直连' : 'n8n'}`;
  const t = o.today; const lr = o.lastRun; const slot = o.schedule.slots[0];
  // hero
  let tone = 't-accent', ic = 'clock-3', big = '今天的简报还没发送', meta = o.nextRun ? '' : '没有安装定时任务';
  if (t.state === 'sent') { tone = 't-ok'; ic = 'circle-check'; big = '今天的简报已送达'; meta = `${t.sentAt || ''} 由 ${t.engine === 'direct' ? '直连模式' : 'n8n'} 发送${slot && t.sentAt && toMin(t.sentAt.slice(0, 5)) <= toMin(slot) + 10 ? ' · 准点' : slot && t.sentAt ? ' · 晚于计划（电脑当时可能在睡眠或没接电源）' : ''}`; }
  else if (t.state === 'unknown') { tone = 't-warn'; ic = 'circle-help'; big = '今天的发送结果不明'; meta = '请求已发出但没有得到明确回答。为避免重复不会自动重发；没收到的话可以补发。'; }
  else if (t.state === 'failed') { tone = 't-bad'; ic = 'circle-x'; big = '今天的发送失败了'; meta = o.nextRun && new Date(o.nextRun).toDateString() === new Date().toDateString() ? '后面的重试时间点还会再试，原因见日志。' : '今天的重试时间点都已经过了，可以在下面补发；原因见日志。'; }
  const clockVal = h('b', { class: 'num' }); const nextLabel = o.nextRun ? new Date(o.nextRun).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const tick = () => { if (o.nextRun) clockVal.textContent = hms(Math.round((new Date(o.nextRun) - Date.now()) / 1000)); };
  tick(); const timer = setInterval(() => { if (!document.body.contains(clockVal)) clearInterval(timer); else tick(); }, 1000);
  const hero = h('div', { class: 'card hero' },
    h('div', { class: 'eyebrow' }, h('span', { class: `badge ${tone}` }, icon(ic, 'sm'), STATE_TEXT[t.state]), o.running ? h('span', { class: 'badge t-info', title: o.running.holder || '' }, h('span', { class: 'spin', style: 'width:10px;height:10px' }), '有操作正在进行') : ''),
    h('div', { class: 'big' }, big), h('div', { class: 'meta' }, meta),
    o.nextRun ? h('div', { class: 'clock' }, clockVal, h('span', {}, `距离下一次定时（${nextLabel}）`)) : '',
    h('div', { class: 'actions' },
      h('button', { class: 'btn sun', onclick: () => runJob('preview') }, icon('eye'), '预览今天的简报'),
      h('button', { class: 'btn', onclick: () => runJob('test') }, icon('send'), '发测试简报'),
      t.state !== 'sent' ? h('button', { class: 'btn ghost', onclick: () => runJob('force') }, icon('rotate-cw'), '现在补发') : ''));
  // health
  const okN = o.checks.filter((c) => c.level !== 'warn').length;
  const toneOf = { ok: ['t-ok', 'check'], warn: ['t-warn', 'triangle-alert'], info: ['t-info', 'circle-help'] };
  const sorted = [...o.checks].sort((a, b) => ({ warn: 0, info: 1, ok: 2 }[a.level] - { warn: 0, info: 1, ok: 2 }[b.level]));
  let expanded = false; const list = h('ul', { class: 'checks' });
  const drawChecks = () => { const show = expanded ? sorted : sorted.slice(0, 5); list.replaceChildren(...show.map((c) => h('li', {}, h('span', { class: `ci ${toneOf[c.level][0]}` }, icon(toneOf[c.level][1])), h('span', {}, c.text), c.fix ? h('span', { class: 'fix' }, c.fix) : ''))); more.classList.toggle('hidden', sorted.length <= 5); more.textContent = expanded ? '收起' : `显示全部 ${sorted.length} 项`; };
  const more = h('button', { class: 'btn ghost sm', onclick: () => { expanded = !expanded; drawChecks(); } });
  const health = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h2', {}, '健康检查'), h('span', { class: 'spacer' }), more),
    h('div', { class: 'bd' }, h('div', { class: 'ringwrap', style: 'margin-bottom:10px' }, healthRing(okN, o.checks.length), h('div', {}, h('div', { style: 'font-weight:600' }, okN === o.checks.length ? '全部正常' : `${o.checks.length - okN} 项需要注意`), h('div', { class: 'muted small' }, '运行目录、版本、定时、唤醒、设置'))), list));
  drawChecks();
  // KPIs
  const hist = o.history; const counted = hist.filter((d) => !['none', 'today'].includes(d.state));
  const sentDays = counted.filter((d) => d.state === 'sent').length;
  let streak = 0; for (let i = hist.length - 1; i >= 0; i--) { const d = hist[i]; if (d.state === 'today') continue; if (d.state === 'sent') streak++; else break; }
  const sentTimes = hist.filter((d) => d.sentAt).map((d) => toMin(d.sentAt.slice(0, 5)));
  const avg = sentTimes.length ? fromMin(sentTimes.reduce((a, b) => a + b, 0) / sentTimes.length) : '—';
  const onTime = slot ? sentTimes.filter((m) => m <= toMin(slot) + 10).length : null;
  const kpi = (ic, label, val, unit, note, link) => h('div', { class: 'card kpi', style: link ? 'cursor:pointer' : '', onclick: link ? () => go(link) : null }, h('div', { class: 'lbl' }, icon(ic, 'sm'), label), h('div', { class: 'val' }, val, unit ? h('small', {}, unit) : ''), h('div', { class: 'note' }, note));
  const kpis = h('div', { class: 'grid g-kpi' },
    kpi('flame', '连续送达', streak, '天', streak ? '不含今天' : '还没有连续记录'),
    kpi('calendar-days', '最近 14 天', counted.length ? `${sentDays}/${counted.length}` : '—', '', '送达天数 / 应发天数'),
    kpi('timer', '平均送达', avg, '', sentTimes.length ? (onTime === null ? `${sentTimes.length} 天有送达时间` : `${onTime}/${sentTimes.length} 天在计划后 10 分钟内`) : '还没有正式送达记录'),
    kpi('list-checks', '待确认任务', o._pending ?? 0, '项', o._pending ? '点这里去确认' : '没有需要确认的', 'tasks'));
  // chart + last run
  const chart = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h2', {}, '每天的送达时间'), h('p', {}, '· 最近 14 天'), h('span', { class: 'spacer' }),
    h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:#22c55e;border-radius:50%' }), '准点'), h('span', {}, h('i', { style: 'background:#f59e0b;border-radius:50%' }), '晚到'), h('span', {}, h('i', { style: 'border-top:2px dashed var(--accent);height:0;width:14px;border-radius:0' }), '计划时间'), h('span', {}, '✓ 已送达'), h('span', {}, '✕ 失败 / 漏发'), h('span', {}, '? 结果不明'))),
    h('div', { class: 'bd' }));
  const drawChart = () => { const bd = chart.querySelector('.bd'); if (!bd || !document.body.contains(bd)) return; document.querySelectorAll('.tip').forEach((x) => x.remove()); bd.replaceChildren(deliveryChart(hist, slot, bd.clientWidth - 36)); };
  let runCard;
  if (lr) {
    const segs = [['等网络', lr.waitNetSec, '#60a5fa'], ['等 n8n', lr.waitReadySec, '#fbbf24'], ['执行', lr.execSec, '#22c55e']];
    const total = Math.max(1, segs.reduce((a, x) => a + (x[1] || 0), 0));
    const res = { ok: ['t-ok', '成功'], skipped: ['t-gray', '跳过'], unknown: ['t-warn', '结果不明'], fail: ['t-bad', '失败'] }[lr.result] || ['t-gray', lr.result];
    runCard = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h2', {}, '最近一次运行'), h('span', { class: 'spacer' }), h('span', { class: `badge ${res[0]}` }, h('span', { class: 'dot' }), res[1])),
      h('div', { class: 'bd' }, h('dl', { class: 'kv' }, h('dt', {}, '时间'), h('dd', {}, `${new Date(lr.started * 1000).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${ago(lr.started)}`),
        h('dt', {}, '方式'), h('dd', {}, { normal: '定时', test: '测试', force: '手动补发' }[lr.mode] || lr.mode, ' · ', lr.engine === 'none' ? '没有发送' : lr.engine === 'direct' ? '直连模式' : 'n8n', ` · ${lr.seconds} 秒`),
        lr.result !== 'ok' && lr.reason ? [h('dt', {}, '原因'), h('dd', {}, lr.reason)] : ''),
        lr.result === 'ok' ? [h('div', { class: 'stack' }, segs.map(([, v, c]) => h('i', { style: `width:${(100 * (v || 0)) / total}%;background:${c}` }))), h('div', { class: 'legend' }, segs.map(([l, v, c]) => h('span', {}, h('i', { style: `background:${c}` }), `${l} `, h('b', { class: 'num' }, `${v || 0}s`))))] : '',
        h('div', { class: 'minis' }, [['日程', lr.events], ['进行中', lr.tasks], ['新任务', lr.newTasks], ['AI 调用', lr.aiCalls]].map(([l, v]) => h('div', { class: 'mini' }, h('b', {}, v ?? 0), h('span', {}, l))))));
  } else runCard = h('div', { class: 'card empty' }, h('div', { class: 'ico' }, icon('activity', 'lg')), '还没有运行记录');
  const sys = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h2', {}, '系统')), h('div', { class: 'bd' }, h('dl', { class: 'kv' },
    h('dt', {}, '定时'), h('dd', {}, o.schedule.slots.length ? o.schedule.slots.join(' · ') : '未安装', o.schedule.loaded ? '' : '（未加载）'),
    h('dt', {}, '唤醒'), h('dd', {}, o.schedule.wake[0] || '未设置'),
    h('dt', {}, '工作流'), h('dd', { class: 'num' }, o.build || '未部署'), h('dt', {}, 'n8n'), h('dd', {}, o.n8nVersion || '—'),
    h('dt', {}, '数据库'), h('dd', {}, o.dbSize ? fmtBytes(o.dbSize) : '—'), h('dt', {}, '运行目录'), h('dd', {}, o.home))));
  const agendaHost = h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h2', {}, '接下来'), h('p', {}, '· 日程来自上一次运行缓存的日历，截止来自任务表'), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost sm', onclick: () => go('tasks') }, '全部任务', icon('chevron-right', 'sm'))), h('div', { class: 'bd' }, h('div', { class: 'skel', style: 'height:120px' })));
  const outdated = o.consoleOutdated ? h('div', { class: 'card', style: 'padding:12px 16px;display:flex;align-items:center;gap:10px;border-color:var(--warn-line);background:var(--warn-soft)' }, icon('triangle-alert'), h('div', {}, h('b', {}, '控制台的程序已经更新。'), ' 这个页面还是旧版本，新功能要关掉控制台（「工具」→「关闭控制台」或在终端按 Ctrl-C）后重新运行 console.sh 才能用。')) : '';
  view.replaceChildren(h('div', { class: 'grid' }, outdated, h('div', { class: 'grid g-hero' }, hero, health), kpis, agendaHost, chart, h('div', { class: 'grid g-2' }, runCard, sys)));
  fillAgenda(agendaHost); drawChart();
  window.onresize = () => { clearTimeout(window.__chartRT); window.__chartRT = setTimeout(drawChart, 120); };
}

async function fillAgenda(card) {
  const body = card.querySelector('.bd');
  let a; try { a = await api('/api/agenda'); } catch (e) { body.replaceChildren(h('div', { class: 'muted small' }, '读不到：', e.message)); return; }
  const now = new Date(); const nowHM = `${pad(now.getHours())}:${pad(now.getMinutes())}`; const today = todayStr();
  const label = (d) => { const dd = new Date(`${d}T00:00:00`); const rd = relDay(d); return [rd === '今天' || rd === '明天' || rd === '后天' ? rd : `${dd.getMonth() + 1}月${dd.getDate()}日`, h('span', {}, `周${WEEK[dd.getDay()]}`)]; };
  // events, grouped by day
  let evCol;
  if (a.calendar === 'none') evCol = h('div', { class: 'muted small' }, '没有配置日历。去「设置 → 日历」填写。');
  else if (a.calendar === 'error') evCol = h('div', { class: 'muted small' }, `读日历出错：${a.error || ''}`);
  else if (!a.events.length) evCol = h('div', { class: 'muted small' }, a.calendar === 'stale' ? '没有可用的日历缓存（超过 48 小时或从未成功下载）。点「预览今天的简报」会重新下载。' : '接下来几天没有日程。');
  else {
    const days = {}; for (const e of a.events) (days[e.allDay ? (e.day < today ? today : e.day) : e.day] ||= []).push(e);
    evCol = h('div', {}, Object.keys(days).sort().slice(0, 3).map((d) => [h('div', { class: 'day-h' }, label(d)), days[d].map((e) => {
      const isToday = d === today; const now2 = isToday && !e.allDay && e.start <= nowHM && nowHM < (e.end || '24:00'); const past = isToday && !e.allDay && (e.end || e.start) <= nowHM;
      return h('div', { class: `ev${now2 ? ' now' : ''}${past ? ' past' : ''}` }, h('div', { class: 'tm' }, e.allDay ? '全天' : `${e.start}–${e.end}`), h('div', {}, h('div', { class: 'tt' }, e.title, now2 ? h('span', { class: 'badge t-ok', style: 'margin-left:8px' }, '进行中') : ''), e.location ? h('div', { class: 'loc' }, icon('map-pin', 'sm'), e.location) : ''));
    })]), a.cachedAgeH ? h('div', { class: 'faint small' }, `日历缓存于 ${a.cachedAgeH} 小时前`) : '');
  }
  const dlCol = a.deadlines.length ? h('div', {}, a.deadlines.map((d) => h('div', { class: 'dl' }, h('span', { class: `badge ${d.overdue ? 't-bad' : relDay(d.due) === '今天' || relDay(d.due) === '明天' ? 't-warn' : 't-gray'}` }, relDay(d.due)), h('div', { class: 'tt' }, h('div', {}, d.title), h('small', {}, d.course || '—', ' · ', d.due)))))
    : h('div', { class: 'muted small' }, '接下来 7 天没有要交的任务。');
  body.replaceChildren(h('div', { class: 'agenda' }, h('div', {}, h('h3', {}, icon('calendar-days', 'sm'), '日程'), evCol), h('div', {}, h('h3', {}, icon('calendar-clock', 'sm'), '截止（7 天内）'), dlCol)));
}

// ---------------------------------------------------------------- view: setup wizard -----------------------------------
// First-run setup in five steps. Every value is checked BEFORE it is saved (the webhook is only read, nothing is posted);
// secrets are typed into password fields, sent once to this computer's console and never shown again.
const AI_PRESETS = [
  { id: 'deepseek', label: 'DeepSeek', base: 'https://api.deepseek.com', help: '在 platform.deepseek.com 注册 →「API keys」→ 创建并复制。读一份课程大纲通常只要几分钱。' },
  { id: 'openai', label: 'OpenAI', base: 'https://api.openai.com/v1', help: '在 platform.openai.com →「API keys」创建。' },
  { id: 'local', label: '本机模型', base: 'http://127.0.0.1:11434/v1', help: '例如 Ollama（默认端口 11434），不需要密钥，文件不会离开这台电脑。' },
  { id: 'custom', label: '其他', base: '', help: '任何 OpenAI 兼容的接口，地址通常以 /v1 结尾。' },
];
async function waitJob(kind, param) {
  const j = await api('/api/jobs', { method: 'POST', body: { kind, param } }); showJob(j);
  for (;;) { await new Promise((r) => setTimeout(r, 1000)); const c = await api('/api/jobs/current'); showJob(c); if (c.id !== j.id || c.state !== 'running') return c; }
}
async function viewSetup(view) {
  const o = await refreshOverview(); let cfg = await api('/api/settings');
  const F = (k) => cfg.fields.find((f) => f.key === k) || {};
  const STEPS = [['Discord', 'send'], ['日历', 'calendar-days'], ['AI', 'sparkles'], ['时间', 'clock-3'], ['完成', 'circle-check']];
  // Always opens at the first step: each step shows what is already set (and continues with one click), and the step tabs
  // above jump straight to any step once Discord is set. (Jumping to the first unfinished step always landed on 时间,
  // which is never marked as done when the page opens.)
  let step = 0;
  let timeDone = false;
  const done = () => ({ 0: F('DISCORD_WEBHOOK_URL').set, 1: F('ICS_URLS').set, 2: F('AI_BASE_URL').set && F('AI_MODEL').set, 3: timeDone, 4: false });
  $('#subtitle').textContent = '五步完成设置。密钥和链接只保存在这台电脑上，页面上不会再显示它们。';
  const host = h('div', { class: 'wiz' });
  const msg = (ok, text) => h('div', { class: `wmsg ${ok ? 'ok' : 'bad'}` }, icon(ok ? 'circle-check' : 'circle-x', 'sm'), h('div', {}, text));
  const howto = (...items) => h('ol', { class: 'howto' }, items.map((x) => h('li', {}, x)));
  const busy = (btn, on, label) => { btn.disabled = on; if (on) { btn._kids = [...btn.childNodes]; btn.replaceChildren(h('span', { class: 'spin', style: 'width:14px;height:14px' }), label || '检查中…'); } else if (btn._kids) btn.replaceChildren(...btn._kids); };
  const save = async (changes) => { cfg = await api('/api/settings', { method: 'POST', body: { changes } }); refreshOverview(); };
  const next = () => { step = Math.min(4, step + 1); draw(); window.scrollTo(0, 0); };
  const foot = (...kids) => h('div', { class: 'wfoot' }, step > 0 && step < 4 ? h('button', { class: 'btn ghost', onclick: () => { step -= 1; draw(); } }, '上一步') : h('span'), h('span', { class: 'spacer' }), kids);

  function stepDiscord() {
    const f = F('DISCORD_WEBHOOK_URL'); const out = h('div');
    const inp = h('input', { type: 'password', autocomplete: 'off', placeholder: f.set ? '已设置。想换一个就粘贴新的地址' : '粘贴 Webhook URL（https://discord.com/api/webhooks/…）' });
    const go1 = h('button', { class: 'btn sun', onclick: async () => {
      if (!inp.value.trim()) { if (f.set) return next(); inp.focus(); return out.replaceChildren(msg(false, '先把 Webhook URL 粘贴到上面')); }
      busy(go1, true); try {
        const r = await api('/api/setup/webhook', { method: 'POST', body: { url: inp.value.trim() } });
        if (!r.ok) return out.replaceChildren(msg(false, r.message));
        await save({ DISCORD_WEBHOOK_URL: inp.value.trim() }); inp.value = '';
        out.replaceChildren(msg(true, `${r.message}，已保存。`)); setTimeout(next, 900);
      } catch (e) { out.replaceChildren(msg(false, e.message)); } finally { busy(go1, false); }
    } }, f.set ? '检查并继续' : '检查并保存');
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go1.click(); });
    setTimeout(() => inp.focus(), 0);
    return [h('h2', {}, '简报发到哪里？'), h('p', { class: 'lead' }, '简报会发到你自己的一个 Discord 频道。需要一个这个频道的 Webhook 地址（必填）。'),
      howto('打开 Discord，进到你想收简报的服务器。没有的话点左侧的「＋」创建一个，只给自己用。',
        '把鼠标移到频道名上，点齿轮「编辑频道」→「整合」→「Webhook」→「新 Webhook」。',
        '点「复制 Webhook URL」，粘贴到下面。'),
      f.set ? h('div', { class: 'wnow' }, h('span', { class: 'badge t-ok' }, icon('check', 'sm'), `已设置 · ${f.hint}`)) : '',
      h('div', { class: 'wrow' }, inp), out, h('p', { class: 'faint small' }, '检查只会读取这个 Webhook 的名字，不会往频道里发消息。这个地址相当于发消息的钥匙，不要发给别人。'),
      foot(go1)];
  }
  function stepCalendar() {
    const f = F('ICS_URLS'); const out = h('div');
    const ta = h('textarea', { rows: 3, spellcheck: false, autocomplete: 'off', placeholder: f.set ? '已设置。想重新设置就在这里粘贴（会替换原来的全部链接），每行一个' : '每行一个链接（https:// 或 webcal://）' });
    const go1 = h('button', { class: 'btn sun', onclick: async () => {
      if (!ta.value.trim()) { if (f.set) return next(); ta.focus(); return out.replaceChildren(msg(false, '先粘贴日历链接，或者点「跳过」')); }
      busy(go1, true, '正在读取日历…'); try {
        const r = await api('/api/setup/calendars', { method: 'POST', body: { urls: ta.value } });
        if (r.message) return out.replaceChildren(msg(false, r.message));
        out.replaceChildren(...r.lines.map((l) => msg(l.startsWith('✅'), l.replace(/^✅ /, ''))));
        if (!r.ok) return out.append(h('p', { class: 'small muted' }, '有链接读不了：检查是不是复制完整了，或者先跳过，以后在「设置」里补。'));
        await save({ ICS_URLS: ta.value }); ta.value = ''; out.append(msg(true, '已保存。')); setTimeout(next, 1200);
      } catch (e) { out.replaceChildren(msg(false, e.message)); } finally { busy(go1, false); }
    } }, '测试并保存');
    return [h('h2', {}, '接上你的日历'), h('p', { class: 'lead' }, '可选。接上之后，简报会列出今天、明天和之后几天的日程。可以接多个日历。'),
      howto('在电脑上打开 Google 日历网页版，点右上角齿轮 →「设置」。',
        '在左侧「我的日历的设置」里点你的日历，往下找到「集成日历」。',
        '复制「iCal 格式的私人地址」，粘贴到下面。其他日历（iCloud、Outlook）的 .ics 订阅链接也可以。'),
      f.set ? h('div', { class: 'wnow' }, h('span', { class: 'badge t-ok' }, icon('check', 'sm'), `已设置 · ${f.hint}`)) : '',
      ta, out, h('p', { class: 'faint small' }, '这个链接谁拿到都能看你的日历，所以它只保存在这台电脑上，保存后页面上不会再显示。'),
      foot(h('button', { class: 'btn ghost', onclick: next }, f.set ? '保持不变' : '跳过'), go1)];
  }
  function stepAi() {
    const fb = F('AI_BASE_URL'); const fk = F('AI_API_KEY'); const fm = F('AI_MODEL'); const out = h('div');
    let preset = AI_PRESETS.find((p) => p.base && p.base === fb.value) || (fb.value ? AI_PRESETS[3] : AI_PRESETS[0]);
    const base = h('input', { type: 'text', spellcheck: false, value: fb.value || preset.base, placeholder: 'https://…/v1' });
    const key = h('input', { type: 'password', autocomplete: 'off', placeholder: fk.set ? '已保存密钥。留空就继续用它' : '粘贴 API 密钥（本机模型可以留空）' });
    const help = h('p', { class: 'small muted' }, preset.help);
    const modelSel = h('select', { class: 'hidden', 'aria-label': '模型' }); const modelLabel = h('label', { class: 'hidden' }, '模型'); let models = [];
    const seg = h('div', { class: 'seg' });
    const drawSeg = () => seg.replaceChildren(...AI_PRESETS.map((p) => h('button', { class: p === preset ? 'on' : '', onclick: () => { preset = p; if (p.base) base.value = p.base; help.textContent = p.help; modelSel.classList.add('hidden'); modelLabel.classList.add('hidden'); models = []; out.replaceChildren(); drawSeg(); go1.textContent = '获取模型列表'; } }, p.label)));
    const go1 = h('button', { class: 'btn sun', onclick: async () => {
      if (models.length) {
        busy(go1, true, '保存中…'); try { await save({ AI_BASE_URL: base.value.trim(), AI_MODEL: modelSel.value, ...(key.value.trim() ? { AI_API_KEY: key.value.trim() } : {}) }); key.value = ''; out.replaceChildren(msg(true, `已保存：${modelSel.value}`)); setTimeout(next, 800); }
        catch (e) { out.replaceChildren(msg(false, e.data?.fieldErrors ? Object.values(e.data.fieldErrors).join('；') : e.message)); } finally { busy(go1, false); go1.textContent = '保存并继续'; }
        return;
      }
      busy(go1, true, '正在连接…'); try {
        const r = await api('/api/setup/models', { method: 'POST', body: { base: base.value, key: key.value, useSaved: !key.value.trim() && fk.set } });
        if (!r.ok) { out.replaceChildren(msg(false, r.message)); return; }
        models = r.models; modelSel.replaceChildren(...models.map((m) => h('option', { value: m, selected: m === (fm.value && models.includes(fm.value) ? fm.value : r.suggested) }, m))); modelSel.classList.remove('hidden'); modelLabel.classList.remove('hidden');
        out.replaceChildren(msg(true, `连上了，找到 ${models.length} 个模型。已选好推荐的那个，确认后点「保存并继续」。`));
      } catch (e) { out.replaceChildren(msg(false, e.message)); } finally { busy(go1, false); go1.textContent = models.length ? '保存并继续' : '获取模型列表'; }
    } }, '获取模型列表');
    for (const el of [base, key]) el.addEventListener('input', () => { models = []; modelSel.classList.add('hidden'); modelLabel.classList.add('hidden'); go1.textContent = '获取模型列表'; });
    drawSeg();
    return [h('h2', {}, '让 AI 帮你读文件'), h('p', { class: 'lead' }, '可选。把课程大纲、作业说明放进收件箱后，AI 会找出里面的任务和截止日期。任何 OpenAI 兼容的服务都可以。'),
      fb.set && fm.set ? h('div', { class: 'wnow' }, h('span', { class: 'badge t-ok' }, icon('check', 'sm'), `已设置 · ${fm.value}`)) : '',
      seg, help, h('div', { class: 'wgrid' }, h('label', {}, '接口地址'), base, h('label', {}, 'API 密钥'), key, modelLabel, modelSel), out,
      h('p', { class: 'faint small' }, '注意：收件箱里文件的文字会发给这个服务去读。敏感文件不要放进收件箱，或者选「本机模型」。'),
      foot(h('button', { class: 'btn ghost', onclick: next }, fb.set ? '保持不变' : '跳过'), go1)];
  }
  function stepTime() {
    const slot = OV?.schedule?.slots?.[0] || '08:00'; const out = h('div');
    const time = h('input', { type: 'time', value: slot, style: 'width:140px' });
    const base = h('input', { type: 'date', value: F('BRIEF_BASE_DATE').value || '', style: 'width:180px' });
    const ign = h('input', { type: 'text', spellcheck: false, value: F('BRIEF_IGNORE').value || '', placeholder: '例如 午饭|课间|Recess' });
    const go1 = h('button', { class: 'btn sun', onclick: async () => {
      busy(go1, true, '保存中…'); try {
        const changes = {}; if (base.value !== (F('BRIEF_BASE_DATE').value || '')) changes.BRIEF_BASE_DATE = base.value || null; if (ign.value.trim() !== (F('BRIEF_IGNORE').value || '')) changes.BRIEF_IGNORE = ign.value.trim() || null;
        if (Object.keys(changes).length) await save(changes);
        if (time.value && time.value !== slot) { const j = await waitJob('schedule', time.value); if (j.state !== 'done') { out.replaceChildren(msg(false, '修改发送时间没有成功，详情见右下角。')); return; } $('#drawerHost').replaceChildren(); }
        await refreshOverview(); timeDone = true; next();
      } catch (e) { out.replaceChildren(msg(false, e.data?.fieldErrors ? Object.values(e.data.fieldErrors).join('；') : e.message)); } finally { busy(go1, false); }
    } }, '保存并继续');
    return [h('h2', {}, '每天几点收到？'), h('p', { class: 'lead' }, `简报每天在这个时间发出；没发成功时 20、40、90 分钟后会再试。时区跟随这台 Mac（${o?.setup?.sysTz || '系统'}）。`),
      h('div', { class: 'wgrid' }, h('label', {}, '发送时间'), time,
        h('label', {}, '第 1 周的周一', h('small', {}, '可选。文件里写「第 4 周周五」时用它算日期')), base,
        h('label', {}, '不想看到的日程', h('small', {}, '可选。标题里含这些词的日程不显示，用 | 隔开')), ign), out,
      foot(go1)];
  }
  function stepDone() {
    const slot = OV?.schedule?.slots?.[0] || '08:00';
    const wake = `sudo pmset repeat wakeorpoweron MTWRFSU ${fromMin((toMin(slot) - 5 + 1440) % 1440)}:00`;
    const row = (ok, label, text) => h('li', {}, h('span', { class: `ci ${ok ? 't-ok' : 't-gray'}` }, icon(ok ? 'check' : 'circle-help')), h('b', {}, label), h('span', { class: 'muted' }, text));
    const d = done(); const testOut = h('div');
    // the result is shown right here: a beginner should not have to read a log to know whether it worked
    const testBtn = h('button', { class: 'btn sun lg', disabled: !d[0], onclick: async () => {
      if (!(await confirmBox('发送测试简报', '会真的往你的 Discord 频道发一条带 🧪 的简报。', '发送'))) return;
      busy(testBtn, true, '正在生成并发送…'); testOut.replaceChildren();
      try {
        const j = await waitJob('test'); $('#drawerHost').replaceChildren();
        testOut.replaceChildren(j.state === 'done' ? msg(true, '已发送！去 Discord 频道看看。没看到的话，确认第 1 步复制的是这个频道的 Webhook。')
          : msg(false, ['没有发出去。', h('a', { href: '#logs', onclick: (e) => { e.preventDefault(); go('logs'); } }, '看日志里的原因'), '，或者回到第 1 步检查 Webhook。']));
      } catch (e) { testOut.replaceChildren(msg(false, e.message)); } finally { busy(testBtn, false); }
    } }, icon('send'), '发一条测试简报');
    return [h('h2', {}, '设置好了 🎉'), h('p', { class: 'lead' }, `从明天起，每天 ${slot} 你的 Discord 会收到一份简报。现在可以先发一条测试的看看效果。`),
      h('ul', { class: 'checks wsum' }, row(d[0], 'Discord', d[0] ? F('DISCORD_WEBHOOK_URL').hint : '还没设置：简报发不出去'), row(d[1], '日历', d[1] ? F('ICS_URLS').hint : '跳过了，以后可以在「设置」里补'), row(d[2], 'AI', d[2] ? F('AI_MODEL').value : '跳过了，收件箱里的文件不会被读取'), row(true, '发送时间', `每天 ${slot}`)),
      h('div', { class: 'wcta' }, testBtn, h('span', { class: 'small muted' }, '大约 30 秒。带 🧪 标记，不影响明天正式的那条。')), testOut,
      h('div', { class: 'card wwake' }, h('div', { class: 'hd' }, icon('moon'), h('h2', {}, '建议：让 Mac 早上自动醒来')), h('div', { class: 'bd' },
        h('p', { class: 'small muted' }, `Mac 睡着时简报要等它醒来才发。复制下面这条命令，打开「终端」粘贴，按回车后输入开机密码（输入时不显示）。晚上记得插着电源。`),
        h('div', { class: 'row', style: 'display:flex;gap:8px;align-items:center' }, h('div', { class: 'code' }, wake), h('button', { class: 'btn sm', onclick: async () => { try { await navigator.clipboard.writeText(wake); toast('已复制，粘贴到「终端」运行'); } catch { toast('复制失败，请手动选中复制', 'bad'); } } }, icon('command', 'sm'), '复制')))),
      h('div', { class: 'wnext' }, h('button', { class: 'btn', onclick: () => go('inbox') }, icon('inbox'), '把课程大纲放进收件箱'), h('button', { class: 'btn primary', onclick: () => go('overview') }, '进入总览', icon('chevron-right', 'sm'))),
      h('p', { class: 'faint small' }, '这个页面以后也可以打开：在「终端」运行 ~/.n8n-morning-brief/scripts/console.sh。关掉这个页面和终端不影响每天的定时发送。')];
  }
  function draw() {
    const d = done();
    const steps = h('div', { class: 'steps' }, STEPS.map(([label, ic], i) => h('button', { class: `step${i === step ? ' on' : ''}${d[i] && i !== step ? ' done' : ''}`, 'aria-label': `第 ${i + 1} 步：${label}`, onclick: () => { if (i <= step || d[0]) { step = i; draw(); } } }, h('span', { class: 'num' }, d[i] && i !== step ? icon('check', 'sm') : String(i + 1)), h('span', { class: 'lbl' }, icon(ic, 'sm'), label))));
    const body = [stepDiscord, stepCalendar, stepAi, stepTime, stepDone][step]();
    host.replaceChildren(h('div', { class: 'card wcard' }, h('div', { class: 'whead' }, h('div', { class: 'mark' }, icon('sunrise', 'lg')), h('div', {}, h('b', {}, '欢迎使用每日简报'), h('small', {}, `第 ${step + 1} 步，共 5 步`))), steps, h('div', { class: 'wbody' }, body)));
  }
  view.replaceChildren(host); draw();
}

// ---------------------------------------------------------------- view: tasks ------------------------------------------
async function viewTasks(view) {
  let data = await api('/api/tasks');
  if (data.error) { view.replaceChildren(h('div', { class: 'card empty' }, h('div', { class: 'ico' }, icon('triangle-alert', 'lg')), h('b', {}, '任务表读不了'), data.error, h('div', { class: 'small' }, '可能是表头被改坏了，可以用 tasks.csv.bak 恢复。'))); return; }
  let filter = 'active'; let q = ''; const changes = new Map(); const adds = []; let adding = false;
  const KIND = { '待确认': 'pending', '进行中': 'active', '完成': 'done', '忽略': 'ignored' };
  const valueOf = (r, k) => (changes.get(r._i)?.[k] ?? r[k] ?? '');
  const kindOf = (r) => (changes.get(r._i)?.['状态'] !== undefined ? (KIND[changes.get(r._i)['状态']] || 'unknown') : r._kind);
  const counts = () => { const c = { active: 0, pending: 0, done: 0, ignored: 0, all: data.rows.length }; for (const r of data.rows) c[kindOf(r)] = (c[kindOf(r)] || 0) + 1; return c; };
  const isDirty = () => changes.size > 0 || adds.length > 0; dirtyGuard = isDirty;
  const setField = (r, k, v) => { const c = changes.get(r._i) || {}; if (v === (r[k] ?? '')) delete c[k]; else c[k] = v; if (Object.keys(c).length) changes.set(r._i, c); else changes.delete(r._i); drawBar(); };
  const barHost = h('div'); const segHost = h('div'); const tableHost = h('div');
  function drawBar() {
    const n = changes.size + adds.length;
    barHost.replaceChildren(n ? h('div', { class: 'savebar' }, h('span', {}, `${n} 处修改还没保存`), h('button', { class: 'btn ghost', onclick: () => { changes.clear(); adds.length = 0; drawAll(); } }, '撤销'), h('button', { class: 'btn sun', onclick: save }, icon('check'), '保存到任务表')) : '');
  }
  async function save() {
    try {
      data = await api('/api/tasks', { method: 'POST', body: { version: data.version, updates: [...changes].map(([index, fields]) => ({ index, fields })), additions: adds } });
      changes.clear(); adds.length = 0; toast('已保存。原来的文件留在 tasks.csv.bak'); drawAll(); refreshOverview();
    } catch (e) {
      toast(e.message, 'bad');
      if (e.data?.conflict && await confirmBox('任务表被别处改过', '早上的运行或 Excel 在你打开之后改过它。要放弃你的修改并重新读取吗？', '重新读取', true)) { changes.clear(); adds.length = 0; data = await api('/api/tasks'); drawAll(); }
    }
  }
  function statusSel(r) {
    const v = valueOf(r, '状态');
    const sel = h('select', { class: `stsel st-${KIND[v] || 'pending'}`, 'aria-label': '状态', onchange: (e) => { setField(r, '状态', e.target.value); drawAll(); } }, [...new Set([...data.statuses, v])].map((x) => h('option', { value: x, selected: x === v }, x)));
    return h('span', { class: 'selwrap' }, sel, icon('chevron-right'));
  }
  const inp = (r, k, type = 'text', ph = '') => h('input', { type, placeholder: ph, 'aria-label': k, value: type === 'date' ? (/^\d{4}-\d{2}-\d{2}$/.test(valueOf(r, k)) ? valueOf(r, k) : '') : valueOf(r, k), oninput: (e) => { setField(r, k, e.target.value); e.target.closest('tr').classList.toggle('dirty', changes.has(r._i)); } });
  // a learning milestone (类型 = 里程碑) is a target, not a deadline: once its day has passed it is "已过", in grey, never a red 逾期
  const isGoal = (r) => r['类型'] === '里程碑';
  function dueBadge(d, goal = false) { const rd = relDay(d); if (!rd) return ''; if (goal && rd.startsWith('逾期')) return h('span', { class: 'due badge t-gray' }, rd.replace('逾期', '已过')); const cls = rd.startsWith('逾期') ? 't-bad' : (rd === '今天' || rd === '明天') ? 't-warn' : 't-gray'; return h('span', { class: `due badge ${cls}` }, rd); }
  function drawAll() {
    const c = counts();
    segHost.replaceChildren(h('div', { class: 'seg', role: 'tablist' }, [['active', '进行中'], ['pending', '待确认'], ['done', '完成'], ['ignored', '忽略'], ['all', '全部']].map(([k, l]) => h('button', { class: filter === k ? 'on' : '', role: 'tab', onclick: () => { filter = k; drawAll(); } }, l, h('small', {}, c[k] || 0)))));
    const rows = data.rows.filter((r) => (filter === 'all' || kindOf(r) === filter) && (!q || `${r['任务']} ${r['分类']} ${r['备注']} ${r['类型'] || ''}`.toLowerCase().includes(q))).sort((a, b) => (valueOf(a, '截止日') || '9999').localeCompare(valueOf(b, '截止日') || '9999'));
    const f = { t: h('input', { type: 'text', placeholder: '任务名称（必填）' }), c: h('input', { type: 'text', placeholder: '分类' }), d: h('input', { type: 'date' }), n: h('input', { type: 'text', placeholder: '备注' }) };
    const addNow = () => { if (!f.t.value.trim()) { f.t.focus(); return toast('先写任务名称', 'bad'); } adds.push({ '状态': '进行中', '任务': f.t.value.trim(), '分类': f.c.value.trim(), '截止日': f.d.value, '备注': f.n.value.trim() }); adding = false; drawAll(); };
    f.t.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNow(); if (e.key === 'Escape') { adding = false; drawAll(); } });
    const newRow = adding ? h('tr', { class: 'newrow' }, h('td', {}, h('span', { class: 'badge t-ok' }, '进行中')), h('td', {}, f.t), h('td', {}, f.c), h('td', {}, f.d), h('td', {}, f.n), h('td', {}, h('div', { style: 'display:flex;gap:6px' }, h('button', { class: 'btn sm primary', onclick: addNow }, '加入'), h('button', { class: 'btn sm ghost', onclick: () => { adding = false; drawAll(); } }, '取消')))) : null;
    const addRows = adds.map((a, i) => h('tr', { class: 'dirty' }, h('td', {}, h('span', { class: 'badge t-ok' }, a['状态'])), h('td', {}, a['任务']), h('td', {}, a['分类']), h('td', {}, a['截止日'], dueBadge(a['截止日'])), h('td', {}, a['备注']), h('td', {}, h('button', { class: 'btn sm ghost', onclick: () => { adds.splice(i, 1); drawAll(); } }, icon('x', 'sm'), '移除'))));
    const body = rows.map((r) => {
      const due = valueOf(r, '截止日'); const d = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : r._due;
      return h('tr', { class: changes.has(r._i) ? 'dirty' : '' }, h('td', {}, statusSel(r)), h('td', { style: 'min-width:220px' }, isGoal(r) ? h('div', { style: 'display:flex;align-items:center;gap:6px' }, h('span', { class: 'badge t-accent', title: '学习里程碑：这一天之前学完它。来自课程大纲，不是截止日' }, '里程碑'), inp(r, '任务')) : inp(r, '任务')), h('td', { style: 'min-width:120px' }, inp(r, '分类')),
        h('td', { style: 'min-width:220px;white-space:nowrap' }, h('div', { style: 'display:flex;align-items:center' }, h('div', { style: 'width:150px' }, inp(r, '截止日', 'date')), d ? dueBadge(d, isGoal(r)) : (r['截止日'] && !r._due ? h('span', { class: 'due badge t-bad' }, `认不出：${r['截止日']}`) : ''))),
        h('td', { style: 'min-width:180px' }, inp(r, '备注', 'text', '—')), h('td', { class: 'faint small', style: 'white-space:nowrap' }, r['来源'] || ''));
    });
    const empty = !rows.length && !adds.length && !adding;
    tableHost.replaceChildren(empty ? h('div', { class: 'card empty' }, h('div', { class: 'ico' }, icon('list-checks', 'lg')), h('b', {}, filter === 'pending' ? '没有待确认的任务' : '这里还没有任务'), h('div', { class: 'small' }, '点「新任务」手动加，或把课程大纲放进收件箱，让 AI 找出来。'))
      : h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['状态', '任务', '分类', '截止日', '备注', '来源'].map((x) => h('th', {}, x)))), h('tbody', {}, newRow, addRows, body))));
    bulk.classList.toggle('hidden', !(filter === 'pending' && c.pending));
    drawBar(); if (adding) setTimeout(() => f.t.focus(), 0);
  }
  const bulk = h('button', { class: 'btn sm', onclick: () => { for (const r of data.rows) if (kindOf(r) === 'pending') setField(r, '状态', '进行中'); drawAll(); } }, icon('check', 'sm'), '全部确认为进行中');
  const search = h('div', { class: 'search' }, icon('search'), h('input', { type: 'search', placeholder: '搜索任务、分类、备注', oninput: (e) => { q = e.target.value.trim().toLowerCase(); drawAll(); } }));
  $('#subtitle').textContent = '直接在表里改。只有「进行中」会进简报；保存时先备份，并确认没有别处同时在改。';
  view.replaceChildren(h('div', { class: 'toolbar' }, segHost, bulk, h('span', { class: 'spacer' }), search, h('a', { class: 'btn icon', href: '/api/tasks/download', title: '下载任务表（CSV）', 'aria-label': '下载任务表' }, icon('download')), h('button', { class: 'btn primary', onclick: () => { adding = true; filter = filter === 'active' || filter === 'all' ? filter : 'active'; drawAll(); } }, icon('plus'), '新任务')), tableHost, barHost);
  drawAll();
}

// ---------------------------------------------------------------- view: inbox ------------------------------------------
const FILE_STATE = { new: ['等待读取', 't-info'], partial: ['读到一半', 't-accent'], done: ['已读完', 't-ok'], ignored: ['已忽略', 't-gray'], failed: ['失败暂停', 't-warn'], 'gave-up': ['已放弃', 't-bad'], 'waiting-extraction': ['等待提取文字', 't-accent'], unsupported: ['格式不支持', 't-gray'] };
async function viewInbox(view) {
  let data = await api('/api/inbox');
  const list = h('div', { class: 'files' }); const summary = h('div', { class: 'toolbar', style: 'margin:16px 0 0' });
  const input = h('input', { type: 'file', multiple: true, accept: '.pdf,.docx,.txt,.md', class: 'hidden', onchange: (e) => upload([...e.target.files]) });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); } },
    h('div', { class: 'ico' }, icon('file-up', 'lg')), h('b', {}, '把文件拖到这里，或点一下选择'), h('div', { class: 'small' }, '课程大纲、作业说明、项目计划 · PDF、Word（docx）、txt、md · 下一次运行时 AI 会读它们，也可以点「现在读取」'));
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', (e) => upload([...e.dataTransfer.files]));
  async function upload(files) {
    for (const file of files) { try { const r = await api('/api/inbox/upload', { method: 'POST', raw: true, body: file, headers: { 'X-File-Name': encodeURIComponent(file.name) } }); toast(`已放进收件箱：${r.saved}`); } catch (e) { toast(`${file.name}：${e.message}`, 'bad'); } }
    data = await api('/api/inbox'); draw(); refreshOverview();
  }
  async function act(action, name, full) {
    if (action === 'remove' && !(await confirmBox('移到废纸篓', `「${name}」会被移到废纸篓（可以从废纸篓找回）。已经从它读出的任务会留在任务表里。`, '移到废纸篓', true))) return;
    try { data = await api('/api/inbox/action', { method: 'POST', body: { action, name, full } }); toast(data.message || '完成'); draw(); refreshOverview(); } catch (e) { toast(e.message, 'bad'); }
  }
  function draw() {
    if (data.error) { list.replaceChildren(h('div', { class: 'card empty' }, data.error)); return; }
    $('#subtitle').textContent = `收件夹 ${data.inbox}`;
    const files = data.files || [];
    list.replaceChildren(...(files.length ? files.map((f) => {
      const [label, tone] = FILE_STATE[f.state] || [f.state, 't-gray'];
      const ext = (f.name.split('.').pop() || '').toLowerCase();
      const acts = [];
      if (f.state === 'ignored') acts.push(h('button', { class: 'btn sm', onclick: () => act('unignore', f.name) }, icon('undo-2', 'sm'), '取消忽略'));
      if (['failed', 'gave-up', 'waiting-extraction', 'partial'].includes(f.state)) acts.push(h('button', { class: 'btn sm', onclick: () => act('retry', f.name) }, icon('rotate-cw', 'sm'), '重试'));
      if (f.state === 'done') acts.push(h('button', { class: 'btn sm', title: '从头再读一遍（完全相同的任务不会重复加入）', onclick: () => act('retry', f.name, true) }, icon('rotate-cw', 'sm'), '重新读'));
      if (['new', 'partial', 'failed', 'gave-up', 'waiting-extraction'].includes(f.state)) acts.push(h('button', { class: 'btn sm ghost', onclick: () => act('ignore', f.name) }, '忽略'));
      if (['pdf', 'docx', 'txt', 'md'].includes(ext)) acts.push(h('button', { class: 'btn sm ghost icon', title: '查看 AI 会读到的文字', 'aria-label': `查看 ${f.name} 的文字`, onclick: () => showText(f.name) }, icon('book-open', 'sm')));
      acts.push(h('button', { class: 'btn sm ghost danger icon', title: '移到废纸篓', 'aria-label': `把 ${f.name} 移到废纸篓`, onclick: () => act('remove', f.name) }, icon('trash-2', 'sm')));
      return h('div', { class: 'file' }, h('div', { class: `ft ft-${['pdf', 'docx', 'txt', 'md'].includes(ext) ? ext : 'other'}` }, ext.slice(0, 4) || '?'),
        h('div', { style: 'min-width:0' }, h('div', { class: 'name' }, f.name, h('span', { class: `badge ${tone}` }, h('span', { class: 'dot' }), label)), h('div', { class: 'detail' }, f.detail, f.truncated ? ' · 文件太长，只读了前一部分' : '')),
        h('div', { class: 'acts' }, acts));
    }) : [h('div', { class: 'card empty' }, h('div', { class: 'ico' }, icon('inbox', 'lg')), h('b', {}, '收件箱是空的'), h('div', { class: 'small' }, '放进来的文件会在下一次运行时被读取。'))]));
    const t = data.tasks || {};
    const waiting = files.filter((f) => ['new', 'partial', 'failed', 'waiting-extraction'].includes(f.state)).length;
    const readNow = h('button', { class: `btn sm${waiting ? ' sun' : ''}`, title: '现在就让 AI 读收件箱里的新文件，把找到的任务写进任务表（不发 Discord）', onclick: () => runJob('ingest') }, icon('sparkles', 'sm'), waiting ? `现在读取（${waiting} 个文件）` : '现在读取');
    summary.replaceChildren(readNow, t.error ? h('span', { class: 'badge t-bad' }, `任务表：${t.error}`) : h('span', { class: 'muted small' }, '任务表 · ', Object.entries({ active: '进行中', pending: '待确认', done: '完成', ignored: '忽略' }).map(([k, l]) => `${l} ${t[k] || 0}`).join(' · ')), h('span', { class: 'spacer' }), h('span', { class: 'faint small' }, `AI JSON 模式：${data.aiJsonMode === 'on' ? '开' : '关（服务商不支持）'}`));
  }
  view.replaceChildren(drop, input, summary, list); draw();
}

async function showText(name) {
  let t; try { t = await api(`/api/inbox/text?name=${encodeURIComponent(name)}`); } catch (e) { return toast(e.message, 'bad'); }
  const close = () => { bg.remove(); document.removeEventListener('keydown', key); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  const bg = h('div', { class: 'overlay', onclick: (e) => { if (e.target === bg) close(); } }, h('div', { class: 'textview', role: 'dialog', 'aria-label': name },
    h('header', {}, icon('book-open'), h('b', {}, name), t.ready ? h('span', { class: 'faint small num' }, `${t.length.toLocaleString()} 个字符`) : '', h('button', { class: 'btn ghost sm icon', 'aria-label': '关闭', onclick: close }, icon('x', 'sm'))),
    h('pre', {}, t.ready ? [t.text, t.more ? `\n\n……（还有 ${t.more.toLocaleString()} 个字符没有显示）` : ''] : t.note)));
  $('#modalHost').append(bg); document.addEventListener('keydown', key);
}

// ---------------------------------------------------------------- view: settings ---------------------------------------
const GROUP_ICON = { 推送: 'send', 日历: 'calendar-days', AI: 'sparkles', 文件与任务: 'file-text', 简报外观: 'eye', 高级: 'wrench' };
async function viewSettings(view) {
  let data = await api('/api/settings');
  const edits = {}; let errors = {};
  dirtyGuard = () => Object.keys(edits).length > 0;
  const barHost = h('div'); const host = h('div', { class: 'grid' }); const toc = h('div', { class: 'toc' });
  const drawBar = () => { const n = Object.keys(edits).length; barHost.replaceChildren(n ? h('div', { class: 'savebar' }, h('span', {}, `${n} 项设置还没保存`), h('button', { class: 'btn ghost', onclick: () => { for (const k of Object.keys(edits)) delete edits[k]; errors = {}; draw(); } }, '撤销'), h('button', { class: 'btn sun', onclick: save }, icon('check'), '保存设置')) : ''); };
  const set = (k, v, orig) => { if (v === orig) delete edits[k]; else edits[k] = v; drawBar(); };
  async function save() {
    try { data = await api('/api/settings', { method: 'POST', body: { changes: edits } }); for (const k of Object.keys(edits)) delete edits[k]; errors = {}; toast('已保存，下一次运行生效（原文件留有 .bak 备份）'); refreshOverview(); }
    catch (e) { errors = e.data?.fieldErrors || {}; toast(e.data?.fieldErrors ? '有设置不对，请看标红的地方' : e.message, 'bad'); }
    draw();
  }
  function fieldInput(f) {
    const orig = f.value || ''; const cur = f.key in edits ? edits[f.key] : orig;
    if (f.readonly) return h('div', { class: 'muted', style: 'padding-top:6px' }, f.secret ? (f.set ? '已设置（只在本机）' : '未设置') : (orig || '默认'));
    if (f.secret) {
      const wrap = h('div', { class: 'secret' });
      const editing = f.key in edits && edits[f.key] !== null;
      if (!editing) {
        wrap.append(f.set && edits[f.key] !== null ? h('span', { class: 'badge t-ok' }, icon('check', 'sm'), `已设置 · ${f.hint}`) : h('span', { class: `badge ${f.required ? 't-warn' : 't-gray'}` }, edits[f.key] === null ? '将被清除' : '未设置'),
          h('button', { class: 'btn sm', onclick: () => { edits[f.key] = ''; draw(); } }, f.set ? '更换' : '填写'),
          f.set && !f.required && edits[f.key] !== null ? h('button', { class: 'btn sm ghost danger', onclick: () => { edits[f.key] = null; draw(); } }, '清除') : '',
          edits[f.key] === null ? h('button', { class: 'btn sm ghost', onclick: () => { delete edits[f.key]; draw(); } }, '撤销') : '');
        return wrap;
      }
      const el = f.type === 'urls' ? h('textarea', { rows: 3, placeholder: '每行一个 https:// 链接', autocomplete: 'off', spellcheck: false, oninput: (e) => { edits[f.key] = e.target.value; drawBar(); } }) : h('input', { type: 'password', autocomplete: 'new-password', placeholder: f.set ? '输入新的值（旧值不会显示）' : '粘贴到这里', oninput: (e) => { edits[f.key] = e.target.value; drawBar(); } });
      el.value = edits[f.key];
      wrap.append(el, h('button', { class: 'btn sm ghost', onclick: () => { delete edits[f.key]; draw(); } }, '取消'));
      if (f.type === 'urls') wrap.append(h('div', { class: 'faint small', style: 'width:100%' }, '会替换全部日历链接。链接本身就是密码，保存后不会再显示。'));
      setTimeout(() => el.focus(), 0);
      return wrap;
    }
    if (f.type === 'bool') return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: /^(1|true|yes)$/i.test(cur), onchange: (e) => set(f.key, e.target.checked ? '1' : '', orig ? '1' : '') }), h('span'));
    if (f.type === 'select') return h('select', { onchange: (e) => set(f.key, e.target.value === '__default' ? '' : e.target.value, orig) }, h('option', { value: '__default', selected: !cur }, `默认（${f.labels[f.options.indexOf(f.placeholder)] || f.placeholder}）`), f.options.map((o, i) => h('option', { value: o, selected: cur === o }, f.labels[i])));
    return h('input', { type: f.type === 'date' ? 'date' : 'text', value: cur, placeholder: f.example ? `例如 ${f.example}` : f.placeholder ? `默认 ${f.placeholder}` : '', spellcheck: false, oninput: (e) => set(f.key, e.target.value, orig) });
  }
  function draw() {
    const groups = {}; for (const f of data.fields) (groups[f.group] ||= []).push(f);
    const extra = { AI: h('button', { class: 'btn sm', onclick: () => runJob('checkai') }, icon('activity', 'sm'), '测试连接'), 日历: h('button', { class: 'btn sm', onclick: () => runJob('checkcal') }, icon('activity', 'sm'), '测试链接'), 推送: h('button', { class: 'btn sm', onclick: () => runJob('test') }, icon('send', 'sm'), '发测试简报') };
    toc.replaceChildren(...Object.keys(groups).map((g) => h('a', { href: `#settings`, onclick: (e) => { e.preventDefault(); document.getElementById(`grp-${g}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, g)));
    host.replaceChildren(
      data.errors?.length ? h('div', { class: 'card', style: 'padding:12px 16px' }, h('span', { class: 'badge t-warn' }, icon('triangle-alert', 'sm'), `设置文件第 ${data.errors.join('、')} 行看不懂`), h('span', { class: 'muted small', style: 'margin-left:8px' }, '运行时会跳过这些行；在这里重新保存对应的设置可以修正。')) : '',
      ...Object.entries(groups).map(([g, fields]) => h('div', { class: 'card', id: `grp-${g}`, style: 'scroll-margin-top:84px' }, h('div', { class: 'hd' }, icon(GROUP_ICON[g] || 'settings-2'), h('h2', {}, g), h('span', { class: 'spacer' }), extra[g] || ''),
        h('div', { class: 'bd' }, fields.map((f) => h('div', { class: `field${f.key in edits ? ' changed' : ''}` },
          h('div', {}, h('label', {}, f.label), f.help ? h('div', { class: 'help' }, f.help) : '', h('div', { class: 'key' }, f.key)),
          h('div', {}, fieldInput(f), errors[f.key] ? h('div', { class: 'err' }, icon('circle-x', 'sm'), errors[f.key]) : '', f.note ? h('div', { class: 'note' }, icon('triangle-alert', 'sm'), f.note) : '')))))),
      data.extra?.length ? h('div', { class: 'card' }, h('div', { class: 'hd' }, h('h2', {}, '其他设置')), h('div', { class: 'bd muted' }, '控制台不认识、保持原样：', data.extra.join('、'))) : '');
    drawBar();
  }
  $('#subtitle').textContent = '密钥和链接只保存在本机，页面上看不到它们的值；保存后下一次运行生效。';
  view.replaceChildren(h('div', { class: 'settings' }, toc, host), barHost); draw();
}

// ---------------------------------------------------------------- view: logs -------------------------------------------
async function viewLogs(view) {
  let which = 'run'; let date = todayStr(); let level = 'all'; let timer = null; let last = '';
  const term = h('div', { class: 'term' }); const lines = h('div', { style: 'padding:8px 0' });
  term.append(h('div', { class: 'term-head' }, h('i', { style: 'background:#f87171' }), h('i', { style: 'background:#fbbf24' }), h('i', { style: 'background:#4ade80' }), h('span', { style: 'margin-left:8px;color:#71717a' }, 'run log')), lines);
  const dateSel = h('select', { style: 'width:auto', onchange: (e) => { date = e.target.value; load(); } });
  const segW = h('div', { class: 'seg' }, [['run', '运行'], ['n8n', 'n8n'], ['launchd', 'launchd']].map(([k, l]) => h('button', { class: k === which ? 'on' : '', onclick: (e) => { which = k; [...segW.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); dateSel.classList.toggle('hidden', k !== 'run'); load(); } }, l)));
  const segL = h('div', { class: 'seg' }, [['all', '全部'], ['fail', '只看失败'], ['ok', '只看成功']].map(([k, l]) => h('button', { class: k === level ? 'on' : '', onclick: (e) => { level = k; [...segL.children].forEach((b) => b.classList.toggle('on', b === e.currentTarget)); paint(); } }, l)));
  const auto = h('label', { class: 'small muted', style: 'display:flex;align-items:center;gap:8px' }, h('label', { class: 'switch' }, h('input', { type: 'checkbox', onchange: (e) => { clearInterval(timer); if (e.target.checked) timer = setInterval(() => { if (!document.body.contains(term)) clearInterval(timer); else load(); }, 3000); } }), h('span')), '自动刷新');
  const cls = (l) => (/FAIL|ERROR|CRITICAL/.test(l) ? 'fail' : /OK: brief sent|restored|took over/.test(l) ? 'ok' : /WARN|alert|unknown/.test(l) ? 'warn' : /skipping|SKIP|already sent/.test(l) ? 'skip' : '');
  function paint() {
    const all = last.replace(/\n+$/, '').split('\n'); const shown = all.map((l, i) => [l, i]).filter(([l]) => level === 'all' || cls(l) === level);
    lines.replaceChildren(...(last.trim() ? shown.map(([l, i]) => { const m = /^(\S+ \S+)( \[[^\]]+\])?(.*)$/.exec(l); return h('div', { class: 'ln' }, h('span', { class: 'no' }, i + 1), h('span', { class: `tx ${cls(l)}` }, m ? [h('span', { class: 'tm' }, m[1]), m[2] ? h('span', { class: 'tm' }, m[2]) : '', m[3]] : (l || ' '))); }) : [h('div', { class: 'ln' }, h('span', { class: 'no' }, ''), h('span', { class: 'tx skip' }, '（这一天没有日志）'))]));
    term.scrollTop = term.scrollHeight;
  }
  async function load() {
    const d = await api(`/api/logs?which=${which}&date=${date}`);
    if (dateSel.dataset.n !== String(d.days.length)) { dateSel.replaceChildren(...(d.days.length ? d.days : [date]).map((x) => h('option', { value: x, selected: x === date }, x))); dateSel.dataset.n = String(d.days.length); }
    last = d.text || ''; paint();
  }
  $('#subtitle').textContent = '日志里的链接和密钥会被替换成 <链接> / <密钥>。';
  view.replaceChildren(h('div', { class: 'toolbar' }, segW, dateSel, segL, h('span', { class: 'spacer' }), auto, h('button', { class: 'btn sm', onclick: load }, icon('refresh-cw', 'sm'), '刷新')), term);
  await load();
}

// ---------------------------------------------------------------- view: tools ------------------------------------------
async function viewTools(view) {
  const o = OV || await refreshOverview();
  const first = o?.schedule?.slots?.[0] || '08:00';
  const timeIn = h('input', { type: 'time', value: first, style: 'width:120px' });
  const wake = () => { const t = (toMin(timeIn.value) - 5 + 1440) % 1440; return `sudo pmset repeat wakeorpoweron MTWRFSU ${fromMin(t)}:00`; };
  const wakeCode = h('div', { class: 'code' }, wake()); timeIn.addEventListener('input', () => { wakeCode.textContent = wake(); });
  const tool = (ic, tone, title, text, ...controls) => h('div', { class: 'card tool' }, h('div', { class: `ico ${tone}` }, icon(ic)), h('h3', {}, title), h('p', {}, text), h('div', { class: 'row' }, controls));
  $('#subtitle').textContent = '常用操作。会真的发消息的操作都会先问你。';
  view.replaceChildren(h('div', { class: 'tools' },
    tool('eye', 't-accent', '预览简报', '按现在的日历和任务生成今天的简报，只显示，不发送、不调 AI、不改记录。', h('button', { class: 'btn sun', onclick: () => runJob('preview') }, '预览')),
    tool('send', 't-info', '发送测试简报', '真的发一条带 🧪 标记的简报到 Discord，不影响正式简报。大约 30 秒。', h('button', { class: 'btn', onclick: () => runJob('test') }, '发送')),
    tool('rotate-cw', 't-warn', '补发今天的简报', '只在今天确实没收到时用。补发不写「已发送」标记，如果之后的定时点还没跑，可能再收到一份。', h('button', { class: 'btn', onclick: () => runJob('force') }, '补发')),
    tool('activity', 't-ok', '完整自检', '运行 status.sh：安装、定时、唤醒、锁、收件夹、数据库，一次看全。', h('button', { class: 'btn', onclick: () => runJob('status') }, '运行')),
    tool('sparkles', 't-accent', '测试 AI 连接', '用你设置的接口和模型发一个极小的请求，确认密钥和模型名正确。', h('button', { class: 'btn', onclick: () => runJob('checkai') }, '测试')),
    tool('calendar-days', 't-info', '测试日历链接', '逐个下载你的日历，报告能不能读、有多少条目；不会显示链接本身。', h('button', { class: 'btn', onclick: () => runJob('checkcal') }, '测试')),
    tool('bell-ring', 't-info', '测试本机通知', 'Discord 发不出去时，报警会改成在 Mac 上弹通知。点这里确认通知能弹出来。', h('button', { class: 'btn', onclick: () => runJob('notify') }, '测试')),
    tool('clock-3', 't-accent', '每天发送的时间', `现在：${o?.schedule?.slots?.join('、') || '未安装'}（后面几个是失败时的重试）。`, timeIn, h('button', { class: 'btn', onclick: async () => { if (await confirmBox('修改发送时间', `改为每天 ${timeIn.value}（另有 20、40、90 分钟后的重试）？`, '修改')) runJob('schedule', timeIn.value); } }, '保存')),
    tool('moon', 't-gray', '定时唤醒', '让 Mac 在发送前 5 分钟醒来。需要管理员密码，请复制到「终端」执行；它会替换已有的重复唤醒规则。过夜要接电源。', wakeCode, h('button', { class: 'btn sm icon', title: '复制', onclick: async () => { try { await navigator.clipboard.writeText(wake()); toast('已复制，粘贴到「终端」执行'); } catch { toast('复制失败，请手动选中复制', 'bad'); } } }, icon('command', 'sm'))),
    tool('power', 't-bad', '关闭控制台', '停止这个本机网页服务。简报的定时发送不受影响。', h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('关闭控制台', '关闭后这个页面就不能用了，需要时再运行 scripts/console.sh。', '关闭', true)) { await api('/api/shutdown', { method: 'POST', body: {} }).catch(() => {}); document.body.replaceChildren(h('div', { class: 'empty', style: 'padding:80px' }, h('div', { class: 'ico' }, icon('power', 'lg')), '控制台已关闭，可以关掉这个页面了。')); } } }, '关闭'))));
}

// ---------------------------------------------------------------- jobs ---------------------------------------------------
let jobTimer = null;
async function runJob(kind, param) {
  if (kind === 'test' && !(await confirmBox('发送测试简报', '会真的往你的 Discord 频道发一条带 🧪 的简报，不影响正式简报。', '发送'))) return;
  if (kind === 'force' && !(await confirmBox('补发今天的简报', '只在今天确实没收到时使用。补发不写「已发送」标记：如果今天的定时点还没跑完，之后可能会再收到一份。', '补发', true))) return;
  try { const j = await api('/api/jobs', { method: 'POST', body: { kind, param } }); showJob(j); poll(); } catch (e) { toast(e.message, 'bad'); }
}
function poll() { clearInterval(jobTimer); jobTimer = setInterval(async () => { try { const j = await api('/api/jobs/current'); showJob(j); if (j.state !== 'running') { clearInterval(jobTimer); toast(`${j.label}：${j.state === 'done' ? '完成' : '失败'}`, j.state === 'done' ? 'ok' : 'bad'); refreshOverview().then(() => { if (current === 'overview') viewOverview($('#view'), true); else if (['ingest', 'test', 'force'].includes(j.kind) && (current === 'inbox' || (current === 'tasks' && !(dirtyGuard && dirtyGuard())))) render(); }); } } catch { clearInterval(jobTimer); } }, 1000); }
function renderBrief(text) {
  const lines = text.split('\n'); const box = h('div', { class: 'embed' });
  if (lines.length) { box.append(h('div', { style: 'font-weight:700;color:#f2f3f5;margin-bottom:6px' }, lines.shift())); while (lines.length && !lines[0].trim()) lines.shift(); }
  for (const l of lines) {
    const small = l.startsWith('-# '); const quote = l.startsWith('> '); const content = small ? l.slice(3) : quote ? l.slice(2) : l;
    const line = h('div', { class: small ? 'sub' : '', style: quote ? 'border-left:3px solid #4e5058;padding-left:8px' : '' });
    for (const part of content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) { if (!part) continue; if (/^`[^`]+`$/.test(part)) { line.append(h('code', { style: 'font:12.5px var(--mono);background:#1e1f22;border-radius:4px;padding:1px 4px;margin-right:4px' }, part.slice(1, -1))); continue; } if (/^\*\*[^*]+\*\*$/.test(part)) line.append(h('b', { style: 'color:#f2f3f5' }, part.slice(2, -2))); else line.append(part.replace(/\\([*_~`>|\\()[\]])/g, '$1')); }
    if (!content) line.append(' ');
    box.append(line);
  }
  return h('div', { class: 'discord' }, h('div', { class: 'who' }, h('div', { class: 'av' }, icon('sunrise')), h('div', {}, h('b', {}, '每日简报'), h('small', {}, '预览 · 不会发送'))), box);
}
// Called every second while a job runs. The drawer of a job is built once and then updated in place: rebuilding it each
// time replayed its entrance animation and restarted the spinner (the drawer flickered), and lost the scroll position.
function showJob(j) {
  if (!j || !j.id) return;
  const host = $('#drawerHost'); const running = j.state === 'running';
  const secs = Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000);
  if (host._closed === j.id) return; // closed by the reader: not opened again for the same job
  let drawer = host.querySelector('.drawer');
  if (!drawer || drawer._job !== j.id) {
    drawer = h('div', { class: 'drawer', role: 'status' }, h('header', {}, h('span', { class: 'jstate' }), h('b', {}, j.label), h('span', { class: 'faint small num jsecs' }), h('button', { class: 'btn ghost sm icon', 'aria-label': '关闭', onclick: () => { host._closed = j.id; host.replaceChildren(); } }, icon('x', 'sm'))), h('div', { class: 'body' }));
    drawer._job = j.id; host.replaceChildren(drawer);
  }
  drawer.querySelector('.jsecs').textContent = `${secs} 秒`;
  const st = drawer.querySelector('.jstate');
  if (st._state !== j.state) { st._state = j.state; st.replaceChildren(running ? h('div', { class: 'spin' }) : h('span', { class: `badge ${j.state === 'done' ? 't-ok' : 't-bad'}` }, h('span', { class: 'dot' }), j.state === 'done' ? '完成' : '失败')); }
  if (drawer._out === j.output && drawer._shown === j.state) return; // nothing new to show
  const b = drawer.querySelector('.body');
  const follow = drawer._out === undefined || b.scrollHeight - b.scrollTop - b.clientHeight < 40; // only follow the end if the reader is there
  drawer._out = j.output; drawer._shown = j.state;
  let body;
  if (j.kind === 'preview' && j.state === 'done') {
    const text = j.output.split('\n').filter((l) => !/^\[(brief|dry-run)\]|^extract-inbox/.test(l)).join('\n').trim();
    const meta = (j.output.match(/\[dry-run\][^\n]*/) || [''])[0].replace('[dry-run] nothing was sent; ', '').replace(/(\d+) events, (\d+) active tasks, (\d+) messages/, '日程 $1 项 · 进行中任务 $2 · 提示 $3 条');
    body = [renderBrief(text), h('div', { class: 'faint small', style: 'margin-top:10px' }, meta)];
  } else {
    const term = h('div', { class: 'term' }, h('div', { style: 'padding:8px 0' }, (j.output || (running ? '开始……' : '（没有输出）')).split('\n').map((l, i) => h('div', { class: 'ln' }, h('span', { class: 'no' }, i + 1), h('span', { class: 'tx' }, l || ' ')))));
    body = term;
  }
  b.replaceChildren(...[body].flat());
  if (running && follow) b.scrollTop = b.scrollHeight;
}

// ---------------------------------------------------------------- command palette (⌘K) ---------------------------------
function palette() {
  if ($('.palette')) return;
  const items = [
    ...Object.entries(VIEWS).map(([k, [l, ic]]) => ({ grp: '跳转', label: `打开「${l}」`, ic, run: () => go(k) })),
    { grp: '操作', label: '预览今天的简报', ic: 'eye', run: () => runJob('preview') },
    { grp: '操作', label: '发送测试简报', ic: 'send', run: () => runJob('test') },
    { grp: '操作', label: '现在读取收件箱', ic: 'sparkles', run: () => runJob('ingest') },
    { grp: '操作', label: '完整自检', ic: 'activity', run: () => runJob('status') },
    { grp: '操作', label: '测试 AI 连接', ic: 'sparkles', run: () => runJob('checkai') },
    { grp: '操作', label: '测试日历链接', ic: 'calendar-days', run: () => runJob('checkcal') },
    { grp: '操作', label: '新增任务', ic: 'plus', run: () => go('tasks') },
    { grp: '操作', label: '测试本机通知', ic: 'bell-ring', run: () => runJob('notify') },
    { grp: '操作', label: '下载任务表', ic: 'download', run: () => { location.href = '/api/tasks/download'; } },
    { grp: '外观', label: '切换深色 / 浅色', ic: 'moon', run: toggleTheme },
  ];
  let sel = 0; let shown = items;
  const q = h('input', { type: 'text', placeholder: '输入要做的事，例如「预览」「任务」「日志」' });
  const ul = h('ul', { role: 'listbox' });
  const close = () => { bg.remove(); document.removeEventListener('keydown', key, true); };
  const draw = () => {
    const words = q.value.trim().toLowerCase();
    shown = items.filter((it) => !words || it.label.toLowerCase().includes(words) || it.grp.includes(words)); sel = Math.min(sel, Math.max(0, shown.length - 1));
    const out = []; let g = '';
    shown.forEach((it, i) => { if (it.grp !== g) { g = it.grp; out.push(h('div', { class: 'grp' }, g)); } out.push(h('li', { class: i === sel ? 'on' : '', role: 'option', onmouseenter: () => { sel = i; draw(); }, onclick: () => { close(); it.run(); } }, icon(it.ic), it.label, h('small', {}, i === sel ? '↵' : ''))); });
    ul.replaceChildren(...(out.length ? out : [h('div', { class: 'empty', style: 'padding:24px' }, '没有匹配的操作')]));
  };
  const key = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); draw(); }
    else if (e.key === 'Enter' && shown[sel]) { e.preventDefault(); const it = shown[sel]; close(); it.run(); }
  };
  q.addEventListener('input', () => { sel = 0; draw(); });
  const bg = h('div', { class: 'overlay', onclick: (e) => { if (e.target === bg) close(); } }, h('div', { class: 'palette', role: 'dialog', 'aria-label': '命令面板' }, h('div', { class: 'q' }, icon('search', 'lg'), q, h('kbd', {}, 'esc')), ul));
  $('#modalHost').append(bg); document.addEventListener('keydown', key, true); draw(); setTimeout(() => q.focus(), 0);
}
$('#cmdkBtn').addEventListener('click', palette);
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); palette(); return; }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || $('.overlay');
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const map = { 0: 'setup', 1: 'overview', 2: 'tasks', 3: 'inbox', 4: 'settings', 5: 'logs', 6: 'tools' };
    if (map[e.key]) go(map[e.key]); else if (e.key === 'r') { refreshOverview(); render(); }
  }
});

// ---------------------------------------------------------------- start ------------------------------------------------
paintThemeBtn(); renderNav(); render();
api('/api/jobs/current').then((j) => { if (j && j.state === 'running') { showJob(j); poll(); } }).catch(() => {});
refreshOverview().then((o) => { if (o?.setup?.needed && !location.hash && current !== 'setup') go('setup'); });
