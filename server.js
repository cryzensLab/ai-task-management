const http = require('http');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const team = require('./team');

// Owner forgot the PIN: `npm run set-owner-pin -- 1234` sets a new one and signs out old owner sessions.
const pinArg = process.argv.indexOf('--set-owner-pin');
if (pinArg !== -1) {
  // A running server keeps the data in memory and would overwrite the new PIN.
  const probe = http.get({ host: '127.0.0.1', port: process.env.PORT || 3000, path: '/api/store', timeout: 1500 }, () => {
    console.error('Stop the ListingFlow server first, then run this command again.');
    process.exit(1);
  });
  probe.on('timeout', () => probe.destroy());
  probe.on('error', () => {
    try {
      if (!team.getTeam().ownerId) throw new Error('No owner has been set up yet; open the app to set one up.');
      team.setOwnerPin(process.argv[pinArg + 1]);
      store.flushNow();
      console.log('Owner PIN updated. Start the server again with "npm start".');
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });
}

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'index.html');

// JSON requests are small (the browser sends edits in chunks of about 8 MB);
// images are streamed to disk, so they can be bigger without using memory.
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = (await readBody(req, MAX_JSON_BYTES)).toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch (e) {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

// Every change needs a signed-in team member. Returns that member.
function requireMember(token) {
  const member = team.memberForToken(token);
  if (!member) throw new HttpError(401, 'Pick your name (top right) to make changes.');
  return member;
}

// People waiting for a role may only comment. Automatic work the browser does
// for everyone (tracker sync, cleanup) is marked `system` and is allowed for them.
function opAllowedFor(member, op) {
  if (member.role !== 'pending') return true;
  return op.store === 'comments' || op.system === true;
}

// Shared team data: snapshot, batched writes, image files and live events.
async function handleDataApi(req, res, reqPath, query) {
  if (reqPath === '/api/store' && req.method === 'GET') {
    return sendJson(res, 200, { stores: store.snapshot() });
  }

  if (reqPath === '/api/store/batch' && req.method === 'POST') {
    const body = await readJson(req);
    const member = requireMember(body.token || req.headers['x-session-token']);
    const ops = (Array.isArray(body.ops) ? body.ops : []).filter(op => op && opAllowedFor(member, op));
    const applied = store.applyOps(ops);
    if (applied.length) store.emit({ type: 'store', clientId: body.clientId, ops: applied }, body.clientId);
    // Return the stored items so the sender can pick up extracted image URLs.
    return sendJson(res, 200, { ok: true, applied: applied.length, ops: applied });
  }

  if (reqPath === '/api/files' && req.method === 'POST') {
    requireMember(req.headers['x-session-token']);
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_FILE_BYTES) throw new HttpError(413, 'File too large');
    const url = await store.saveFileStream(req, req.headers['content-type'], MAX_FILE_BYTES);
    if (!url) throw new HttpError(400, 'Empty file');
    return sendJson(res, 200, { url });
  }

  if (reqPath.startsWith('/api/files/') && (req.method === 'GET' || req.method === 'HEAD')) {
    const name = reqPath.slice('/api/files/'.length);
    const file = store.filePath(name);
    if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'File not found' });
    res.writeHead(200, {
      'Content-Type': store.fileType(name),
      'Cache-Control': 'public, max-age=31536000, immutable',
      // Uploaded files are shown as images only. The sandbox stops scripts inside
      // an uploaded SVG from running if someone opens the file directly.
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff'
    });
    return fs.createReadStream(file).pipe(res);
  }

  if (reqPath === '/api/events' && req.method === 'GET') {
    return store.addClient(req, res, String(query.get('clientId') || ''));
  }

  if (reqPath === '/api/broadcast' && req.method === 'POST') {
    const body = await readJson(req);
    requireMember(body.token);
    store.emit({ type: 'broadcast', clientId: body.clientId, action: body.action, payload: body.payload }, body.clientId);
    return sendJson(res, 200, { ok: true });
  }

  const teamRoute = /^\/api\/team\/([a-z-]+)$/.exec(reqPath);
  if (teamRoute && req.method === 'POST' && team.ROUTES[teamRoute[1]]) {
    const body = await readJson(req);
    return sendJson(res, 200, team.ROUTES[teamRoute[1]](body, { ip: clientIp(req) }));
  }

  return false;
}

function sendIndex(res) {
  fs.readFile(INDEX_FILE, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

function sendTracker(res) {
  const localTracker = path.join(ROOT, 'tracker.xlsx');
  if (!fs.existsSync(localTracker)) {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: 'tracker.xlsx not found' }));
  }
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="tracker.xlsx"',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(localTracker).pipe(res);
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, 'http://localhost');
  let reqPath;
  try {
    reqPath = decodeURIComponent(parsedUrl.pathname);
  } catch (e) {
    throw new HttpError(400, 'Bad URL');
  }

  if (/^\/api\/(store|files|events|broadcast|team)\b/.test(reqPath)) {
    const handled = await handleDataApi(req, res, reqPath, parsedUrl.searchParams);
    if (handled === false) sendJson(res, 404, { error: 'Unknown endpoint' });
    return;
  }

  // Production tracker export (serves the local tracker.xlsx).
  if (reqPath === '/api/tracker/export' || reqPath === '/api/drive/export') return sendTracker(res);

  if (reqPath.startsWith('/api/')) return sendJson(res, 404, { error: 'Unknown endpoint' });

  // The whole app is index.html. Nothing else in the project folder (data,
  // package files, .env, git internals) is ever served.
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    return res.end('405 Method Not Allowed');
  }
  return sendIndex(res);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch(err => {
    const status = err.status || 500; // HttpError and team.TeamError carry their own status
    if (status >= 500) console.error('Request error:', err);
    if (!res.headersSent) return sendJson(res, status, { error: status >= 500 ? 'Server error' : err.message });
    res.end();
  });
});

if (pinArg === -1) server.listen(PORT, () => {
  console.log(`ListingFlow server is running at http://localhost:${PORT}`);
  const nets = Object.values(require('os').networkInterfaces()).flat();
  nets.filter(n => n && n.family === 'IPv4' && !n.internal)
    .forEach(n => console.log(`  Team members on this network can open http://${n.address}:${PORT}`));
  store.startBackups();
});

function shutdown() {
  store.flushNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
