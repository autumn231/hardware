import { jsonResponse, kvAvailable, kv } from '../_shared/http.js';
import { sha256Hex } from '../_shared/store.js';

// TEMPORARY one-shot KV audit endpoint. Guarded by the SHA-256 of a random
// token that never appears in this repo. Removed right after use.
const TOKEN_HASH = '2f4685c5bacd637a23d782b24283d38c02a5d2cd1e582ec20b63cd6e35d33330';

function classify(key, value) {
  const info = { key, bytes: value ? value.length : 0 };
  const today = new Date().toISOString().slice(0, 10);
  if (key === 'cfg') {
    try {
      const cfg = JSON.parse(value);
      info.kind = 'config (live)';
      info.providers = Object.keys(cfg.providers || {});
      info.order = cfg.order || [];
    } catch (e) { info.kind = 'config (unparseable)'; }
    return info;
  }
  if (key === 'admin_password') { info.kind = 'LEGACY v1 plaintext password (stale, hash supersedes it)'; return info; }
  if (key === 'admin_password_hash') { info.kind = 'admin password hash (live)'; return info; }
  if (key === 'api_key' || key === 'model' || key === 'daily_limit') { info.kind = 'LEGACY v1 flat key (stale, cfg supersedes it)'; return info; }
  if (key.startsWith('session:')) {
    try {
      const rec = JSON.parse(value);
      info.kind = rec.exp && Date.now() > rec.exp ? 'session EXPIRED (stale)' : 'session (live)';
      info.exp = rec.exp ? new Date(rec.exp).toISOString() : null;
    } catch (e) { info.kind = 'session (unparseable)'; }
    return info;
  }
  if (key.startsWith('cache_')) {
    try {
      const entry = JSON.parse(value);
      const ageDays = entry.ts ? ((Date.now() - entry.ts) / 86400000) : null;
      info.kind = ageDays !== null && ageDays > 7 ? 'analysis cache EXPIRED >7d (stale)' : 'analysis cache (live)';
      info.age_days = ageDays !== null ? Math.round(ageDays * 10) / 10 : null;
    } catch (e) { info.kind = 'analysis cache (unparseable)'; }
    return info;
  }
  const m = key.match(/^(call_count|pstats)_(\d{4}-\d{2}-\d{2})$/);
  if (m) { info.kind = m[2] === today ? 'daily stat (today, live)' : 'daily stat (past day, stale)'; info.value = value.slice(0, 120); return info; }
  if (/^ip_[0-9a-f]+_\d{4}-\d{2}-\d{2}$/.test(key)) {
    const d = key.slice(-10);
    info.kind = d === today ? 'per-IP counter (today, live)' : 'per-IP counter (past day, stale)';
    info.value = value;
    return info;
  }
  if (key.startsWith('token_usage_')) { info.kind = 'monthly token usage'; info.value = value.slice(0, 300); return info; }
  if (key === 'total_calls') { info.kind = 'counter (live)'; info.value = value; return info; }
  if (key === 'events') { info.kind = 'event log (live)'; return info; }
  info.kind = 'UNKNOWN';
  info.preview = value ? value.slice(0, 80) : '';
  return info;
}

export async function onRequest(context) {
  const given = context.request.headers.get('X-Audit-Token') || '';
  if (!given || (await sha256Hex(given)) !== TOKEN_HASH) {
    return jsonResponse({ success: false, error: 'not found' }, 404);
  }
  if (!kvAvailable()) return jsonResponse({ success: false, error: 'kv missing' }, 503);
  const ns = kv();
  if (typeof ns.list !== 'function') {
    return jsonResponse({ success: false, error: 'KV list() not supported on this binding' }, 501);
  }
  const keys = [];
  let cursor = '';
  for (let page = 0; page < 40; page++) {
    const res = await ns.list({ limit: 256, cursor });
    for (const k of res.keys || []) keys.push(k.key);
    if (res.complete || !res.cursor) break;
    cursor = res.cursor;
  }
  const report = [];
  for (const key of keys) {
    const value = await ns.get(key);
    report.push(classify(key, value == null ? '' : String(value)));
  }
  return jsonResponse({ success: true, total_keys: keys.length, report });
}
