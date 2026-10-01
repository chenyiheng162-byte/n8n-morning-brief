// Pre-step (runs BEFORE n8n starts): turns PDF/DOCX files in the inbox into plain-text caches.
// n8n's Code-node sandbox breaks the PDF/DOCX parsers, so this runs as ordinary Node instead.
// Cache: <state>/extracted/<sha256>.txt  (or .err with the reason). Idempotent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const home = process.env.BRIEF_HOME || path.join(os.homedir(), '.n8n-morning-brief');
const inbox = process.env.BRIEF_INBOX || path.join(os.homedir(), 'n8n-inbox');
const stateDir = process.env.BRIEF_STATE_DIR || path.join(home, 'data', 'state');
const req = createRequire(path.join(home, 'package.json')); // libraries live in BRIEF_HOME, wherever this script runs from
const outDir = path.join(stateDir, 'extracted');
fs.mkdirSync(inbox, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

let done = 0, failed = 0;
for (const name of fs.readdirSync(inbox)) {
  const file = path.join(inbox, name);
  const ext = path.extname(name).toLowerCase();
  if (name.startsWith('.') || !fs.lstatSync(file).isFile() || !['.pdf', '.docx'].includes(ext)) continue;
  const buf = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const txt = path.join(outDir, `${hash}.txt`), err = path.join(outDir, `${hash}.err`);
  if (fs.existsSync(txt)) continue;
  // A failed extraction is remembered for 6 hours (avoids hammering a broken file), then tried again. The number of
  // attempts is kept in the .err file; after 5 the file is given up on for good and the ingest node says so once.
  let attempts = 0;
  if (fs.existsSync(err)) {
    let prev = { n: 1 };
    try { prev = JSON.parse(fs.readFileSync(err, 'utf8')); } catch (e) { /* older plain-text format counts as one attempt */ }
    attempts = Number(prev.n) || 1;
    if (attempts >= 5 || Date.now() - fs.statSync(err).mtimeMs < 6 * 3600 * 1000) continue;
    fs.rmSync(err);
  }
  try {
    let text;
    if (ext === '.pdf') {
      const { getDocumentProxy, extractText } = req('unpdf');
      text = (await extractText(await getDocumentProxy(new Uint8Array(buf)), { mergePages: true })).text;
    } else {
      const mammoth = req('mammoth');
      text = (await mammoth.extractRawText({ buffer: buf })).value;
    }
    fs.writeFileSync(txt, text);
    done++;
  } catch (e) {
    fs.writeFileSync(err, JSON.stringify({ n: attempts + 1, msg: String(e.message || e).slice(0, 200), at: Date.now() }));
    failed++;
  }
}
console.log(`extract-inbox: ${done} extracted, ${failed} failed`);
