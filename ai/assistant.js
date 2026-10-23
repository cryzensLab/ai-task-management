// Prompt Studio assistant: turns a request such as "use the navy striped polo,
// black flared denim and our three-quarter pose" into proposed configuration
// changes that point at real Asset Library ids.
// The AI service is optional. Without it (not configured, switched off, over
// budget or failing) the built-in matcher below answers instead, so Prompt
// Studio keeps working. Whatever answers, every id is checked against the
// library here; nothing unknown reaches the browser.
// Only text is sent to the AI service, never reference images.

const { AiError } = require('./providers');
const { validate, PROPOSAL_SCHEMA, REWORD_SCHEMA, SECTIONS } = require('./schema');

const DETAIL_FIELDS = ['garmentType', 'fit', 'colour', 'fabric', 'shoeType', 'accessoryType', 'material', 'poseGroup', 'framing', 'cameraAngle', 'lighting', 'background', 'genderPresentation'];

// Sections an asset may fill. Sunglasses can also go in the accessories list.
function sectionsForAsset(a) {
  switch (a.type) {
    case 'model': return ['model'];
    case 'top': return ['top'];
    case 'bottom': return ['bottom'];
    case 'shoes': return ['shoes'];
    case 'accessory': return a.accessoryType === 'Sunglasses' ? ['sunglasses', 'accessories'] : ['accessories'];
    case 'prop': return ['accessories'];
    case 'pose': return ['pose'];
    case 'style': return ['style'];
    case 'expression': return ['expression'];
    default: return [];
  }
}

// Text-only view of the library: what the assistant may choose from.
function buildCatalog(libraryItems) {
  return libraryItems
    .filter(a => a && a.id && !a.archived && sectionsForAsset(a).length)
    .map(a => {
      const details = {};
      DETAIL_FIELDS.forEach(k => { if (a[k] && a[k] !== 'Not specified') details[k] = String(a[k]).slice(0, 80); });
      return {
        id: a.id, type: a.type, name: String(a.name || '').slice(0, 120), code: String(a.code || '').slice(0, 40),
        aliases: (a.aliases || []).slice(0, 10), tags: (a.tags || []).slice(0, 10), details,
        hasImage: Boolean((a.images || []).length), sections: sectionsForAsset(a)
      };
    });
}

// ---- Built-in matcher ------------------------------------------------------------
const STOP = new Set(['the', 'and', 'with', 'our', 'saved', 'use', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'please', 'add', 'some', 'my']);
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const stem = (w) => w.replace(/(ing|ed|es|s)$/, '').replace(/e$/, '');
const tokens = (t) => norm(t).split(' ').filter(w => w && !STOP.has(w)).map(stem);

const SECTION_WORDS = {
  sunglasses: /\b(sunglass(es)?|shades|aviators?)\b/,
  shoes: /\b(boots?|sneakers?|shoes?|loafers?|trainers?|sandals?|heels)\b/,
  pose: /\bpose\b/,
  top: /\b(polo|shirt|tee|t shirt|henley|jacket|top|hoodie|sweater|overshirt|knit)\b/,
  bottom: /\b(jeans?|denim|trousers?|pants|shorts|joggers?|cargos?|chinos?|flares?)\b/,
  style: /\b(house style|studio|lighting|backdrop)\b/,
  expression: /\b(smile|smiling|expression|serious|neutral face)\b/,
  model: /\bmodel\b/
};

// 100+: the full name, code or alias appears; 50+: every word of it appears;
// 20+: most of its words appear (a loose match, used only if nothing better).
function matchStrength(item, msgNorm, msgTokens) {
  let best = 0;
  for (const label of [item.name, item.code, ...(item.aliases || [])]) {
    const n = norm(label);
    if (n.length >= 3 && (` ${msgNorm} `).includes(` ${n} `)) best = Math.max(best, 100 + n.length);
    const t = tokens(label).filter(w => w.length >= 3);
    const hits = t.filter(w => msgTokens.has(w)).length;
    if (t.length >= 2 && hits === t.length) best = Math.max(best, 50 + t.length);
    else if (hits >= 2 && hits / t.length >= 0.6) best = Math.max(best, 20 + hits);
  }
  return best;
}

// The clause of the message that mentions a word, e.g. "Chelsea boots".
function clauseWith(message, regex) {
  const parts = message.split(/,|;|\band\b|\bwith\b/i).map(s => s.trim()).filter(Boolean);
  const hit = parts.find(p => regex.test(p.toLowerCase()));
  return hit ? hit.replace(/^(use|add|wear|wearing|the|our|saved)\s+/i, '').slice(0, 200) : '';
}

function localResolve(message, catalog) {
  const msgNorm = norm(message);
  const msgTokens = new Set(tokens(message));
  const bySection = {};
  catalog.forEach(item => {
    const strength = matchStrength(item, msgNorm, msgTokens);
    if (!strength) return;
    // Sunglasses named directly go to the sunglasses section.
    const section = item.sections[0];
    (bySection[section] = bySection[section] || []).push({ item, strength });
  });

  const out = { reply: '', changes: [], clarifications: [], missing: [], conflicts: [] };
  const names = [];
  Object.entries(bySection).forEach(([section, hits]) => {
    hits.sort((a, b) => b.strength - a.strength);
    if (section === 'accessories') {
      hits.forEach(h => { out.changes.push({ section, action: 'add', assetId: h.item.id, text: '' }); names.push(h.item.name); });
      return;
    }
    // Two assets named outright are ambiguous; otherwise the strongest match wins.
    const exact = hits.filter(h => h.strength >= 100);
    const top = exact.length > 1 ? exact : hits.filter(h => h.strength === hits[0].strength);
    if (top.length === 1) {
      out.changes.push({ section, action: 'set', assetId: top[0].item.id, text: '' });
      names.push(top[0].item.name);
    } else {
      out.clarifications.push({ section, question: `Which ${section === 'accessories' ? 'item' : section} did you mean?`, optionIds: top.map(h => h.item.id) });
    }
  });

  // Words that name a kind of item but no saved asset.
  Object.entries(SECTION_WORDS).forEach(([section, regex]) => {
    if (!regex.test(msgNorm) || bySection[section]) return;
    const candidates = catalog.filter(c => c.sections.includes(section));
    if (section === 'sunglasses') {
      const sunglasses = candidates.filter(c => c.sections[0] === 'sunglasses');
      if (sunglasses.length === 1) { out.changes.push({ section, action: 'set', assetId: sunglasses[0].id, text: '' }); names.push(sunglasses[0].name); }
      else if (sunglasses.length > 1) out.clarifications.push({ section, question: 'Which sunglasses should the model wear?', optionIds: sunglasses.map(s => s.id) });
      else out.missing.push('There are no saved sunglasses. Add a reference image in the Sunglasses section or save some in the Asset Library.');
      return;
    }
    const phrase = clauseWith(message, regex);
    if (section === 'shoes' && phrase) {
      out.changes.push({ section, action: 'text', assetId: '', text: phrase });
      names.push(`shoes described as "${phrase}"`);
    } else if (section === 'top' || section === 'bottom') {
      out.missing.push(`No saved ${section} matches "${phrase || section}". Add it to the Asset Library, or choose "New product" and upload its photos.`);
    } else if (section === 'pose' && phrase) {
      out.missing.push(`No saved pose matches "${phrase}". Pick one from the library or describe it in the Pose section.`);
    }
  });

  out.reply = names.length
    ? `I matched: ${names.join(', ')}.`
    : 'I could not match anything in the Asset Library to that request.';
  if (out.clarifications.length) out.reply += ' Some names match more than one asset; please choose below.';
  return out;
}

// ---- Checking proposals ---------------------------------------------------------------
const ACTIONS_BY_SECTION = {
  accessories: ['add', 'remove', 'clear', 'text'],
  shoes: ['set', 'clear', 'text'],
  pose: ['set', 'clear', 'text'],
  expression: ['set', 'clear', 'text'],
  default: ['set', 'clear']
};

// Words in an AI "text" change must come from the user's message.
function textFromMessage(text, message) {
  const msg = new Set(tokens(message));
  const words = tokens(text).filter(w => w.length >= 3);
  if (!words.length) return false;
  return words.filter(w => msg.has(w)).length / words.length >= 0.6;
}

function checkProposal(raw, catalog, message) {
  const byId = new Map(catalog.map(c => [c.id, c]));
  const notes = [];
  const allowedFor = (section) => ACTIONS_BY_SECTION[section] || ACTIONS_BY_SECTION.default;
  const seen = new Set();
  const changes = [];
  (raw.changes || []).forEach(ch => {
    if (!SECTIONS.includes(ch.section) || !allowedFor(ch.section).includes(ch.action)) return notes.push(`Ignored an unsupported change to ${ch.section}.`);
    if (ch.action === 'set' || ch.action === 'add' || ch.action === 'remove') {
      const item = byId.get(ch.assetId);
      if (!item) return notes.push('Ignored a suggestion for an asset that is not in the library.');
      if (!item.sections.includes(ch.section)) return notes.push(`Ignored "${item.name}": it cannot be used as ${ch.section}.`);
    }
    if (ch.action === 'text' && !(ch.text && textFromMessage(ch.text, message))) return notes.push('Ignored a description that was not in your message.');
    const key = `${ch.section}|${ch.action}|${ch.assetId || ''}|${ch.text || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    changes.push({ section: ch.section, action: ch.action, assetId: ch.action === 'text' || ch.action === 'clear' ? '' : ch.assetId, text: ch.action === 'text' ? ch.text.trim() : '' });
  });
  const clarifications = (raw.clarifications || []).map(c => ({
    section: c.section,
    question: c.question,
    options: (c.optionIds || []).map(id => byId.get(id)).filter(item => item && item.sections.includes(c.section)).map(item => ({ assetId: item.id, label: (item.code ? item.code + ' · ' : '') + item.name }))
  })).filter(c => SECTIONS.includes(c.section) && c.options.length);
  return {
    reply: String(raw.reply || '').slice(0, 2000),
    changes,
    clarifications,
    missing: (raw.missing || []).map(String).slice(0, 10),
    conflicts: (raw.conflicts || []).map(String).slice(0, 10),
    notes
  };
}

// ---- AI calls ---------------------------------------------------------------------------
const ASSIST_SYSTEM = [
  'You help production staff configure an AI fashion product photo shoot in ListingFlow.',
  'You receive the user message, the current selection and a catalog of saved assets (text only).',
  'Rules:',
  '- Only use asset ids that appear in the catalog. Never invent products, ids, images or garment attributes.',
  '- An asset may only go in one of the sections listed in its "sections" field.',
  '- If a name could match more than one catalog asset, do not choose: add a clarification listing the candidate ids.',
  '- If the user asks for something that is not in the catalog, say so in "missing". Only use action "text" with words the user actually wrote (for shoes, pose, expression or a custom accessory).',
  '- Use action "add" for accessories and props, "set" for single-choice sections, "clear" to remove a section.',
  '- In "conflicts", explain contradictions between the request and the products\' details or the current selection. Do not resolve them yourself.',
  '- Keep "reply" short and factual.'
].join('\n');

function summarizeSelection(config, byId) {
  const c = config || {};
  const name = (id) => (byId.get(id) || {}).name || null;
  return {
    model: c.model && c.model.mode === 'saved' ? name(c.model.assetId) : (c.model && c.model.mode) || null,
    top: c.top && c.top.mode === 'saved' ? name(c.top.assetId) : (c.top && c.top.mode) || null,
    bottom: c.bottom && c.bottom.mode === 'saved' ? name(c.bottom.assetId) : (c.bottom && c.bottom.mode) || null,
    shoes: c.shoes && c.shoes.mode === 'saved' ? name(c.shoes.assetId) : (c.shoes && c.shoes.mode) || null,
    sunglasses: c.sunglasses && c.sunglasses.enabled ? (name(c.sunglasses.assetId) || 'yes') : 'no',
    accessories: ((c.accessories || [])).map(a => a.kind === 'saved' ? name(a.assetId) : 'custom item').filter(Boolean),
    pose: c.pose && c.pose.mode === 'saved' ? name(c.pose.assetId) : (c.pose && c.pose.mode) || null,
    style: c.style ? name(c.style.assetId) : null
  };
}

// Runs the assistant. Returns { proposal, source, provider, model, fallbackReason }.
async function assist({ message, config, libraryItems, provider, limiter, aiEnabled }) {
  const catalog = buildCatalog(libraryItems);
  const local = (reason) => ({ proposal: checkProposal(localResolve(message, catalog), catalog, message), source: 'local', fallbackReason: reason || null });

  if (!aiEnabled) return local(null);
  if (!provider.isConfigured()) return local('AI is not configured on the server.');
  const blocked = limiter.check();
  if (blocked) return local(blocked.message);

  limiter.record();
  try {
    const byId = new Map(catalog.map(c => [c.id, c]));
    const raw = await provider.generateJson({
      system: ASSIST_SYSTEM,
      input: JSON.stringify({ message, currentSelection: summarizeSelection(config, byId), catalog }),
      schema: PROPOSAL_SCHEMA
    });
    const errors = validate(raw, PROPOSAL_SCHEMA);
    if (errors.length) throw new AiError('bad_response', 'The AI answer did not match the expected format.');
    return { proposal: checkProposal(raw, catalog, message), source: 'ai', provider: provider.name, model: provider.model };
  } catch (err) {
    if (err.code === 'rate_limited') limiter.pause(err.retryAfterSeconds || 60);
    console.warn(`AI assistant fell back to the built-in matcher: ${err.code || 'error'}`);
    return local(err instanceof AiError ? err.message : 'The AI service failed.');
  }
}

// ---- Rewording ------------------------------------------------------------------------------
const REWORD_SYSTEM = [
  'You improve the wording of sections of an image-generation prompt for a fashion product photo.',
  'For each section, rewrite the connecting words so it reads clearly and naturally.',
  'Every phrase listed in "locked" must appear in your text exactly, character for character.',
  'Do not add, remove or change any facts, attributes, colours, measurements, names or image numbers. Do not mention images that are not already mentioned.',
  'Return every section you were given, with the same key.'
].join('\n');

const imageRefs = (text) => (String(text).match(/\bImages? \d+(?:[–-]\d+)?\b/g) || []).sort().join('|');

async function reword({ sections, provider, limiter, aiEnabled }) {
  if (!aiEnabled) throw new AiError('not_configured', 'The AI assistant is switched off.');
  if (!provider.isConfigured()) throw new AiError('not_configured', 'AI is not configured on the server.');
  const blocked = limiter.check();
  if (blocked) throw new AiError('rate_limited', blocked.message, { retryAfterSeconds: blocked.retryAfterSeconds });
  limiter.record();
  let raw;
  try {
    raw = await provider.generateJson({ system: REWORD_SYSTEM, input: JSON.stringify({ sections }), schema: REWORD_SCHEMA });
  } catch (err) {
    if (err.code === 'rate_limited') limiter.pause(err.retryAfterSeconds || 60);
    throw err;
  }
  if (validate(raw, REWORD_SCHEMA).length) throw new AiError('bad_response', 'The AI answer did not match the expected format.');
  const byKey = new Map(raw.sections.map(s => [s.key, s.text]));
  // A rewritten section is only used if every locked fact and image number is intact.
  return sections.map(s => {
    const text = byKey.get(s.key);
    if (typeof text !== 'string' || !text.trim()) return { key: s.key, text: s.text, accepted: false, reason: 'missing from the AI answer' };
    const lost = (s.locked || []).filter(l => !text.includes(l));
    if (lost.length) return { key: s.key, text: s.text, accepted: false, reason: 'changed a locked fact' };
    if (imageRefs(text) !== imageRefs(s.text)) return { key: s.key, text: s.text, accepted: false, reason: 'changed the image numbering' };
    if (text.length > s.text.length * 2 + 200) return { key: s.key, text: s.text, accepted: false, reason: 'added too much text' };
    return { key: s.key, text, accepted: true };
  });
}

module.exports = { assist, reword, buildCatalog, localResolve, checkProposal };
