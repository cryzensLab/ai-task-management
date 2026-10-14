const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
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

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const MAX_BODY_BYTES = 300 * 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

// Shared team data: snapshot, batched writes, image files and live events.
async function handleDataApi(req, res, reqPath, query) {
  if (reqPath === '/api/store' && req.method === 'GET') {
    return sendJson(res, 200, { stores: store.snapshot() });
  }

  if (reqPath === '/api/store/batch' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const applied = store.applyOps(body.ops);
    if (applied.length) store.emit({ type: 'store', clientId: body.clientId, ops: applied }, body.clientId);
    // Return the stored items so the sender can pick up extracted image URLs.
    return sendJson(res, 200, { ok: true, applied: applied.length, ops: applied });
  }

  if (reqPath === '/api/files' && req.method === 'POST') {
    const buf = await readBody(req);
    if (!buf.length) return sendJson(res, 400, { error: 'Empty file' });
    return sendJson(res, 200, { url: store.saveFileBuffer(buf, req.headers['content-type']) });
  }

  if (reqPath.startsWith('/api/files/') && req.method === 'GET') {
    const name = reqPath.slice('/api/files/'.length);
    const file = store.filePath(name);
    if (!file || !fs.existsSync(file)) return sendJson(res, 404, { error: 'File not found' });
    res.writeHead(200, { 'Content-Type': store.fileType(name), 'Cache-Control': 'public, max-age=31536000, immutable' });
    return fs.createReadStream(file).pipe(res);
  }

  if (reqPath === '/api/events' && req.method === 'GET') {
    return store.addClient(req, res, String(query.clientId || ''));
  }

  if (reqPath === '/api/broadcast' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    store.emit({ type: 'broadcast', clientId: body.clientId, action: body.action, payload: body.payload }, body.clientId);
    return sendJson(res, 200, { ok: true });
  }

  const teamRoute = /^\/api\/team\/([a-z-]+)$/.exec(reqPath);
  if (teamRoute && req.method === 'POST' && team.ROUTES[teamRoute[1]]) {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    try {
      return sendJson(res, 200, team.ROUTES[teamRoute[1]](body));
    } catch (err) {
      if (err instanceof team.TeamError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  let reqPath = decodeURI(parsedUrl.pathname);

  if (/^\/api\/(store|files|events|broadcast|team)\b/.test(reqPath)) {
    try {
      const handled = await handleDataApi(req, res, reqPath, parsedUrl.query);
      if (handled !== false) return;
      return sendJson(res, 404, { error: 'Unknown endpoint' });
    } catch (err) {
      console.error('Data API error:', err);
      if (!res.headersSent) return sendJson(res, 500, { error: err.message });
      return res.end();
    }
  }

  // Never serve the database, git internals or dependencies as static files.
  if (/^\/(data|\.git|node_modules)(\/|$)/i.test(reqPath) || /^\/(store|server|team)\.js$/i.test(reqPath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  // 1. Production Tracker Export Endpoint (serves local tracker.xlsx)
  if (reqPath === '/api/tracker/export' || reqPath === '/api/drive/export') {
    const localTracker = path.join(ROOT, 'tracker.xlsx');
    if (fs.existsSync(localTracker)) {
      const buf = fs.readFileSync(localTracker);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="tracker.xlsx"',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache'
      });
      return res.end(buf);
    }
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ error: 'tracker.xlsx not found' }));
  }

  // 2. Static File Server
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const safePath = path.normalize(path.join(ROOT, reqPath));
  if (!safePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  fs.stat(safePath, (err, stats) => {
    if (err) {
      const indexPath = path.join(ROOT, 'index.html');
      fs.readFile(indexPath, (indexErr, content) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    if (stats.isDirectory()) {
      const indexPath = path.join(safePath, 'index.html');
      fs.readFile(indexPath, (indexErr, content) => {
        if (indexErr) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(safePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(safePath, (readErr, data) => {
      if (readErr) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('500 Internal Server Error');
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });
});

if (pinArg === -1) server.listen(PORT, () => {
  console.log(`ListingFlow server is running at http://localhost:${PORT}`);
  const nets = Object.values(require('os').networkInterfaces()).flat();
  nets.filter(n => n && n.family === 'IPv4' && !n.internal)
    .forEach(n => console.log(`  Team members on this network can open http://${n.address}:${PORT}`));
});

function shutdown() {
  store.flushNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
