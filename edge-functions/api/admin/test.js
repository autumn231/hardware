import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../../_shared/http.js';
import { loadConfig, verifySession, PROVIDER_IDS } from '../../_shared/store.js';
import { probeProvider } from '../../_shared/providers.js';

// Connectivity probe. Runs the provider's model list from inside the edge
// function, so the result reflects the network vantage point that analyze
// calls actually have, not the admin's browser.
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
    const result = await probeProvider(provider, cfg.providers[provider]);
    return jsonResponse({ success: true, provider, ...result });
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误：${err.message}` }, 500);
  }
}
