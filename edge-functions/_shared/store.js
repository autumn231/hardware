// Configuration, counters, cache, stats and admin auth, all backed by the
// AI_HARDWARE_TOOL KV namespace. Configuration lives in a single JSON
// document under the key "cfg". Legacy flat keys from v1 (api_key, model,
// daily_limit, admin_password) are migrated on first read so an existing
// deployment keeps working after the upgrade.

import { kv } from './http.js';

export const PROVIDER_IDS = ['makers', 'openrouter'];

function emptyProvider() {
  return { key: '', model: '', base_url: '' };
}

export function defaultConfig() {
  return {
    providers: {
      makers: emptyProvider(),
      openrouter: emptyProvider(),
    },
    order: ['makers', 'openrouter'],
    daily_limit: 100,
    ip_daily_limit: 20,
    access_code: '',
  };
}

function normalizeConfig(raw) {
  const cfg = defaultConfig();
  if (raw && typeof raw === 'object') {
    if (raw.providers && typeof raw.providers === 'object') {
      for (const id of PROVIDER_IDS) {
        const p = raw.providers[id];
        if (p && typeof p === 'object') {
          cfg.providers[id] = {
            key: typeof p.key === 'string' ? p.key : '',
            model: typeof p.model === 'string' ? p.model : '',
            base_url: typeof p.base_url === 'string' ? p.base_url : '',
          };
        }
      }
    }
    if (Array.isArray(raw.order)) {
      const order = raw.order.filter((id) => PROVIDER_IDS.includes(id));
      for (const id of PROVIDER_IDS) {
        if (!order.includes(id)) order.push(id);
      }
      cfg.order = order;
    }
    // One-time migration: a config written while removed providers still
    // existed restarts from the canonical order, official built-in first.
    const hadRemoved =
      (Array.isArray(raw.order) && raw.order.some((id) => !PROVIDER_IDS.includes(id))) ||
      (raw.providers && Object.keys(raw.providers).some((id) => !PROVIDER_IDS.includes(id)));
    if (hadRemoved) cfg.order = ['makers', 'openrouter'];
    if (Number(raw.daily_limit) > 0) cfg.daily_limit = Number(raw.daily_limit);
    if (raw.ip_daily_limit !== undefined && Number(raw.ip_daily_limit) >= 0) {
      cfg.ip_daily_limit = Number(raw.ip_daily_limit);
    }
    if (typeof raw.access_code === 'string') cfg.access_code = raw.access_code;
  }
  return cfg;
}

export async function loadConfig() {
  const raw = await kv().get('cfg');
  if (raw) {
    try {
      return normalizeConfig(JSON.parse(raw));
    } catch (e) {
      // Corrupt config falls through to defaults plus legacy migration.
    }
  }
  const cfg = defaultConfig();
  const legacyKey = await kv().get('api_key');
  const legacyModel = await kv().get('model');
  const legacyLimit = await kv().get('daily_limit');
  if (legacyKey) {
    cfg.providers.openrouter.key = legacyKey;
    if (legacyModel) cfg.providers.openrouter.model = legacyModel;
    cfg.order = ['makers', 'openrouter'];
  }
  if (legacyLimit && Number(legacyLimit) > 0) cfg.daily_limit = Number(legacyLimit);
  await saveConfig(cfg);
  return cfg;
}

export async function saveConfig(cfg) {
  await kv().put('cfg', JSON.stringify(normalizeConfig(cfg)));
}

// ---- call counters -------------------------------------------------------

export function todayStr() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayKey() {
  return `call_count_${todayStr()}`;
}

export async function getTodayCount() {
  const count = await kv().get(todayKey());
  return count ? Number(count) || 0 : 0;
}

export async function getTotalCount() {
  const count = await kv().get('total_calls');
  return count ? Number(count) || 0 : 0;
}

export async function incrementCallCount() {
  const today = await getTodayCount();
  await kv().put(todayKey(), String(today + 1));
  const total = await getTotalCount();
  await kv().put('total_calls', String(total + 1));
}

export async function resetCounts() {
  await kv().put(todayKey(), '0');
  await kv().put('total_calls', '0');
}

// ---- per-IP rate limiting -------------------------------------------------

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function clientIp(request) {
  const xff = request.headers.get('x-forwarded-for') || '';
  const first = xff.split(',')[0].trim();
  return first || request.headers.get('EO-Client-IP') || 'unknown';
}

export async function getIpCount(ipHash) {
  const count = await kv().get(`ip_${ipHash}_${todayStr()}`);
  return count ? Number(count) || 0 : 0;
}

export async function incrementIpCount(ipHash) {
  const current = await getIpCount(ipHash);
  await kv().put(`ip_${ipHash}_${todayStr()}`, String(current + 1));
}

// ---- analysis result cache -------------------------------------------------
// Same manual excerpt + MCU + language returns the previous result for 7
// days, so repeat analyses cost nothing.

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function cacheKeyFor(text, mcu, language) {
  const hash = await sha256Hex(`${language}|${mcu}|${text}`);
  return `cache_${hash}`;
}

export async function getCached(key) {
  try {
    const raw = await kv().get(key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (!entry || !entry.ts || Date.now() - entry.ts > CACHE_TTL_MS) return null;
    return entry;
  } catch (e) {
    return null;
  }
}

export async function setCached(key, result, meta) {
  try {
    await kv().put(key, JSON.stringify({ ts: Date.now(), result, meta }));
  } catch (e) {
    // Cache failures never break an analysis.
  }
}

// ---- provider stats and event log (best effort, never throws) -------------

export async function recordProviderStat(provider, ok, ms) {
  try {
    const key = `pstats_${todayStr()}`;
    const raw = await kv().get(key);
    const stats = raw ? JSON.parse(raw) : {};
    const entry = stats[provider] || { calls: 0, ok: 0, fail: 0, total_ms: 0 };
    entry.calls += 1;
    if (ok) entry.ok += 1;
    else entry.fail += 1;
    entry.total_ms += ms || 0;
    stats[provider] = entry;
    await kv().put(key, JSON.stringify(stats));
  } catch (e) {
    // ignore
  }
}

export async function getProviderStats() {
  try {
    const raw = await kv().get(`pstats_${todayStr()}`);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

// ---- monthly token usage (per provider, from real API responses) ----------
// The EdgeOne built-in model quota is a monthly account-level pool, so the
// counter that matters is monthly. Only usage figures actually returned by
// an API response are recorded; nothing is estimated.

export function monthStr() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export async function recordTokenUsage(provider, usage, officialUsage) {
  if (!provider || !usage) return;
  try {
    const key = `token_usage_${monthStr()}`;
    const raw = await kv().get(key);
    const data = raw ? JSON.parse(raw) : { providers: {} };
    const entry = data.providers[provider] || {
      calls: 0,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      official_tokens: 0,
    };
    const prompt = Number(usage.prompt_tokens) || 0;
    const completion = Number(usage.completion_tokens) || 0;
    const total = Number(usage.total_tokens) || prompt + completion;
    entry.calls += 1;
    entry.prompt_tokens += prompt;
    entry.completion_tokens += completion;
    entry.total_tokens += total;
    if (officialUsage && Number(officialUsage.total_tokens)) {
      entry.official_tokens += Number(officialUsage.total_tokens);
    }
    data.providers[provider] = entry;
    data.updated_at = Date.now();
    await kv().put(key, JSON.stringify(data));
  } catch (e) {
    // ignore
  }
}

export async function getTokenUsage() {
  try {
    const raw = await kv().get(`token_usage_${monthStr()}`);
    const data = raw ? JSON.parse(raw) : { providers: {} };
    let total = 0;
    for (const id of Object.keys(data.providers || {})) {
      total += data.providers[id].total_tokens || 0;
    }
    return { month: monthStr(), providers: data.providers || {}, total_tokens: total };
  } catch (e) {
    return { month: monthStr(), providers: {}, total_tokens: 0 };
  }
}

const MAX_EVENTS = 50;

export async function pushEvent(event) {
  try {
    const raw = await kv().get('events');
    const events = raw ? JSON.parse(raw) : [];
    events.unshift({ ts: Date.now(), ...event });
    await kv().put('events', JSON.stringify(events.slice(0, MAX_EVENTS)));
  } catch (e) {
    // ignore
  }
}

export async function getEvents(limit) {
  try {
    const raw = await kv().get('events');
    const events = raw ? JSON.parse(raw) : [];
    return events.slice(0, limit || 10);
  } catch (e) {
    return [];
  }
}

// ---- admin password and sessions -----------------------------------------

export async function verifyAdminPassword(password) {
  const hash = await kv().get('admin_password_hash');
  if (hash) {
    return (await sha256Hex(password)) === hash;
  }
  // Legacy plaintext password from v1, upgraded to a hash on first use.
  const legacy = await kv().get('admin_password');
  const correct = legacy || 'admin123';
  if (password === correct) {
    await kv().put('admin_password_hash', await sha256Hex(password));
    return true;
  }
  return false;
}

export async function setAdminPassword(password) {
  await kv().put('admin_password_hash', await sha256Hex(password));
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export async function issueSession() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const record = { exp: Date.now() + SESSION_TTL_MS };
  await kv().put(`session:${token}`, JSON.stringify(record));
  return token;
}

export async function verifySession(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.substring(7);
  if (!token) return false;
  const raw = await kv().get(`session:${token}`);
  if (!raw) return false;
  try {
    const record = JSON.parse(raw);
    if (!record.exp || Date.now() > record.exp) {
      await kv().delete(`session:${token}`);
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}
