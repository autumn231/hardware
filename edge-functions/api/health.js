import { handleOptions, jsonResponse, kvAvailable } from '../_shared/http.js';
import { loadConfig, PROVIDER_IDS } from '../_shared/store.js';

// Public health probe: confirms the deployment is alive, KV is bound and
// at least one provider is configured. Reveals no keys or config values.
export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  if (!kvAvailable()) {
    return jsonResponse({ success: true, version: '3.0', kv: false, providers_configured: 0 }, 200);
  }
  try {
    const cfg = await loadConfig();
    const configured = PROVIDER_IDS.filter((id) => cfg.providers[id] && cfg.providers[id].key).length;
    return jsonResponse({ success: true, version: '3.0', kv: true, providers_configured: configured });
  } catch (err) {
    return jsonResponse({ success: false, version: '3.0', kv: true, error: err.message }, 500);
  }
}
