function getCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      ...getCorsHeaders(),
    },
  });
}

async function verifyToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  const token = authHeader.substring(7);
  const storedToken = await AI_HARDWARE_TOOL.get('session_token');
  return token === storedToken;
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders() });
  }

  if (typeof AI_HARDWARE_TOOL === 'undefined') {
    return jsonResponse({ success: false, error: 'KV 存储未绑定，请在 EdgeOne Pages 控制台绑定 KV 命名空间后重新部署' }, 503);
  }

  const authenticated = await verifyToken(context.request);
  if (!authenticated) {
    return jsonResponse({ success: false, error: '未授权，请重新登录' }, 401);
  }

  try {
    if (context.request.method === 'GET') {
      const provider = await AI_HARDWARE_TOOL.get('provider') || 'openrouter';
      const dailyLimit = await AI_HARDWARE_TOOL.get('daily_limit') || '100';
      const providers = ['openrouter', 'deepseek'];

      const providerConfigs = {};
      for (const p of providers) {
        const key = await AI_HARDWARE_TOOL.get(`api_key_${p}`);
        const m = await AI_HARDWARE_TOOL.get(`model_${p}`);
        providerConfigs[p] = {
          api_key_set: !!key,
          api_key_masked: key ? key.substring(0, 6) + '****' + key.substring(key.length - 4) : '',
          model: m || (p === 'deepseek' ? 'deepseek-chat' : 'openai/gpt-4o'),
        };
      }

      return jsonResponse({
        success: true,
        config: {
          provider,
          daily_limit: Number(dailyLimit),
          providers: providerConfigs,
          ...providerConfigs[provider],
        },
      });
    }

    if (context.request.method === 'POST') {
      const body = await context.request.json();
      const updates = [];

      if (body.provider !== undefined) {
        await AI_HARDWARE_TOOL.put('provider', body.provider);
        updates.push('provider');
      }

      const provider = body.provider || (await AI_HARDWARE_TOOL.get('provider')) || 'openrouter';

      if (body.api_key !== undefined) {
        await AI_HARDWARE_TOOL.put(`api_key_${provider}`, body.api_key);
        updates.push(`api_key_${provider}`);
      }
      if (body.model !== undefined) {
        await AI_HARDWARE_TOOL.put(`model_${provider}`, body.model);
        updates.push(`model_${provider}`);
      }
      if (body.daily_limit !== undefined) {
        await AI_HARDWARE_TOOL.put('daily_limit', String(body.daily_limit));
        updates.push('daily_limit');
      }
      if (body.new_password !== undefined && body.new_password.length > 0) {
        await AI_HARDWARE_TOOL.put('admin_password', body.new_password);
        updates.push('admin_password');
      }

      return jsonResponse({ success: true, updated: updates });
    }

    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误: ${err.message}` }, 500);
  }
}
