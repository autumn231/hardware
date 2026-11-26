(function () {
  var $ = function (sel) { return document.querySelector(sel); };
  var TOKEN_KEY = 'hw_admin_token';

  var loginSection = $('#login-section');
  var panelSection = $('#panel-section');
  var providerList = $('#provider-list');
  var orderList = $('#order-list');

  var config = null; // last config fetched from the server (public view)
  var order = []; // working copy of the provider order

  function token() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
  }

  async function api(path, options) {
    var headers = { 'Content-Type': 'application/json' };
    if (token()) headers['Authorization'] = 'Bearer ' + token();
    var res = await fetch(path, Object.assign({}, options || {}, { headers: headers }));
    var data = await res.json().catch(function () { return null; });
    if (res.status === 401) {
      logout();
      throw new Error('登录已过期，请重新登录');
    }
    if (!data) throw new Error('服务器无响应');
    return data;
  }

  // ---------- login ----------

  $('#login-btn').addEventListener('click', doLogin);
  $('#password-input').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
  });
  $('#logout-btn').addEventListener('click', logout);

  async function doLogin() {
    var password = $('#password-input').value;
    var errorEl = $('#login-error');
    errorEl.textContent = '';
    try {
      var res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
      });
      var data = await res.json();
      if (!data.success) throw new Error(data.error || '登录失败');
      sessionStorage.setItem(TOKEN_KEY, data.token);
      await enterPanel();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    panelSection.style.display = 'none';
    loginSection.style.display = '';
  }

  // ---------- panel ----------

  async function enterPanel() {
    var data = await api('/api/admin/config');
    if (!data.success) throw new Error(data.error || '读取配置失败');
    config = data.config;
    order = config.order.slice();
    loginSection.style.display = 'none';
    panelSection.style.display = '';
    renderProviders();
    renderOrder();
    $('#daily-limit-input').value = config.daily_limit;
    $('#ip-limit-input').value = config.ip_daily_limit;
    loadHealth();
    $('#access-code-input').value = '';
    $('#access-code-input').placeholder = config.access_code_set
      ? '已启用口令，输入新口令可更换，清空并保存则关闭'
      : '启用后，用户分析时需输入此口令';
    await refreshStats();
  }

  function renderProviders() {
    providerList.innerHTML = '';
    order.concat(Object.keys(config.providers).filter(function (id) { return !order.includes(id); }))
      .forEach(function (id) {
        providerList.appendChild(providerCard(id, config.providers[id]));
      });
  }

  function providerCard(id, p) {
    var card = document.createElement('div');
    card.className = 'card provider-card';
    var rank = order.indexOf(id);
    card.innerHTML =
      '<div class="card-header"><span class="card-icon">🤖</span><h3></h3>' +
      '<span class="provider-rank"></span>' +
      '<span class="provider-state"></span></div>';
    card.querySelector('h3').textContent = p.name;
    card.querySelector('.provider-rank').textContent = rank >= 0 ? '第 ' + (rank + 1) + ' 顺位' : '';
    var state = card.querySelector('.provider-state');
    state.textContent = p.key_set ? '已配置 ' + p.key_masked : '未配置 Key';
    state.className = 'provider-state ' + (p.key_set ? 'ok' : 'off');

    var body = document.createElement('div');
    body.className = 'card-body';

    var keyGroup = fieldGroup('API Key' + (p.key_hint ? '（' + p.key_hint + '）' : ''));
    var keyInput = document.createElement('input');
    keyInput.type = 'password';
    keyInput.id = 'key-' + id;
    keyInput.placeholder = p.key_set ? '已保存，留空表示不修改' : '粘贴 API Key';
    keyInput.autocomplete = 'off';
    keyGroup.appendChild(keyInput);
    if (p.key_set) {
      var clearBtn = document.createElement('button');
      clearBtn.className = 'btn btn-secondary btn-sm';
      clearBtn.textContent = '清除 Key';
      clearBtn.addEventListener('click', async function () {
        if (!window.confirm('确定清除 ' + p.name + ' 的 Key 吗？')) return;
        var payload = { providers: {} };
        payload.providers[id] = { key: '__CLEAR__' };
        var data = await api('/api/admin/config', { method: 'POST', body: JSON.stringify(payload) });
        if (data.success) {
          config = data.config;
          renderProviders();
          showSaveStatus('已清除');
        }
      });
      keyGroup.appendChild(clearBtn);
    }
    body.appendChild(keyGroup);

    var row = document.createElement('div');
    row.className = 'form-row';
    var modelGroup = fieldGroup('模型');
    var modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.id = 'model-' + id;
    modelInput.value = p.model || '';
    modelGroup.appendChild(modelInput);
    row.appendChild(modelGroup);
    if (id === 'custom') {
      var baseGroup = fieldGroup('接口地址（以 /v1 结尾）');
      var baseInput = document.createElement('input');
      baseInput.type = 'text';
      baseInput.id = 'base-' + id;
      baseInput.value = p.base_url || '';
      baseInput.placeholder = 'https://example.com/v1';
      baseGroup.appendChild(baseInput);
      row.appendChild(baseGroup);
    } else {
      var baseGroup2 = fieldGroup('接口地址');
      var baseText = document.createElement('input');
      baseText.type = 'text';
      baseText.value = p.base_url || '';
      baseText.disabled = true;
      baseGroup2.appendChild(baseText);
      row.appendChild(baseGroup2);
    }
    body.appendChild(row);

    var actions = document.createElement('div');
    actions.className = 'provider-actions';
    var testBtn = document.createElement('button');
    testBtn.className = 'btn btn-secondary btn-sm';
    testBtn.textContent = '测试连接';
    var testStatus = document.createElement('span');
    testStatus.className = 'test-status';
    testBtn.addEventListener('click', async function () {
      testBtn.disabled = true;
      testStatus.textContent = '正在从边缘函数探测...';
      testStatus.className = 'test-status';
      try {
        // Save this provider's fields first so the probe uses what is on
        // screen, then run the probe.
        await saveProviders(false);
        var data = await api('/api/admin/test', {
          method: 'POST',
          body: JSON.stringify({ provider: id }),
        });
        if (data.ok) {
          testStatus.textContent = '✓ 连通，' + data.ms + ' ms';
          testStatus.className = 'test-status ok';
        } else {
          testStatus.textContent = '✗ ' + (data.error || '不通') + (data.ms ? '（' + data.ms + ' ms）' : '');
          testStatus.className = 'test-status fail';
        }
      } catch (err) {
        testStatus.textContent = '✗ ' + err.message;
        testStatus.className = 'test-status fail';
      } finally {
        testBtn.disabled = false;
      }
    });
    actions.appendChild(testBtn);
    actions.appendChild(testStatus);
    body.appendChild(actions);
    card.appendChild(body);
    return card;
  }

  function fieldGroup(label) {
    var group = document.createElement('div');
    group.className = 'form-group';
    var lab = document.createElement('label');
    lab.textContent = label;
    group.appendChild(lab);
    return group;
  }

  function renderOrder() {
    orderList.innerHTML = '';
    order.forEach(function (id, idx) {
      var row = document.createElement('div');
      row.className = 'order-item';
      var name = document.createElement('span');
      name.textContent = (idx + 1) + '. ' + (config.providers[id] ? config.providers[id].name : id);
      var up = document.createElement('button');
      up.className = 'btn btn-secondary btn-sm';
      up.textContent = '上移';
      up.disabled = idx === 0;
      up.addEventListener('click', function () {
        var t = order[idx - 1];
        order[idx - 1] = order[idx];
        order[idx] = t;
        renderOrder();
        renderProviders();
      });
      var down = document.createElement('button');
      down.className = 'btn btn-secondary btn-sm';
      down.textContent = '下移';
      down.disabled = idx === order.length - 1;
      down.addEventListener('click', function () {
        var t = order[idx + 1];
        order[idx + 1] = order[idx];
        order[idx] = t;
        renderOrder();
        renderProviders();
      });
      row.appendChild(name);
      row.appendChild(up);
      row.appendChild(down);
      orderList.appendChild(row);
    });
  }

  // ---------- saving ----------

  function collectProviders() {
    var providers = {};
    Object.keys(config.providers).forEach(function (id) {
      var entry = {};
      var keyInput = document.getElementById('key-' + id);
      var modelInput = document.getElementById('model-' + id);
      var baseInput = document.getElementById('base-' + id);
      if (keyInput && keyInput.value.trim()) entry.key = keyInput.value.trim();
      if (modelInput) entry.model = modelInput.value.trim();
      if (baseInput) entry.base_url = baseInput.value.trim();
      providers[id] = entry;
    });
    return providers;
  }

  async function saveProviders(showStatus) {
    var data = await api('/api/admin/config', {
      method: 'POST',
      body: JSON.stringify({ providers: collectProviders(), order: order }),
    });
    if (!data.success) throw new Error(data.error || '保存失败');
    config = data.config;
    if (showStatus) showSaveStatus('已保存');
    return data;
  }

  $('#save-btn').addEventListener('click', async function () {
    try {
      var payload = {
        providers: collectProviders(),
        order: order,
        daily_limit: Number($('#daily-limit-input').value) || 100,
        ip_daily_limit: Number($('#ip-limit-input').value) || 0,
      };
      var codeInput = $('#access-code-input');
      // Only send access_code when the admin typed something or a code was
      // already set and the field was deliberately cleared after focus.
      if (codeInput.value.trim() || codeInput.dataset.touched === '1') {
        payload.access_code = codeInput.value.trim();
      }
      var newPassword = $('#new-password-input').value;
      if (newPassword) payload.new_password = newPassword;
      var data = await api('/api/admin/config', { method: 'POST', body: JSON.stringify(payload) });
      if (!data.success) throw new Error(data.error || '保存失败');
      config = data.config;
      $('#new-password-input').value = '';
      renderProviders();
      showSaveStatus('全部设置已保存');
      await refreshStats();
    } catch (err) {
      showSaveStatus('保存失败：' + err.message);
    }
  });
  $('#access-code-input').addEventListener('input', function () {
    this.dataset.touched = '1';
  });

  function showSaveStatus(text) {
    var el = $('#save-status');
    el.textContent = text;
    setTimeout(function () { el.textContent = ''; }, 3000);
  }

  // ---------- stats ----------

  async function refreshStats() {
    var data = await api('/api/admin/stats');
    if (data.success) {
      $('#stat-today').textContent = data.stats.today;
      $('#stat-total').textContent = data.stats.total;
      $('#stat-limit').textContent = data.stats.daily_limit;
      renderProviderStats(data.stats.provider_stats || {});
      renderEvents(data.stats.events || []);
    }
  }

  var PROVIDER_LABELS = {
    sensenova: 'SenseNova（商汤）',
    deepseek: 'DeepSeek 官方',
    gemini: 'Google Gemini',
    openrouter: 'OpenRouter',
    custom: '自定义服务',
  };

  function renderProviderStats(stats) {
    var wrap = $('#pstats-wrap');
    wrap.innerHTML = '';
    var ids = Object.keys(stats);
    if (!ids.length) return;
    var title = document.createElement('h4');
    title.className = 'sub-title';
    title.textContent = '今日各供应商';
    wrap.appendChild(title);
    var table = document.createElement('table');
    table.className = 'data-table';
    var html = '<thead><tr><th>供应商</th><th>调用</th><th>成功</th><th>失败</th><th>平均耗时</th></tr></thead><tbody>';
    ids.forEach(function (id) {
      var st = stats[id];
      var avg = st.calls ? Math.round(st.total_ms / st.calls) : 0;
      html += '<tr><td>' + (PROVIDER_LABELS[id] || id) + '</td><td>' + st.calls + '</td><td>' + st.ok + '</td><td>' + st.fail + '</td><td>' + avg + ' ms</td></tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
    wrap.appendChild(table);
  }

  function renderEvents(events) {
    var list = $('#event-list');
    list.innerHTML = '';
    if (!events.length) {
      list.textContent = '暂无事件';
      return;
    }
    events.forEach(function (evt) {
      var row = document.createElement('div');
      row.className = 'event-item';
      var when = new Date(evt.ts);
      var time = (when.getMonth() + 1) + '-' + when.getDate() + ' ' +
        String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
      var status = document.createElement('span');
      status.className = evt.ok ? 'event-ok' : 'event-fail';
      status.textContent = evt.ok ? '成功' : '失败';
      var desc = evt.type === 'chat' ? '手册问答' : '手册分析';
      var detail = '';
      if (evt.ok) {
        detail = (PROVIDER_LABELS[evt.provider] || evt.provider || '') + ' · ' + (evt.model || '') +
          (evt.chip ? ' · ' + evt.chip : '') + (evt.ms ? ' · ' + (evt.ms / 1000).toFixed(1) + ' 秒' : '');
      } else {
        detail = evt.error || '';
      }
      row.textContent = time + ' ';
      row.appendChild(status);
      row.appendChild(document.createTextNode(' ' + desc + (detail ? ' · ' + detail : '')));
      list.appendChild(row);
    });
  }

  async function loadHealth() {
    var el = $('#health-line');
    try {
      var res = await fetch('/api/health');
      var data = await res.json();
      var span = document.createElement('span');
      span.className = 'ok';
      span.textContent = '正常';
      el.textContent = '服务状态：';
      el.appendChild(span);
      el.appendChild(document.createTextNode(
        ' · 版本 ' + data.version + ' · KV ' + (data.kv ? '已绑定' : '未绑定') +
        ' · 已配置 ' + data.providers_configured + ' 家供应商'));
    } catch (e) {
      el.textContent = '服务状态：健康检查失败';
    }
  }
  $('#refresh-stats-btn').addEventListener('click', refreshStats);
  $('#reset-stats-btn').addEventListener('click', async function () {
    if (!window.confirm('确定重置调用统计吗？')) return;
    await api('/api/admin/stats', { method: 'POST', body: JSON.stringify({ action: 'reset' }) });
    await refreshStats();
  });

  // ---------- boot ----------

  if (token()) {
    enterPanel().catch(function () {
      logout();
    });
  }
})();
