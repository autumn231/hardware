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
var elapsedTimer = null;

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

async function handleFile(file) {
if (file.type!== 'application/pdf' &&!/\.pdf$/i.test(file.name)) {
showToast('请选择 PDF 文件', 'error');
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

// ---------- analysis flow ----------

analyzeBtn.addEventListener('click', startAnalysis);
$('#new-analysis-btn').addEventListener('click', resetView);
$('#retry-btn').addEventListener('click', resetView);
$('#download-btn').addEventListener('click', downloadAllCode);

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
showSection('progress');
setStepState('extract', 'done');
setStepState('analyze', 'active');
startElapsed();
try {
var payload = buildPayloadText();
var data = await callAnalyzeApi(payload.text, mcu, language, false);
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
showError(err);
}
}

async function callAnalyzeApi(text, mcu, language, retried) {
var headers = { 'Content-Type': 'application/json'};
var code = sessionStorage.getItem(ACCESS_CODE_KEY);
if (code) headers['X-Access-Code'] = code;
var res = await fetch('/api/analyze', {
method: 'POST',
headers: headers,
body: JSON.stringify({ text: text, mcu: mcu, language: language}),
});
var data = await res.json().catch(function () { return null;});
if (data && data.need_access_code &&!retried) {
var entered = window.prompt('该站点已开启访问口令，请输入口令');
if (entered) {
sessionStorage.setItem(ACCESS_CODE_KEY, entered);
return callAnalyzeApi(text, mcu, language, true);
}
throw new Error('需要访问口令才能使用分析功能');
}
if (!data ||!data.success) {
var err = new Error((data && data.error) || '分析请求失败');
err.attempts = data && data.attempts;
throw err;
}
return data;
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
sensenova: 'SenseNova（商汤）',
deepseek: 'DeepSeek 官方',
gemini: 'Google Gemini',
openrouter: 'OpenRouter',
custom: '自定义服务',
};

function renderResult(result, meta) {
resultCards.innerHTML = '';
renderMeta(meta);
if (!result) return;
if (result.raw_content) {
resultCards.appendChild(textCard('📄', '模型原始输出', result.raw_content));
return;
}
if (result.chip_info) resultCards.appendChild(chipInfoCard(result.chip_info));
if (result.working_principle) {
resultCards.appendChild(textCard('📖', '工作原理', result.working_principle));
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
if (meta && meta.provider) {
parts.push('由 ' + (PROVIDER_NAMES[meta.provider] || meta.provider) + ' · ' + (meta.model || '') + ' 生成');
}
if (meta && meta.ms) parts.push('耗时 ' + (meta.ms / 1000).toFixed(1) + ' 秒');
if (meta && meta.excerpted) {
parts.push('长手册智能取段：共 ' + meta.totalPages + ' 页，选用了 ' + meta.includedPages + ' 页关键页');
}
if (meta && meta.repaired) parts.push('模型输出经过一次 JSON 修复');
resultMeta.textContent = parts.join('　|　');
resultMeta.style.display = parts.length? '': 'none';
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
var blob = new Blob([chunks.join('\n\n')], { type: 'text/plain;charset=utf-8'});
var url = URL.createObjectURL(blob);
var a = document.createElement('a');
a.href = url;
a.download = chip.replace(/[\\/:*?"<>|]/g, '_') + '_driver' + ext;
a.click();
setTimeout(function () { URL.revokeObjectURL(url);}, 1000);
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
});
list = list.slice(0, 10);
try {
localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
} catch (e) {
// Storage full: drop the oldest half and retry once.
try {
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
renderResult(currentResult, currentMeta);
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
