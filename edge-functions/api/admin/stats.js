import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../../_shared/http.js';
import {
  getTodayCount,
  getTotalCount,
  resetCounts,
  verifySession,
  loadConfig,
  getProviderStats,
  getTokenUsage,
  getEvents,
} from '../../_shared/store.js';

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
      return jsonResponse({
        success: true,
        stats: {
          today: await getTodayCount(),
          total: await getTotalCount(),
          daily_limit: cfg.daily_limit,
          ip_daily_limit: cfg.ip_daily_limit,
          order: cfg.order,
          provider_stats: await getProviderStats(),
          token_usage: await getTokenUsage(),
          events: await getEvents(10),
        },
      });
    }

    if (context.request.method === 'POST') {
      const body = await context.request.json().catch(() => ({}));
      if (body && body.action === 'reset') {
        await resetCounts();
        return jsonResponse({ success: true, stats: { today: 0, total: 0 } });
      }
      return jsonResponse({ success: false, error: '未知操作' }, 400);
    }

    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误：${err.message}` }, 500);
  }
}
