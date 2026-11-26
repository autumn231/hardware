import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../../_shared/http.js';
import { verifyAdminPassword, issueSession } from '../../_shared/store.js';

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  if (context.request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  if (!kvAvailable()) {
    return jsonResponse({ success: false, error: KV_MISSING_MESSAGE }, 503);
  }

  try {
    const body = await context.request.json();
    const { password } = body || {};
    if (!password) {
      return jsonResponse({ success: false, error: '请输入密码' }, 400);
    }
    const ok = await verifyAdminPassword(password);
    if (!ok) {
      return jsonResponse({ success: false, error: '密码错误' }, 401);
    }
    const token = await issueSession();
    return jsonResponse({ success: true, token });
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误：${err.message}` }, 500);
  }
}
