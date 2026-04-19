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
  return `你是一位资深硬件工程师和嵌入式软件开发专家。请根据以下硬件芯片数据手册的文本内容，进行专业分析。

目标MCU平台：${mcu}
目标编程语言：${language}

请严格按照以下JSON格式返回分析结果，不要添加任何markdown标记或额外文字，直接返回纯JSON：

{
  "chip_info": {
    "model": "芯片型号",
    "purpose": "芯片主要用途",
    "power_supply": "供电要求（电压、电流）",
    "temperature_range": "工作温度范围",
    "communication": "支持的通信接口/协议",
    "pin_description": "主要引脚功能说明"
  },
  "working_principle": "芯片工作原理简介（200-500字）",
  "driver_functions": [
    {
      "name": "函数名称1",
      "description": "该函数的功能说明",
      "code": "完整的函数实现代码"
    },
    {
      "name": "函数名称2",
      "description": "该函数的功能说明",
      "code": "完整的函数实现代码"
    }
  ],
  "initialization": {
    "description": "初始化步骤说明",
    "code": "完整的初始化代码"
  },
  "usage_notes": ["注意事项1", "注意事项2", "注意事项3", "注意事项4", "注意事项5"]
}

要求：
1. 两个驱动函数必须是最核心、最常用的功能函数（如读写寄存器、数据采集、通信发送等）
2. 初始化代码必须完整可运行，包含所有必要的配置步骤
3. 代码风格要通用实用，添加必要的错误处理
4. 代码必须针对${mcu}平台和${language}语言编写
5. 如果数据手册信息不足以确定某些细节，请根据芯片类型和常见用法给出合理的专业推断
6. **代码中必须在关键位置添加中文注释**：包括但不限于以下位置——函数功能说明、关键参数含义、重要寄存器操作、时序要求、错误处理分支、引脚定义说明。注释要简洁实用，不要过度注释，只标注工程师真正需要关注的要点

以下是数据手册文本内容：
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

    const truncatedText = text.length > 80000 ? text.substring(0, 80000) + '\n\n[注意：文本过长已截断]' : text;
    const model = await getModel();
    const prompt = buildPrompt(truncatedText, mcu, language);

    const openrouterRes = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hardware-analyzer.pages.edgeone.ai',
        'X-OpenRouter-Title': 'Hardware Data Analyzer',
      },
      body: JSON.stringify({
        model: model,
        messages: [
          {
            role: 'system',
            content: '你是一位专业的硬件工程师和嵌入式开发专家，擅长分析芯片数据手册并编写驱动代码。请始终以纯JSON格式返回结果，不要使用markdown代码块包裹。',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.3,
        max_tokens: 4096,
      }),
    });

    if (!openrouterRes.ok) {
      const errText = await openrouterRes.text();
      return jsonResponse({ success: false, error: `OpenRouter API 调用失败: ${openrouterRes.status} - ${errText}` }, 502);
    }

    const openrouterData = await openrouterRes.json();
    const content = openrouterData.choices?.[0]?.message?.content;

    if (!content) {
      return jsonResponse({ success: false, error: 'OpenRouter 返回内容为空' }, 502);
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
