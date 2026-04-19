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

function getTodayKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `call_count_${y}-${m}-${d}`;
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
      const todayKey = getTodayKey();
      const todayCount = await AI_HARDWARE_TOOL.get(todayKey);
      const totalCount = await AI_HARDWARE_TOOL.get('total_calls');
      const dailyLimit = await AI_HARDWARE_TOOL.get('daily_limit') || '100';

      const now = new Date();
      const dateStr = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;

      return jsonResponse({
        success: true,
        stats: {
          today_calls: todayCount ? Number(todayCount) : 0,
          total_calls: totalCount ? Number(totalCount) : 0,
          daily_limit: Number(dailyLimit),
          date: dateStr,
        },
      });
    }

    if (context.request.method === 'POST') {
      const body = await context.request.json();
      const { action } = body;

      if (action === 'reset_today') {
        const todayKey = getTodayKey();
        await AI_HARDWARE_TOOL.put(todayKey, '0');
        return jsonResponse({ success: true, message: '今日调用次数已重置' });
      }

      if (action === 'reset_all') {
        const todayKey = getTodayKey();
        await AI_HARDWARE_TOOL.put(todayKey, '0');
        await AI_HARDWARE_TOOL.put('total_calls', '0');
        return jsonResponse({ success: true, message: '所有调用次数已重置' });
      }

      return jsonResponse({ success: false, error: '未知操作' }, 400);
    }

    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误: ${err.message}` }, 500);
  }
}
