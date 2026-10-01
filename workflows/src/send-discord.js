// n8n Code node "Send to Discord" (the direct engine runs this same file). Posts the brief and says what happened in
// one of three words, which run-brief.sh turns into its delivery records:
//   sent      Discord stored the message (it returned the message id)
//   not_sent  nothing can have been delivered: no webhook, Discord refused it (4xx/429), or the connection never opened
//   unknown   the request may have reached Discord but no clear answer came back (timeout, broken connection, 5xx, no id)
// It never throws, so a failure of the workflow itself (HTTP 500) can only come from a step BEFORE this one, or from the
// attempt record below. A request that may already have been delivered is never repeated: only a refusal (429) or a
// connection that never opened is retried.
const fs = require('fs');
const path = require('path');
const os = require('os');

const brief = $input.first().json;
const body = (() => { try { return $('Webhook').first().json.body || {}; } catch (e) { return {}; } })();
const run = String(body.run || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
const stateDir = $env.BRIEF_STATE_DIR || path.join($env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief'), 'data', 'state');
const sleep = (ms) => (typeof setTimeout === 'function' ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const safe = (m) => String(m || '').replace(/https?:\/\/\S+/g, '<链接>').slice(0, 160);
const attemptFile = run ? path.join(stateDir, `attempt-${run}`) : '';
// A clear "not sent" removes the attempt record again: the record means "this may have reached Discord", which is now
// known to be false, so the caller can safely try again later (whichever engine ran this).
const out = (status, extra = {}) => {
  if (status === 'not_sent' && attemptFile) { try { fs.rmSync(attemptFile, { force: true }); } catch (e) { /* the record stays: treated as unknown */ } }
  return [{ json: { ...brief, send: { status, ...extra } } }];
};
// (Errors can lose their properties on the way out of n8n's task runner, so the message is read as a fallback.)
const httpCode = (e) => Number((e && (e.httpCode ?? e.statusCode ?? (e.response && (e.response.status ?? e.response.statusCode)))) || 0)
  || Number((String((e && e.message) || '').match(/status code (\d{3})|^(\d{3}) /) || []).slice(1).find(Boolean) || 0);
const errCode = (e) => String((e && (e.code || (e.cause && e.cause.code))) || (String((e && e.message) || '').match(/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/) || [])[1] || '');
const NEVER_SENT = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)$/;
const retryAfter = (e) => { const h = (e && e.response && e.response.headers) || {}; const v = Number(e && e.retryAfter) || Number(h['retry-after']) || 0; return Number.isFinite(v) && v > 0 ? v : 0; };

const base = $env.DISCORD_WEBHOOK_URL;
if (!base) return out('not_sent', { reason: 'DISCORD_WEBHOOK_URL is not configured' });
// The attempt is recorded BEFORE anything can reach Discord. If this run dies later in any way (crash, kill, a failing
// step after this one), run-brief.sh finds this file and treats the day as "unknown" instead of sending again.
if (run) {
  try { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(attemptFile, `${Date.now()}\n`); } catch (e) {
    return out('not_sent', { reason: `could not record the delivery attempt (${safe(e.message)})` });
  }
}
const url = `${base}${base.includes('?') ? '&' : '?'}wait=true`;
for (let attempt = 0; ; attempt++) {
  try {
    const res = await this.helpers.httpRequest({ method: 'POST', url, body: brief.payload, json: true, timeout: 30000 });
    if (res && res.id) return out('sent', { id: String(res.id) });
    return out('unknown', { reason: 'Discord answered without a message id' });
  } catch (e) {
    const code = httpCode(e);
    const neverSent = NEVER_SENT.test(errCode(e));
    // 502/503 (Cloudflare "bad gateway" / "service unavailable", frequent for a few seconds at a time) means the request
    // was not taken: without a retry the whole day's automation stops on it. 500 and 504 may have been processed: unknown.
    const notTaken = code === 502 || code === 503;
    if (attempt < 2 && (code === 429 || neverSent || notTaken)) { await sleep(Math.max(retryAfter(e) * 1000, 3000) * (notTaken ? attempt + 1 : 1)); continue; }
    if (code === 429 || (code >= 400 && code < 500) || neverSent) return out('not_sent', { reason: `Discord: ${code || errCode(e)} ${safe(e.message)}` });
    return out('unknown', { reason: `Discord: ${code || errCode(e) || 'no answer'} ${safe(e.message)}` });
  }
}
