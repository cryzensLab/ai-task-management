// Who may write what. The browser hides actions people can't take, but these
// checks are the real rules: every change the server stores passes through
// opAllowed(). They follow the existing roles (owner, admin, reviewer, creator,
// pending) rather than adding a second permission system.
//
//   creator   makes images, builds Prompt Studio setups, links products,
//             adds assets and proposes presets; moves own work to QC
//   reviewer  inspects setups and prompts, gives QC feedback, passes QC or
//             requests changes, proposes presets
//   admin     everything above plus shared assets, prompt templates, presets,
//             categories and the AI switch
//   owner     like admin, and manages people and roles (team.js)
//   pending   comments only (plus automatic work such as the sheet sync)

const store = require('./store');
const team = require('./team');

const isAdmin = (m) => m.role === 'admin' || m.role === 'owner';
const canConfigure = (m) => m.role === 'creator' || isAdmin(m);
const canReview = (m) => m.role === 'reviewer' || isAdmin(m);

// True when `next` differs from `prev` only in the listed fields.
function onlyChanged(prev, next, allowed) {
  const strip = (o) => {
    const copy = { ...(o || {}) };
    allowed.forEach(k => delete copy[k]);
    return JSON.stringify(Object.keys(copy).sort().map(k => [k, copy[k]]));
  };
  return strip(prev) === strip(next);
}

// Usage counts and favourites change as people work; they are not edits.
const ASSET_ACTIVITY_FIELDS = ['usageCount', 'lastUsedAt', 'favouredBy', 'updatedAt'];
const PRESET_ACTIVITY_FIELDS = ['favouredBy', 'updatedAt', 'updatedBy'];

function libraryAllowed(member, op, existing) {
  if (op.op === 'delete') return isAdmin(member);
  if (!existing) return canConfigure(member); // adding a new asset
  if (isAdmin(member) || existing.createdBy === member.id) return true;
  return onlyChanged(existing, op.item, ASSET_ACTIVITY_FIELDS);
}

// Presets: admins manage them. Others may propose a candidate (and change or
// withdraw their own candidate); approving one is an admin decision.
function presetAllowed(member, op, existing) {
  if (isAdmin(member)) return true;
  if (op.op === 'delete') return Boolean(existing && existing.status === 'candidate' && existing.createdBy === member.id);
  if (!existing) {
    return (canConfigure(member) || canReview(member)) && op.item.status === 'candidate' && op.item.createdBy === member.id;
  }
  if (existing.status === 'candidate' && existing.createdBy === member.id && op.item.status === 'candidate') return true;
  return onlyChanged(existing, op.item, PRESET_ACTIVITY_FIELDS);
}

// Stage moves on the board follow the QC rules in the browser.
function cardAllowed(member, op, existing) {
  if (op.op === 'delete' || !existing || !op.item) return true;
  const to = op.item.stage;
  if (!to || to === existing.stage) return true;
  if (to === 'Passed QC') {
    if (!canReview(member)) return false;
    const rules = team.getTeam();
    if (rules.creatorCannotPassOwnWork && existing.createdBy === member.id && !isAdmin(member)) return false;
    const outputs = op.item.outputs || [];
    return outputs.length > 0 && outputs.every(o => o && o.status === 'approved');
  }
  if (to === 'Changes requested') return canReview(member);
  if (to === 'Delivered') {
    if (existing.stage === 'Passed QC' || isAdmin(member)) return true;
    // The tracker sync moves rows marked Completed in the sheet.
    return op.system === true && String(op.item.sheetStatus || '').trim().toLowerCase() === 'completed';
  }
  return true;
}

function opAllowed(member, op) {
  const key = String(op.key);
  const existing = op.store ? store.getItem(op.store, key) : null;

  // Shared configuration.
  if (op.store === 'settings' && (key === 'assetCategories' || key === 'aiSettings')) return isAdmin(member);
  if (op.store === 'prompt_templates') return isAdmin(member);
  if (op.store === 'libraries') return libraryAllowed(member, op, existing);
  if (op.store === 'outfit_presets') return presetAllowed(member, op, existing);

  // Prompt Studio setups and product links: creators and admins. A finalized
  // setup is a historical record that nobody may change or delete.
  if (op.store === 'shoots') return canConfigure(member) && !(existing && existing.status === 'final');
  if (op.store === 'product_links') return canConfigure(member);

  if (op.store === 'cards' && !cardAllowed(member, op, existing)) return false;

  if (member.role !== 'pending') return true;
  return op.store === 'comments' || op.system === true;
}

module.exports = { opAllowed, isAdmin, canConfigure, canReview };
