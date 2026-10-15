// Shared data store for ListingFlow.
// All team data lives in data/db.json; uploaded images live in data/files/.
// Browsers read a full snapshot on load, write through batched ops, and
// receive everyone else's changes over a Server-Sent Events stream.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.LISTINGFLOW_DATA_DIR || path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const STORE_NAME_RE = /^[a-z_]{1,40}$/;
const FILE_NAME_RE = /^[a-f0-9]{40}\.[a-z0-9]{1,5}$/;

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif'
};
const TYPE_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_TYPE).map(([t, e]) => [e, t]));
TYPE_BY_EXT.jpg = 'image/jpeg';

fs.mkdirSync(FILES_DIR, { recursive: true });

let db = { version: 1, stores: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!db.stores) db.stores = {};
  } catch (e) {
    // Keep the unreadable file for recovery instead of overwriting it.
    const backup = DB_FILE + '.corrupt-' + Date.now();
    fs.copyFileSync(DB_FILE, backup);
    console.error(`data/db.json could not be parsed; copied to ${path.basename(backup)} and starting empty.`);
  }
}

// Writes are coalesced and done atomically (temp file + rename).
let saveTimer = null;
function writeDbAtomically() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeDbAtomically();
  }, 300);
}

function extForType(contentType) {
  return EXT_BY_TYPE[String(contentType || '').split(';')[0].trim().toLowerCase()] || 'bin';
}

function saveFileBuffer(buf, contentType) {
  const name = crypto.createHash('sha1').update(buf).digest('hex') + '.' + extForType(contentType);
  const target = path.join(FILES_DIR, name);
  if (!fs.existsSync(target)) fs.writeFileSync(target, buf);
  return '/api/files/' + name;
}

// Streams an upload to a temp file while hashing it, so big images never sit in memory.
// Resolves to the file URL, or null for an empty upload.
function saveFileStream(req, contentType, maxBytes) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(FILES_DIR, '.upload-' + crypto.randomBytes(8).toString('hex'));
    const out = fs.createWriteStream(tmp);
    const hash = crypto.createHash('sha1');
    let size = 0;
    let failed = false;
    const fail = (err) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.rm(tmp, { force: true }, () => reject(err));
    };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error('File too large');
        err.status = 413;
        req.destroy();
        return fail(err);
      }
      hash.update(chunk);
    });
    req.on('error', fail);
    out.on('error', fail);
    req.pipe(out);
    out.on('finish', () => {
      if (failed) return;
      if (size === 0) return fs.rm(tmp, { force: true }, () => resolve(null));
      const name = hash.digest('hex') + '.' + extForType(contentType);
      const target = path.join(FILES_DIR, name);
      if (fs.existsSync(target)) fs.rmSync(tmp, { force: true });
      else fs.renameSync(tmp, target);
      resolve('/api/files/' + name);
    });
  });
}

// Cards from older versions embed whole images as base64 data URLs.
// Pull every embedded image out into data/files so db.json stays small.
function extractDataUrls(value) {
  if (typeof value === 'string') {
    const m = value.length > 200 && /^data:([\w/+.-]+);base64,/.exec(value);
    if (!m) return value;
    return saveFileBuffer(Buffer.from(value.slice(m[0].length), 'base64'), m[1]);
  }
  if (Array.isArray(value)) return value.map(extractDataUrls);
  if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) value[k] = extractDataUrls(value[k]);
  }
  return value;
}

// Items only the server may write (team membership and roles go through /api/team).
function isProtected(storeName, key) {
  return storeName === 'settings' && key === 'team';
}

function applyOps(ops) {
  const applied = [];
  for (const op of ops || []) {
    if (!op || !STORE_NAME_RE.test(op.store) || op.key === undefined || op.key === null) continue;
    const key = String(op.key);
    if (isProtected(op.store, key)) continue;
    const store = db.stores[op.store] || (db.stores[op.store] = {});
    if (op.op === 'put' && op.item && typeof op.item === 'object') {
      const item = extractDataUrls(op.item);
      store[key] = item;
      applied.push({ op: 'put', store: op.store, key, item });
    } else if (op.op === 'delete') {
      delete store[key];
      applied.push({ op: 'delete', store: op.store, key });
    }
  }
  if (applied.length) scheduleSave();
  return applied;
}

function snapshot() {
  const out = {};
  for (const [name, store] of Object.entries(db.stores)) out[name] = Object.values(store);
  return out;
}

// ---- Live event stream --------------------------------------------------
const clients = new Set(); // { res, clientId }

function addClient(req, res, clientId) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  res.write('retry: 3000\n\n');
  const client = { res, clientId };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

function emit(message, exceptClientId) {
  const line = 'data: ' + JSON.stringify(message) + '\n\n';
  for (const c of clients) {
    if (c.clientId !== exceptClientId) c.res.write(line);
  }
}

// Keeps proxies and idle connections from closing the stream.
setInterval(() => {
  for (const c of clients) c.res.write(': ping\n\n');
}, 25000).unref();

function filePath(name) {
  return FILE_NAME_RE.test(name) ? path.join(FILES_DIR, name) : null;
}

function fileType(name) {
  return TYPE_BY_EXT[name.split('.').pop()] || 'application/octet-stream';
}

function flushNow() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeDbAtomically();
}

// ---- Daily backups ----------------------------------------------------------
// One copy of db.json per day in data/backups/, keeping the newest BACKUP_DAYS.
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_DAYS = 7;

function backupNow() {
  if (!fs.existsSync(DB_FILE)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const target = path.join(BACKUP_DIR, `db-${new Date().toISOString().slice(0, 10)}.json`);
  if (!fs.existsSync(target)) fs.copyFileSync(DB_FILE, target);
  fs.readdirSync(BACKUP_DIR)
    .filter(f => /^db-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .slice(0, -BACKUP_DAYS)
    .forEach(f => fs.rmSync(path.join(BACKUP_DIR, f), { force: true }));
}

function startBackups() {
  const run = () => {
    try { backupNow(); } catch (e) { console.error('Backup failed:', e.message); }
  };
  run();
  setInterval(run, 60 * 60 * 1000).unref(); // hourly check; copies once per day
}

function getItem(storeName, key) {
  return (db.stores[storeName] || {})[key];
}

// Server-side write that bypasses isProtected; tells every browser about it.
function putItemAsServer(storeName, key, item) {
  (db.stores[storeName] || (db.stores[storeName] = {}))[key] = item;
  scheduleSave();
  emit({ type: 'store', clientId: null, ops: [{ op: 'put', store: storeName, key, item }] });
}

// Secrets (owner PIN hash, session tokens) live outside `stores`, so they are
// never part of the snapshot sent to browsers.
function getPrivate() {
  return db.private || (db.private = {});
}

module.exports = {
  applyOps, snapshot, addClient, emit, saveFileBuffer, saveFileStream, filePath, fileType, flushNow,
  getItem, putItemAsServer, getPrivate, scheduleSave, startBackups
};
