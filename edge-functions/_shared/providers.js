// AI provider layer. Every preset speaks the OpenAI chat completions dialect,
// so one caller serves all of them. The analyze handler walks the configured
// provider order and falls back on network errors, timeouts, rate limits and
// server errors, which is what makes a flaky route to one vendor survivable.

export const PROVIDERS = {
  sensenova: {
    name: 'SenseNova（商汤）',
    baseUrl: 'https://token.sensenova.cn/v1',
    defaultModel: 'deepseek-v4-flash',
    jsonMode: false,
    // SenseNova serves DeepSeek with reasoning on by default. Reasoning eats
    // the whole token budget and returns empty content, so it is disabled.
    extraBody: { thinking: { type: 'disabled' } },
    keyHint: '在 token.sensenova.cn 申请的 API Key',
  },
  deepseek: {
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    jsonMode: true,
    extraBody: {},
    keyHint: '在 platform.deepseek.com 申请的 API Key',
  },
  gemini: {
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    jsonMode: true,
    extraBody: {},
    keyHint: '在 Google AI Studio 申请的 API Key',
  },
  openrouter: {
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o',
    jsonMode: false,
    extraBody: {},
    keyHint: '在 openrouter.ai/keys 申请的 API Key',
  },
  custom: {
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    defaultModel: '',
    jsonMode: false,
    extraBody: {},
    keyHint: '任意 OpenAI 兼容服务的 API Key',
  },
};

const CALL_TIMEOUT_MS = 50000;

function providerBaseUrl(id, providerCfg) {
  if (id === 'custom') return (providerCfg.base_url || '').replace(/\/+$/, '');
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

// One chat completion call against one provider. Throws an Error whose
// message is safe to show an admin. Returns the message content string.
export async function callProvider(id, providerCfg, messages, request) {
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

  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 8192,
    ...preset.extraBody,
  };
  if (preset.jsonMode) body.response_format = { type: 'json_object' };

  const send = (payload) =>
    fetchWithTimeout(
      `${baseUrl}/chat/completions`,
      { method: 'POST', headers, body: JSON.stringify(payload) },
      CALL_TIMEOUT_MS
    );

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
      throw new Error(`${preset.name} 请求超时（${CALL_TIMEOUT_MS / 1000} 秒）`);
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
  return { content, model };
}

// Walk the configured order until one provider answers. Returns the winning
// content plus the full attempt log so the UI can show what actually served
// the request and what failed along the way.
export async function chatWithFallback(cfg, messages, request) {
  const attempts = [];
  for (const id of cfg.order) {
    const providerCfg = cfg.providers[id] || {};
    if (!providerCfg.key) {
      attempts.push({ provider: id, ok: false, error: '未配置 Key，已跳过' });
      continue;
    }
    const started = Date.now();
    try {
      const { content, model } = await callProvider(id, providerCfg, messages, request);
      attempts.push({ provider: id, ok: true, ms: Date.now() - started });
      return { content, provider: id, model, attempts };
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
    const res = await fetchWithTimeout(
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
