// The "Send to Discord" step (shared by n8n and the direct engine): one attempt record before posting, a three-word
// verdict, and no repeat of a request that may already have been delivered (final review R5-01 / R5-02).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runNode, tmpdir } from './helpers.mjs';

const brief = { payload: { embeds: [{ title: 't' }] }, eventCount: 1 };
const send = async (http, env = {}, run = '080000-123') => {
  const state = tmpdir('send-state-');
  const calls = [];
  const r = await runNode('send-discord.js', { env: { BRIEF_STATE_DIR: state, DISCORD_WEBHOOK_URL: 'https://discord.example/api/webhooks/1/tok', ...env }, nodes: { Webhook: { body: { run } } }, input: brief,
    http: async (opts) => { calls.push({ opts, attemptExisted: fs.existsSync(path.join(state, `attempt-${run}`)) }); return http(calls.length); } });
  return { ...r.send, calls, state };
};
const err = (props, msg = 'boom') => Object.assign(new Error(msg), props);

test('send: success needs a message id; the attempt is on disk BEFORE the request leaves', async () => {
  const r = await send(async () => ({ id: '42' }));
  assert.equal(r.status, 'sent'); assert.equal(r.id, '42'); assert.equal(r.calls.length, 1); assert.equal(r.calls[0].attemptExisted, true);
  assert.match(r.calls[0].opts.url, /\?wait=true$/);
  assert.equal((await send(async () => ({}))).status, 'unknown', 'no id: it may or may not be stored');
});
test('send: a server error, a timeout or a broken connection is UNKNOWN and is NOT repeated', async () => {
  for (const e of [err({ httpCode: 500 }), err({ response: { status: 504 } }), err({}, 'timeout of 30000ms exceeded'), err({ code: 'ECONNRESET' }), err({ cause: { code: 'UND_ERR_SOCKET' } }, 'fetch failed')]) {
    const r = await send(async () => { throw e; }); assert.equal(r.status, 'unknown', e.message); assert.equal(r.calls.length, 1, 'never repeated');
  }
});
test('send: a 502/503 from the gateway (the request was not taken) is retried, and only then UNKNOWN', { timeout: 30000 }, async () => {
  const bg = await send(async (n) => { if (n === 1) throw err({ response: { status: 502 } }); return { id: '9' }; });
  assert.equal(bg.status, 'sent'); assert.equal(bg.calls.length, 2);
  const down = await send(async () => { throw err({ httpCode: 503 }); });
  assert.equal(down.status, 'unknown'); assert.equal(down.calls.length, 3, 'two retries, then it stops');
});
test('send: a refusal is NOT_SENT; a rate limit and a connection that never opened are retried', { timeout: 30000 }, async () => {
  assert.equal((await send(async () => { throw err({ httpCode: 404 }); })).status, 'not_sent');
  assert.equal((await send(async () => { throw err({}, 'Request failed with status code 401'); })).status, 'not_sent', 'status read from the message when the properties are lost in the task runner');
  const rl = await send(async (n) => { if (n === 1) throw err({ httpCode: 429, response: { status: 429, headers: { 'retry-after': '0' } } }); return { id: '7' }; });
  assert.equal(rl.status, 'sent'); assert.equal(rl.calls.length, 2);
  const refused = await send(async (n) => { if (n === 1) throw err({}, 'connect ECONNREFUSED 1.2.3.4:443'); return { id: '8' }; });
  assert.equal(refused.status, 'sent'); assert.equal(refused.calls.length, 2);
  const always = await send(async () => { throw err({ httpCode: 429 }); }); assert.equal(always.status, 'not_sent'); assert.equal(always.calls.length, 3);
});
test('send: no webhook, or an attempt that cannot be recorded, sends nothing at all', async () => {
  const none = await send(async () => ({ id: '1' }), { DISCORD_WEBHOOK_URL: '' }); assert.equal(none.status, 'not_sent'); assert.equal(none.calls.length, 0);
  const ro = tmpdir('send-ro-'); fs.chmodSync(ro, 0o500);
  try { const r = await send(async () => ({ id: '1' }), { BRIEF_STATE_DIR: ro }); assert.equal(r.status, 'not_sent'); assert.equal(r.calls.length, 0); assert.match(r.reason, /could not record/); } finally { fs.chmodSync(ro, 0o700); }
});
test('send: the reason never contains the webhook link', async () => {
  const r = await send(async () => { throw err({ httpCode: 404 }, 'POST https://discord.example/api/webhooks/1/tok failed'); });
  assert.doesNotMatch(r.reason, /discord\.example|tok/);
});

test('send: a clear "not sent" removes its own attempt record, so either engine can try again later (review R6-02)', async () => {
  const r = await send(async () => { throw err({ httpCode: 404 }); }); assert.equal(r.status, 'not_sent');
  assert.equal(fs.existsSync(path.join(r.state, 'attempt-080000-123')), false);
  const u = await send(async () => { throw err({ httpCode: 500 }); }); assert.equal(u.status, 'unknown');
  assert.equal(fs.existsSync(path.join(u.state, 'attempt-080000-123')), true, 'an unknown outcome keeps it');
});
