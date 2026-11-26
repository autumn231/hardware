import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../../_shared/http.js';
import {
  loadConfig,
  saveConfig,
  verifySession,
  setAdminPassword,
  PROVIDER_IDS,
} from '../../_shared/store.js';
import { PROVIDERS } from '../../_shared/providers.js';

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '****';
  return key.slice(0, 6) + '****' + key.slice(-4);
}

function publicConfig(cfg) {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const p = cfg.providers[id] || {};
    providers[id] = {
      name: PROVIDERS[id].name,
      key_set: !!p.key,
      key_masked: maskKey(p.key),
      model: p.model || PROVIDERS[id].defaultModel,
      base_url: PROVIDERS[id].baseUrl,
      key_hint: PROVIDERS[id].keyHint,
      models: PROVIDERS[id].models || null,
    };
  }
  return {
    providers,
    order: cfg.order,
    daily_limit: cfg.daily_limit,
    ip_daily_limit: cfg.ip_daily_limit,
    access_code_set: !!cfg.access_code,
  };
}

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  if (!kvAvailable()) {
    return jsonResponse({ success: false, error: KV_MISSING_MESSAGE }, 503);
  }

  const authenticated = await verifySession(context.request);
  if (!authenticated) {
    return jsonResponse({ success: false, error: '未授权，请重新登录' }, 401);
  }

  try {
    if (context.request.method === 'GET') {
      const cfg = await loadConfig();
      return jsonResponse({ success: true, config: publicConfig(cfg) });
    }

    if (context.request.method === 'POST') {
      const body = await context.request.json();
      const cfg = await loadConfig();
      const updated = [];

      if (body.providers && typeof body.providers === 'object') {
        for (const id of PROVIDER_IDS) {
          const incoming = body.providers[id];
          if (!incoming || typeof incoming !== 'object') continue;
          const target = cfg.providers[id];
          // An empty key field means "leave unchanged" so the admin UI never
          // has to send the real key back. The literal value "__CLEAR__"
          // removes a stored key.
          if (typeof incoming.key === 'string') {
            if (incoming.key === '__CLEAR__') {
              target.key = '';
              updated.push(`${id}.key`);
            } else if (incoming.key.length > 0) {
              target.key = incoming.key;
              updated.push(`${id}.key`);
            }
          }
          if (typeof incoming.model === 'string') {
            target.model = incoming.model.trim();
            updated.push(`${id}.model`);
          }
        }
      }

      if (Array.isArray(body.order)) {
        cfg.order = body.order;
        updated.push('order');
      }
      if (body.daily_limit !== undefined && Number(body.daily_limit) > 0) {
        cfg.daily_limit = Number(body.daily_limit);
        updated.push('daily_limit');
      }
      if (body.ip_daily_limit !== undefined && Number(body.ip_daily_limit) >= 0) {
        cfg.ip_daily_limit = Number(body.ip_daily_limit);
        updated.push('ip_daily_limit');
      }
      if (typeof body.access_code === 'string') {
        cfg.access_code = body.access_code.trim();
        updated.push('access_code');
      }

      await saveConfig(cfg);

      if (typeof body.new_password === 'string' && body.new_password.length > 0) {
        await setAdminPassword(body.new_password);
        updated.push('admin_password');
      }

      return jsonResponse({ success: true, updated, config: publicConfig(cfg) });
    }

    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误：${err.message}` }, 500);
  }
}
