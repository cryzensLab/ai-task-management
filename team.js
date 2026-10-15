// Team membership and roles.
// People sign in by picking their name and entering their own PIN; only the
// owner can assign roles or accept role requests. The team lives in the shared
// store as settings/team so every browser sees it, but only this module writes it.
// Each sign-in gets a session token, and the server checks it on every change.

const crypto = require('crypto');
const store = require('./store');

const ROLES = ['creator', 'reviewer', 'admin'];
const DEMO_MEMBER_IDS = ['user_alex', 'user_taylor', 'user_jordan'];
// Muted, print-like avatar colours that read on light and dark backgrounds.
const COLORS = ['#3f5a4a', '#8a4b2e', '#4a5578', '#7a6a3a', '#6b4060', '#2f6670', '#7d3b3b', '#5a5a52', '#46607e', '#6e5a3e'];
const MAX_NAME_LENGTH = 40;
const MAX_SESSIONS_PER_MEMBER = 10;

class TeamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function getTeam() {
  const rec = store.getItem('settings', 'team');
  const team = rec && rec.value ? JSON.parse(JSON.stringify(rec.value)) : {};
  if (!team.members) team.members = {};
  if (team.creatorCannotPassOwnWork === undefined) team.creatorCannotPassOwnWork = true;
  return team;
}

function saveTeam(team) {
  store.putItemAsServer('settings', 'team', { key: 'team', value: team });
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw new TeamError(400, 'Please enter your name.');
  if (n.length > MAX_NAME_LENGTH) throw new TeamError(400, `Names can be at most ${MAX_NAME_LENGTH} characters.`);
  return n;
}

function cleanRole(role) {
  if (!ROLES.includes(role)) throw new TeamError(400, 'Unknown role.');
  return role;
}

function assertNameFree(team, name, exceptId) {
  const taken = Object.values(team.members).some(m => m.id !== exceptId && m.name.toLowerCase() === name.toLowerCase());
  if (taken) throw new TeamError(409, `"${name}" is already on the team. Pick it from the list instead.`);
}

function newMember(team, name, role) {
  const id = 'user_' + crypto.randomBytes(6).toString('hex');
  const color = COLORS[Object.keys(team.members).length % COLORS.length];
  return { id, name, role, color, createdAt: new Date().toISOString() };
}

// ---- PINs ------------------------------------------------------------------
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function cleanPin(pin) {
  const p = String(pin || '');
  if (!/^\d{4,12}$/.test(p)) throw new TeamError(400, 'The PIN must be 4 to 12 digits.');
  return p;
}

function newPinRecord(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPin(cleanPin(pin), salt) };
}

function pinMatches(record, pin) {
  if (!record || !record.hash) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hashPin(String(pin || ''), record.salt), 'hex'),
    Buffer.from(record.hash, 'hex')
  );
}

function ownerPinRecord() {
  const priv = store.getPrivate();
  return { salt: priv.ownerPinSalt, hash: priv.ownerPinHash };
}

function memberPins() {
  const priv = store.getPrivate();
  return priv.memberPins || (priv.memberPins = {});
}

// Slow down PIN guessing: 5 wrong attempts from one device lock sign-in for that
// person on that device for 60 seconds. Other devices are not affected, so a
// stranger guessing cannot lock the real person out.
const pinAttempts = new Map(); // `${ip}|${memberId}` -> { failures, lockedUntil }

function checkPin(record, pin, lockKey) {
  const now = Date.now();
  const entry = pinAttempts.get(lockKey) || { failures: 0, lockedUntil: 0 };
  if (now < entry.lockedUntil) {
    throw new TeamError(429, `Too many wrong PINs. Try again in ${Math.ceil((entry.lockedUntil - now) / 1000)} seconds.`);
  }
  if (!pinMatches(record, pin)) {
    entry.failures++;
    if (entry.failures >= 5) {
      entry.failures = 0;
      entry.lockedUntil = now + 60 * 1000;
    }
    pinAttempts.set(lockKey, entry);
    throw new TeamError(403, 'Wrong PIN.');
  }
  pinAttempts.delete(lockKey);
}

// Forget old lock entries so the map cannot grow without limit.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pinAttempts) {
    if (entry.lockedUntil < now - 60 * 1000) pinAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

// ---- Session tokens ----------------------------------------------------------
// Stored as sha256 hashes in the private part of the database, never sent to browsers.
function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessions() {
  const priv = store.getPrivate();
  if (!priv.sessions) {
    priv.sessions = {};
    // Owner sign-ins from before member sessions existed stay valid.
    const ownerId = getTeam().ownerId;
    if (ownerId) (priv.ownerTokens || []).forEach(hash => { priv.sessions[hash] = ownerId; });
    delete priv.ownerTokens;
  }
  return priv.sessions;
}

function issueToken(memberId) {
  const all = sessions();
  const token = crypto.randomBytes(32).toString('hex');
  all[tokenHash(token)] = memberId;
  // Keep only the newest sessions for this person (objects keep insertion order).
  const mine = Object.keys(all).filter(h => all[h] === memberId);
  mine.slice(0, -MAX_SESSIONS_PER_MEMBER).forEach(h => delete all[h]);
  store.scheduleSave();
  return token;
}

function revokeSessions(memberId) {
  const all = sessions();
  Object.keys(all).filter(h => all[h] === memberId).forEach(h => delete all[h]);
  store.scheduleSave();
}

// The team member a session token belongs to, or null.
function memberForToken(token) {
  if (!token || typeof token !== 'string') return null;
  const memberId = sessions()[tokenHash(token)];
  return memberId ? getTeam().members[memberId] || null : null;
}

function isValidOwnerToken(token) {
  const member = memberForToken(token);
  return Boolean(member && member.id === getTeam().ownerId);
}

function requireSession(token) {
  const member = memberForToken(token);
  if (!member) throw new TeamError(401, 'Please sign in again.');
  return member;
}

function setOwnerPin(pin) {
  const priv = store.getPrivate();
  const record = newPinRecord(pin);
  priv.ownerPinSalt = record.salt;
  priv.ownerPinHash = record.hash;
  const ownerId = getTeam().ownerId;
  if (ownerId) revokeSessions(ownerId); // a new PIN signs out every owner session
  store.scheduleSave();
}

// ---- Actions -----------------------------------------------------------------
// First person to set up the app becomes the owner.
function claimOwner({ name, pin }) {
  const team = getTeam();
  if (team.ownerId) throw new TeamError(409, 'This team already has an owner.');
  const cleanedName = cleanName(name);
  cleanPin(pin);
  // Drop the placeholder people that shipped with the app.
  DEMO_MEMBER_IDS.forEach(id => delete team.members[id]);
  assertNameFree(team, cleanedName);
  const owner = newMember(team, cleanedName, 'owner');
  owner.hasPin = true;
  team.members[owner.id] = owner;
  team.ownerId = owner.id;
  saveTeam(team);
  setOwnerPin(pin);
  return { member: owner, token: issueToken(owner.id) };
}

function ownerLogin({ pin }, ctx) {
  const team = getTeam();
  if (!team.ownerId) throw new TeamError(409, 'No owner has been set up yet.');
  checkPin(ownerPinRecord(), pin, `${ctx.ip}|${team.ownerId}`);
  return { member: team.members[team.ownerId], token: issueToken(team.ownerId) };
}

// New people join as "pending" with the role they asked for; the owner decides.
function join({ name, requestedRole, pin }) {
  const team = getTeam();
  if (!team.ownerId) throw new TeamError(409, 'The owner has to set up the team first.');
  const cleanedName = cleanName(name);
  assertNameFree(team, cleanedName);
  const pinRecord = newPinRecord(pin);
  const member = newMember(team, cleanedName, 'pending');
  member.requestedRole = cleanRole(requestedRole);
  member.requestedAt = new Date().toISOString();
  member.hasPin = true;
  memberPins()[member.id] = pinRecord;
  team.members[member.id] = member;
  saveTeam(team);
  return { member, token: issueToken(member.id) };
}

// Sign in as an existing (non-owner) member. Someone without a PIN yet (they
// joined before PINs existed, or the owner reset it) chooses one now.
function memberLogin({ memberId, pin }, ctx) {
  const team = getTeam();
  const member = team.members[memberId];
  if (!member) throw new TeamError(404, 'Team member not found.');
  if (member.id === team.ownerId) return ownerLogin({ pin }, ctx);
  const pins = memberPins();
  if (!pins[member.id]) {
    pins[member.id] = newPinRecord(pin);
    member.hasPin = true;
    saveTeam(team);
  } else {
    checkPin(pins[member.id], pin, `${ctx.ip}|${member.id}`);
  }
  return { member, token: issueToken(member.id) };
}

function requestRole({ token, role }) {
  const team = getTeam();
  const member = team.members[requireSession(token).id];
  if (member.role === 'owner') throw new TeamError(400, 'The owner already has full access.');
  const wanted = cleanRole(role);
  if (wanted === member.role) {
    delete member.requestedRole;
    delete member.requestedAt;
  } else {
    member.requestedRole = wanted;
    member.requestedAt = new Date().toISOString();
  }
  saveTeam(team);
  return { member };
}

function changeMyPin({ token, newPin }) {
  const me = requireSession(token);
  if (me.id === getTeam().ownerId) return changeOwnerPin({ token, newPin });
  memberPins()[me.id] = newPinRecord(newPin);
  revokeSessions(me.id);
  return { token: issueToken(me.id) };
}

function ownerAction({ token, action, memberId, role, value, name }) {
  if (!isValidOwnerToken(token)) throw new TeamError(403, 'Only the owner can do this. Sign in as the owner again.');
  const team = getTeam();

  if (action === 'set-rule') {
    team.creatorCannotPassOwnWork = Boolean(value);
    saveTeam(team);
    return { team };
  }

  const member = team.members[memberId];
  if (!member) throw new TeamError(404, 'Team member not found.');
  const isOwner = member.id === team.ownerId;

  switch (action) {
    case 'accept-request':
      if (!member.requestedRole) throw new TeamError(400, 'There is no pending request for this person.');
      member.role = member.requestedRole;
      delete member.requestedRole;
      delete member.requestedAt;
      break;
    case 'decline-request':
      delete member.requestedRole;
      delete member.requestedAt;
      break;
    case 'set-role':
      if (isOwner) throw new TeamError(400, "The owner's role can't be changed.");
      member.role = cleanRole(role);
      delete member.requestedRole;
      delete member.requestedAt;
      break;
    case 'rename': {
      const cleanedName = cleanName(name);
      assertNameFree(team, cleanedName, member.id);
      member.name = cleanedName;
      break;
    }
    case 'reset-pin':
      // They choose a new PIN the next time they pick their name.
      if (isOwner) throw new TeamError(400, 'Change the owner PIN from your profile instead.');
      delete memberPins()[member.id];
      member.hasPin = false;
      revokeSessions(member.id);
      break;
    case 'remove':
      if (isOwner) throw new TeamError(400, "The owner can't be removed.");
      delete team.members[member.id];
      delete memberPins()[member.id];
      revokeSessions(member.id);
      break;
    default:
      throw new TeamError(400, 'Unknown action.');
  }
  saveTeam(team);
  return { team };
}

function changeOwnerPin({ token, newPin }) {
  if (!isValidOwnerToken(token)) throw new TeamError(403, 'Only the owner can do this.');
  setOwnerPin(newPin);
  return { token: issueToken(getTeam().ownerId) };
}

// Routes: POST /api/team/<name>, called as handler(body, { ip })
const ROUTES = {
  'claim-owner': claimOwner,
  'owner-login': ownerLogin,
  'member-login': memberLogin,
  'join': join,
  'request-role': requestRole,
  'owner-action': ownerAction,
  'change-pin': changeOwnerPin,
  'change-my-pin': changeMyPin,
  'check-token': ({ token }) => {
    const member = memberForToken(token);
    return { valid: Boolean(member), memberId: member ? member.id : null };
  }
};

module.exports = { ROUTES, TeamError, setOwnerPin, getTeam, memberForToken };
