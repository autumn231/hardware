import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../_shared/http.js';
import { loadConfig, getTodayCount, incrementCallCount } from '../_shared/store.js';
import { chatWithFallback, callProvider } from '../_shared/providers.js';
import { buildMessages, buildRepairMessages, extractJson, normalizeResult } from '../_shared/prompt.js';

// Hard cap on the manual text accepted by this endpoint. The frontend packs
// a keyword scored excerpt when a manual is longer than this.
const MAX_TEXT_CHARS = 150000;

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

    const todayCount = await getTodayCount();
    if (todayCount >= cfg.daily_limit) {
      return jsonResponse(
        { success: false, error: `今日调用次数已达上限 (${cfg.daily_limit} 次)` },
        429
      );
    }

    const body = await context.request.json();
    const { text, mcu, language } = body || {};
    if (!text || !mcu || !language) {
      return jsonResponse({ success: false, error: '缺少必要参数：text, mcu, language' }, 400);
    }

    const truncated = text.length > MAX_TEXT_CHARS;
    const finalText = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;

    const started = Date.now();
    const first = await chatWithFallback(cfg, buildMessages(finalText, mcu, language), context.request);

    let parsed = extractJson(first.content);
    let repaired = false;
    if (!parsed) {
      // One repair pass through the provider that answered, then give up and
      // hand the raw text to the frontend instead of failing outright.
      try {
        const fix = await callProvider(
          first.provider,
          cfg.providers[first.provider],
          buildRepairMessages(first.content),
          context.request
        );
        parsed = extractJson(fix.content);
        repaired = !!parsed;
      } catch (e) {
        parsed = null;
      }
    }

    await incrementCallCount();

    const meta = {
      provider: first.provider,
      model: first.model,
      ms: Date.now() - started,
      attempts: first.attempts,
      repaired,
      truncated,
    };

    if (!parsed) {
      return jsonResponse({ success: true, result: { raw_content: first.content }, meta });
    }
    return jsonResponse({ success: true, result: normalizeResult(parsed), meta });
  } catch (err) {
    return jsonResponse(
      {
        success: false,
        error: `分析失败：${err.message}`,
        attempts: err.attempts || undefined,
      },
      502
    );
  }
}
