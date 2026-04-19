(function () {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const $ = (sel) => document.querySelector(sel);
  const fileInput = $('#pdf-file');
  const fileDropZone = $('#file-drop-zone');
  const fileNameDisplay = $('#file-name-display');
  const mcuInput = $('#mcu-input');
  const languageSelect = $('#language-select');
  const analyzeBtn = $('#analyze-btn');
  const uploadSection = $('#upload-section');
  const progressSection = $('#progress-section');
  const resultSection = $('#result-section');
  const errorSection = $('#error-section');
  const errorMessage = $('#error-message');
  const newAnalysisBtn = $('#new-analysis-btn');
  const retryBtn = $('#retry-btn');

  let pdfText = '';
  let pdfFileName = '';

  fileDropZone.addEventListener('click', () => fileInput.click());

  fileDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    fileDropZone.classList.add('dragover');
  });

  fileDropZone.addEventListener('dragleave', () => {
    fileDropZone.classList.remove('dragover');
  });

  fileDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    fileDropZone.classList.remove('dragover');
    const files = e.dataTransfer.files;
    if (files.length > 0 && files[0].type === 'application/pdf') {
      handleFile(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  function handleFile(file) {
    pdfFileName = file.name;
    fileNameDisplay.textContent = file.name;
    analyzeBtn.disabled = false;
  }

  analyzeBtn.addEventListener('click', startAnalysis);
  newAnalysisBtn.addEventListener('click', resetView);
  retryBtn.addEventListener('click', resetView);

  document.querySelectorAll('.btn-copy').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const codeEl = document.getElementById(targetId);
      if (codeEl) {
        navigator.clipboard.writeText(codeEl.textContent).then(() => {
          btn.textContent = '已复制';
          btn.classList.add('copied');
          setTimeout(() => {
            btn.textContent = '复制';
            btn.classList.remove('copied');
          }, 2000);
        });
      }
    });
  });

  const contactBtn = $('#contact-btn');
  const contactModal = $('#contact-modal');
  const modalCloseBtn = $('#modal-close-btn');
  const copyQqBtn = $('#copy-qq-btn');

  if (contactBtn && contactModal) {
    contactBtn.addEventListener('click', () => {
      contactModal.style.display = '';
    });
    modalCloseBtn.addEventListener('click', () => {
      contactModal.style.display = 'none';
    });
    contactModal.addEventListener('click', (e) => {
      if (e.target === contactModal) {
        contactModal.style.display = 'none';
      }
    });
  }

  if (copyQqBtn) {
    copyQqBtn.addEventListener('click', () => {
      navigator.clipboard.writeText($('#qq-value').textContent).then(() => {
        copyQqBtn.textContent = '已复制';
        setTimeout(() => {
          copyQqBtn.textContent = '复制';
        }, 2000);
      });
    });
  }

  async function startAnalysis() {
    if (!fileInput.files.length) {
      showToast('请先上传 PDF 文件', 'error');
      return;
    }

    const mcu = mcuInput.value.trim();
    const language = languageSelect.value;

    if (!mcu) {
      showToast('请输入目标 MCU', 'error');
      return;
    }

    showSection('progress');
    setStepState('extract', 'active');

    try {
      pdfText = await extractPdfText(fileInput.files[0]);
      setStepState('extract', 'done');
      setStepState('analyze', 'active');

      const result = await callAnalyzeApi(pdfText, mcu, language);
      setStepState('analyze', 'done');
      setStepState('generate', 'done');

      renderResult(result);
      showSection('result');
    } catch (err) {
      showError(err.message || '分析过程中发生错误');
    }
  }

  async function extractPdfText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const totalPages = pdf.numPages;
    let fullText = '';

    for (let i = 1; i <= totalPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item) => item.str).join(' ');
      fullText += pageText + '\n';
    }

    if (!fullText.trim()) {
      throw new Error('PDF 中未提取到文本内容，该 PDF 可能是扫描件或图片格式');
    }

    return fullText;
  }

  async function callAnalyzeApi(text, mcu, language) {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mcu, language }),
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || '分析请求失败');
    }

    return data.result;
  }

  function renderResult(result) {
    if (result.raw_content) {
      renderRawContent(result.raw_content);
      return;
    }

    if (result.chip_info) {
      const info = result.chip_info;
      const fields = [
        { label: '芯片型号', value: info.model },
        { label: '主要用途', value: info.purpose },
        { label: '供电要求', value: info.power_supply },
        { label: '温度范围', value: info.temperature_range },
        { label: '通信方式', value: info.communication },
        { label: '引脚说明', value: info.pin_description },
      ];
      let html = '<div class="info-grid">';
      fields.forEach((f) => {
        html += `<div class="info-item"><span class="info-label">${f.label}</span><span class="info-value">${escapeHtml(f.value || '-')}</span></div>`;
      });
      html += '</div>';
      $('#chip-info-body').innerHTML = html;
    }

    if (result.working_principle) {
      $('#principle-body').innerHTML = `<p class="principle-text">${escapeHtml(result.working_principle)}</p>`;
    }

    if (result.driver_functions && result.driver_functions.length >= 1) {
      const d1 = result.driver_functions[0];
      $('#driver1-desc').textContent = d1.description || '';
      $('#driver1-code').textContent = d1.code || '';
      $('#card-driver1 .card-header h3').textContent = `驱动函数 1：${d1.name || ''}`;
    }

    if (result.driver_functions && result.driver_functions.length >= 2) {
      const d2 = result.driver_functions[1];
      $('#driver2-desc').textContent = d2.description || '';
      $('#driver2-code').textContent = d2.code || '';
      $('#card-driver2 .card-header h3').textContent = `驱动函数 2：${d2.name || ''}`;
    }

    if (result.initialization) {
      $('#init-desc').textContent = result.initialization.description || '';
      $('#init-code').textContent = result.initialization.code || '';
    }

    if (result.usage_notes && result.usage_notes.length > 0) {
      let html = '<ul class="notes-list">';
      result.usage_notes.forEach((note) => {
        html += `<li>${escapeHtml(note)}</li>`;
      });
      html += '</ul>';
      $('#notes-body').innerHTML = html;
    }
  }

  function renderRawContent(content) {
    $('#chip-info-body').innerHTML = `<p class="principle-text">${escapeHtml(content)}</p>`;
    $('#principle-body').innerHTML = '';
    $('#driver1-code').textContent = '';
    $('#driver2-code').textContent = '';
    $('#init-code').textContent = '';
    $('#notes-body').innerHTML = '';
  }

  function setStepState(step, state) {
    const stepEl = $(`#step-${step}`);
    const statusEl = $(`#step-${step}-status`);
    stepEl.className = `step ${state}`;

    if (state === 'active') {
      statusEl.textContent = '进行中...';
    } else if (state === 'done') {
      statusEl.textContent = '✓ 完成';
    } else {
      statusEl.textContent = '';
    }

    const lines = document.querySelectorAll('.step-line');
    lines.forEach((line) => {
      const prevStep = line.previousElementSibling;
      if (prevStep && prevStep.classList.contains('done')) {
        line.classList.add('done');
        line.classList.remove('active');
      } else if (prevStep && prevStep.classList.contains('active')) {
        line.classList.add('active');
        line.classList.remove('done');
      }
    });
  }

  function showSection(name) {
    uploadSection.style.display = name === 'upload' ? '' : 'none';
    progressSection.style.display = name === 'progress' ? '' : 'none';
    resultSection.style.display = name === 'result' ? '' : 'none';
    errorSection.style.display = name === 'error' ? '' : 'none';
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    showSection('error');
  }

  function resetView() {
    pdfText = '';
    pdfFileName = '';
    fileNameDisplay.textContent = '点击或拖拽上传 PDF 文件';
    fileInput.value = '';
    analyzeBtn.disabled = true;
    analyzeBtn.querySelector('.btn-text').style.display = '';
    analyzeBtn.querySelector('.btn-loading').style.display = 'none';
    showSection('upload');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;')
      .replace(/\n/g, '<br>');
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.remove();
    }, 3000);
  }
})();
