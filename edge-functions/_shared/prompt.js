// Prompt construction and tolerant JSON extraction. Models regularly wrap
// JSON in code fences or pad it with prose, so extraction tries a direct
// parse, then a brace slice, and the caller may ask the model to repair the
// text once before giving up and returning the raw content.

export function buildMessages(text, mcu, language) {
  const user = `你是一位嵌入式硬件工程师。请根据下面的芯片数据手册内容，为 ${mcu} 平台生成 ${language} 语言的驱动代码。严格输出 JSON，不要 markdown 代码围栏，不要任何额外文字。

输出格式：
{
  "chip_info": {"model":"型号","purpose":"用途","power_supply":"供电","temperature_range":"温度范围","communication":"通信接口","pin_description":"关键引脚说明"},
  "working_principle": "200字内的工作原理简介",
  "pins": [{"pin":"引脚号或名称","name":"信号名","function":"功能说明"}],
  "registers": [{"name":"寄存器名","address":"地址(手册未给则留空字符串)","description":"功能说明","reset_value":"复位值(手册未给则留空字符串)"}],
  "driver_functions": [
    {"name":"函数名","description":"功能说明","code":"完整代码"}
  ],
  "initialization": {"description":"初始化说明","code":"完整代码"},
  "usage_notes": ["注意事项1","注意事项2","注意事项3"]
}

要求：
1. driver_functions 给出 2 到 4 个最核心的驱动函数，代码精简实用、可以直接参考使用
2. pins 从手册引脚说明中提取，最多 24 条，提取不到给空数组，不要编造
3. registers 从手册寄存器表中提取，最多 20 条，提取不到给空数组，不要编造地址
4. 关键位置加中文注释，不要过度注释
5. 手册信息不足时基于该类芯片的通用知识合理推断，并在 usage_notes 里注明哪些是推断
6. 不要编造手册中明确写出的参数，电气参数以手册为准

数据手册内容：
${text}`;
  return [
    { role: 'system', content: '你是嵌入式硬件工程师，只输出纯 JSON，不要 markdown，不要额外文字。' },
    { role: 'user', content: user },
  ];
}

export function buildRepairMessages(broken) {
  return [
    {
      role: 'system',
      content:
        '你是一个 JSON 修复工具。把用户给出的内容修复成一个合法的 JSON 对象，只输出 JSON 本身，不要 markdown，不要任何解释。保持原有字段和内容，不要删减代码。',
    },
    { role: 'user', content: broken.slice(0, 60000) },
  ];
}

// Follow-up questions about the manual after an analysis. Plain text
// answer, grounded in the manual text; the caller disables JSON mode.
export function buildChatMessages(text, history, question) {
  const messages = [
    {
      role: 'system',
      content:
        '你是一位嵌入式硬件工程师，正在根据一份芯片数据手册回答问题。只依据手册内容回答，手册未提及的就明确说"手册未提及"，不要编造参数。回答简洁、直接，可以使用简短的列表。',
    },
    { role: 'user', content: `数据手册内容（节选）：\n${text}` },
    { role: 'assistant', content: '已阅读手册，请提问。' },
  ];
  const recent = Array.isArray(history) ? history.slice(-6) : [];
  for (const turn of recent) {
    if (turn && (turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string') {
      messages.push({ role: turn.role, content: turn.content.slice(0, 2000) });
    }
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

export function extractJson(content) {
  if (!content) return null;
  const cleaned = content
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // fall through to brace slicing
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }
  return null;
}

// Normalize a parsed result so the frontend can render any model output
// without special cases. Missing pieces become empty defaults.
export function normalizeResult(parsed) {
  const result = {
    chip_info: {
      model: '',
      purpose: '',
      power_supply: '',
      temperature_range: '',
      communication: '',
      pin_description: '',
    },
    working_principle: '',
    pins: [],
    registers: [],
    driver_functions: [],
    initialization: { description: '', code: '' },
    usage_notes: [],
  };
  if (!parsed || typeof parsed !== 'object') return result;
  if (parsed.chip_info && typeof parsed.chip_info === 'object') {
    for (const key of Object.keys(result.chip_info)) {
      if (parsed.chip_info[key] != null) result.chip_info[key] = String(parsed.chip_info[key]);
    }
  }
  if (parsed.working_principle != null) result.working_principle = String(parsed.working_principle);
  if (Array.isArray(parsed.pins)) {
    result.pins = parsed.pins
      .filter((p) => p && typeof p === 'object')
      .slice(0, 24)
      .map((p) => ({
        pin: String(p.pin || ''),
        name: String(p.name || ''),
        function: String(p.function || ''),
      }));
  }
  if (Array.isArray(parsed.registers)) {
    result.registers = parsed.registers
      .filter((r) => r && typeof r === 'object')
      .slice(0, 20)
      .map((r) => ({
        name: String(r.name || ''),
        address: String(r.address || ''),
        description: String(r.description || ''),
        reset_value: String(r.reset_value || ''),
      }));
  }
  if (Array.isArray(parsed.driver_functions)) {
    result.driver_functions = parsed.driver_functions
      .filter((f) => f && typeof f === 'object')
      .map((f) => ({
        name: String(f.name || 'driver'),
        description: String(f.description || ''),
        code: String(f.code || ''),
      }));
  }
  if (parsed.initialization && typeof parsed.initialization === 'object') {
    result.initialization = {
      description: String(parsed.initialization.description || ''),
      code: String(parsed.initialization.code || ''),
    };
  }
  if (Array.isArray(parsed.usage_notes)) {
    result.usage_notes = parsed.usage_notes.map((n) => String(n));
  }
  return result;
}
