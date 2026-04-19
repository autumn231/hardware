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

  const authenticated = await verifyToken(context.request);
  if (!authenticated) {
    return jsonResponse({ success: false, error: '未授权，请重新登录' }, 401);
  }

  try {
    if (context.request.method === 'GET') {
      const apiKey = await AI_HARDWARE_TOOL.get('api_key');
      const model = await AI_HARDWARE_TOOL.get('model') || 'openai/gpt-4o';
      const dailyLimit = await AI_HARDWARE_TOOL.get('daily_limit') || '100';

      const maskedKey = apiKey
        ? apiKey.substring(0, 6) + '****' + apiKey.substring(apiKey.length - 4)
        : '';

      return jsonResponse({
        success: true,
        config: {
          api_key_set: !!apiKey,
          api_key_masked: maskedKey,
          model,
          daily_limit: Number(dailyLimit),
        },
      });
    }

    if (context.request.method === 'POST') {
      const body = await context.request.json();
      const updates = [];

      if (body.api_key !== undefined) {
        await AI_HARDWARE_TOOL.put('api_key', body.api_key);
        updates.push('api_key');
      }
      if (body.model !== undefined) {
        await AI_HARDWARE_TOOL.put('model', body.model);
        updates.push('model');
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
