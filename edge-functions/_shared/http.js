// Shared HTTP helpers for EdgeOne Pages edge functions.
// Files under _shared are imported by route handlers and hold no routes
// of their own.

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Access-Code',
  };
}

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      ...corsHeaders(),
    },
  });
}

export function handleOptions(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  return null;
}

export function kvAvailable() {
  return typeof AI_HARDWARE_TOOL !== 'undefined';
}

export function kv() {
  return AI_HARDWARE_TOOL;
}

export const KV_MISSING_MESSAGE =
  'KV 存储未绑定，请在 EdgeOne Pages 控制台绑定 KV 命名空间后重新部署';
