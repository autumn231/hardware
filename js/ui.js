// Shared UI: theme toggle (dark / light instrument panel) + custom dropdowns.
(function () {
  'use strict';

  /* ---------- theme ---------- */
  var THEME_KEY = 'hw-theme';

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  function syncToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    btn.textContent = currentTheme() === 'light' ? '◑ 深色面板' : '◐ 浅色面板';
  }

  function initTheme() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    syncToggle();
    btn.addEventListener('click', function () {
      var next = currentTheme() === 'light' ? 'dark' : 'light';
      if (next === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
      } else {
        document.documentElement.removeAttribute('data-theme');
      }
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* ignore */ }
      syncToggle();
    });
  }

  /* ---------- custom dropdown ---------- */
  function upgradeSelect(select) {
    if (select.dataset.upgraded) return;
    select.dataset.upgraded = '1';

    var wrap = document.createElement('div');
    wrap.className = 'dd';
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);
    select.classList.add('dd-native');
    select.setAttribute('tabindex', '-1');

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    var label = document.createElement('span');
    var chevron = document.createElement('span');
    chevron.className = 'dd-chevron';
    chevron.textContent = '▼';
    btn.appendChild(label);
    btn.appendChild(chevron);
    wrap.appendChild(btn);

    var list = document.createElement('div');
    list.className = 'dd-list';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(list);

    var items = [];
    function rebuild() {
      list.innerHTML = '';
      items = [];
      Array.prototype.forEach.call(select.options, function (opt, i) {
        var item = document.createElement('div');
        item.className = 'dd-item' + (i === select.selectedIndex ? ' selected' : '');
        item.textContent = opt.textContent;
        item.setAttribute('role', 'option');
        item.addEventListener('click', function () { choose(i); close(); btn.focus(); });
        item.addEventListener('mousemove', function () { setFocus(i); });
        list.appendChild(item);
        items.push(item);
      });
      var cur = select.options[select.selectedIndex];
      label.textContent = cur ? cur.textContent : '';
    }

    var focusIdx = -1;
    function setFocus(i) {
      if (focusIdx >= 0 && items[focusIdx]) items[focusIdx].classList.remove('focused');
      focusIdx = i;
      if (i >= 0 && items[i]) items[i].classList.add('focused');
    }

    function open() {
      rebuild();
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      setFocus(select.selectedIndex);
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKey, true);
    }
    function close() {
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onDocClick(e) { if (!wrap.contains(e.target)) close(); }
    function onKey(e) {
      if (e.key === 'Escape') { close(); btn.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(Math.min(focusIdx + 1, items.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(Math.max(focusIdx - 1, 0)); }
      else if (e.key === 'Enter' || e.key === ' ') {
        if (focusIdx >= 0) { e.preventDefault(); choose(focusIdx); close(); btn.focus(); }
      }
    }
    function choose(i) {
      if (select.selectedIndex !== i) {
        select.selectedIndex = i;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      rebuild();
    }

    btn.addEventListener('click', function () {
      if (wrap.classList.contains('open')) close(); else open();
    });
    btn.addEventListener('keydown', function (e) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !wrap.classList.contains('open')) {
        e.preventDefault(); open();
      }
    });
    select.addEventListener('change', rebuild);
    rebuild();
  }

  function init() {
    initTheme();
    Array.prototype.forEach.call(document.querySelectorAll('select.select-upgrade'), upgradeSelect);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
