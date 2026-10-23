// A small JSON-schema checker for AI output. The AI service is asked for this
// schema, but its answer is still checked here before anything uses it.
// Supports: type (object/array/string/number/integer/boolean), properties,
// required, items, enum, maxItems, maxLength.

function validate(value, schema, path = '$') {
  const errors = [];
  check(value, schema, path, errors);
  return errors;
}

function check(value, schema, path, errors) {
  if (!schema) return;
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return errors.push(`${path} should be an object`);
    (schema.required || []).forEach(k => { if (!(k in value)) errors.push(`${path}.${k} is missing`); });
    Object.entries(schema.properties || {}).forEach(([k, sub]) => { if (k in value) check(value[k], sub, `${path}.${k}`, errors); });
  } else if (type === 'array') {
    if (!Array.isArray(value)) return errors.push(`${path} should be an array`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path} has too many items`);
    value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`, errors));
  } else if (type === 'string') {
    if (typeof value !== 'string') return errors.push(`${path} should be a string`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path} is too long`);
    if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} has an unexpected value`);
  } else if (type === 'number' || type === 'integer') {
    if (typeof value !== 'number' || (type === 'integer' && !Number.isInteger(value))) errors.push(`${path} should be a ${type}`);
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path} should be a boolean`);
  }
}

const SECTIONS = ['model', 'sunglasses', 'expression', 'top', 'bottom', 'shoes', 'accessories', 'pose', 'style'];

// What the assistant must return.
const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', maxLength: 2000, description: 'Short answer to the user in plain language.' },
    changes: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: SECTIONS },
          action: { type: 'string', enum: ['set', 'add', 'remove', 'clear', 'text'] },
          assetId: { type: 'string', description: 'An id from the catalog, or empty.' },
          text: { type: 'string', maxLength: 500, description: 'Words taken from the user message, only for action "text".' }
        },
        required: ['section', 'action', 'assetId', 'text']
      }
    },
    clarifications: {
      type: 'array', maxItems: 10,
      items: {
        type: 'object',
        properties: {
          section: { type: 'string', enum: SECTIONS },
          question: { type: 'string', maxLength: 300 },
          optionIds: { type: 'array', maxItems: 10, items: { type: 'string' } }
        },
        required: ['section', 'question', 'optionIds']
      }
    },
    missing: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
    conflicts: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 400 } }
  },
  required: ['reply', 'changes', 'clarifications', 'missing', 'conflicts']
};

// What the wording rewrite must return.
const REWORD_SCHEMA = {
  type: 'object',
  properties: {
    sections: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object',
        properties: { key: { type: 'string', maxLength: 40 }, text: { type: 'string', maxLength: 6000 } },
        required: ['key', 'text']
      }
    }
  },
  required: ['sections']
};

module.exports = { validate, PROPOSAL_SCHEMA, REWORD_SCHEMA, SECTIONS };
