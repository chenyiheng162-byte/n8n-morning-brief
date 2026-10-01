// Assembles workflows/morning-brief.json (and workflows/BUILD) from the Code-node sources in workflows/src/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'); // fileURLToPath copes with spaces and non-ASCII paths
const src = (f) => fs.readFileSync(path.join(root, 'workflows', 'src', f), 'utf8')
  .replace(/^\/\/@include (\S+)$/gm, (_, inc) => fs.readFileSync(path.join(root, 'workflows', 'src', 'lib', inc), 'utf8'));
const id = (n) => `b1a00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const code = (n, name, x, jsCode) => ({ id: id(n), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [x, 0], parameters: { jsCode } });

const readCode = src('read-calendars.js');
const ingestCode = src('ingest-files.js');
const briefCode = src('build-brief.js');
const sendCode = src('send-discord.js');

// BUILD is a hash of the WHOLE workflow (every node, its settings and the connections). It is computed with a fixed
// placeholder where the hash itself appears (the webhook path and the Done node) and substituted afterwards. The
// webhook path contains it, so a stale workflow cannot answer the request that run-brief.sh sends.
const PH = '@@BUILD@@';
// The path carries the build hash, which anyone can compute from the public source, so it is NOT authentication. This node is:
// run-brief.sh sends a random token (BRIEF_TOKEN, created by the installer) that only the settings file knows.
const checkCode = `const expected = $env.BRIEF_TOKEN;
if (expected) {
  const got = (($('Webhook').first().json.headers) || {})['x-brief-token'];
  if (got !== expected) throw new Error('unauthorized: missing or wrong x-brief-token');
}
return $input.all();`;
// Done only reports. Send to Discord never throws, so its three-word result always reaches run-brief.sh.
const doneCode = `const s = $('Send to Discord').first().json;
const r = s.send || {};
const t = s.timing || {};
return [{ json: { status: r.status || 'unknown', reason: r.reason || '', events: s.eventCount, errors: s.errorCount, tasks: s.taskCount, newTasks: s.newTasks, aiCalls: t.aiCalls || 0, calendarMs: t.calendarMs || 0, ingestMs: t.ingestMs || 0, build: '${PH}' } }];`;

const wf = {
  id: 'morningBriefTest01', // stable id so re-importing updates the same workflow
  name: 'Morning Brief',
  active: false,
  nodes: [
    { id: id(1), name: 'Webhook', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: 'b1a00000-0000-4000-8000-0000000000aa',
      parameters: { httpMethod: 'POST', path: `morning-brief-${PH}`, responseMode: 'lastNode', options: {} } },
    code(7, 'Check token', 240, checkCode),
    code(2, 'Read calendars', 480, readCode),
    code(6, 'Ingest files', 720, ingestCode),
    code(3, 'Build brief', 960, briefCode),
    code(4, 'Send to Discord', 1200, sendCode), // a Code node, not the HTTP node: the HTTP node would retry a request that may already have been delivered
    code(5, 'Done', 1440, doneCode),
  ],
  connections: {
    Webhook: { main: [[{ node: 'Check token', type: 'main', index: 0 }]] },
    'Check token': { main: [[{ node: 'Read calendars', type: 'main', index: 0 }]] },
    'Read calendars': { main: [[{ node: 'Ingest files', type: 'main', index: 0 }]] },
    'Ingest files': { main: [[{ node: 'Build brief', type: 'main', index: 0 }]] },
    'Build brief': { main: [[{ node: 'Send to Discord', type: 'main', index: 0 }]] },
    'Send to Discord': { main: [[{ node: 'Done', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};
const build = crypto.createHash('sha256').update(JSON.stringify(wf)).digest('hex').slice(0, 12);
const json = JSON.stringify(wf, null, 2).split(PH).join(build) + '\n';
fs.writeFileSync(path.join(root, 'workflows', 'morning-brief.json'), json);
fs.writeFileSync(path.join(root, 'workflows', 'BUILD'), `${build}\n`);
console.log(`wrote workflows/morning-brief.json (build ${build})`);
