import { handleOptions, jsonResponse, kvAvailable, KV_MISSING_MESSAGE } from '../_shared/http.js';
import {
  loadConfig,
  getTodayCount,
  incrementCallCount,
  clientIp,
  sha256Hex,
  getIpCount,
  incrementIpCount,
  cacheKeyFor,
  getCached,
  setCached,
  recordProviderStat,
  recordTokenUsage,
  pushEvent,
} from '../_shared/store.js';
import { chatWithFallback, callProvider, streamChatWithFallback } from '../_shared/providers.js';
import {
  buildMessages,
  buildRepairMessages,
  buildSectionMessages,
  extractJson,
  mergeSectionResults,
  normalizeResult,
  ANALYSIS_SECTIONS,
} from '../_shared/prompt.js';

// Hard cap on the manual text accepted by this endpoint. The frontend packs
// a keyword scored excerpt when a manual is longer than this.
const MAX_TEXT_CHARS = 150000;

async function parseAndRepair(cfg, first, request) {
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
        request,
        { timeoutMs: 120000 }
      );
      parsed = extractJson(fix.content);
      repaired = !!parsed;
      await recordTokenUsage(first.provider, fix.usage, fix.officialUsage);
    } catch (e) {
      parsed = null;
    }
  }
  return { parsed, repaired };
}

const CHUNK_MIN_TEXT_CHARS = 16000;
const SECTION_TIMEOUT_MS = 45000;

function sumUsage(usages) {
  if (!usages || !usages.length) return null;
  const total = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  for (const usage of usages) {
    if (!usage) continue;
    total.prompt_tokens += Number(usage.prompt_tokens) || 0;
    total.completion_tokens += Number(usage.completion_tokens) || 0;
    total.total_tokens += Number(usage.total_tokens) || 0;
  }
  if (!total.total_tokens) total.total_tokens = total.prompt_tokens + total.completion_tokens;
  return total;
}

function shouldUseChunked(cfg, text) {
  return (
    text &&
    text.length >= CHUNK_MIN_TEXT_CHARS &&
    cfg.providers.makers &&
    cfg.providers.makers.key
  );
}

// Long-manual fast path: split the work into small parallel completions
// on the EdgeOne built-in model. Each section is short enough to finish
// before the Makers gateway severs long generations, and each prompt is
// a keyword-scored excerpt instead of the full manual. OpenRouter stays
// configured as the last-resort whole-request fallback only.
async function runChunkedAnalysis(cfg, text, mcu, language, request, onEvent) {
  const started = Date.now();
  const providerCfg = cfg.providers.makers;
  const model = providerCfg.model || '@makers/deepseek-v4-flash';
  if (onEvent) onEvent({ type: 'provider', provider: 'makers', model });

  const usages = [];
  let completedChars = 0;
  const parts = await Promise.all(
    ANALYSIS_SECTIONS.map(async (section) => {
      const sectionStarted = Date.now();
      try {
        const res = await callProvider(
          'makers',
          providerCfg,
          buildSectionMessages(section, text, mcu, language),
          request,
          { timeoutMs: SECTION_TIMEOUT_MS, maxTokens: section.maxTokens }
        );
        if (res.usage) usages.push(res.usage);
        const parsed = extractJson(res.content);
        completedChars += res.content.length;
        if (onEvent) {
          onEvent({
            type: 'delta',
            chars: completedChars,
            tail: `【${section.label}完成】` + res.content.slice(-300),
          });
        }
        if (!parsed) {
          return {
            section: section.id,
            label: section.label,
            ok: false,
            ms: Date.now() - sectionStarted,
            error: 'JSON 解析失败',
            rawContent: res.content,
          };
        }
        return {
          section: section.id,
          label: section.label,
          ok: true,
          ms: Date.now() - sectionStarted,
          parsed,
        };
      } catch (e) {
        return {
          section: section.id,
          label: section.label,
          ok: false,
          ms: Date.now() - sectionStarted,
          error: String((e && e.message) || e).slice(0, 300),
        };
      }
    })
  );

  // One sequential rescue pass for failed sections. Parse failures first
  // go through a constrained JSON repair of the raw section output; empty
  // or network-failed sections are regenerated once with a stricter,
  // shorter instruction. This keeps the common case parallel and fast
  // while avoiding a result with missing core sections.
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.ok) continue;
    const section = ANALYSIS_SECTIONS.find((s) => s.id === part.section);
    if (!section) continue;
    const retryStarted = Date.now();
    try {
      let retryContent = '';
      if (part.rawContent) {
        const fix = await callProvider('makers', providerCfg, buildRepairMessages(part.rawContent), request, {
          timeoutMs: 35000,
          maxTokens: section.maxTokens + 800,
        });
        if (fix.usage) usages.push(fix.usage);
        retryContent = fix.content;
      } else {
        const messages = buildSectionMessages(section, text, mcu, language);
        messages.push({
          role: 'user',
          content:
            '上一次输出未成功。请重新输出，务必只输出合法 JSON；代码字符串中的换行、引号、反斜杠必须正确转义；内容更简洁。',
        });
        const res = await callProvider('makers', providerCfg, messages, request, {
          timeoutMs: SECTION_TIMEOUT_MS,
          maxTokens: section.maxTokens + 400,
        });
        if (res.usage) usages.push(res.usage);
        retryContent = res.content;
      }
      const parsed = extractJson(retryContent);
      if (!parsed) throw new Error('补跑后 JSON 仍无法解析');
      completedChars += retryContent.length;
      if (onEvent) {
        onEvent({
          type: 'delta',
          chars: completedChars,
          tail: `【${section.label}已补齐】` + retryContent.slice(-300),
        });
      }
      parts[i] = {
        section: section.id,
        label: section.label,
        ok: true,
        ms: part.ms + (Date.now() - retryStarted),
        parsed,
        retried: true,
      };
    } catch (e) {
      parts[i] = {
        ...part,
        error: `${part.error || '失败'}；补跑失败：${String((e && e.message) || e).slice(0, 200)}`,
      };
    }
  }

  const merged = mergeSectionResults(parts.filter((p) => p.ok));
  // Sanity checks on the assembled result: a section can parse as JSON
  // yet still carry a truncated fragment (observed: initialization code
  // reduced to a single include line). Broken code pieces are dropped,
  // and a broken initialization gets one focused regeneration attempt.
  if (Array.isArray(merged.driver_functions)) {
    merged.driver_functions = merged.driver_functions.filter(
      (f) => f && String(f.code || '').length >= 80
    );
  }
  const initCodeOk = (obj) => {
    const code = obj && obj.initialization && obj.initialization.code;
    return typeof code === 'string' && code.length >= 120;
  };
  if (!initCodeOk(merged)) {
    try {
      const section = ANALYSIS_SECTIONS.find((s) => s.id === 'init');
      const messages = buildSectionMessages(section, text, mcu, language);
      messages.push({
        role: 'user',
        content:
          '初始化代码必须是完整代码片段（至少包含外设初始化与芯片配置，不少于 300 字符），只输出合法 JSON，代码中的换行、引号、反斜杠必须正确转义。',
      });
      const res = await callProvider('makers', providerCfg, messages, request, {
        timeoutMs: SECTION_TIMEOUT_MS,
        maxTokens: 2400,
      });
      if (res.usage) usages.push(res.usage);
      const parsed = extractJson(res.content);
      if (parsed && initCodeOk(parsed)) {
        merged.initialization = parsed.initialization;
      }
    } catch (e) {
      // fall through to clearing below
    }
  }
  if (!initCodeOk(merged)) {
    if (merged.initialization) {
      merged.initialization = {
        description: merged.initialization.description || '',
        code: '',
      };
    }
    const initPart = parts.find((p) => p.section === 'init');
    if (initPart && initPart.ok) {
      initPart.ok = false;
      initPart.error = '初始化代码不完整';
    }
  }
  const failed = parts.filter((p) => !p.ok);
  const normalized = normalizeResult(merged);
  const hasCode =
    (normalized.driver_functions || []).length > 0 ||
    !!(normalized.initialization && normalized.initialization.code);
  const hasContent =
    !!normalized.working_principle ||
    (normalized.pins || []).length > 0 ||
    (normalized.registers || []).length > 0 ||
    !!(normalized.chip_info && normalized.chip_info.model);
  if (!hasCode || !hasContent || failed.length >= 4) {
    const err = new Error(`分段分析未完成（失败 ${failed.length}/${parts.length} 段）`);
    err.sectionResults = parts;
    throw err;
  }

  return {
    content: JSON.stringify(merged),
    provider: 'makers',
    model,
    usage: sumUsage(usages),
    officialUsage: null,
    attempts: [{ provider: 'makers', ok: true, ms: Date.now() - started }],
    chunked: true,
    sections: parts.map((p) => ({
      section: p.section,
      label: p.label,
      ok: p.ok,
      ms: p.ms,
      retried: p.retried || undefined,
      error: p.error || undefined,
    })),
    sections_failed: failed.map((p) => p.section),
  };
}

async function analyzeWithBuiltInFirst(cfg, text, mcu, language, request, onEvent) {
  if (shouldUseChunked(cfg, text)) {
    try {
      return await runChunkedAnalysis(cfg, text, mcu, language, request, onEvent);
    } catch (e) {
      const fallback = onEvent
        ? await streamChatWithFallback(cfg, buildMessages(text, mcu, language), request, onEvent)
        : await chatWithFallback(cfg, buildMessages(text, mcu, language), request, {
            timeoutMs: 240000,
          });
      fallback.chunked_failed = String((e && e.message) || e).slice(0, 300);
      return fallback;
    }
  }
  if (onEvent) {
    return streamChatWithFallback(cfg, buildMessages(text, mcu, language), request, onEvent);
  }
  return chatWithFallback(cfg, buildMessages(text, mcu, language), request, {
    timeoutMs: 240000,
  });
}

function firstMeta(first, truncated) {
  return {
    truncated,
    chunked: first.chunked || undefined,
    chunked_failed: first.chunked_failed || undefined,
    sections: first.sections || undefined,
    sections_failed: first.sections_failed || undefined,
  };
}

async function finalizeSuccess(cfg, first, started, request, cacheKey, ipHash, extraMeta) {
  const { parsed, repaired } = await parseAndRepair(cfg, first, request);
  const ms = Date.now() - started;
  const meta = {
    provider: first.provider,
    model: first.model,
    ms,
    attempts: first.attempts,
    repaired,
    ...(extraMeta || {}),
  };
  await recordTokenUsage(first.provider, first.usage, first.officialUsage);
  const result = parsed ? normalizeResult(parsed) : { raw_content: first.content };
  // A parseable answer with no driver code at all is a degraded result
  // (weak model or truncated output). Flag it so the UI can warn instead
  // of presenting a hollow success.
  meta.degraded =
    !parsed ||
    ((result.driver_functions || []).length === 0 &&
      !(result.initialization && result.initialization.code));
  if (
    extraMeta &&
    Array.isArray(extraMeta.sections_failed) &&
    extraMeta.sections_failed.some((s) => s === 'overview' || s === 'init')
  ) {
    meta.degraded = true;
  }
  await incrementCallCount();
  await incrementIpCount(ipHash);
  for (const attempt of first.attempts) {
    if (attempt.provider === first.provider) {
      await recordProviderStat(attempt.provider, true, attempt.ms);
    } else if (attempt.error && !attempt.error.includes('未配置')) {
      await recordProviderStat(attempt.provider, false, attempt.ms);
    }
  }
  await pushEvent({
    type: 'analyze',
    ok: true,
    provider: first.provider,
    model: first.model,
    ms,
    chip: (result.chip_info && result.chip_info.model) || '',
  });
  if (parsed) await setCached(cacheKey, result, meta);
  return { result, meta };
}

async function recordFailure(err, started) {
  if (err && err.attempts) {
    for (const attempt of err.attempts) {
      if (attempt.error && !attempt.error.includes('未配置')) {
        await recordProviderStat(attempt.provider, false, attempt.ms);
      }
    }
  }
  await pushEvent({
    type: 'analyze',
    ok: false,
    ms: Date.now() - started,
    error: String((err && err.message) || err).slice(0, 200),
  });
}

// Shared gate: config, access code, quotas, cache lookup. Returns either
// { errorResponse } or { cfg, cacheKey, cached, ipHash }.
async function gate(context, body) {
  const cfg = await loadConfig();

  if (cfg.access_code) {
    const code = context.request.headers.get('X-Access-Code') || '';
    if (code !== cfg.access_code) {
      return {
        errorResponse: jsonResponse(
          { success: false, error: '访问口令不正确', need_access_code: true },
          401
        ),
      };
    }
  }

  const ipHash = (await sha256Hex(clientIp(context.request))).slice(0, 16);

  const cacheKey = await cacheKeyFor(body.text, body.mcu, body.language);
  if (!body.force) {
    const cached = await getCached(cacheKey);
    if (cached) return { cfg, cacheKey, cached, ipHash };
  }

  const todayCount = await getTodayCount();
  if (todayCount >= cfg.daily_limit) {
    return {
      errorResponse: jsonResponse(
        { success: false, error: `今日调用次数已达上限 (${cfg.daily_limit} 次)` },
        429
      ),
    };
  }
  if (cfg.ip_daily_limit > 0) {
    const ipCount = await getIpCount(ipHash);
    if (ipCount >= cfg.ip_daily_limit) {
      return {
        errorResponse: jsonResponse(
          { success: false, error: `你今日的调用次数已达上限 (${cfg.ip_daily_limit} 次)` },
          429
        ),
      };
    }
  }
  return { cfg, cacheKey, cached: null, ipHash };
}

export async function onRequest(context) {
  const preflight = handleOptions(context.request);
  if (preflight) return preflight;

  if (context.request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  if (!kvAvailable()) {
    return jsonResponse({ success: false, error: KV_MISSING_MESSAGE }, 503);
  }

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return jsonResponse({ success: false, error: '请求体不是合法 JSON' }, 400);
  }
  const { text, mcu, language } = body || {};
  if (!text || !mcu || !language) {
    return jsonResponse({ success: false, error: '缺少必要参数：text, mcu, language' }, 400);
  }
  const truncated = text.length > MAX_TEXT_CHARS;
  const finalText = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;
  const gated = await gate(context, { ...body, text: finalText });
  if (gated.errorResponse) return gated.errorResponse;
  const { cfg, cacheKey, cached, ipHash } = gated;

  // ---- streaming mode (SSE) ----
  if (body.stream) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          } catch (e) {
            // client went away
          }
        };
        // Heartbeats for the whole response lifetime: provider legs can
        // stay silent for a long time (queueing, prompt processing) and
        // any idle timeout along the client path would otherwise sever
        // the stream mid-analysis.
        const heartbeat = setInterval(() => send({ type: 'heartbeat' }), 5000);
        try {
        if (cached) {
          send({
            type: 'done',
            result: cached.result,
            meta: { ...cached.meta, cached: true, truncated },
          });
          controller.close();
          return;
        }
        const started = Date.now();
        try {
          const first = await analyzeWithBuiltInFirst(cfg, finalText, mcu, language, context.request, (evt) => {
            if (evt.type === 'provider') {
              send({ type: 'provider', provider: evt.provider, model: evt.model });
            } else if (evt.type === 'delta') {
              send({ type: 'delta', chars: evt.chars, tail: evt.tail });
            } else if (evt.type === 'heartbeat') {
              send({ type: 'heartbeat' });
            }
          });
          const { result, meta } = await finalizeSuccess(cfg, first, started, context.request, cacheKey, ipHash, firstMeta(first, truncated));
          send({ type: 'done', result, meta });
        } catch (err) {
          await recordFailure(err, started);
          send({
            type: 'error',
            error: `分析失败：${err.message}`,
            attempts: err.attempts || undefined,
          });
        }
        controller.close();
        } finally {
          clearInterval(heartbeat);
        }
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=UTF-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ---- plain JSON mode ----
  if (cached) {
    return jsonResponse({
      success: true,
      result: cached.result,
      meta: { ...cached.meta, cached: true, truncated },
    });
  }
  const started = Date.now();
  try {
    const first = await analyzeWithBuiltInFirst(cfg, finalText, mcu, language, context.request, null);
    const { result, meta } = await finalizeSuccess(cfg, first, started, context.request, cacheKey, ipHash, firstMeta(first, truncated));
    return jsonResponse({ success: true, result, meta });
  } catch (err) {
    await recordFailure(err, started);
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
