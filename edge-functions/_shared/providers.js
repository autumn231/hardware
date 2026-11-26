// AI provider layer. Every preset speaks the OpenAI chat completions dialect,
// so one caller serves all of them. Callers walk the configured provider
// order and fall back on network errors, timeouts, rate limits and server
// errors, which is what makes a flaky route to one vendor survivable.

export const PROVIDERS = {
  makers: {
    name: 'EdgeOne 官方内置',
    baseUrl: 'https://ai-gateway.edgeone.link/v1',
    defaultModel: '@makers/deepseek-v4-flash',
    jsonMode: true,
    // The Makers gateway implements no GET /models (404 Invalid request
    // path), so the connectivity probe must use a minimal chat call.
    probeViaChat: true,
    // The gateway severs streaming responses at ~20 s (verified
    // 2026-11-26: a user run and a sandbox repro both cut at 19-20 s
    // while OpenRouter streams ran up to 195 s through the same stack),
    // and the severing kills the whole edge function, leaving no chance
    // for fallback or an error event. Makers is therefore called
    // non-streamed (long timeout) inside the SSE response instead,
    // with heartbeats keeping the client leg alive.
    pseudoStream: true,
    // Built-in model catalogue (official Makers list, 2026-11-26). The
    // admin UI renders this as a dropdown. No per-model rate annotation:
    // the gateway never returns its official quota deduction (verified
    // 2026-11-26 by dumping response keys and headers in both stream
    // and non-stream modes), so multipliers are not measurable here.
    models: [
      { id: '@makers/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
      { id: '@makers/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { id: '@makers/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash' },
      { id: '@makers/kimi-k2.6', label: 'Kimi K2.6' },
      { id: '@makers/minimax-m3', label: 'MiniMax M3' },
      { id: '@makers/minimax-m2.7', label: 'MiniMax M2.7' },
      { id: '@makers/hy3', label: '混元 Hy3' },
      { id: '@makers/hy3-preview', label: '混元 Hy3 Preview' },
    ],
    extraBody: {},
    keyHint: '在 EdgeOne 控制台 Makers → Models → API Key 创建的密钥',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    jsonMode: false,
    extraBody: {},
    keyHint: '在 openrouter.ai/keys 申请的 API Key',
  },
};

const CALL_TIMEOUT_MS = 50000;
const STREAM_TIMEOUT_MS = 150000;

function providerBaseUrl(id, providerCfg) {
  return PROVIDERS[id].baseUrl;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildRequest(id, providerCfg, messages, request, opts) {
  const preset = PROVIDERS[id];
  if (!preset) throw new Error(`未知供应商 ${id}`);
  const baseUrl = providerBaseUrl(id, providerCfg);
  if (!baseUrl) throw new Error(`${preset.name} 未填写接口地址`);
  if (!providerCfg.key) throw new Error(`${preset.name} 未配置 API Key`);
  const model = providerCfg.model || preset.defaultModel;
  if (!model) throw new Error(`${preset.name} 未填写模型`);

  const headers = {
    Authorization: `Bearer ${providerCfg.key}`,
    'Content-Type': 'application/json',
  };
  if (id === 'openrouter' && request) {
    const origin = request.headers.get('Origin') || '';
    if (origin) headers['HTTP-Referer'] = origin;
    headers['X-OpenRouter-Title'] = 'Hardware Data Analyzer';
  }

  const wantJson = opts && opts.jsonMode !== undefined ? opts.jsonMode : preset.jsonMode;
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 8192,
    ...preset.extraBody,
  };
  if (wantJson) body.response_format = { type: 'json_object' };
  if (opts && opts.stream) body.stream = true;
  return { url: `${baseUrl}/chat/completions`, headers, body, model, preset };
}

// One chat completion call against one provider. Throws an Error whose
// message is safe to show an admin. Returns the message content string.
// opts: { jsonMode?: boolean } — chat answers want plain text, analysis
// wants JSON mode where the preset supports it.
export async function callProvider(id, providerCfg, messages, request, opts) {
  const { url, headers, body, model, preset } = buildRequest(id, providerCfg, messages, request, opts);
  const timeoutMs = (opts && opts.timeoutMs) || CALL_TIMEOUT_MS;
  const send = (payload) =>
    fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) }, timeoutMs);

  let res;
  try {
    res = await send(body);
    if (res.status === 400 && body.response_format) {
      // Some models reject response_format. Retry once without it.
      const retryBody = { ...body };
      delete retryBody.response_format;
      res = await send(retryBody);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`${preset.name} 请求超时（${timeoutMs / 1000} 秒）`);
    }
    throw new Error(`${preset.name} 网络连不上：${(e && e.message) || e}`);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${preset.name} 返回 ${res.status}：${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const message = data.choices && data.choices[0] && data.choices[0].message;
  const content = message && message.content;
  if (!content) {
    throw new Error(`${preset.name} 返回内容为空`);
  }
  return { content, model, usage: data.usage || null, officialUsage: data.makers_models_usage || null };
}

// Walk the configured order until one provider answers. Returns the winning
// content plus the full attempt log so the UI can show what actually served
// the request and what failed along the way.
export async function chatWithFallback(cfg, messages, request, opts) {
  const attempts = [];
  for (const id of cfg.order) {
    const providerCfg = cfg.providers[id] || {};
    if (!providerCfg.key) {
      attempts.push({ provider: id, ok: false, error: '未配置 Key，已跳过' });
      continue;
    }
    const started = Date.now();
    try {
      const { content, model, usage, officialUsage } = await callProvider(id, providerCfg, messages, request, opts);
      attempts.push({ provider: id, ok: true, ms: Date.now() - started });
      return { content, provider: id, model, usage, officialUsage, attempts };
    } catch (e) {
      attempts.push({
        provider: id,
        ok: false,
        ms: Date.now() - started,
        error: String((e && e.message) || e).slice(0, 300),
      });
    }
  }
  const err = new Error('所有已配置的供应商都调用失败');
  err.attempts = attempts;
  throw err;
}

// Streaming variant used by the analysis endpoint. onEvent receives
// { type: 'provider', provider, model } once a provider starts answering,
// then { type: 'delta', chars } as content grows. Fallback only happens
// before the first token: once a provider is streaming, it owns the call.
export async function streamChatWithFallback(cfg, messages, request, onEvent) {
  const attempts = [];
  for (const id of cfg.order) {
    const providerCfg = cfg.providers[id] || {};
    if (!providerCfg.key) {
      attempts.push({ provider: id, ok: false, error: '未配置 Key，已跳过' });
      continue;
    }
    const started = Date.now();
    try {
      const result = PROVIDERS[id].pseudoStream
        ? await pseudoStreamProvider(id, providerCfg, messages, request, onEvent)
        : await streamProvider(id, providerCfg, messages, request, onEvent);
      attempts.push({ provider: id, ok: true, ms: Date.now() - started });
      return { ...result, attempts };
    } catch (e) {
      attempts.push({
        provider: id,
        ok: false,
        ms: Date.now() - started,
        error: String((e && e.message) || e).slice(0, 300),
      });
    }
  }
  const err = new Error('所有已配置的供应商都调用失败');
  err.attempts = attempts;
  throw err;
}

// Pseudo-streaming for providers whose real streams are unreliable:
// one non-streamed call with a long timeout, heartbeats to keep the
// client connection warm, and the full content as a single delta at
// the end. If the call fails the error is catchable here, so the
// fallback chain still works — unlike a severed real stream, which
// takes the whole function down with it.
async function pseudoStreamProvider(id, providerCfg, messages, request, onEvent) {
  const preset = PROVIDERS[id];
  onEvent({ type: 'provider', provider: id, model: providerCfg.model || preset.defaultModel });
  const heartbeat = setInterval(() => {
    try {
      onEvent({ type: 'heartbeat' });
    } catch (e) {
      // event sink is best-effort
    }
  }, 5000);
  try {
    const { content, model, usage, officialUsage } = await callProvider(
      id,
      providerCfg,
      messages,
      request,
      { timeoutMs: 240000 }
    );
    onEvent({ type: 'delta', chars: content.length, tail: content.slice(-400) });
    return { content, provider: id, model, usage, officialUsage };
  } finally {
    clearInterval(heartbeat);
  }
}

async function streamProvider(id, providerCfg, messages, request, onEvent) {
  const { url, headers, body, model, preset } = buildRequest(id, providerCfg, messages, request, { stream: true });
  body.stream_options = { include_usage: true };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 400 && (body.response_format || body.stream_options)) {
      const retryBody = { ...body };
      delete retryBody.response_format;
      delete retryBody.stream_options;
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(retryBody),
        signal: controller.signal,
      });
    }
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error(`${preset.name} 流式请求超时`);
    throw new Error(`${preset.name} 网络连不上：${(e && e.message) || e}`);
  }
  if (!res.ok || !res.body) {
    clearTimeout(timer);
    const errText = res.body ? await res.text().catch(() => '') : '';
    throw new Error(`${preset.name} 返回 ${res.status}：${errText.slice(0, 300)}`);
  }

  onEvent({ type: 'provider', provider: id, model });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let usage = null;
  let officialUsage = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          if (json.usage) usage = json.usage;
          if (json.makers_models_usage) officialUsage = json.makers_models_usage;
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          const piece = (delta && delta.content) || '';
          if (piece) {
            content += piece;
            onEvent({ type: 'delta', chars: content.length, tail: content.slice(-400) });
          }
        } catch (e) {
          // Partial or non-JSON SSE lines are ignored.
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (!content) throw new Error(`${preset.name} 流式返回内容为空`);
  return { content, provider: id, model, usage, officialUsage };
}

// Lightweight reachability probe used by the admin connectivity test. It
// calls the provider's model list from inside the edge function, which is
// the only vantage point that matters for this deployment.
export async function probeProvider(id, providerCfg) {
  const preset = PROVIDERS[id];
  if (!preset) return { ok: false, error: `未知供应商 ${id}` };
  const baseUrl = providerBaseUrl(id, providerCfg || {});
  if (!baseUrl) return { ok: false, error: '未填写接口地址' };
  if (!providerCfg || !providerCfg.key) return { ok: false, error: '未配置 API Key' };
  const started = Date.now();
  try {
    const res = preset.probeViaChat
      ? await fetchWithTimeout(
          `${baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${providerCfg.key}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: providerCfg.model || preset.defaultModel,
              messages: [{ role: 'user', content: 'ping' }],
              max_tokens: 1,
              stream: false,
            }),
          },
          15000
        )
      : await fetchWithTimeout(
          `${baseUrl}/models`,
          { method: 'GET', headers: { Authorization: `Bearer ${providerCfg.key}` } },
          15000
        );
    const ms = Date.now() - started;
    if (res.ok) return { ok: true, ms };
    const errText = await res.text();
    return { ok: false, ms, error: `返回 ${res.status}：${errText.slice(0, 200)}` };
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - started,
      error:
        e && e.name === 'AbortError'
          ? '连接超时（15 秒）'
          : `网络连不上：${(e && e.message) || e}`,
    };
  }
}
