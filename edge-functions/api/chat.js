import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../_shared/http.js';
import {
  loadConfig,
  getTodayCount,
  incrementCallCount,
  clientIp,
  sha256Hex,
  getIpCount,
  incrementIpCount,
  recordProviderStat,
  recordTokenUsage,
  pushEvent,
} from '../_shared/store.js';
import { chatWithFallback } from '../_shared/providers.js';
import { buildChatMessages } from '../_shared/prompt.js';

// Follow-up Q&A grounded in the manual excerpt the user already analyzed.
// Shares the analyze quotas so the public endpoint cannot be drained
// through the chat door.
const MAX_TEXT_CHARS = 80000;

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
    const cfg = await loadConfig();

    if (cfg.access_code) {
      const code = context.request.headers.get('X-Access-Code') || '';
      if (code !== cfg.access_code) {
        return jsonResponse({ success: false, error: '访问口令不正确', need_access_code: true }, 401);
      }
    }

    const body = await context.request.json();
    const { text, question, history } = body || {};
    if (!text || !question) {
      return jsonResponse({ success: false, error: '缺少必要参数：text, question' }, 400);
    }

    const ipHash = (await sha256Hex(clientIp(context.request))).slice(0, 16);
    const todayCount = await getTodayCount();
    if (todayCount >= cfg.daily_limit) {
      return jsonResponse({ success: false, error: `今日调用次数已达上限 (${cfg.daily_limit} 次)` }, 429);
    }
    if (cfg.ip_daily_limit > 0 && (await getIpCount(ipHash)) >= cfg.ip_daily_limit) {
      return jsonResponse({ success: false, error: `你今日的调用次数已达上限 (${cfg.ip_daily_limit} 次)` }, 429);
    }

    const finalText = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
    const started = Date.now();
    const first = await chatWithFallback(
      cfg,
      buildChatMessages(finalText, history, String(question).slice(0, 1000)),
      context.request,
      { jsonMode: false }
    );
    const ms = Date.now() - started;
    await incrementCallCount();
    await incrementIpCount(ipHash);
    await recordProviderStat(first.provider, true, ms);
    await recordTokenUsage(first.provider, first.usage, first.officialUsage);
    await pushEvent({ type: 'chat', ok: true, provider: first.provider, model: first.model, ms });
    return jsonResponse({
      success: true,
      answer: first.content,
      meta: { provider: first.provider, model: first.model, ms, attempts: first.attempts },
    });
  } catch (err) {
    await pushEvent({ type: 'chat', ok: false, error: String((err && err.message) || err).slice(0, 200) });
    return jsonResponse(
      { success: false, error: `问答失败：${err.message}`, attempts: err.attempts || undefined },
      502
    );
  }
}
