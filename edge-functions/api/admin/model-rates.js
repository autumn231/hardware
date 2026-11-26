import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../../_shared/http.js';
import { loadConfig, verifySession, PROVIDER_IDS } from '../../_shared/store.js';
import { measureModelRates } from '../../_shared/providers.js';

// One-shot per-model rate measurement for providers with a model
// catalogue (the built-in Makers gateway): fires one tiny chat request
// per model and reports the effective quota multiplier of each, derived
// from the gateway's own usage receipt. Costs a few hundred tokens of
// the provider's quota per run.
export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  if (context.request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  if (!kvAvailable()) {
    return jsonResponse({ success: false, error: KV_MISSING_MESSAGE }, 503);
  }

  const authenticated = await verifySession(context.request);
  if (!authenticated) {
    return jsonResponse({ success: false, error: '未授权，请重新登录' }, 401);
  }

  try {
    const body = await context.request.json();
    const { provider } = body || {};
    if (!PROVIDER_IDS.includes(provider)) {
      return jsonResponse({ success: false, error: '未知供应商' }, 400);
    }
    const cfg = await loadConfig();
    const outcome = await measureModelRates(provider, cfg.providers[provider]);
    if (outcome.error) {
      return jsonResponse({ success: false, error: outcome.error }, 400);
    }
    return jsonResponse({ success: true, provider, results: outcome.results });
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误：${err.message}` }, 500);
  }
}
