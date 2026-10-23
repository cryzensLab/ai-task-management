// Full backup of ListingFlow data: npm run backup [-- <destination folder>]
// Copies data/db.json (cards, Asset Library, Prompt Studio, team) and every
// uploaded image in data/files into a dated folder. Safe while the server runs:
// the server only ever replaces db.json in one atomic step, and image files
// are never changed once written.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.LISTINGFLOW_DATA_DIR || path.join(__dirname, '..', 'data');
const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
const dest = path.resolve(process.argv[2] || path.join(__dirname, '..', 'backups'), `listingflow-${stamp}`);

if (!fs.existsSync(path.join(DATA_DIR, 'db.json'))) {
  console.error(`No data found at ${DATA_DIR}. Nothing to back up.`);
  process.exit(1);
}

fs.mkdirSync(path.join(dest, 'files'), { recursive: true });
fs.copyFileSync(path.join(DATA_DIR, 'db.json'), path.join(dest, 'db.json'));
let files = 0;
const filesDir = path.join(DATA_DIR, 'files');
if (fs.existsSync(filesDir)) {
  for (const name of fs.readdirSync(filesDir)) {
    if (name.startsWith('.')) continue; // unfinished uploads
    fs.copyFileSync(path.join(filesDir, name), path.join(dest, 'files', name));
    files++;
  }
}
console.log(`Backed up db.json and ${files} image file(s) to ${dest}`);
