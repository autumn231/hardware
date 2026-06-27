(function () {
  const $ = (sel) => document.querySelector(sel);

  const loginSection = $('#login-section');
  const adminSection = $('#admin-section');
  const loginBtn = $('#login-btn');
  const logoutBtn = $('#logout-btn');
  const passwordInput = $('#admin-password');
  const loginError = $('#login-error');

  const refreshStatsBtn = $('#refresh-stats-btn');
  const resetTodayBtn = $('#reset-today-btn');
  const resetAllBtn = $('#reset-all-btn');
  const saveConfigBtn = $('#save-config-btn');
  const changePasswordBtn = $('#change-password-btn');

  let authToken = localStorage.getItem('admin_token') || '';

  function init() {
    if (authToken) {
      verifyAndShowAdmin();
    } else {
      showLogin();
    }
  }

  function showLogin() {
    loginSection.style.display = '';
    adminSection.style.display = 'none';
  }

  function showAdmin() {
    loginSection.style.display = 'none';
    adminSection.style.display = '';
    loadStats();
    loadConfig();
  }

  async function verifyAndShowAdmin() {
    try {
      const res = await fetch('/api/admin/config', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      if (res.ok) {
        showAdmin();
      } else {
        localStorage.removeItem('admin_token');
        authToken = '';
        showLogin();
      }
    } catch {
      showLogin();
    }
  }

  loginBtn.addEventListener('click', async () => {
    const password = passwordInput.value.trim();
    if (!password) {
      loginError.textContent = '请输入密码';
      loginError.style.display = '';
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = '登录中...';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const data = await res.json();

      if (data.success) {
        authToken = data.token;
        localStorage.setItem('admin_token', authToken);
        loginError.style.display = 'none';
        showAdmin();
      } else {
        loginError.textContent = data.error || '登录失败';
        loginError.style.display = '';
      }
    } catch (err) {
      loginError.textContent = '网络错误，请重试';
      loginError.style.display = '';
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = '登录';
    }
  });

  passwordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loginBtn.click();
  });

  logoutBtn.addEventListener('click', () => {
    authToken = '';
    localStorage.removeItem('admin_token');
    passwordInput.value = '';
    showLogin();
  });

  async function loadStats() {
    try {
      const res = await fetch('/api/admin/stats', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (data.success) {
        $('#stat-today').textContent = data.stats.today_calls;
        $('#stat-limit').textContent = data.stats.daily_limit;
        $('#stat-total').textContent = data.stats.total_calls;
        $('#stat-date').textContent = data.stats.date;
      } else if (res.status === 401) {
        handleAuthError();
      }
    } catch {
      showToast('加载统计失败', 'error');
    }
  }

  async function loadConfig() {
    try {
      const res = await fetch('/api/admin/config', {
        headers: { 'Authorization': `Bearer ${authToken}` },
      });
      const data = await res.json();
      if (data.success) {
        $('#config-model').value = data.config.model;
        $('#config-daily-limit').value = data.config.daily_limit;
        $('#api-key-hint').textContent = data.config.api_key_set
          ? `当前：${data.config.api_key_masked}`
          : '当前未设置';
      } else if (res.status === 401) {
        handleAuthError();
      }
    } catch {
      showToast('加载配置失败', 'error');
    }
  }

  refreshStatsBtn.addEventListener('click', loadStats);

  resetTodayBtn.addEventListener('click', async () => {
    if (!confirm('确定要重置今日调用次数吗？')) return;
    try {
      const res = await fetch('/api/admin/stats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ action: 'reset_today' }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('今日调用次数已重置', 'success');
        loadStats();
      } else {
        showToast(data.error || '操作失败', 'error');
      }
    } catch {
      showToast('操作失败', 'error');
    }
  });

  resetAllBtn.addEventListener('click', async () => {
    if (!confirm('确定要重置所有调用次数吗？此操作不可恢复！')) return;
    try {
      const res = await fetch('/api/admin/stats', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ action: 'reset_all' }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('所有调用次数已重置', 'success');
        loadStats();
      } else {
        showToast(data.error || '操作失败', 'error');
      }
    } catch {
      showToast('操作失败', 'error');
    }
  });

  saveConfigBtn.addEventListener('click', async () => {
    const apiKey = $('#config-api-key').value.trim();
    const model = $('#config-model').value.trim();
    const dailyLimit = parseInt($('#config-daily-limit').value, 10);

    const payload = {};
    if (apiKey) payload.api_key = apiKey;
    if (model) payload.model = model;
    if (!isNaN(dailyLimit) && dailyLimit > 0) payload.daily_limit = dailyLimit;

    if (Object.keys(payload).length === 0) {
      showToast('没有需要保存的更改', 'error');
      return;
    }

    saveConfigBtn.disabled = true;
    saveConfigBtn.textContent = '保存中...';

    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        showToast('配置已保存', 'success');
        $('#config-api-key').value = '';
        loadConfig();
      } else {
        if (res.status === 401) {
          handleAuthError();
        } else {
          showToast(data.error || '保存失败', 'error');
        }
      }
    } catch {
      showToast('保存失败', 'error');
    } finally {
      saveConfigBtn.disabled = false;
      saveConfigBtn.textContent = '保存配置';
    }
  });

  changePasswordBtn.addEventListener('click', async () => {
    const newPwd = $('#new-password').value;
    const confirmPwd = $('#confirm-password').value;

    if (!newPwd) {
      showToast('请输入新密码', 'error');
      return;
    }
    if (newPwd !== confirmPwd) {
      showToast('两次输入的密码不一致', 'error');
      return;
    }
    if (newPwd.length < 4) {
      showToast('密码长度至少4位', 'error');
      return;
    }

    changePasswordBtn.disabled = true;
    changePasswordBtn.textContent = '修改中...';

    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authToken}`,
        },
        body: JSON.stringify({ new_password: newPwd }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('密码已修改，请重新登录', 'success');
        authToken = '';
        localStorage.removeItem('admin_token');
        setTimeout(() => showLogin(), 1500);
      } else {
        if (res.status === 401) {
          handleAuthError();
        } else {
          showToast(data.error || '修改失败', 'error');
        }
      }
    } catch {
      showToast('修改失败', 'error');
    } finally {
      changePasswordBtn.disabled = false;
      changePasswordBtn.textContent = '修改密码';
    }
  });

  function handleAuthError() {
    authToken = '';
    localStorage.removeItem('admin_token');
    showLogin();
    showToast('登录已过期，请重新登录', 'error');
  }

  function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  init();
})();
