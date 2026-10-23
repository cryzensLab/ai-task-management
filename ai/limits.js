// Local request budget for the AI service. Free-tier quotas are limited and
// can change at any time, so the server never assumes unlimited requests.
// AI_MAX_REQUESTS_PER_MINUTE and AI_MAX_REQUESTS_PER_DAY set the budget; a
// rate-limit answer from the provider pauses all requests until it says so.

function createLimiter(env = process.env) {
  const perMinute = Math.max(1, Number(env.AI_MAX_REQUESTS_PER_MINUTE) || 5);
  const perDay = Math.max(1, Number(env.AI_MAX_REQUESTS_PER_DAY) || 100);
  let minuteStamps = [];
  let day = '';
  let usedToday = 0;
  let cooldownUntil = 0;

  function today() { return new Date().toISOString().slice(0, 10); }

  function refresh(now) {
    minuteStamps = minuteStamps.filter(t => now - t < 60000);
    if (day !== today()) { day = today(); usedToday = 0; }
  }

  // Returns null when a request may go ahead, otherwise the reason it may not.
  function check(now = Date.now()) {
    refresh(now);
    if (now < cooldownUntil) return { code: 'rate_limited', retryAfterSeconds: Math.ceil((cooldownUntil - now) / 1000), message: 'The AI service asked us to wait.' };
    if (usedToday >= perDay) return { code: 'rate_limited', retryAfterSeconds: null, message: `The daily AI budget (${perDay} requests) is used up.` };
    if (minuteStamps.length >= perMinute) return { code: 'rate_limited', retryAfterSeconds: Math.ceil((60000 - (now - minuteStamps[0])) / 1000), message: `Too many AI requests this minute (limit ${perMinute}).` };
    return null;
  }

  function record(now = Date.now()) {
    refresh(now);
    minuteStamps.push(now);
    usedToday++;
  }

  function pause(seconds) {
    cooldownUntil = Math.max(cooldownUntil, Date.now() + seconds * 1000);
  }

  function status() {
    refresh(Date.now());
    return { perMinute, perDay, usedToday, cooldownUntil: cooldownUntil > Date.now() ? new Date(cooldownUntil).toISOString() : null };
  }

  return { check, record, pause, status };
}

module.exports = { createLimiter };
