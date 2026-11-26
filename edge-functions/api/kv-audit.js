import { handleOptions, jsonResponse, kvAvailable, kv } from '../_shared/http.js';
import { sha256Hex, loadConfig, saveConfig } from '../_shared/store.js';

// TEMPORARY one-shot KV cleanup endpoint v2: every step is individually
// wrapped so a platform error comes back as JSON instead of an opaque 545.
// Guarded by the SHA-256 of a random token. Removed right after use.
const TOKEN_HASH = '3e2b062fc61d1b8dae4094cf150108a4b6ed7be9e35ac118cfffac15b1dc01be';

const STALE_KEYS = [
  'admin_password', 'api_key', 'model', 'daily_limit', 'provider',
  'session_token',
  'call_count_2026-04-19', 'call_count_2026-04-20', 'call_count_2026-04-21',
  'call_count_2026-05-12', 'call_count_2026-06-27', 'call_count_2026-07-08',
  'call_count_2026-07-10', 'call_count_2026-07-16', 'call_count_2026-07-22',
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
  const url = new URL(context.request.url);

  try {
    if (context.request.method === 'GET') {
      const keys = await listAllKeys(ns);
      return jsonResponse({
        success: true,
        total_keys: keys.length,
        stale_present: STALE_KEYS.filter((k) => keys.includes(k)),
      });
    }
    if (context.request.method === 'POST') {
      const only = url.searchParams.get('only');
      const action = url.searchParams.get('action');
      if (only) {
        if (!STALE_KEYS.includes(only)) {
          return jsonResponse({ success: false, error: 'key not in stale list' }, 400);
        }
        let before;
        try { before = await ns.get(only); } catch (e) { return jsonResponse({ success: false, step: 'get', error: String((e && e.message) || e) }, 500); }
        if (before === null || before === undefined) {
          return jsonResponse({ success: true, key: only, already_gone: true });
        }
        try { await ns.delete(only); } catch (e) { return jsonResponse({ success: false, step: 'delete', error: String((e && e.message) || e) }, 500); }
        let after;
        try { after = await ns.get(only); } catch (e) { return jsonResponse({ success: false, step: 'verify-get', error: String((e && e.message) || e) }, 500); }
        return jsonResponse({ success: true, key: only, deleted: true, gone: after === null || after === undefined });
      }
      if (action === 'cfg') {
        try {
          const cfg = await loadConfig();
          await saveConfig(cfg);
          const raw = await ns.get('cfg');
          const parsed = raw ? JSON.parse(raw) : null;
          return jsonResponse({
            success: true,
            cfg_providers: parsed ? Object.keys(parsed.providers || {}) : null,
            cfg_order: parsed ? parsed.order : null,
            openrouter_key_kept: !!(parsed && parsed.providers.openrouter && parsed.providers.openrouter.key),
            openrouter_model: parsed && parsed.providers.openrouter ? parsed.providers.openrouter.model : null,
          });
        } catch (e) {
          return jsonResponse({ success: false, step: 'cfg', error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 400) }, 500);
        }
      }
      return jsonResponse({ success: false, error: 'specify ?only=<key> or ?action=cfg' }, 400);
    }
    return jsonResponse({ success: false, error: 'method not allowed' }, 405);
  } catch (e) {
    return jsonResponse({ success: false, step: 'outer', error: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 400) }, 500);
  }
}
