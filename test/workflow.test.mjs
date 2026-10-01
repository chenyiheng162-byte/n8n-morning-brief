import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, tmpdir } from './helpers.mjs';

const wf = JSON.parse(fs.readFileSync(path.join(ROOT, 'workflows', 'morning-brief.json'), 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name);

test('the committed workflow JSON is exactly what the sources build to', () => {
  const copy = tmpdir('build-copy-'); // also proves the builder works from a path with spaces
  const dir = path.join(copy, 'a folder with spaces');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'build-workflow.mjs'), path.join(dir, 'scripts', 'build-workflow.mjs'));
  fs.cpSync(path.join(ROOT, 'workflows', 'src'), path.join(dir, 'workflows', 'src'), { recursive: true });
  execFileSync(process.execPath, [path.join(dir, 'scripts', 'build-workflow.mjs')]);
  assert.equal(fs.readFileSync(path.join(dir, 'workflows', 'morning-brief.json'), 'utf8'), fs.readFileSync(path.join(ROOT, 'workflows', 'morning-brief.json'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'workflows', 'BUILD'), 'utf8'), fs.readFileSync(path.join(ROOT, 'workflows', 'BUILD'), 'utf8'));
});

test('the Discord call is a Code node that asks for the stored message and has no blind retry (review R5-01)', () => {
  const n = node('Send to Discord');
  assert.equal(n.type, 'n8n-nodes-base.code'); assert.equal(n.retryOnFail, undefined, 'no node-level retry: it could repeat a delivered request');
  assert.match(n.parameters.jsCode, /wait=true/); assert.match(n.parameters.jsCode, /attempt-\$\{run\}/);
  assert.ok(n.parameters.jsCode.indexOf('attempt-') < n.parameters.jsCode.indexOf('httpRequest('), 'the attempt is recorded before the request');
});

test('Done reports the send step\'s verdict and the build hash, and never throws', () => {
  const code = node('Done').parameters.jsCode;
  assert.match(code, /status: r\.status/); assert.doesNotMatch(code, /throw /);
  assert.ok(code.includes(`build: '${fs.readFileSync(path.join(ROOT, 'workflows', 'BUILD'), 'utf8').trim()}'`));
  assert.doesNotMatch(JSON.stringify(wf), /@@BUILD@@/, 'the placeholder must be replaced everywhere');
});

test('no secret or personal path is baked into the workflow', () => {
  const s = JSON.stringify(wf);
  assert.doesNotMatch(s, /discord\.com\/api\/webhooks\/\d|sk-[A-Za-z0-9]{20,}|private-[0-9a-f]{20,}|\/Users\//);
});

test('the webhook path carries the build hash, so a stale workflow cannot answer', () => {
  const build = fs.readFileSync(path.join(ROOT, 'workflows', 'BUILD'), 'utf8').trim();
  assert.equal(node('Webhook').parameters.path, `morning-brief-${build}`);
});

test('the build hash covers the WHOLE workflow: changing the send step, the Done node or the wiring changes it (review finding 8)', () => {
  const buildWith = (edit = (x) => x, editSrc = {}) => {
    const dir = tmpdir('hash-copy-'); fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'build-workflow.mjs'), edit(fs.readFileSync(path.join(ROOT, 'scripts', 'build-workflow.mjs'), 'utf8')));
    fs.cpSync(path.join(ROOT, 'workflows', 'src'), path.join(dir, 'workflows', 'src'), { recursive: true });
    for (const [f, fn] of Object.entries(editSrc)) { const p = path.join(dir, 'workflows', 'src', f); fs.writeFileSync(p, fn(fs.readFileSync(p, 'utf8'))); }
    execFileSync(process.execPath, [path.join(dir, 'scripts', 'build-workflow.mjs')]);
    return fs.readFileSync(path.join(dir, 'workflows', 'BUILD'), 'utf8').trim();
  };
  const base = buildWith();
  assert.equal(base, fs.readFileSync(path.join(ROOT, 'workflows', 'BUILD'), 'utf8').trim(), 'deterministic');
  assert.notEqual(buildWith(undefined, { 'send-discord.js': (x) => x.replace('wait=true', 'wait=false') }), base, 'send step');
  assert.notEqual(buildWith((x) => x.replace("status: r.status || 'unknown'", "status: 'sent'")), base, 'Done node');
  assert.notEqual(buildWith((x) => x.replace("'Build brief': { main: [[{ node: 'Send to Discord'", "'Build brief': { main: [[{ node: 'Done'")), base, 'connections');
});
