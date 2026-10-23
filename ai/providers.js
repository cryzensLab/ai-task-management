// AI providers for the Prompt Studio assistant.
// Every provider exposes the same small interface, so Prompt Studio never
// depends on a specific vendor:
//   { name, model, isConfigured(), generateJson({ system, input, schema, timeoutMs }) -> object }
// generateJson throws an AiError with a code the caller can act on:
//   not_configured | rate_limited | model_unavailable | timeout | bad_response | provider_error
// Credentials come only from server-side environment variables and are never
// logged or returned to the browser.

class AiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Gemini Developer API, Interactions endpoint with JSON-schema output.
// Default model: gemini-3.5-flash-lite (stable, has a free tier). Override with GEMINI_MODEL.
function geminiProvider(env) {
  const apiKey = env.GEMINI_API_KEY || '';
  const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
  const base = (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');

  const defaultTimeout = Math.max(1000, Number(env.AI_TIMEOUT_MS) || 20000);

  async function generateJson({ system, input, schema, timeoutMs = defaultTimeout }) {
    if (!apiKey) throw new AiError('not_configured', 'GEMINI_API_KEY is not set on the server.');
    let res;
    try {
      res = await fetch(`${base}/v1beta/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          model,
          system_instruction: system,
          input,
          store: false, // nothing is kept for later retrieval
          response_format: { type: 'text', mime_type: 'application/json', schema }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new AiError('timeout', 'The AI service did not answer in time.');
      throw new AiError('provider_error', 'Could not reach the AI service.');
    }

    let body = null;
    const raw = await res.text();
    try { body = raw ? JSON.parse(raw) : null; } catch (e) { body = null; }

    if (res.status === 429) {
      throw new AiError('rate_limited', 'The AI service rate limit was reached.', { retryAfterSeconds: retryAfter(res, body) });
    }
    if (res.status === 404 || (res.status === 400 && /model/i.test(errorMessage(body)))) {
      throw new AiError('model_unavailable', `The AI model "${model}" is not available.`);
    }
    if (res.status === 401 || res.status === 403) throw new AiError('provider_error', 'The AI service rejected the server credentials.');
    if (res.status >= 500) throw new AiError('provider_error', `The AI service had an error (${res.status}).`);
    if (!res.ok) throw new AiError('provider_error', `The AI service refused the request (${res.status}).`);

    const text = extractText(body);
    if (!text) throw new AiError('bad_response', 'The AI service returned no text.');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new AiError('bad_response', 'The AI service returned text that is not valid JSON.');
    }
  }

  return { name: 'gemini', model, isConfigured: () => Boolean(apiKey), generateJson };
}

// Text of the first model_output step: steps[].content[] with type "text".
function extractText(body) {
  const steps = (body && Array.isArray(body.steps)) ? body.steps : [];
  for (const step of steps) {
    if (step && step.type === 'model_output' && Array.isArray(step.content)) {
      const part = step.content.find(c => c && c.type === 'text' && typeof c.text === 'string');
      if (part) return part.text;
    }
  }
  return '';
}

function errorMessage(body) {
  return (body && body.error && (body.error.message || body.error.status)) || '';
}

function retryAfter(res, body) {
  const header = Number(res.headers.get('retry-after'));
  if (header > 0) return Math.min(header, 3600);
  // Google errors may carry a RetryInfo detail like { retryDelay: "37s" }.
  const details = (body && body.error && body.error.details) || [];
  for (const d of details) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec((d && d.retryDelay) || '');
    if (m) return Math.min(Math.ceil(Number(m[1])), 3600);
  }
  return 60;
}

const PROVIDERS = { gemini: geminiProvider };

function createProvider(env = process.env) {
  const name = (env.AI_PROVIDER || 'gemini').toLowerCase();
  const make = PROVIDERS[name];
  if (!make) throw new Error(`Unknown AI_PROVIDER "${name}". Supported: ${Object.keys(PROVIDERS).join(', ')}`);
  return make(env);
}

module.exports = { AiError, createProvider };
