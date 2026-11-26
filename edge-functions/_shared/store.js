// Configuration, counters and admin auth, all backed by the AI_HARDWARE_TOOL
// KV namespace. Configuration lives in a single JSON document under the key
// "cfg". Legacy flat keys from v1 (api_key, model, daily_limit,
// admin_password) are migrated on first read so an existing deployment keeps
// working after the upgrade.

import { kv } from './http.js';

export const PROVIDER_IDS = ['sensenova', 'deepseek', 'gemini', 'openrouter', 'custom'];

function emptyProvider() {
  return { key: '', model: '', base_url: '' };
}

export function defaultConfig() {
  return {
    providers: {
      sensenova: emptyProvider(),
      deepseek: emptyProvider(),
      gemini: emptyProvider(),
      openrouter: emptyProvider(),
      custom: emptyProvider(),
    },
    order: ['sensenova', 'deepseek', 'gemini', 'openrouter', 'custom'],
    daily_limit: 100,
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
    if (Number(raw.daily_limit) > 0) cfg.daily_limit = Number(raw.daily_limit);
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
    cfg.order = ['openrouter', 'sensenova', 'deepseek', 'gemini', 'openrouter', 'custom']
      .filter((v, i, a) => a.indexOf(v) === i);
  }
  if (legacyLimit && Number(legacyLimit) > 0) cfg.daily_limit = Number(legacyLimit);
  await saveConfig(cfg);
  return cfg;
}

export async function saveConfig(cfg) {
  await kv().put('cfg', JSON.stringify(normalizeConfig(cfg)));
}

// ---- call counters -------------------------------------------------------

function todayKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `call_count_${y}-${m}-${d}`;
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

// ---- admin password and sessions -----------------------------------------

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
