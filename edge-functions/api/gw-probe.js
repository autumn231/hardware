import { handleOptions, jsonResponse, kvAvailable } from '../_shared/http.js';
import { sha256Hex, loadConfig, saveConfig } from '../_shared/store.js';

// TEMPORARY probe: does this project already carry a platform-injected
// AI gateway key (AI_GATEWAY_API_KEY)? Reports presence and length only,
// never the value. POST ?action=adopt copies it into the makers provider
// config server-side. Removed right after use.
const TOKEN_HASH = '0d2b8541356374dc399519eea07bfae7b3217c40090a70e08a8c4cd2922ea043';

function findGatewayKey(context) {
  const candidates = [];
  try {
    if (context.env && typeof context.env === 'object') {
      candidates.push(['context.env', context.env]);
    }
  } catch (e) {}
  try {
    if (typeof process !== 'undefined' && process.env) {
      candidates.push(['process.env', process.env]);
    }
  } catch (e) {}
  for (const [source, env] of candidates) {
    let names = [];
    try { names = Object.keys(env); } catch (e) {}
    const interesting = names.filter((n) => /GATEWAY|MAKERS|AI_/i.test(n));
    const key = env.AI_GATEWAY_API_KEY;
    if (typeof key === 'string' && key.length > 0) {
      return { found: true, source, length: key.length, value: key, envNames: interesting, baseUrl: env.AI_GATEWAY_BASE_URL || null };
    }
    if (interesting.length) {
      return { found: false, source, envNames: interesting };
    }
  }
  return { found: false, envNames: [] };
}

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;
  const given = context.request.headers.get('X-Audit-Token') || '';
  if (!given || (await sha256Hex(given)) !== TOKEN_HASH) {
    return jsonResponse({ success: false, error: 'not found' }, 404);
  }
  const probe = findGatewayKey(context);
  if (context.request.method === 'GET') {
    return jsonResponse({
      success: true,
      found: probe.found,
      source: probe.source || null,
      key_length: probe.length || 0,
      env_names: probe.envNames || [],
      gateway_base_url: probe.baseUrl || null,
    });
  }
  if (context.request.method === 'POST') {
    const url = new URL(context.request.url);
    if (url.searchParams.get('action') !== 'adopt') {
      return jsonResponse({ success: false, error: 'unknown action' }, 400);
    }
    if (!probe.found) return jsonResponse({ success: false, error: 'no gateway key in environment' }, 404);
    if (!kvAvailable()) return jsonResponse({ success: false, error: 'kv missing' }, 503);
    const cfg = await loadConfig();
    cfg.providers.makers.key = probe.value;
    if (!cfg.providers.makers.model) cfg.providers.makers.model = '@makers/deepseek-v4-flash';
    await saveConfig(cfg);
    const check = await loadConfig();
    return jsonResponse({
      success: true,
      adopted: true,
      makers_key_set: !!check.providers.makers.key,
      makers_key_length: (check.providers.makers.key || '').length,
      makers_model: check.providers.makers.model,
      order: check.order,
    });
  }
  return jsonResponse({ success: false, error: 'method not allowed' }, 405);
}
