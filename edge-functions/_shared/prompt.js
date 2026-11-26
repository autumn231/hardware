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

// Sectioned analysis used for long manuals. The Makers gateway severs
// requests whose generation runs past roughly 20 seconds, so one huge
// completion is split into several small completions that each finish
// quickly on the built-in model and run in parallel. Each section gets a
// keyword-scored excerpt instead of the whole manual, which also cuts
// prompt-processing time.
export const ANALYSIS_SECTIONS = [
  {
    id: 'overview',
    label: '基本信息',
    budget: 16000,
    maxTokens: 1400,
    keywords: ['feature', 'description', 'application', 'overview', 'power supply', 'temperature', 'interface', '特性', '概述', '用途', '供电', '温度范围', '通信接口'],
    format:
      '{"chip_info":{"model":"型号","purpose":"用途","power_supply":"供电","temperature_range":"温度范围","communication":"通信接口","pin_description":"关键引脚说明"},"working_principle":"120字内的工作原理简介","usage_notes":["注意事项1","注意事项2","注意事项3"]}',
    extra: 'usage_notes 给 3 条；手册信息不足时可基于同类芯片合理推断，但要在 usage_notes 里注明哪些是推断。',
  },
  {
    id: 'pins',
    label: '引脚定义',
    budget: 18000,
    maxTokens: 1800,
    keywords: ['pin', 'package', 'terminal', 'pin description', '引脚', '管脚', '封装', 'vdd', 'vss', 'sda', 'scl', 'soic', 'qfn'],
    format: '{"pins":[{"pin":"引脚号或名称","name":"信号名","function":"28字内功能说明"}]}',
    extra: '最多 24 条；提取不到就给空数组，不要编造引脚。',
  },
  {
    id: 'registers',
    label: '寄存器表',
    budget: 24000,
    maxTokens: 2000,
    keywords: ['register', 'address', 'reset value', 'bit', 'field', 'configuration', 'temperature register', '寄存器', '地址', '复位值', '位定义', '配置寄存器'],
    format:
      '{"registers":[{"name":"寄存器名","address":"地址(手册未给则留空字符串)","description":"32字内功能说明","reset_value":"复位值(手册未给则留空字符串)"}]}',
    extra: '最多 20 条；提取不到就给空数组，不要编造地址或复位值。',
  },
  {
    id: 'init',
    label: '初始化代码',
    budget: 20000,
    maxTokens: 1800,
    keywords: ['interface', 'timing', 'command', 'configuration', 'initialize', 'address', 'i2c', 'spi', 'uart', '接口', '时序', '命令', '配置', '初始化', '器件地址'],
    format: '{"initialization":{"description":"初始化说明","code":"完整代码，尽量控制在1200字符内"}}',
    extra: '代码包含总线/外设初始化与芯片关键配置；关键位置加中文注释，不要过度注释。',
  },
  {
    id: 'funcs_a',
    label: '基础读写函数',
    budget: 24000,
    maxTokens: 2200,
    keywords: ['register', 'write', 'read', 'command', 'interface', 'address', 'i2c', 'spi', '寄存器', '写入', '读取', '命令', '接口', '器件地址'],
    format: '{"driver_functions":[{"name":"函数名","description":"功能说明","code":"完整代码"}]}',
    extra:
      '只给 2 个最基础的驱动函数：优先寄存器/命令写入与读取。函数命名保持稳定，例如 Chip_WriteRegister、Chip_ReadRegister；代码自包含、精简实用，不要生成初始化代码。',
  },
  {
    id: 'funcs_b',
    label: '数据与配置函数',
    budget: 24000,
    maxTokens: 2200,
    keywords: ['data', 'conversion', 'measurement', 'threshold', 'mode', 'status', 'alert', '数据', '转换', '测量', '阈值', '模式', '状态', '报警'],
    format: '{"driver_functions":[{"name":"函数名","description":"功能说明","code":"完整代码"}]}',
    extra:
      '只给 1 个进阶函数：读取并换算测量数据，或设置工作模式/阈值（二选一）。不要重复基础读写函数名；代码控制在 900 字符内，必须是合法 JSON 字符串（换行、引号、反斜杠正确转义）；手册依据不足时在 description 里说明。',
  },
];

function splitTextBlocks(text) {
  const paragraphs = String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const blocks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (paragraph.length > 2600) {
      if (current) blocks.push(current);
      current = '';
      for (let i = 0; i < paragraph.length; i += 2600) {
        blocks.push(paragraph.slice(i, i + 2600));
      }
    } else if (!current || (current + '\n' + paragraph).length <= 2600) {
      current = current ? current + '\n' + paragraph : paragraph;
    } else {
      blocks.push(current);
      current = paragraph;
    }
  }
  if (current) blocks.push(current);
  return blocks.length ? blocks : [String(text || '')];
}

function countOccurrences(lowerText, keyword) {
  const needle = String(keyword || '').toLowerCase();
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    idx = lowerText.indexOf(needle, idx);
    if (idx === -1) break;
    count += 1;
    idx += Math.max(needle.length, 1);
  }
  return count;
}

export function selectSectionText(text, section) {
  if (!text || text.length <= section.budget) return text;
  const blocks = splitTextBlocks(text);
  const scored = blocks.map((block, i) => {
    const lower = block.toLowerCase();
    let score = 0;
    for (const keyword of section.keywords) {
      score += countOccurrences(lower, keyword) * (keyword.length > 3 ? 2 : 1);
    }
    if (/0x[0-9a-f]+|\btable\b|表\s*\d+|figure|图\s*\d+/i.test(block)) score += 2;
    if (i === 0 && ['overview', 'init', 'funcs_a', 'funcs_b'].includes(section.id)) score += 6;
    return { i, block, score };
  });
  const picked = new Set();
  let used = 0;
  const add = (item) => {
    if (!item || picked.has(item.i)) return;
    if (used + item.block.length > section.budget && picked.size > 0) return;
    picked.add(item.i);
    used += item.block.length;
  };
  if (['overview', 'init', 'funcs_a', 'funcs_b'].includes(section.id)) add(scored[0]);
  scored
    .slice()
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .forEach((item) => {
      if (item.score > 0) add(item);
    });
  if (!picked.size) scored.slice(0, Math.min(3, scored.length)).forEach(add);
  const ordered = [...picked].sort((a, b) => a - b);
  return (
    `（以下为从手册全文中按「${section.label}」相关性自动选取的片段）\n\n` +
    ordered.map((i) => blocks[i]).join('\n\n')
  );
}

export function buildSectionMessages(section, text, mcu, language) {
  const excerpt = selectSectionText(text, section);
  const user = `你是一位嵌入式硬件工程师。请根据下面的芯片数据手册片段，只完成「${section.label}」这一部分，为 ${mcu} 平台生成 ${language} 语言相关内容。严格输出 JSON，不要 markdown 代码围栏，不要任何额外文字。

输出格式：
${section.format}

要求：
1. 只输出上面格式里的字段，不要输出其他分析部分
2. ${section.extra}
3. 电气参数、引脚、寄存器地址以手册片段为准；片段未提及的表格数据不要编造
4. 代码精简实用，关键位置加中文注释，不要过度注释

数据手册片段：
${excerpt}`;
  return [
    { role: 'system', content: '你是嵌入式硬件工程师，只输出纯 JSON，不要 markdown，不要额外文字。' },
    { role: 'user', content: user },
  ];
}

export function mergeSectionResults(parts) {
  const merged = {};
  const seenFunctions = new Set();
  for (const part of parts || []) {
    const parsed = part && part.parsed;
    if (!parsed || typeof parsed !== 'object') continue;
    if (parsed.chip_info) merged.chip_info = parsed.chip_info;
    if (parsed.working_principle != null) merged.working_principle = parsed.working_principle;
    if (Array.isArray(parsed.pins)) merged.pins = parsed.pins;
    if (Array.isArray(parsed.registers)) merged.registers = parsed.registers;
    if (parsed.initialization) merged.initialization = parsed.initialization;
    if (Array.isArray(parsed.usage_notes)) merged.usage_notes = parsed.usage_notes;
    if (Array.isArray(parsed.driver_functions)) {
      merged.driver_functions = merged.driver_functions || [];
      for (const fn of parsed.driver_functions) {
        const name = fn && fn.name ? String(fn.name) : '';
        if (name && seenFunctions.has(name)) continue;
        if (name) seenFunctions.add(name);
        merged.driver_functions.push(fn);
      }
    }
  }
  if (Array.isArray(merged.driver_functions)) {
    merged.driver_functions = merged.driver_functions.slice(0, 4);
  }
  return merged;
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
