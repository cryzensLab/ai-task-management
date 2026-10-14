// Team membership and roles.
// People identify themselves by picking a name; only the owner (protected by a
// PIN) can assign roles or accept role requests. The team lives in the shared
// store as settings/team so every browser sees it, but only this module writes it.

const crypto = require('crypto');
const store = require('./store');

const ROLES = ['creator', 'reviewer', 'admin'];
const DEMO_MEMBER_IDS = ['user_alex', 'user_taylor', 'user_jordan'];
const COLORS = ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#ec4899', '#14b8a6', '#f97316', '#64748b'];
const MAX_NAME_LENGTH = 40;

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

// ---- Owner PIN and session tokens ------------------------------------------
function hashPin(pin, salt) {
  return crypto.scryptSync(String(pin), salt, 32).toString('hex');
}

function cleanPin(pin) {
  const p = String(pin || '');
  if (!/^\d{4,12}$/.test(p)) throw new TeamError(400, 'The PIN must be 4 to 12 digits.');
  return p;
}

function setOwnerPin(pin) {
  const priv = store.getPrivate();
  priv.ownerPinSalt = crypto.randomBytes(16).toString('hex');
  priv.ownerPinHash = hashPin(cleanPin(pin), priv.ownerPinSalt);
  priv.ownerTokens = []; // a new PIN signs out every owner session
  store.scheduleSave();
}

function issueOwnerToken() {
  const priv = store.getPrivate();
  const token = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  priv.ownerTokens = [hash, ...(priv.ownerTokens || [])].slice(0, 10);
  store.scheduleSave();
  return token;
}

function isValidOwnerToken(token) {
  if (!token || typeof token !== 'string') return false;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return (store.getPrivate().ownerTokens || []).includes(hash);
}

// Slow down PIN guessing: 5 wrong attempts lock owner sign-in for 60 seconds.
const pinAttempts = { failures: 0, lockedUntil: 0 };

function verifyPin(pin) {
  const now = Date.now();
  if (now < pinAttempts.lockedUntil) {
    throw new TeamError(429, `Too many wrong PINs. Try again in ${Math.ceil((pinAttempts.lockedUntil - now) / 1000)} seconds.`);
  }
  const priv = store.getPrivate();
  const ok = priv.ownerPinHash && crypto.timingSafeEqual(
    Buffer.from(hashPin(String(pin || ''), priv.ownerPinSalt), 'hex'),
    Buffer.from(priv.ownerPinHash, 'hex')
  );
  if (!ok) {
    pinAttempts.failures++;
    if (pinAttempts.failures >= 5) {
      pinAttempts.failures = 0;
      pinAttempts.lockedUntil = now + 60 * 1000;
    }
    throw new TeamError(403, 'Wrong PIN.');
  }
  pinAttempts.failures = 0;
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
  team.members[owner.id] = owner;
  team.ownerId = owner.id;
  setOwnerPin(pin);
  saveTeam(team);
  return { member: owner, token: issueOwnerToken() };
}

function ownerLogin({ pin }) {
  const team = getTeam();
  if (!team.ownerId) throw new TeamError(409, 'No owner has been set up yet.');
  verifyPin(pin);
  return { member: team.members[team.ownerId], token: issueOwnerToken() };
}

// New people join as "pending" with the role they asked for; the owner decides.
function join({ name, requestedRole }) {
  const team = getTeam();
  if (!team.ownerId) throw new TeamError(409, 'The owner has to set up the team first.');
  const cleanedName = cleanName(name);
  assertNameFree(team, cleanedName);
  const member = newMember(team, cleanedName, 'pending');
  member.requestedRole = cleanRole(requestedRole);
  member.requestedAt = new Date().toISOString();
  team.members[member.id] = member;
  saveTeam(team);
  return { member };
}

function requestRole({ memberId, role }) {
  const team = getTeam();
  const member = team.members[memberId];
  if (!member) throw new TeamError(404, 'Team member not found.');
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
    case 'remove':
      if (isOwner) throw new TeamError(400, "The owner can't be removed.");
      delete team.members[member.id];
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
  return { token: issueOwnerToken() };
}

// Routes: POST /api/team/<name>
const ROUTES = {
  'claim-owner': claimOwner,
  'owner-login': ownerLogin,
  'join': join,
  'request-role': requestRole,
  'owner-action': ownerAction,
  'change-pin': changeOwnerPin,
  'check-token': ({ token }) => ({ valid: isValidOwnerToken(token) })
};

module.exports = { ROUTES, TeamError, setOwnerPin, getTeam };
