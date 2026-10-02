// Validated settings, shared by the Code nodes (inlined by the build script). Needs csv.js (normalizeDate) before it.
// A wrong value never stops the brief: it falls back to a safe default and the fallback is listed in `warnings`,
// which the brief prints, so a typo costs you a warning line instead of the whole morning.
function loadSettings($env) {
  const warnings = [];
  // soft: values below it are accepted but flagged (a budget of "5" is almost certainly meant as seconds, not milliseconds)
  const num = (name, def, min, max, soft = min) => {
    const raw = $env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < min || n > max) { warnings.push(`${name}「${String(raw).slice(0, 20)}」无效（应在 ${min} 到 ${max} 之间），已改用 ${def}`); return def; }
    if (n < soft) warnings.push(`${name} 只有 ${n}，单位是毫秒，这个值非常小`);
    return Math.round(n);
  };
  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let tz = $env.BRIEF_TZ || systemTz;
  try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch (e) { warnings.push(`BRIEF_TZ「${String(tz).slice(0, 30)}」不是有效的时区，已改用系统时区 ${systemTz}`); tz = systemTz; }
  let view = String($env.BRIEF_VIEW || 'compact').toLowerCase();
  if (view !== 'compact' && view !== 'full') { warnings.push(`BRIEF_VIEW「${view.slice(0, 20)}」无效（应为 compact 或 full），已改用 compact`); view = 'compact'; }
  let baseDate = null;
  if ($env.BRIEF_BASE_DATE) {
    baseDate = normalizeDate($env.BRIEF_BASE_DATE) || null;
    if (!baseDate) warnings.push(`BRIEF_BASE_DATE「${String($env.BRIEF_BASE_DATE).slice(0, 20)}」不是有效日期，已忽略`);
    else if (new Date(`${baseDate}T00:00:00Z`).getUTCDay() !== 1) warnings.push(`BRIEF_BASE_DATE ${baseDate} 不是周一：它应该是第 1 周周一的日期，否则「第 N 周」会整体错位`);
  }
  const regex = (name, flags) => { const v = $env[name]; if (!v) return null; try { return new RegExp(v, flags); } catch (e) { warnings.push(`${name} 不是有效的正则表达式，已忽略`); return null; } };
  return {
    warnings, tz, view, baseDate,
    eventDays: num('BRIEF_EVENT_DAYS', 3, 1, 14),
    aiTimeoutMs: num('BRIEF_AI_TIMEOUT_MS', 90000, 1, 600000, 10000),
    ingestBudgetMs: num('BRIEF_INGEST_BUDGET_MS', 150000, 1, 500000, 20000),
    chunkChars: num('BRIEF_CHUNK_CHARS', 24000, 4000, 60000),
    autoConfirm: /^(1|true|yes)$/i.test(String($env.BRIEF_AUTO_CONFIRM || '')),
    milestones: !/^(0|false|no|off)$/i.test(String($env.BRIEF_MILESTONES || '')), // learning milestones from syllabi: on unless turned off
    ignore: regex('BRIEF_IGNORE', 'i'),
    strip: regex('BRIEF_STRIP', 'gi'),
    test: !!$env.BRIEF_TEST,
  };
}
