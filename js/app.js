(function () {
pdfjsLib.GlobalWorkerOptions.workerSrc =
'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

var $ = function (sel) { return document.querySelector(sel);};

var fileInput = $('#pdf-file');
var fileDropZone = $('#file-drop-zone');
var fileNameDisplay = $('#file-name-display');
var fileMeta = $('#file-meta');
var mcuInput = $('#mcu-input');
var languageSelect = $('#language-select');
var analyzeBtn = $('#analyze-btn');
var uploadSection = $('#upload-section');
var progressSection = $('#progress-section');
var resultSection = $('#result-section');
var errorSection = $('#error-section');
var errorMessage = $('#error-message');
var errorDetail = $('#error-detail');
var resultCards = $('#result-cards');
var resultMeta = $('#result-meta');

// Character budget for one analysis. Manuals longer than this are packed
// by scored excerpt instead of being blindly truncated at the front.
var TEXT_BUDGET = 120000;
var HISTORY_KEY = 'hw_history_v2';
var ACCESS_CODE_KEY = 'hw_access_code';

var pageTexts = [];
var pdfFileName = '';
var pdfTotalChars = 0;
var currentResult = null;
var currentMeta = null;
var lastPayloadText = '';
var chatHistory = [];
var elapsedTimer = null;
var analyzeAbort = null;

var MCU_PRESETS = ['STM32F103C8T6', 'STM32F407VET6', 'STM32H743', 'ESP32-S3', 'GD32F103C8', 'CH32V307', 'ATmega328P', 'RP2040'];
var chipRow = $('#mcu-chips');
MCU_PRESETS.forEach(function (name) {
var chip = document.createElement('button');
chip.type = 'button';
chip.className = 'mcu-chip';
chip.textContent = name;
chip.addEventListener('click', function () { mcuInput.value = name;});
chipRow.appendChild(chip);
});

// ---------- file intake and PDF extraction ----------

fileDropZone.addEventListener('click', function () { fileInput.click();});
fileDropZone.addEventListener('dragover', function (e) {
e.preventDefault();
fileDropZone.classList.add('dragover');
});
fileDropZone.addEventListener('dragleave', function () {
fileDropZone.classList.remove('dragover');
});
fileDropZone.addEventListener('drop', function (e) {
e.preventDefault();
fileDropZone.classList.remove('dragover');
var files = e.dataTransfer.files;
if (files.length > 0) handleFile(files[0]);
});
fileInput.addEventListener('change', function (e) {
if (e.target.files.length > 0) handleFile(e.target.files[0]);
});

var MAX_FILE_BYTES = 20 * 1024 * 1024;
var MAX_PDF_PAGES = 500;
var MAX_TEXT_CHARS_LIMIT = 1500000;

async function handleFile(file) {
if (file.type!== 'application/pdf' &&!/\.pdf$/i.test(file.name)) {
showToast('请选择 PDF 文件', 'error');
return;
}
if (file.size > MAX_FILE_BYTES) {
showToast('文件过大：单个 PDF 上限 20MB', 'error');
return;
}
pdfFileName = file.name;
fileNameDisplay.textContent = file.name;
fileMeta.style.display = '';
fileMeta.textContent = '正在本地提取文本...';
analyzeBtn.disabled = true;
try {
pageTexts = await extractPdfText(file);
pdfTotalChars = pageTexts.reduce(function (sum, t) { return sum + t.length;}, 0);
if (!pdfTotalChars) {
throw new Error('PDF 中未提取到文本内容，该 PDF 可能是扫描件或图片格式');
}
if (pdfTotalChars > MAX_TEXT_CHARS_LIMIT) {
throw new Error('提取文本过长（' + pdfTotalChars.toLocaleString() + ' 字符），上限 150 万字符，请拆分手册后重试');
}
var note = '共 ' + pageTexts.length + ' 页，提取文本 ' + pdfTotalChars.toLocaleString() + ' 字符';
if (pdfTotalChars > TEXT_BUDGET) {
note += '。手册较长，分析时会自动选取关键页（特性、引脚、寄存器、电气参数相关页优先），不会只截前半部分';
}
fileMeta.textContent = note;
analyzeBtn.disabled = false;
} catch (err) {
pageTexts = [];
fileMeta.textContent = '提取失败：' + err.message;
showToast(err.message, 'error');
}
}

async function extractPdfText(file) {
var arrayBuffer = await file.arrayBuffer();
var pdf = await pdfjsLib.getDocument({ data: arrayBuffer}).promise;
if (pdf.numPages > MAX_PDF_PAGES) {
throw new Error('手册页数过多：共 ' + pdf.numPages + ' 页，上限 ' + MAX_PDF_PAGES + ' 页');
}
var pages = [];
for (var i = 1; i <= pdf.numPages; i++) {
var page = await pdf.getPage(i);
var textContent = await page.getTextContent();
var pageText = textContent.items.map(function (item) { return item.str;}).join(' ');
pages.push(pageText);
fileMeta.textContent = '正在本地提取文本... ' + i + ' / ' + pdf.numPages + ' 页';
}
return pages;
}

// ---------- excerpt packing for long manuals ----------

var KEYWORDS = [
'register', '寄存器', 'pin', '引脚', 'electrical', '电气', 'timing', '时序',
'interface', '接口', 'protocol', '协议', 'address', '地址', 'command', '命令',
'feature', '特性', 'description', '说明', 'voltage', '电流', 'current', '温度',
'temperature', 'i2c', 'spi', 'uart', 'i²c', 'block diagram', '框图', '功能',
'工作模式', 'mode', 'configuration', '配置', '初始化', 'initialization',
];

function scorePage(text) {
var lower = text.toLowerCase();
var score = 0;
KEYWORDS.forEach(function (kw) {
var idx = 0;
while (true) {
idx = lower.indexOf(kw, idx);
if (idx === -1) break;
score += 1;
idx += kw.length;
}
});
return score;
}

function buildPayloadText() {
var full = pageTexts.join('\n');
if (full.length <= TEXT_BUDGET) {
return { text: full, excerpted: false, includedPages: pageTexts.length};
}
var total = pageTexts.length;
var picked = new Set();
// Always keep the opening pages (features and pinout live there) and the
// final page, then fill the rest of the budget by keyword score.
[0, 1, total - 1].forEach(function (i) { if (i >= 0 && i < total) picked.add(i);});
var scored = pageTexts
.map(function (t, i) { return { i: i, score: scorePage(t)};})
.filter(function (s) { return!picked.has(s.i);})
.sort(function (a, b) { return b.score - a.score;});
var used = [...picked].reduce(function (sum, i) { return sum + pageTexts[i].length;}, 0);
for (var s of scored) {
if (used + pageTexts[s.i].length > TEXT_BUDGET) continue;
picked.add(s.i);
used += pageTexts[s.i].length;
}
var ordered = [...picked].sort(function (a, b) { return a - b;});
var parts = ordered.map(function (i) { return '\n' + pageTexts[i];});
var header =
'（本手册共 ' + total + ' 页，以下为系统自动选取的关键页：' +
ordered.map(function (i) { return i + 1;}).join(', ') + '）\n\n';
return { text: header + parts.join('\n\n'), excerpted: true, includedPages: ordered.length};
}

// ---------- API helpers ----------

function authHeaders(extra) {
var headers = { 'Content-Type': 'application/json'};
var code = sessionStorage.getItem(ACCESS_CODE_KEY);
if (code) headers['X-Access-Code'] = code;
return Object.assign(headers, extra || {});
}

function askAccessCode() {
var entered = window.prompt('该站点已开启访问口令，请输入口令');
if (entered) sessionStorage.setItem(ACCESS_CODE_KEY, entered);
return!!entered;
}

async function postJson(path, body, retried) {
var res = await fetch(path, {
method: 'POST',
headers: authHeaders(),
body: JSON.stringify(body),
});
var data = await res.json().catch(function () { return null;});
if (data && data.need_access_code &&!retried) {
if (askAccessCode()) return postJson(path, body, true);
throw new Error('需要访问口令才能使用');
}
if (!data ||!data.success) {
var err = new Error((data && data.error) || '请求失败');
err.attempts = data && data.attempts;
throw err;
}
return data;
}

// Streaming analyze over SSE. Resolves with { result, meta} on the done
// event, rejects with an Error (carrying attempts) on the error event.
function streamAnalyze(body, onProgress, signal, retried) {
return fetch('/api/analyze', {
method: 'POST',
headers: authHeaders(),
body: JSON.stringify(Object.assign({}, body, { stream: true})),
signal: signal,
}).then(async function (res) {
var contentType = res.headers.get('Content-Type') || '';
if (!contentType.includes('text/event-stream')) {
// Gate errors (access code, quota) come back as plain JSON.
var data = await res.json().catch(function () { return null;});
if (data && data.need_access_code &&!retried) {
if (askAccessCode()) return streamAnalyze(body, onProgress, signal, true);
throw new Error('需要访问口令才能使用分析功能');
}
var err = new Error((data && data.error) || '分析请求失败');
err.attempts = data && data.attempts;
        err.noFallback = true;
throw err;
}
var reader = res.body.getReader();
var decoder = new TextDecoder();
var buffer = '';
while (true) {
var chunk = await reader.read();
if (chunk.done) break;
buffer += decoder.decode(chunk.value, { stream: true});
var blocks = buffer.split('\n\n');
buffer = blocks.pop() || '';
for (var block of blocks) {
var line = block.split('\n').find(function (l) { return l.startsWith('data:');});
if (!line) continue;
var evt;
try { evt = JSON.parse(line.slice(5).trim());} catch (e) { continue;}
if (evt.type === 'provider' || evt.type === 'delta') {
onProgress(evt);
} else if (evt.type === 'done') {
return { result: evt.result, meta: evt.meta};
} else if (evt.type === 'error') {
var err2 = new Error(evt.error || '分析失败');
err2.attempts = evt.attempts;
            err2.noFallback = true;
throw err2;
}
}
}
throw new Error('连接中断，未收到分析结果');
});
}

// ---------- analysis flow ----------

analyzeBtn.addEventListener('click', startAnalysis);
$('#new-analysis-btn').addEventListener('click', resetView);
$('#retry-btn').addEventListener('click', resetView);
$('#download-btn').addEventListener('click', downloadAllCode);
$('#report-btn').addEventListener('click', downloadReport);
$('#cancel-btn').addEventListener('click', function () {
if (analyzeAbort) analyzeAbort.abort();
});

async function startAnalysis() {
if (!pageTexts.length) {
showToast('请先上传 PDF 文件', 'error');
return;
}
var mcu = mcuInput.value.trim();
var language = languageSelect.value;
if (!mcu) {
showToast('请输入目标 MCU', 'error');
return;
}
var payload = buildPayloadText();
lastPayloadText = payload.text;
chatHistory = [];
$('#chat-log').innerHTML = '';
showSection('progress');
setStepState('extract', 'done');
setStepState('analyze', 'active');
resetStreamUi();
startElapsed();
analyzeAbort = new AbortController();
try {
var data;
try {
data = await streamAnalyze(
{ text: payload.text, mcu: mcu, language: language},
onStreamProgress,
analyzeAbort.signal,
false
);
} catch (streamErr) {
if (streamErr.name === 'AbortError' || streamErr.noFallback) throw streamErr;
// Streaming transport failed outright: fall back to the plain call.
data = await postJson('/api/analyze', { text: payload.text, mcu: mcu, language: language}, false);
}
setStepState('analyze', 'done');
setStepState('generate', 'done');
stopElapsed();
currentResult = data.result;
currentMeta = data.meta || {};
if (payload.excerpted) {
currentMeta.excerpted = true;
currentMeta.includedPages = payload.includedPages;
currentMeta.totalPages = pageTexts.length;
}
renderResult(currentResult, currentMeta);
saveHistory(mcu, language);
showSection('result');
} catch (err) {
stopElapsed();
if (err.name === 'AbortError') {
showToast('已取消分析', 'error');
showSection('upload');
} else {
if (err.name === 'TypeError' || /failed to fetch|networkerror/i.test(err.message || '')) {
showError(new Error('网络连接中断，分析未完成，请检查网络后重试'));
} else {
showError(err);
}
}
} finally {
analyzeAbort = null;
}
}

function resetStreamUi() {
$('#stream-stats').textContent = '';
$('#stream-preview').textContent = '';
$('#stream-preview-wrap').style.display = 'none';
}

function onStreamProgress(evt) {
var stats = $('#stream-stats');
if (evt.type === 'provider') {
stats.textContent = '，' + (PROVIDER_NAMES[evt.provider] || evt.provider) + ' 正在生成';
} else if (evt.type === 'delta') {
stats.textContent = '，已生成 ' + evt.chars.toLocaleString() + ' 字符';
var wrap = $('#stream-preview-wrap');
wrap.style.display = '';
var preview = $('#stream-preview');
preview.textContent = evt.tail || '';
preview.scrollTop = preview.scrollHeight;
}
}

function startElapsed() {
var el = $('#elapsed');
var start = Date.now();
el.textContent = '0';
elapsedTimer = setInterval(function () {
el.textContent = String(Math.floor((Date.now() - start) / 1000));
}, 500);
}
function stopElapsed() {
if (elapsedTimer) clearInterval(elapsedTimer);
elapsedTimer = null;
}

// ---------- result rendering ----------

var EXT_MAP = { C: '.c', Arduino: '.ino', 'STM32 HAL': '.c', Python: '.py', 'ESP-IDF': '.c', Rust: '.rs'};
var HLJS_MAP = { C: 'c', Arduino: 'cpp', 'STM32 HAL': 'c', Python: 'python', 'ESP-IDF': 'c', Rust: 'rust'};
var PROVIDER_NAMES = {
makers: 'EdgeOne 官方内置',
openrouter: 'OpenRouter',
};

function renderResult(result, meta) {
resultCards.innerHTML = '';
renderMeta(meta);
$('#chat-card').style.display = result? '': 'none';
if (!result) return;
if (result.raw_content) {
resultCards.appendChild(textCard('📄', '模型原始输出', result.raw_content));
return;
}
if (result.chip_info) resultCards.appendChild(chipInfoCard(result.chip_info));
if (result.working_principle) {
resultCards.appendChild(textCard('📖', '工作原理', result.working_principle));
}
if (result.pins && result.pins.length) {
resultCards.appendChild(tableCard('📌', '引脚定义', ['引脚', '信号名', '功能'], result.pins.map(function (p) {
return [p.pin, p.name, p.function];
})));
}
if (result.registers && result.registers.length) {
resultCards.appendChild(tableCard('🗂️', '寄存器速查', ['寄存器', '地址', '功能', '复位值'], result.registers.map(function (r) {
return [r.name, r.address || '-', r.description, r.reset_value || '-'];
})));
}
var language = languageSelect.value;
var ext = EXT_MAP[language] || '.c';
(result.driver_functions || []).forEach(function (fn, idx) {
resultCards.appendChild(codeCard('⚙️', '驱动函数 ' + (idx + 1) + '：' + (fn.name || ''), fn.description, fn.code, (fn.name || 'driver') + ext, language));
});
if (result.initialization && result.initialization.code) {
resultCards.appendChild(codeCard('🚀', '初始化代码', result.initialization.description, result.initialization.code, 'init' + ext, language));
}
if (result.usage_notes && result.usage_notes.length) {
var card = document.createElement('div');
card.className = 'card';
var ul = document.createElement('ul');
ul.className = 'notes-list';
result.usage_notes.forEach(function (note) {
var li = document.createElement('li');
li.textContent = note;
ul.appendChild(li);
});
card.innerHTML = '<div class="card-header"><span class="card-icon">⚠️</span><h3>使用注意事项</h3></div>';
var body = document.createElement('div');
body.className = 'card-body';
body.appendChild(ul);
card.appendChild(body);
resultCards.appendChild(card);
}
resultCards.querySelectorAll('pre code').forEach(function (el) {
if (window.hljs) {
try { window.hljs.highlightElement(el);} catch (e) { /* plain text fallback */}
}
});
}

function renderMeta(meta) {
var parts = [];
if (meta && meta.cached) {
parts.push('命中缓存（7 天内相同手册与配置），即时返回，未消耗调用额度');
} else if (meta && meta.provider) {
parts.push('由 ' + (PROVIDER_NAMES[meta.provider] || meta.provider) + ' · ' + (meta.model || '') + ' 生成');
}
if (meta && meta.chunked) parts.push('内置模型分段并行生成');
if (meta && meta.ms) parts.push('耗时 ' + (meta.ms / 1000).toFixed(1) + ' 秒');
if (meta && meta.excerpted) {
parts.push('长手册智能取段：共 ' + meta.totalPages + ' 页，选用了 ' + meta.includedPages + ' 页关键页');
}
if (meta && meta.repaired) parts.push('模型输出经过一次 JSON 修复');
resultMeta.textContent = parts.join('　|　');
resultMeta.style.display = parts.length? '': 'none';
    if (meta && meta.degraded) {
      var warn = document.createElement('div');
      warn.className = 'result-meta-note';
      warn.textContent = '本次生成不完整：有关键小节未完成，或模型未返回完整驱动代码。建议重试，或在管理后台更换更强的模型。';
      resultMeta.appendChild(warn);
    }
if (meta && meta.attempts && meta.attempts.some(function (a) { return!a.ok;})) {
var failed = meta.attempts
.filter(function (a) { return!a.ok;})
.map(function (a) { return (PROVIDER_NAMES[a.provider] || a.provider) + '：' + (a.error || '失败');})
.join('；');
var note = document.createElement('div');
note.className = 'result-meta-note';
note.textContent = '兜底记录：' + failed;
resultMeta.appendChild(note);
}
if (meta && meta.sections_failed && meta.sections_failed.length) {
var sectionNote = document.createElement('div');
sectionNote.className = 'result-meta-note';
sectionNote.textContent = '分段提示：有 ' + meta.sections_failed.length + ' 个小节未完成，已用其余小节拼装结果；缺失部分可重试补齐。';
resultMeta.appendChild(sectionNote);
}
if (meta && meta.chunked_failed) {
var chunkNote = document.createElement('div');
chunkNote.className = 'result-meta-note';
chunkNote.textContent = '分段快速通道未完成，已自动转整段生成：' + meta.chunked_failed;
resultMeta.appendChild(chunkNote);
}
}

function chipInfoCard(info) {
var fields = [
['芯片型号', info.model],
['主要用途', info.purpose],
['供电要求', info.power_supply],
['温度范围', info.temperature_range],
['通信方式', info.communication],
['引脚说明', info.pin_description],
];
var card = document.createElement('div');
card.className = 'card';
card.innerHTML = '<div class="card-header"><span class="card-icon">🔧</span><h3>芯片基本信息</h3></div>';
var body = document.createElement('div');
body.className = 'card-body';
var grid = document.createElement('div');
grid.className = 'info-grid';
fields.forEach(function (f) {
var item = document.createElement('div');
item.className = 'info-item';
var label = document.createElement('span');
label.className = 'info-label';
label.textContent = f[0];
var value = document.createElement('span');
value.className = 'info-value';
value.textContent = f[1] || '-';
item.appendChild(label);
item.appendChild(value);
grid.appendChild(item);
});
body.appendChild(grid);
card.appendChild(body);
return card;
}

function tableCard(icon, title, headers, rows) {
var card = document.createElement('div');
card.className = 'card';
var header = document.createElement('div');
header.className = 'card-header';
var iconSpan = document.createElement('span');
iconSpan.className = 'card-icon';
iconSpan.textContent = icon;
var h3 = document.createElement('h3');
h3.textContent = title;
header.appendChild(iconSpan);
header.appendChild(h3);
card.appendChild(header);
var body = document.createElement('div');
body.className = 'card-body';
var table = document.createElement('table');
table.className = 'data-table';
var thead = document.createElement('thead');
var trh = document.createElement('tr');
headers.forEach(function (h) {
var th = document.createElement('th');
th.textContent = h;
trh.appendChild(th);
});
thead.appendChild(trh);
table.appendChild(thead);
var tbody = document.createElement('tbody');
rows.forEach(function (row) {
var tr = document.createElement('tr');
row.forEach(function (cell) {
var td = document.createElement('td');
td.textContent = cell || '';
tr.appendChild(td);
});
tbody.appendChild(tr);
});
table.appendChild(tbody);
body.appendChild(table);
card.appendChild(body);
return card;
}

function textCard(icon, title, text) {
var card = document.createElement('div');
card.className = 'card';
var header = document.createElement('div');
header.className = 'card-header';
header.innerHTML = '<span class="card-icon"></span><h3></h3>';
header.querySelector('.card-icon').textContent = icon;
header.querySelector('h3').textContent = title;
var body = document.createElement('div');
body.className = 'card-body';
var p = document.createElement('p');
p.className = 'principle-text';
p.textContent = text;
body.appendChild(p);
card.appendChild(header);
card.appendChild(body);
return card;
}

function codeCard(icon, title, desc, code, filename, language) {
var card = document.createElement('div');
card.className = 'card card-code';
var header = document.createElement('div');
header.className = 'card-header';
var iconSpan = document.createElement('span');
iconSpan.className = 'card-icon';
iconSpan.textContent = icon;
var h3 = document.createElement('h3');
h3.textContent = title;
var copyBtn = document.createElement('button');
copyBtn.className = 'btn-copy';
copyBtn.textContent = '复制';
copyBtn.addEventListener('click', function () {
navigator.clipboard.writeText(code || '').then(function () {
copyBtn.textContent = '已复制';
copyBtn.classList.add('copied');
setTimeout(function () {
copyBtn.textContent = '复制';
copyBtn.classList.remove('copied');
}, 2000);
});
});
header.appendChild(iconSpan);
header.appendChild(h3);
header.appendChild(copyBtn);
card.appendChild(header);
if (desc) {
var sub = document.createElement('div');
sub.className = 'card-subheader';
sub.textContent = desc;
card.appendChild(sub);
}
var body = document.createElement('div');
body.className = 'card-body';
var win = document.createElement('div');
win.className = 'code-window';
var winHead = document.createElement('div');
winHead.className = 'code-header';
winHead.innerHTML =
'<span class="code-dot code-dot-red"></span><span class="code-dot code-dot-yellow"></span><span class="code-dot code-dot-green"></span>';
var titleSpan = document.createElement('span');
titleSpan.className = 'code-title';
titleSpan.textContent = filename;
winHead.appendChild(titleSpan);
var pre = document.createElement('pre');
var codeEl = document.createElement('code');
codeEl.className = 'language-' + (HLJS_MAP[language] || 'c');
codeEl.textContent = unescapeCode(code || '');
pre.appendChild(codeEl);
win.appendChild(winHead);
win.appendChild(pre);
body.appendChild(win);
card.appendChild(body);
return card;
}

// ---------- downloads ----------

function downloadBlob(content, filename, type) {
var blob = new Blob([content], { type: type || 'text/plain;charset=utf-8'});
var url = URL.createObjectURL(blob);
var a = document.createElement('a');
a.href = url;
a.download = filename;
a.click();
setTimeout(function () { URL.revokeObjectURL(url);}, 1000);
}

function safeName(name) {
return (name || 'driver').replace(/[\\/:*?"<>|]/g, '_');
}

function downloadAllCode() {
if (!currentResult) return;
var language = languageSelect.value;
var ext = EXT_MAP[language] || '.c';
var chip = (currentResult.chip_info && currentResult.chip_info.model) || 'driver';
var chunks = [];
(currentResult.driver_functions || []).forEach(function (fn) {
chunks.push('// ===== ' + (fn.name || 'driver') + '：' + (fn.description || '') + ' =====\n' + unescapeCode(fn.code || ''));
});
if (currentResult.initialization && currentResult.initialization.code) {
chunks.push('// ===== 初始化：' + (currentResult.initialization.description || '') + ' =====\n' + unescapeCode(currentResult.initialization.code));
}
if (!chunks.length) {
showToast('没有可下载的代码', 'error');
return;
}
downloadBlob(chunks.join('\n\n'), safeName(chip) + '_driver' + ext);
}

function downloadReport() {
if (!currentResult) return;
var r = currentResult;
var language = languageSelect.value;
var lines = [];
var chip = (r.chip_info && r.chip_info.model) || '芯片';
lines.push('# ' + chip + ' 数据手册分析报告');
lines.push('');
lines.push('- 目标 MCU：' + mcuInput.value.trim());
lines.push('- 编程语言：' + language);
if (currentMeta && currentMeta.provider) {
lines.push('- 生成模型：' + (PROVIDER_NAMES[currentMeta.provider] || currentMeta.provider) + ' · ' + (currentMeta.model || ''));
}
lines.push('');
if (r.chip_info) {
lines.push('## 芯片基本信息');
lines.push('');
lines.push('| 项目 | 内容 |');
lines.push('| --- | --- |');
lines.push('| 型号 | ' + (r.chip_info.model || '-') + ' |');
lines.push('| 用途 | ' + (r.chip_info.purpose || '-') + ' |');
lines.push('| 供电 | ' + (r.chip_info.power_supply || '-') + ' |');
lines.push('| 温度范围 | ' + (r.chip_info.temperature_range || '-') + ' |');
lines.push('| 通信方式 | ' + (r.chip_info.communication || '-') + ' |');
lines.push('| 引脚说明 | ' + (r.chip_info.pin_description || '-') + ' |');
lines.push('');
}
if (r.working_principle) {
lines.push('## 工作原理');
lines.push('');
lines.push(r.working_principle);
lines.push('');
}
if (r.pins && r.pins.length) {
lines.push('## 引脚定义');
lines.push('');
lines.push('| 引脚 | 信号名 | 功能 |');
lines.push('| --- | --- | --- |');
r.pins.forEach(function (p) { lines.push('| ' + p.pin + ' | ' + p.name + ' | ' + p.function + ' |');});
lines.push('');
}
if (r.registers && r.registers.length) {
lines.push('## 寄存器速查');
lines.push('');
lines.push('| 寄存器 | 地址 | 功能 | 复位值 |');
lines.push('| --- | --- | --- | --- |');
r.registers.forEach(function (reg) {
lines.push('| ' + reg.name + ' | ' + (reg.address || '-') + ' | ' + reg.description + ' | ' + (reg.reset_value || '-') + ' |');
});
lines.push('');
}
(r.driver_functions || []).forEach(function (fn, idx) {
lines.push('## 驱动函数 ' + (idx + 1) + '：' + (fn.name || ''));
lines.push('');
if (fn.description) { lines.push(fn.description); lines.push('');}
lines.push('```c');
lines.push(unescapeCode(fn.code || ''));
lines.push('```');
lines.push('');
});
if (r.initialization && r.initialization.code) {
lines.push('## 初始化代码');
lines.push('');
if (r.initialization.description) { lines.push(r.initialization.description); lines.push('');}
lines.push('```c');
lines.push(unescapeCode(r.initialization.code));
lines.push('```');
lines.push('');
}
if (r.usage_notes && r.usage_notes.length) {
lines.push('## 使用注意事项');
lines.push('');
r.usage_notes.forEach(function (n) { lines.push('- ' + n);});
lines.push('');
}
downloadBlob(lines.join('\n'), safeName(chip) + '_分析报告.md', 'text/markdown;charset=utf-8');
}

function unescapeCode(str) {
if (!str) return '';
if (str.indexOf('\\n') === -1 && str.indexOf('\\t') === -1) return str;
return str
.replace(/\\n/g, '\n')
.replace(/\\t/g, '\t')
.replace(/\\r/g, '\r')
.replace(/\\\\/g, '\\')
.replace(/\\"/g, '"')
.replace(/\\'/g, "'");
}

// ---------- chat with the manual ----------

$('#chat-send-btn').addEventListener('click', sendChat);
$('#chat-input').addEventListener('keydown', function (e) {
if (e.key === 'Enter') sendChat();
});

function appendChatBubble(role, text) {
var log = $('#chat-log');
var bubble = document.createElement('div');
bubble.className = 'chat-bubble chat-' + role;
bubble.textContent = text;
log.appendChild(bubble);
log.scrollTop = log.scrollHeight;
return bubble;
}

async function sendChat() {
var input = $('#chat-input');
var question = input.value.trim();
if (!question) return;
if (!lastPayloadText) {
showToast('请先完成一次分析再追问', 'error');
return;
}
input.value = '';
appendChatBubble('user', question);
var pending = appendChatBubble('assistant', '思考中...');
var btn = $('#chat-send-btn');
btn.disabled = true;
try {
var data = await postJson('/api/chat', {
text: lastPayloadText,
question: question,
history: chatHistory,
}, false);
pending.textContent = data.answer || '(无回答)';
chatHistory.push({ role: 'user', content: question});
chatHistory.push({ role: 'assistant', content: data.answer || ''});
if (chatHistory.length > 12) chatHistory = chatHistory.slice(-12);
} catch (err) {
pending.textContent = '提问失败：' + err.message;
pending.classList.add('chat-error');
} finally {
btn.disabled = false;
}
}

// ---------- history (localStorage) ----------

function loadHistory() {
try {
return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
} catch (e) {
return [];
}
}

function saveHistory(mcu, language) {
if (!currentResult) return;
var list = loadHistory();
list.unshift({
ts: Date.now(),
file: pdfFileName,
mcu: mcu,
language: language,
result: currentResult,
meta: currentMeta,
payloadText: lastPayloadText,
});
list = list.slice(0, 10);
try {
localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
} catch (e) {
// Storage full: drop the payload text first, then the oldest half.
try {
list.forEach(function (item) { delete item.payloadText;});
localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, 5)));
} catch (e2) { /* give up silently */}
}
renderHistory();
}

function renderHistory() {
var list = loadHistory();
var card = $('#history-card');
var container = $('#history-list');
if (!list.length) {
card.style.display = 'none';
return;
}
card.style.display = '';
container.innerHTML = '';
list.forEach(function (item, idx) {
var row = document.createElement('div');
row.className = 'history-item';
var main = document.createElement('button');
main.className = 'history-main';
var when = new Date(item.ts);
var chip = (item.result && item.result.chip_info && item.result.chip_info.model) || item.file || '分析结果';
main.textContent =
chip + ' · ' + item.mcu + ' · ' + item.language + ' · ' +
(when.getMonth() + 1) + '-' + when.getDate() + ' ' +
String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
main.addEventListener('click', function () {
currentResult = item.result;
currentMeta = item.meta || {};
languageSelect.value = item.language;
mcuInput.value = item.mcu;
lastPayloadText = item.payloadText || '';
chatHistory = [];
$('#chat-log').innerHTML = '';
$('#chat-card').style.display = lastPayloadText? '': 'none';
renderResult(currentResult, currentMeta);
if (!lastPayloadText) $('#chat-card').style.display = 'none';
showSection('result');
});
var del = document.createElement('button');
del.className = 'history-del';
del.textContent = '删除';
del.addEventListener('click', function () {
var fresh = loadHistory();
fresh.splice(idx, 1);
localStorage.setItem(HISTORY_KEY, JSON.stringify(fresh));
renderHistory();
});
row.appendChild(main);
row.appendChild(del);
container.appendChild(row);
});
}

$('#history-clear-btn').addEventListener('click', function () {
localStorage.removeItem(HISTORY_KEY);
renderHistory();
});
renderHistory();

// ---------- view helpers ----------

function setStepState(step, state) {
var stepEl = $('#step-' + step);
var statusEl = $('#step-' + step + '-status');
if (!stepEl ||!statusEl) return;
stepEl.className = 'step ' + state;
statusEl.textContent = state === 'active'? '进行中...': state === 'done'? '✓ 完成': '';
document.querySelectorAll('.step-line').forEach(function (line) {
var prev = line.previousElementSibling;
if (prev && prev.classList.contains('done')) {
line.classList.add('done');
line.classList.remove('active');
} else if (prev && prev.classList.contains('active')) {
line.classList.add('active');
line.classList.remove('done');
}
});
}

function showSection(name) {
uploadSection.style.display = name === 'upload'? '': 'none';
progressSection.style.display = name === 'progress'? '': 'none';
resultSection.style.display = name === 'result'? '': 'none';
errorSection.style.display = name === 'error'? '': 'none';
}

function showError(err) {
errorMessage.textContent = err.message || '分析过程中发生错误';
errorDetail.innerHTML = '';
if (err.attempts && err.attempts.length) {
var lines = err.attempts.map(function (a) {
return (PROVIDER_NAMES[a.provider] || a.provider) + (a.ok? '：成功': '：' + (a.error || '失败'));
});
errorDetail.textContent = '各供应商结果：' + lines.join('；');
}
showSection('error');
}

function resetView() {
pageTexts = [];
pdfFileName = '';
pdfTotalChars = 0;
currentResult = null;
currentMeta = null;
lastPayloadText = '';
chatHistory = [];
$('#chat-log').innerHTML = '';
fileNameDisplay.textContent = '点击或拖拽上传 PDF 文件';
fileMeta.style.display = 'none';
fileInput.value = '';
analyzeBtn.disabled = true;
setStepState('extract', '');
setStepState('analyze', '');
setStepState('generate', '');
showSection('upload');
}

function showToast(message, type) {
var toast = document.createElement('div');
toast.className = 'toast toast-' + type;
toast.textContent = message;
document.body.appendChild(toast);
setTimeout(function () { toast.remove();}, 3000);
}

// ---------- contact modal ----------

var contactBtn = $('#contact-btn');
var contactModal = $('#contact-modal');
var modalCloseBtn = $('#modal-close-btn');
var copyQqBtn = $('#copy-qq-btn');
if (contactBtn && contactModal) {
contactBtn.addEventListener('click', function () { contactModal.style.display = '';});
modalCloseBtn.addEventListener('click', function () { contactModal.style.display = 'none';});
contactModal.addEventListener('click', function (e) {
if (e.target === contactModal) contactModal.style.display = 'none';
});
}
if (copyQqBtn) {
copyQqBtn.addEventListener('click', function () {
navigator.clipboard.writeText($('#qq-value').textContent).then(function () {
copyQqBtn.textContent = '已复制';
setTimeout(function () { copyQqBtn.textContent = '复制';}, 2000);
});
});
}
})();
