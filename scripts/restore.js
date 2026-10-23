// Restore ListingFlow data: npm run restore -- <backup folder or db.json file>
// Accepts a folder made by `npm run backup`, a daily copy from data/backups/,
// or a pre-migration copy such as data/db.before-assetLibraryV1.json.
// Stop the server first. The current db.json is kept as db.json.before-restore-<time>.
const fs = require('fs');
const path = require('path');
const http = require('http');

const DATA_DIR = process.env.LISTINGFLOW_DATA_DIR || path.join(__dirname, '..', 'data');
const source = process.argv[2] ? path.resolve(process.argv[2]) : '';
if (!source || !fs.existsSync(source)) {
  console.error('Usage: npm run restore -- <backup folder or db.json file>');
  process.exit(1);
}

// Refuse while the server is running: it keeps data in memory and would overwrite the restore.
const probe = http.get({ host: '127.0.0.1', port: process.env.PORT || 3000, path: '/api/ai/status', timeout: 1500 }, () => {
  console.error('Stop the ListingFlow server first, then run the restore again.');
  process.exit(1);
});
probe.on('timeout', () => probe.destroy());
probe.on('error', restore);

function restore() {
  const isDir = fs.statSync(source).isDirectory();
  const dbSource = isDir ? path.join(source, 'db.json') : source;
  if (!fs.existsSync(dbSource)) { console.error(`No db.json in ${source}`); process.exit(1); }
  try { JSON.parse(fs.readFileSync(dbSource, 'utf8')); } catch (e) { console.error(`${dbSource} is not valid JSON; nothing was changed.`); process.exit(1); }

  fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });
  const current = path.join(DATA_DIR, 'db.json');
  if (fs.existsSync(current)) {
    const keep = path.join(DATA_DIR, `db.json.before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.copyFileSync(current, keep);
    console.log(`Kept the current data as ${path.basename(keep)}`);
  }
  fs.copyFileSync(dbSource, current);

  // Images are content-addressed and never change, so only missing ones are copied.
  let added = 0;
  const filesSource = isDir ? path.join(source, 'files') : null;
  if (filesSource && fs.existsSync(filesSource)) {
    for (const name of fs.readdirSync(filesSource)) {
      const target = path.join(DATA_DIR, 'files', name);
      if (!fs.existsSync(target)) { fs.copyFileSync(path.join(filesSource, name), target); added++; }
    }
  }
  console.log(`Restored ${path.relative(process.cwd(), dbSource)}${filesSource ? ` and ${added} missing image file(s)` : ''}. Start the server with "npm start".`);
}
