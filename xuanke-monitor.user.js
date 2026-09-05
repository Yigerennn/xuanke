// ==UserScript==
// @name         上财选课空位监测助手(半自动版)
// @namespace    sufe-xuanke-helper
// @version      0.2.1
// @description  在自己的登录会话里定时监测心愿单课程余量:发现空位→声音+系统通知+高亮,由你手动确认提交(不自动选课、不收集他人账号)
// @match        https://portal.sufe.edu.cn/*
// @match        https://eams.sufe.edu.cn/*
// @match        https://login.sufe.edu.cn/*
// @match        https://weportal.sufe.edu.cn/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * 0. 基本设置与数据
   * ============================================================ */
  var STORE_KEY = 'sufe_xk_wishlist';     // Tampermonkey 独立存储(不与其他网站共享)
  var DEFAULT_INTERVAL = 20;              // 默认轮询间隔(秒)
  var INTERVAL_CHOICES = [5, 10, 15, 20, 30, 60];

  var cfg = {
    running: false,
    interval: parseInt(GM_getValue('interval', DEFAULT_INTERVAL), 10),
    sound: GM_getValue('sound', true),
    notif: GM_getValue('notif', true),
    lastCheck: '',
    nextCheck: '',
    lastState: {},   // code -> 'full' | 'free' | 'unknown'(用于只在状态变化时记日志)
    foundIds: {},    // code -> true(本轮监测会话中发现过空位)
    ignored: {}      // code -> true(用户点了“忽略”,不再提醒)
  };
  var items = loadItems();
  var timer = null;
  var busy = false;
  var logLines = [];

  function loadItems() {
    try {
      var raw = GM_getValue(STORE_KEY, '');
      if (!raw) return [];
      var o = JSON.parse(raw);
      return (Array.isArray(o) ? o : (o && Array.isArray(o.items) ? o.items : []))
        .filter(function (it) { return it && it.code; })
        .map(function (it) { return { id: it.id || it.code, name: it.name || it.code, code: String(it.code),
          prio: parseInt(it.prio, 10) || 3, type: it.type || '其他', status: it.status === 'backup' ? 'backup' : 'main',
          time: it.time || '', note: it.note || '' }; });
    } catch (e) { return []; }
  }
  function saveItems() {
    GM_setValue(STORE_KEY, JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), items: items }));
  }

  /* ============================================================
   * 1. 对接层(第 2 阶段占位)——选课开放后由开发者填充
   * ------------------------------------------------------------
   * 需要真实选课页面才能实现:
   *   a) 找到选课页面“查询课程/余量”的请求(浏览器 F12 → Network),
   *      把它的 URL、方法、参数、返回结构填进 fetchSeatInfo;
   *   b) 找到“选课”按钮/课程详情入口,把跳转逻辑填进 openCoursePage。
   * 现在两个函数只是占位:监测循环、声音/系统通知/面板均已可用。
   * ============================================================ */
  function delay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  async function fetchSeatInfo(one) {
    // TODO(第2阶段): 替换为真实查询。示例骨架:
    //   const resp = await fetch('/真实接口?courseCode=' + encodeURIComponent(one.code),
    //       { credentials: 'include', headers: { 'Accept': 'application/json' } });
    //   const data = await resp.json();
    //   return { available: (data.余量字段 > 0), detail: data };
    await delay(400 + Math.random() * 400);
    return { available: null, msg: '对接层未配置(见脚本注释)——暂无法查询空位' };
  }

  function openCoursePage(one) {
    // TODO(第2阶段): 跳转到该课程详情/选课页,让你一键确认。
    // 例: window.location.href = 'https://.../course?code=' + encodeURIComponent(one.code);
    alert('对接层未配置:选课开放后,把选课页面信息提供给开发者即可启用“打开课程页”。\n当前请自行到选课系统搜索课程序号:' + one.code);
  }

  /* ============================================================
   * 2. 监测循环
   * ============================================================ */
  async function tick() {
    var targets = items.filter(function (it) { return it.status === 'main' && !cfg.ignored[it.code]; });
    if (!targets.length) { log('没有待监测的主选课程(可先导入心愿单)'); stop(); return; }
    var found = 0;
    for (var i = 0; i < targets.length; i++) {
      var it = targets[i];
      var res = { available: null, msg: '' };
      try { res = await fetchSeatInfo(it); }
      catch (e) { res = { available: null, msg: '查询出错:' + e.message }; }
      var st = res.available === true ? 'free' : (res.available === false ? 'full' : 'unknown');
      if (res.available === true && !cfg.foundIds[it.code]) {
        cfg.foundIds[it.code] = true;
        found++;
        cfg.lastState[it.code] = 'free';
        log('★ 发现空位:' + it.name + ' (' + it.code + ')');
        alarm(it);
      } else if (st !== 'unknown' && cfg.lastState[it.code] !== st) {
        cfg.lastState[it.code] = st;
        if (st === 'full') log(it.name + ' 目前满员(会继续盯)');
      }
    }
    cfg.lastCheck = new Date().toLocaleTimeString();
    cfg.nextCheck = new Date(Date.now() + cfg.interval * 1000).toLocaleTimeString();
    scheduleNext();
    renderPanel();
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null; } }
  function scheduleNext() { stopTimer(); timer = setInterval(runTick, cfg.interval * 1000); }
  async function runTick() {
    if (busy) return;
    busy = true;
    try { await tick(); }
    catch (e) {
      log('循环异常:' + e.message);
      cfg.nextCheck = new Date(Date.now() + cfg.interval * 1000).toLocaleTimeString();
      scheduleNext(); renderPanel();
    } finally { busy = false; }
  }

  function start() {
    if (!items.length) { log('心愿单为空:先在面板输入框粘贴 JSON 并点“导入”,或先在本工具添加课程'); return; }
    requestNotif();
    cfg.running = true;
    cfg.foundIds = {};
    log('开始监测:共 ' + items.filter(function (i) { return i.status === 'main'; }).length + ' 门主选(每 ' + cfg.interval + ' 秒一次)');
    runTick();
    renderPanel();
  }
  function stop() {
    cfg.running = false;
    stopTimer();
    cfg.nextCheck = '';
    log('已停止监测');
    renderPanel();
  }

  /* ============================================================
   * 3. 提醒:声音 + 系统通知 + 面板高亮
   * ============================================================ */
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !cfg.sound) return;
      var ctx = new AC();
      [880, 1174].forEach(function (f, i) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        var t0 = ctx.currentTime + i * 0.25;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0); o.stop(t0 + 0.5);
      });
      setTimeout(function () { try { ctx.close(); } catch (e) {} }, 1500);
    } catch (e) {}
  }
  function requestNotif() {
    if (cfg.notif && 'Notification' in window && Notification.permission === 'default') {
      try { Notification.requestPermission(); } catch (e) {}
    }
  }
  function systemNotify(title, body) {
    if (!cfg.notif) return;
    try {
      if (typeof GM_notification === 'function') { GM_notification({ title: title, text: body, timeout: 10000 }); }
      else if ('Notification' in window && Notification.permission === 'granted') { new Notification(title, { body: body }); }
    } catch (e) {}
  }
  function alarm(it) {
    beep();
    systemNotify('选课监测: 有空位了!', it.name + '(' + it.code + ') 出现空位,快去确认选课!');
  }

  /* ============================================================
   * 4. 面板 UI
   * ============================================================ */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function log(s) {
    logLines.unshift(new Date().toLocaleTimeString() + ' ' + s);
    if (logLines.length > 60) logLines.pop();
    var el = document.getElementById('xk-log');
    if (el) el.innerHTML = logLines.map(esc).join('<br>');
  }

  var opened = false;
  function ensurePanel() {
    if (document.getElementById('xk-panel')) return;
    var css = document.createElement('style');
    css.textContent =
      '#xk-fab{position:fixed;right:18px;bottom:18px;z-index:2147483000;background:#b02a37;color:#fff;border:none;border-radius:40px;padding:10px 16px;font-size:14px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3);font-family:system-ui,"Microsoft YaHei",sans-serif}' +
      '#xk-panel{position:fixed;right:18px;bottom:60px;z-index:2147483001;width:360px;max-height:74vh;display:flex;flex-direction:column;background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.18);font-family:system-ui,"Microsoft YaHei",sans-serif;font-size:13px;color:#1f2937}' +
      '#xk-panel .xk-h{background:#b02a37;color:#fff;padding:9px 12px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center;flex:none}' +
      '#xk-panel .xk-b{padding:10px 12px;overflow:auto}' +
      '#xk-panel button{border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;font-family:inherit}' +
      '#xk-items .xk-it{border:1px solid #e5e7eb;border-radius:8px;padding:7px 9px;margin-bottom:6px}' +
      '#xk-items .xk-it.found{border-color:#16a34a;background:#f0fdf4}' +
      '#xk-log{background:#111827;color:#9fe8b0;font-size:11px;padding:6px 8px;border-radius:8px;max-height:110px;overflow:auto;margin-top:8px;line-height:1.6;white-space:pre-wrap;word-break:break-all}' +
      '.xk-sel{padding:3px 5px;border-radius:5px;border:1px solid #d1d5db;font-size:12px;font-family:inherit}';
    document.head.appendChild(css);

    var fab = document.createElement('button');
    fab.id = 'xk-fab'; fab.textContent = '🎯 选课助手';
    document.body.appendChild(fab);

    var p = document.createElement('div');
    p.id = 'xk-panel'; p.hidden = true;
    p.innerHTML =
      '<div class="xk-h"><b>上财选课助手 · 半自动</b><button id="xk-close" style="background:none;color:#fff;font-size:18px;padding:0 6px;line-height:1">×</button></div>' +
      '<div class="xk-b">' +
        '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
          '<button id="xk-start" style="background:#16a34a;color:#fff">开始监测</button>' +
          '<button id="xk-stop" style="background:#6b7280;color:#fff">停止</button>' +
          '<select id="xk-int" class="xk-sel" title="轮询间隔"></select>' +
          '<label style="font-size:12px;display:inline-flex;align-items:center;gap:2px"><input type="checkbox" id="xk-snd">声音</label>' +
          '<label style="font-size:12px;display:inline-flex;align-items:center;gap:2px"><input type="checkbox" id="xk-nif">系统通知</label>' +
        '</div>' +
        '<div style="font-size:12px;color:#6b7280;margin-bottom:6px">状态:<span id="xk-state">未开始</span> · 上次:<span id="xk-last">-</span> · 下次:<span id="xk-next">-</span></div>' +
        '<div id="xk-items" style="max-height:24vh;overflow:auto"></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px">' +
          '<input id="xk-imp" class="xk-sel" style="flex:1" placeholder="粘贴 index.html 导出的 JSON 后点导入">' +
          '<button id="xk-impbtn" style="background:#1d4ed8;color:#fff;white-space:nowrap">导入</button>' +
        '</div>' +
        '<div style="font-size:11px;color:#9ca3af;line-height:1.6;margin-top:8px">只提醒+高亮,选课由你手动提交。发现空位请尽快去选课系统操作。</div>' +
        '<div id="xk-log"></div>' +
      '</div>';
    document.body.appendChild(p);

    var sel = document.getElementById('xk-int');
    INTERVAL_CHOICES.forEach(function (v) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v + ' 秒';
      if (v === cfg.interval) o.selected = true;
      sel.appendChild(o);
    });
    document.getElementById('xk-snd').checked = cfg.sound;
    document.getElementById('xk-nif').checked = cfg.notif;

    fab.addEventListener('click', function () {
      opened = !opened; p.hidden = !opened;
      if (opened) renderPanel();
    });
    document.getElementById('xk-close').addEventListener('click', function () { opened = false; p.hidden = true; });
    document.getElementById('xk-start').addEventListener('click', start);
    document.getElementById('xk-stop').addEventListener('click', stop);
    sel.addEventListener('change', function () {
      cfg.interval = parseInt(sel.value, 10);
      GM_setValue('interval', cfg.interval);
      if (cfg.running) { log('轮询间隔改为 ' + cfg.interval + ' 秒'); scheduleNext(); }
    });
    document.getElementById('xk-snd').addEventListener('change', function () { cfg.sound = this.checked; GM_setValue('sound', cfg.sound); });
    document.getElementById('xk-nif').addEventListener('change', function () { cfg.notif = this.checked; GM_setValue('notif', cfg.notif); requestNotif(); });
    document.getElementById('xk-impbtn').addEventListener('click', importFromBox);
    renderPanel();
  }

  function importFromBox() {
    var box = document.getElementById('xk-imp');
    try {
      var o = JSON.parse(box.value);
      var arr = Array.isArray(o) ? o : (o && o.items ? o.items : null);
      if (!arr) throw new Error('无法识别为心愿单 JSON');
      var added = 0;
      arr.forEach(function (it) {
        if (!it || !it.code) return;
        var code = String(it.code);
        if (items.some(function (x) { return x.code === code; })) return;
        items.push({ id: it.id || code, name: it.name || code, code: code,
          prio: parseInt(it.prio, 10) || 3, type: it.type || '其他', status: it.status === 'backup' ? 'backup' : 'main',
          time: it.time || '', note: it.note || '' });
        added++;
      });
      saveItems();
      renderPanel();
      log('导入成功:新增 ' + added + ' 门');
    } catch (e) { log('导入失败:' + e.message); }
  }

  function renderPanel() {
    if (!document.getElementById('xk-panel')) return;
    document.getElementById('xk-state').textContent = cfg.running ? '监测中' : '未开始';
    document.getElementById('xk-last').textContent = cfg.lastCheck || '-';
    document.getElementById('xk-next').textContent = cfg.running ? (cfg.nextCheck || '…') : '-';
    var box = document.getElementById('xk-items');
    if (!items.length) {
      box.innerHTML = '<div style="color:#9ca3af;padding:6px 0">心愿单为空:先在本工具(index.html)录入,再把 JSON 粘贴上方导入</div>';
      return;
    }
    box.innerHTML = items.map(function (it) {
      var found = !!cfg.foundIds[it.code];
      var ign = !!cfg.ignored[it.code];
      var canJump = found || ign || it.status === 'backup'; // 备选课随时可手动打开查看
      return '<div class="xk-it' + (found ? ' found' : '') + '">' +
        '<div style="display:flex;justify-content:space-between;gap:6px">' +
          '<b style="flex:1">' + esc(it.name) + '</b>' +
          (it.status === 'backup' ? '<span style="color:#6b7280;font-size:11px">备选</span>' : '') +
          '<span style="color:#9ca3af;font-size:11px;white-space:nowrap">P' + it.prio + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px">' +
          '<code style="font-size:11px">' + esc(it.code) + '</code>' +
          '<div style="white-space:nowrap">' +
            (found ? '<span style="color:#16a34a;font-weight:700;margin-right:6px">有空位!</span>' : '') +
            '<button class="xk-jump" data-id="' + esc(it.id) + '" style="background:' + (found ? '#16a34a' : (canJump ? '#eef2f7' : '#e5e7eb')) + ';color:' + (found ? '#fff' : (canJump ? '#374151' : '#9ca3af')) + '"' + (canJump ? '' : ' disabled title="对接后可用"') + '>去选课</button> ' +
            '<button class="xk-ign" data-id="' + esc(it.id) + '" style="background:#eef2f7;color:#374151">' + (ign ? '恢复' : '忽略') + '</button>' +
          '</div>' +
        '</div>' +
        (ign ? '<div style="color:#9ca3af;font-size:11px">已忽略:本轮不再提醒</div>' : '') +
      '</div>';
    }).join('');
    box.querySelectorAll('.xk-jump').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = findItem(b.getAttribute('data-id'));
        if (it) openCoursePage(it);
      });
    });
    box.querySelectorAll('.xk-ign').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = findItem(b.getAttribute('data-id'));
        if (!it) return;
        if (cfg.ignored[it.code]) { delete cfg.ignored[it.code]; log('恢复提醒:' + it.name); }
        else { cfg.ignored[it.code] = true; log('已忽略:' + it.name + '(本轮不再提醒)'); }
        renderPanel();
      });
    });
  }
  function findItem(id) {
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }

  ensurePanel();
  log('助手已加载(心愿单 ' + items.length + ' 门)。登录选课页面后点右下角按钮开始。');
})();
