'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// ── Config ─────────────────────────────────────────────────────────────────────
const CHUNK_SIZE    = 16 * 1024 * 1024; // 16 MB — larger chunks suit LAN
const RETRY_BASE_MS = 2000;
const RETRY_CAP_MS  = 30000;
const STATE_FILENAME = '.lan-upload-state.json';

// ── CLI args ───────────────────────────────────────────────────────────────────
const [,, srcArg, serverArg] = process.argv;
if (!srcArg || !serverArg) {
  console.error('Usage: node upload-client.js <directory> <server-url>');
  console.error('  e.g. node upload-client.js "C:\\My Videos" http://192.168.1.100:3066');
  process.exit(1);
}

const absDir = path.resolve(srcArg);
if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
  console.error('Not a directory: ' + absDir);
  process.exit(1);
}

const BASE      = serverArg.replace(/\/$/, '');
const stateFile = path.join(absDir, STATE_FILENAME);

// ── State (persisted as JSON next to the source folder) ────────────────────────
function loadState() {
  try {
    if (fs.existsSync(stateFile)) return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  return { pending: {}, done: [] };
}

function saveState(state) {
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2)); } catch {}
}

// ── Directory walker ────────────────────────────────────────────────────────────
function walk(dir, root) {
  root = root || dir;
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory())  out.push(...walk(full, root));
    else if (ent.isFile())  out.push({ full, rel: path.relative(root, full) });
  }
  return out;
}

// ── HTTP helpers (no external deps) ────────────────────────────────────────────
function parseUrl(urlPath) {
  const u   = new URL(urlPath, BASE);
  const lib = u.protocol === 'https:' ? https : http;
  return { lib, opts: { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname } };
}

function postJSON(urlPath, body) {
  const { lib, opts } = parseUrl(urlPath);
  const buf = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { ...opts, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': buf.length } },
      res => collect(res, resolve, reject)
    );
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function postChunk(uploadId, chunkIndex, chunkBuf, filename) {
  const boundary = 'LanUpload' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  const CRLF = '\r\n';
  // Build multipart body manually
  const head = Buffer.from(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="uploadId"${CRLF}${CRLF}${uploadId}${CRLF}` +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="chunkIndex"${CRLF}${CRLF}${chunkIndex}${CRLF}` +
    `--${boundary}${CRLF}Content-Disposition: form-data; name="chunk"; filename="${filename.replace(/"/g, '')}"${CRLF}` +
    `Content-Type: application/octet-stream${CRLF}${CRLF}`
  );
  const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([head, chunkBuf, tail]);

  const { lib, opts } = parseUrl('/upload/chunk');
  return new Promise((resolve, reject) => {
    const req = lib.request(
      { ...opts, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      res => collect(res, resolve, reject)
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpDelete(urlPath) {
  const { lib, opts } = parseUrl(urlPath);
  return new Promise(resolve => {
    const req = lib.request({ ...opts, method: 'DELETE' }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', resolve);
    req.end();
  });
}

function collect(res, resolve, reject) {
  const chunks = [];
  res.on('data', c => chunks.push(c));
  res.on('end', () => {
    const text = Buffer.concat(chunks).toString();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try { resolve(JSON.parse(text)); } catch { resolve(text); }
    } else {
      let msg = `HTTP ${res.statusCode}`, code;
      try { const j = JSON.parse(text); msg = j.error || msg; code = j.code; } catch {}
      const e = new Error(msg); e.code = code; reject(e);
    }
  });
}

// ── Formatting ──────────────────────────────────────────────────────────────────
const fmtSize = b =>
  b >= 1e12 ? (b/1e12).toFixed(2)+' TB' :
  b >= 1e9  ? (b/1e9).toFixed(2)+' GB'  :
  b >= 1e6  ? (b/1e6).toFixed(2)+' MB'  :
  b >= 1e3  ? (b/1e3).toFixed(1)+' KB'  : b+' B';

const fmtSpeed = bps =>
  bps >= 1e9 ? (bps/1e9).toFixed(2)+' GB/s' :
  bps >= 1e6 ? (bps/1e6).toFixed(1)+' MB/s' :
  bps >= 1e3 ? (bps/1e3).toFixed(1)+' KB/s' : Math.round(bps)+' B/s';

const fmtETA = s =>
  !isFinite(s)||s<=0 ? '...' :
  s < 60   ? Math.round(s)+'s' :
  s < 3600 ? Math.floor(s/60)+'m '+Math.round(s%60)+'s' :
             Math.floor(s/3600)+'h '+Math.floor((s%3600)/60)+'m';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Terminal output ─────────────────────────────────────────────────────────────
// status() overwrites the current line; print() commits it and moves to next line.
let lastLen = 0;

function status(text) {
  const width = (process.stdout.columns || 120) - 1;
  const out   = text.length > width ? text.slice(0, width - 1) + '…' : text;
  process.stdout.write('\r' + out.padEnd(lastLen));
  lastLen = out.length;
}

function print(text) {
  process.stdout.write('\r' + text.padEnd(lastLen) + '\n');
  lastLen = 0;
}

// ── Speed tracker ───────────────────────────────────────────────────────────────
function makeTracker() {
  const s = [];
  return {
    record(bytes) {
      const t = Date.now(); s.push({ t, b: bytes });
      while (s.length > 1 && t - s[0].t > 5000) s.shift();
    },
    speed() {
      if (s.length < 2) return 0;
      const dt = (s[s.length-1].t - s[0].t) / 1000;
      return dt < 0.05 ? 0 : (s[s.length-1].b - s[0].b) / dt;
    }
  };
}

// ── Upload one file ─────────────────────────────────────────────────────────────
async function uploadFile(entry, idx, total, state) {
  const { full, rel } = entry;
  const relFwd = rel.replace(/\\/g, '/'); // always forward slashes over the wire

  let fileSize;
  try { fileSize = fs.statSync(full).size; }
  catch (e) { print(`[${idx}/${total}] SKIP (unreadable): ${rel}`); return; }

  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE) || 1;
  const saved       = state.pending[relFwd];
  let uploadId      = saved?.uploadId   ?? null;
  let startChunk    = saved?.nextChunk  ?? 0;

  // ── Init / resume session (retry forever) ──
  let attempt = 0;
  while (true) {
    try {
      const r = await postJSON('/upload/init', {
        uploadId, relativePath: relFwd,
        filename: path.basename(rel),
        fileSize, chunkSize: CHUNK_SIZE, totalChunks
      });
      uploadId = r.uploadId;
      const recv = new Set(r.receivedChunks || []);
      startChunk = 0;
      while (recv.has(startChunk) && startChunk < totalChunks) startChunk++;
      break;
    } catch {
      attempt++;
      const delay = Math.min(RETRY_BASE_MS * attempt, RETRY_CAP_MS);
      status(`[${idx}/${total}] ${rel}  init failed, retry in ${delay/1000}s`);
      await sleep(delay);
    }
  }

  state.pending[relFwd] = { uploadId, nextChunk: startChunk, totalChunks };
  saveState(state);

  if (startChunk > 0)
    status(`[${idx}/${total}] ${rel}  resuming from chunk ${startChunk}/${totalChunks}`);

  const tracker = makeTracker();
  const reuseBuf = Buffer.allocUnsafe(CHUNK_SIZE); // single reusable read buffer

  // ── Chunk loop ──
  for (let ci = startChunk; ci < totalChunks; ci++) {
    const chunkStart = ci * CHUNK_SIZE;
    const chunkLen   = Math.min(CHUNK_SIZE, fileSize - chunkStart);
    const chunkView  = reuseBuf.slice(0, chunkLen);

    // Read chunk from disk
    try {
      const fd = fs.openSync(full, 'r');
      try { fs.readSync(fd, chunkView, 0, chunkLen, chunkStart); }
      finally { fs.closeSync(fd); }
    } catch (e) {
      print(`[${idx}/${total}] ERROR reading ${rel}: ${e.message}`);
      return;
    }

    // Send chunk — retry indefinitely
    attempt = 0;
    while (true) {
      try {
        const result = await postChunk(uploadId, ci, chunkView, path.basename(rel));

        const sent = Math.min((ci + 1) * CHUNK_SIZE, fileSize);
        tracker.record(sent);
        const spd = tracker.speed();
        const eta = spd > 0 ? (fileSize - sent) / spd : Infinity;
        status(
          `[${idx}/${total}] ${rel}  ` +
          `${(sent/fileSize*100).toFixed(1)}%  ` +
          `${fmtSize(sent)}/${fmtSize(fileSize)}  ` +
          `${fmtSpeed(spd)}  ETA ${fmtETA(eta)}`
        );

        state.pending[relFwd].nextChunk = ci + 1;
        saveState(state);

        if (result.complete) {
          print(`[${idx}/${total}] done  ${rel}  (${fmtSize(fileSize)})`);
          delete state.pending[relFwd];
          state.done.push(relFwd);
          saveState(state);
          return;
        }
        break; // chunk OK → next chunk
      } catch (err) {
        if (err.code === 'SESSION_NOT_FOUND') {
          // Server was restarted — force re-init on next call
          state.pending[relFwd] = { uploadId: null, nextChunk: ci, totalChunks };
          saveState(state);
          return await uploadFile(entry, idx, total, state);
        }
        attempt++;
        const delay = Math.min(RETRY_BASE_MS * attempt, RETRY_CAP_MS);
        status(`[${idx}/${total}] ${rel}  chunk ${ci+1}/${totalChunks} failed (attempt ${attempt}), retry in ${delay/1000}s`);
        await sleep(delay);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\nLAN Upload Client');
  console.log('=================');
  console.log('Source : ' + absDir);
  console.log('Server : ' + BASE);
  console.log('');

  status('Scanning…');
  let files;
  try { files = walk(absDir).filter(e => e.full !== stateFile); }
  catch (e) { console.error('Failed to scan directory: ' + e.message); process.exit(1); }

  const totalSize = files.reduce((s, e) => { try { return s + fs.statSync(e.full).size; } catch { return s; } }, 0);
  print(`Found ${files.length} file${files.length !== 1 ? 's' : ''}  (${fmtSize(totalSize)} total)`);
  console.log('');

  if (files.length === 0) { console.log('Nothing to upload.'); return; }

  const state  = loadState();
  if (!state.pending) state.pending = {};
  if (!state.done)    state.done    = [];
  const doneSet = new Set(state.done);

  process.on('SIGINT', () => {
    print('');
    console.log('Interrupted — run the same command to resume.\n');
    process.exit(0);
  });

  let uploaded = 0;
  let skipped  = 0;
  for (let i = 0; i < files.length; i++) {
    const entry  = files[i];
    const relFwd = entry.rel.replace(/\\/g, '/');
    if (doneSet.has(relFwd)) { skipped++; continue; }
    await uploadFile(entry, i + 1 - skipped, files.length - skipped, state);
    uploaded++;
  }

  console.log('');
  console.log(`Done — ${uploaded} file${uploaded !== 1 ? 's' : ''} uploaded.`);
  try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); } catch {}
}

main().catch(err => { console.error('\nFatal: ' + err.message); process.exit(1); });
