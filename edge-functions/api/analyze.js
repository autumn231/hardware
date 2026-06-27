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

function getTodayKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `call_count_${y}-${m}-${d}`;
}

async function getApiKey() {
  const key = await AI_HARDWARE_TOOL.get('api_key');
  return key || '';
}

async function getModel() {
  const model = await AI_HARDWARE_TOOL.get('model');
  return model || 'openai/gpt-4o';
}

async function getDailyLimit() {
  const limit = await AI_HARDWARE_TOOL.get('daily_limit');
  return limit ? Number(limit) : 100;
}

async function getTodayCount() {
  const key = getTodayKey();
  const count = await AI_HARDWARE_TOOL.get(key);
  return count ? Number(count) : 0;
}

async function getTotalCount() {
  const count = await AI_HARDWARE_TOOL.get('total_calls');
  return count ? Number(count) : 0;
}

async function incrementCallCount() {
  const todayKey = getTodayKey();
  const todayCount = await getTodayCount();
  await AI_HARDWARE_TOOL.put(todayKey, String(todayCount + 1));
  const totalCount = await getTotalCount();
  await AI_HARDWARE_TOOL.put('total_calls', String(totalCount + 1));
}

function buildPrompt(text, mcu, language) {
  return `你是一位嵌入式硬件工程师。请根据芯片数据手册，为${mcu}平台生成${language}语言驱动代码。严格输出JSON，不要markdown和额外文字。

输出格式：
{
  "chip_info": {"model":"型号","purpose":"用途","power_supply":"供电","temperature_range":"温度","communication":"通信接口","pin_description":"关键引脚"},
  "working_principle": "200字内工作原理",
  "driver_functions": [
    {"name":"函数名","description":"功能","code":"代码"},
    {"name":"函数名","description":"功能","code":"代码"}
  ],
  "initialization": {"description":"初始化说明","code":"代码"},
  "usage_notes": ["注意1","注意2","注意3"]
}

要求：
1. 只生成2个最核心驱动函数+1个初始化函数，代码精简实用
2. 关键位置加中文注释，不要过度注释
3. 信息不足时合理推断
4. 输出简短，拒绝冗余

数据手册：
${text}`;
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
    const apiKey = await getApiKey();
    if (!apiKey) {
      return jsonResponse({ success: false, error: 'API Key 未配置，请在管理后台设置' }, 400);
    }

    const todayCount = await getTodayCount();
    const dailyLimit = await getDailyLimit();
    if (todayCount >= dailyLimit) {
      return jsonResponse({ success: false, error: `今日调用次数已达上限 (${dailyLimit} 次)` }, 429);
    }

    const body = await context.request.json();
    const { text, mcu, language } = body;

    if (!text || !mcu || !language) {
      return jsonResponse({ success: false, error: '缺少必要参数：text, mcu, language' }, 400);
    }

    const truncatedText = text.length > 50000 ? text.substring(0, 50000) + '\n\n[文本已截断]' : text;
    const model = await getModel();
    const prompt = buildPrompt(truncatedText, mcu, language);

    const openrouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hardware.tbit.xin',
        'X-OpenRouter-Title': 'Hardware Data Analyzer',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: '你是嵌入式硬件工程师，输出纯JSON，不要markdown。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 2048,
      }),
    });

    if (!openrouterRes.ok) {
      const errText = await openrouterRes.text();
      console.error(`OpenRouter API error: status=${openrouterRes.status}, body=${errText}`);
      return jsonResponse({ success: false, error: `OpenRouter API 调用失败: ${openrouterRes.status} - ${errText}` }, 502);
    }

    const openrouterData = await openrouterRes.json();
    const content = openrouterData.choices?.[0]?.message?.content;

    if (!content) {
      console.error('OpenRouter response empty:', JSON.stringify(openrouterData));
      return jsonResponse({ success: false, error: 'OpenRouter 返回内容为空', details: openrouterData }, 502);
    }

    let parsed;
    try {
      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      parsed = { raw_content: content };
    }

    await incrementCallCount();

    return jsonResponse({ success: true, result: parsed });
  } catch (err) {
    return jsonResponse({ success: false, error: `服务器错误: ${err.message}` }, 500);
  }
}
