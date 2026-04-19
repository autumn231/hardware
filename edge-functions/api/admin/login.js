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

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 32; i++) {
    token += chars[arr[i] % chars.length];
  }
  return token;
}

export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders() });
  }

  if (context.request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Method not allowed' }, 405);
  }

  if (typeof AI_HARDWARE_TOOL === 'undefined') {
    return jsonResponse({ success: false, error: 'KV 存储未绑定，请在 EdgeOne Pages 控制台绑定 KV 命名空间后重新部署' }, 503);
  }

  try {
    const body = await context.request.json();
    const { password } = body;

    if (!password) {
      return jsonResponse({ success: false, error: '请输入密码' }, 400);
    }

    const storedPassword = await AI_HARDWARE_TOOL.get('admin_password');
    const correctPassword = storedPassword || 'admin123';

    if (password !== correctPassword) {
      return jsonResponse({ success: false, error: '密码错误' }, 401);
    }

    const token = generateToken();
    await AI_HARDWARE_TOOL.put('session_token', token);

    return jsonResponse({ success: true, token });
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误: ${err.message}` }, 500);
  }
}
