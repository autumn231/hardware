import { handleOptions, jsonResponse, kvAvailable, kv } from '../_shared/http.js';
import { sha256Hex, loadConfig, saveConfig } from '../_shared/store.js';

// TEMPORARY one-shot KV cleanup endpoint. Guarded by the SHA-256 of a
// random token that never appears in this repo. It can only delete the
// hardcoded stale keys below and rewrite cfg in normalized form.
// Removed right after use.
const TOKEN_HASH = '3e2b062fc61d1b8dae4094cf150108a4b6ed7be9e35ac118cfffac15b1dc01be';

const STALE_KEYS = [
  'admin_password',
  'api_key',
  'model',
  'daily_limit',
  'provider',
  'session_token',
  'call_count_2026-04-19',
  'call_count_2026-04-20',
  'call_count_2026-04-21',
  'call_count_2026-05-12',
  'call_count_2026-06-27',
  'call_count_2026-07-08',
  'call_count_2026-07-10',
  'call_count_2026-07-16',
  'call_count_2026-07-22',
];

async function listAllKeys(ns) {
  const keys = [];
  let cursor = '';
  for (let page = 0; page < 40; page++) {
    const res = await ns.list({ limit: 256, cursor });
    for (const k of res.keys || []) keys.push(k.key);
    if (res.complete || !res.cursor) break;
    cursor = res.cursor;
  }
  return keys;
}

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;
  const given = context.request.headers.get('X-Audit-Token') || '';
  if (!given || (await sha256Hex(given)) !== TOKEN_HASH) {
    return jsonResponse({ success: false, error: 'not found' }, 404);
  }
  if (!kvAvailable()) return jsonResponse({ success: false, error: 'kv missing' }, 503);
  const ns = kv();

  if (context.request.method === 'GET') {
    const keys = await listAllKeys(ns);
    return jsonResponse({
      success: true,
      total_keys: keys.length,
      stale_present: STALE_KEYS.filter((k) => keys.includes(k)),
      keys,
    });
  }

  if (context.request.method === 'POST') {
    const deleted = [];
    for (const key of STALE_KEYS) {
      const before = await ns.get(key);
      if (before !== null && before !== undefined) {
        await ns.delete(key);
        deleted.push(key);
      }
    }
    // Rewrite cfg in normalized v5 form (drops removed providers from the
    // stored document; read path already normalized it in memory).
    const cfg = await loadConfig();
    await saveConfig(cfg);
    const keys = await listAllKeys(ns);
    const stillThere = [];
    for (const key of STALE_KEYS) {
      const v = await ns.get(key);
      if (v !== null && v !== undefined) stillThere.push(key);
    }
    const rawCfg = await ns.get('cfg');
    const cfgParsed = rawCfg ? JSON.parse(rawCfg) : null;
    return jsonResponse({
      success: true,
      deleted,
      still_present: stillThere,
      total_keys_after: keys.length,
      cfg_providers: cfgParsed ? Object.keys(cfgParsed.providers || {}) : null,
      cfg_order: cfgParsed ? cfgParsed.order : null,
      openrouter_key_kept: !!(cfgParsed && cfgParsed.providers.openrouter && cfgParsed.providers.openrouter.key),
      openrouter_model: cfgParsed && cfgParsed.providers.openrouter ? cfgParsed.providers.openrouter.model : null,
    });
  }

  return jsonResponse({ success: false, error: 'method not allowed' }, 405);
}
