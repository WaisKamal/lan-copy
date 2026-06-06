const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = 3066;
const UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const TMP_DIR = path.join(UPLOAD_DIR, '.tmp');

[UPLOAD_DIR, TMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

function getLocalIPs() {
  const nets = os.networkInterfaces();
  const results = [];
  for (const iface of Object.values(nets)) {
    for (const net of iface) {
      if (net.family === 'IPv4' && !net.internal) results.push(net.address);
    }
  }
  return results;
}

function safeName(raw) {
  return Buffer.from(String(raw), 'latin1')
    .toString('utf8')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\0/g, '')
    .trim() || 'upload';
}

// Sanitize a relative path from the client: strip '..' components, sanitize each segment.
// Returns an OS-native relative path (e.g. "Movies\\Action\\film.mkv" on Windows).
function sanitizeRelPath(raw) {
  const parts = String(raw)
    .replace(/\\/g, '/')
    .split('/')
    .filter(p => p && p !== '.' && p !== '..');
  return parts.map(safeName).join(path.sep);
}

function uniquePath(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  for (let n = 1; ; n++) {
    dest = path.join(dir, `${base} (${n})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
}

function isValidUUID(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Initialize or resume an upload session ─────────────────────────────────

app.post('/upload/init', (req, res) => {
  let { uploadId, filename, relativePath, fileSize, chunkSize, totalChunks } = req.body;

  // savePath is the relative path under UPLOAD_DIR where the file will be written.
  // CLI uploads supply relativePath (preserves folder structure).
  // Browser uploads supply only filename (flat save with collision avoidance).
  const savePath = relativePath
    ? sanitizeRelPath(relativePath)
    : safeName(filename);

  // Resume existing session
  if (uploadId && isValidUUID(uploadId)) {
    const metaPath    = path.join(TMP_DIR, `${uploadId}.json`);
    const partialPath = path.join(TMP_DIR, `${uploadId}.partial`);
    if (fs.existsSync(metaPath) && fs.existsSync(partialPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      console.log(`Resume: ${meta.savePath} (${meta.receivedChunks.length}/${meta.totalChunks} chunks)`);
      return res.json({ uploadId, receivedChunks: meta.receivedChunks });
    }
  }

  // New session
  uploadId = crypto.randomUUID();
  const meta = {
    savePath,
    fileSize: Number(fileSize),
    chunkSize: Number(chunkSize),
    totalChunks: Number(totalChunks),
    receivedChunks: []
  };
  fs.writeFileSync(path.join(TMP_DIR, `${uploadId}.json`), JSON.stringify(meta));
  fs.closeSync(fs.openSync(path.join(TMP_DIR, `${uploadId}.partial`), 'w'));
  console.log(`New: ${savePath} (${(meta.fileSize / 1e9).toFixed(2)} GB, ${totalChunks} chunks)`);
  res.json({ uploadId, receivedChunks: [] });
});

// ── Receive a single chunk ──────────────────────────────────────────────────

const chunkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 32 * 1024 * 1024 } // 32 MB ceiling — larger than any chunk we send
});

app.post('/upload/chunk', (req, res) => {
  chunkUpload.single('chunk')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });

    const { uploadId, chunkIndex } = req.body;
    if (!uploadId || !isValidUUID(uploadId) || chunkIndex == null) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    const idx         = parseInt(chunkIndex, 10);
    const metaPath    = path.join(TMP_DIR, `${uploadId}.json`);
    const partialPath = path.join(TMP_DIR, `${uploadId}.partial`);

    if (!fs.existsSync(metaPath) || !fs.existsSync(partialPath)) {
      return res.status(404).json({ error: 'Upload session not found', code: 'SESSION_NOT_FOUND' });
    }

    const meta   = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const offset = idx * meta.chunkSize;

    // Write chunk at its correct byte offset in the partial file
    const fd = fs.openSync(partialPath, 'r+');
    try {
      fs.writeSync(fd, req.file.buffer, 0, req.file.buffer.length, offset);
    } finally {
      fs.closeSync(fd);
    }

    if (!meta.receivedChunks.includes(idx)) {
      meta.receivedChunks.push(idx);
    }

    if (meta.receivedChunks.length === meta.totalChunks) {
      // Determine final destination.
      // CLI uploads (savePath has subdirs) use the exact path — preserves folder structure.
      // Browser uploads (savePath is a bare filename) use uniquePath to avoid overwriting.
      let finalPath;
      if (path.dirname(meta.savePath) === '.') {
        finalPath = uniquePath(UPLOAD_DIR, meta.savePath);
      } else {
        const destDir = path.join(UPLOAD_DIR, path.dirname(meta.savePath));
        fs.mkdirSync(destDir, { recursive: true });
        finalPath = path.join(UPLOAD_DIR, meta.savePath);
      }
      fs.renameSync(partialPath, finalPath);
      fs.unlinkSync(metaPath);
      const relResult = path.relative(UPLOAD_DIR, finalPath);
      console.log(`Done: ${relResult} (${(meta.fileSize / 1e9).toFixed(3)} GB)`);
      return res.json({ received: idx, complete: true, filename: relResult });
    }

    fs.writeFileSync(metaPath, JSON.stringify(meta));
    res.json({ received: idx, complete: false });
  });
});

// ── Cancel / clean up a session ────────────────────────────────────────────

app.delete('/upload/:uploadId', (req, res) => {
  const { uploadId } = req.params;
  if (!isValidUUID(uploadId)) return res.status(400).json({ error: 'Invalid uploadId' });
  try {
    const metaPath    = path.join(TMP_DIR, `${uploadId}.json`);
    const partialPath = path.join(TMP_DIR, `${uploadId}.partial`);
    if (fs.existsSync(metaPath))    fs.unlinkSync(metaPath);
    if (fs.existsSync(partialPath)) fs.unlinkSync(partialPath);
    res.json({ cancelled: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log('\nLAN File Transfer Server');
  console.log('========================');
  console.log(`Local:   http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`Network: http://${ip}:${PORT}`));
  console.log(`\nSaving files to: ${UPLOAD_DIR}\n`);
});

server.timeout = 0;
server.requestTimeout = 0;
server.headersTimeout = 65000;
