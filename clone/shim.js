/**
 * 亮宅 Web 版 — Electron ipcRenderer 兼容层 (shim)
 *
 * 仅在浏览器环境生效；在 Electron 中检测到原生 window.ipcRenderer 时自动停用，
 * 因此同一份 dist 可同时供桌面版与 Web 版使用。
 *
 * 通道映射（与 resources/app/index.js 主进程行为对齐）：
 *  - 纯页面能力（窗口控制/剪贴板/右键菜单/截图引导等）在本地实现；
 *  - 需要服务端能力的（共享数据/事件转发/下载/预览/日志）走 HTTP + SSE。
 */
(function () {
  'use strict';

  // Electron 环境：已存在原生 ipcRenderer（preload 注入），不覆盖
  if (window.ipcRenderer) { return; }

  // ---------- 工具 ----------
  function winCodeOf() {
    var m = /[?&]win_code=(\d+)/.exec(location.hash);
    return m ? m[1] : '-1';
  }
  var WIN_CODE = winCodeOf();

  function toast(msg, ms) {
    try {
      var d = document.createElement('div');
      d.textContent = msg;
      d.style.cssText = 'position:fixed;left:50%;top:12%;transform:translateX(-50%);z-index:2147483000;'
        + 'background:rgba(0,0,0,.8);color:#fff;font-size:14px;padding:10px 18px;border-radius:6px;'
        + 'max-width:80vw;white-space:nowrap;box-shadow:0 2px 12px rgba(0,0,0,.3)';
      (document.body || document.documentElement).appendChild(d);
      setTimeout(function () { d.remove(); }, ms || 2600);
    } catch (e) { /* ignore */ }
  }

  // ---------- 事件注册表（复刻 preload.js 的语义） ----------
  var listeners = new Map(); // channel -> Set<fn>
  var channelDispatcher = new Map(); // channel -> wrapper fn

  function ensureSSE() {
    if (window.__LZ_SSE__) return;
    window.__LZ_SSE__ = new EventSource('/__events?win=' + encodeURIComponent(WIN_CODE));
    window.__LZ_SSE__.onmessage = function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (err) { return; }
      if (msg && typeof msg.channel === 'string') dispatch(msg.channel, msg.data);
    };
    window.__LZ_SSE__.onerror = function () { /* EventSource 自动重连 */ };
  }

  function dispatch(channel, data) {
    var set = listeners.get(channel);
    if (!set) return;
    set.forEach(function (fn) {
      try { fn({}, data); } catch (e) { /* 用户回调异常不影响其他监听 */ }
    });
  }

  function ensureChannelBridge(channel) {
    if (channelDispatcher.has(channel)) return;
    var wrapper = function (e, data) { dispatch(channel, data); };
    channelDispatcher.set(channel, wrapper);
  }

  // ---------- 同步请求（sendSync） ----------
  function syncIpc(channel, payload) {
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/__ipc-sync/' + encodeURIComponent(channel), false);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(JSON.stringify(payload || {}));
      if (x.status >= 200 && x.status < 300) {
        return JSON.parse(x.responseText || 'null');
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // ---------- 异步请求（send 的服务端通道） ----------
  // 优先 sendBeacon：即使页面随后立即卸载（openMainWin 触发 reload），
  // 请求也保证送达服务器，避免登录瞬间共享数据丢失。
  function postIpc(channel, payload) {
    var data = JSON.stringify(payload === undefined ? {} : payload);
    try {
      if (navigator.sendBeacon) {
        var blob = new Blob([data], { type: 'application/json' });
        if (navigator.sendBeacon('/__ipc/' + encodeURIComponent(channel), blob)) return;
      }
    } catch (e) { /* fallthrough */ }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', '/__ipc/' + encodeURIComponent(channel), true);
      x.setRequestHeader('Content-Type', 'application/json');
      x.send(data);
    } catch (e) { /* ignore */ }
  }

  function postIpcJson(channel, payload, cb) {
    var x = new XMLHttpRequest();
    x.open('POST', '/__ipc/' + encodeURIComponent(channel), true);
    x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      try {
        if (x.status >= 200 && x.status < 300) cb(JSON.parse(x.responseText || 'null'));
        else cb(null);
      } catch (e) { cb(null); }
    };
    try { x.send(JSON.stringify(payload === undefined ? {} : payload)); } catch (e) { cb(null); }
  }

  // ---------- 窗口关闭 ----------
  function tryCloseWindow(hint) {
    try { window.close(); } catch (e) { /* ignore */ }
    setTimeout(function () {
      if (!window.closed) toast(hint || '当前页面由浏览器管理，请直接关闭标签页');
    }, 350);
  }

  // ---------- 剪贴板 ----------
  function dataURLToBlob(dataURL) {
    var m = /^data:([^;]+);base64,(.*)$/i.exec(dataURL);
    if (!m) return null;
    var bin = atob(m[2]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    try { return new Blob([arr], { type: m[1] }); } catch (e) { return null; }
  }

  function copyTextLocal(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { fallbackCopyText(text); });
    } else {
      fallbackCopyText(text);
    }
  }
  function fallbackCopyText(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (e) { toast('复制失败，请手动复制'); }
  }

  function copyImageLocal(source) {
    var done = function (blob) {
      if (!blob) { toast('复制图片失败'); return; }
      if (navigator.clipboard && navigator.clipboard.write) {
        navigator.clipboard.write([new ClipboardItem((function () {
          var o = {}; o[blob.type || 'image/png'] = blob; return o;
        })())]).catch(function () { toast('复制图片失败，请右键保存图片'); });
      } else {
        toast('当前浏览器不支持复制图片，请右键保存图片');
      }
    };
    if (typeof source === 'string' && /^data:image/i.test(source)) {
      done(dataURLToBlob(source));
    } else if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
      fetch(source).then(function (r) { return r.blob(); }).then(done)
        .catch(function () { toast('复制图片失败'); });
    }
  }

  // 粘贴：先尝试异步剪贴板 API，失败则引导 Ctrl+V 并截获 paste 事件
  function requestPaste(replyChannel, meta) {
    var useApi = function () {
      if (!navigator.clipboard || !navigator.clipboard.read) { return Promise.reject(new Error('no api')); }
      return navigator.clipboard.read().then(function (items) {
        var hasImage = false, hasText = false;
        var jobs = [];
        items.forEach(function (item) {
          if (item.types.indexOf('text/plain') >= 0) {
            hasText = true;
            jobs.push(item.getType('text/plain').then(function (b) {
              return b.text().then(function (t) { dispatch(replyChannel, makePasteResult({ type: 1, data: t }, meta)); });
            }));
          }
          if (!hasImage && item.types.some(function (t) { return t.indexOf('image/') === 0; })) {
            hasImage = true;
            jobs.push(item.getType(item.types.find(function (t) { return t.indexOf('image/') === 0; }))
              .then(function (b) {
                return new Promise(function (res) {
                  var r = new FileReader();
                  r.onload = function () {
                    dispatch(replyChannel, makePasteResult({ type: 2, data: r.result }, meta)); res();
                  };
                  r.onerror = function () { res(); };
                  r.readAsDataURL(b);
                });
              }));
          }
        });
        return Promise.all(jobs);
      });
    };
    useApi().then(function () {
      showPasteOverlay(replyChannel, meta, false);
    }).catch(function () {
      showPasteOverlay(replyChannel, meta, true);
    });
  }

  function makePasteResult(base, meta) {
    if (meta && meta.key !== undefined) base.key = meta.key;
    if (meta && meta.itemIndex !== undefined) base.itemIndex = meta.itemIndex;
    return base;
  }

  function showPasteOverlay(replyChannel, meta, needHint) {
    var id = 'lz-paste-overlay';
    var old = document.getElementById(id);
    if (old) old.remove();
    if (!needHint) { // API 已返回结果但没有任何内容 → 不弹窗
      return;
    }
    var div = document.createElement('div');
    div.id = id;
    div.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);'
      + 'display:flex;align-items:center;justify-content:center';
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;border-radius:8px;padding:26px 34px;font-size:15px;color:#333;'
      + 'box-shadow:0 4px 24px rgba(0,0,0,.25);text-align:center';
    box.innerHTML = '<div style="font-size:16px;font-weight:600;margin-bottom:10px">请粘贴内容</div>'
      + '<div style="color:#666">请按 <b>Ctrl+V</b> 粘贴剪贴板中的文字、图片或文件</div>'
      + '<button style="margin-top:16px;padding:6px 22px;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer">取消</button>';
    div.appendChild(box);
    (document.body || document.documentElement).appendChild(div);
    var timer = setTimeout(function () { cleanup(); }, 45000);
    function cleanup() {
      clearTimeout(timer);
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKey);
      if (div.parentNode) div.remove();
    }
    box.querySelector('button').onclick = cleanup;
    div.onclick = function (ev) { if (ev.target === div) cleanup(); };
    function onKey(ev) { if (ev.key === 'Escape') cleanup(); }
    function onPaste(ev) {
      cleanup();
      var cd = ev.clipboardData;
      if (!cd) return;
      var items = cd.items;
      var files = [];
      var text = null;
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.kind === 'string' && it.type === 'text/plain') text = cd.getData('text/plain');
        else if (it.kind === 'file') files.push(it.getAsFile());
      }
      if (files.length) {
        var f = files[0];
        if (/^image\//.test(f.type)) {
          var r = new FileReader();
          r.onload = function () {
            dispatch(replyChannel, makePasteResult({ type: 2, data: r.result }, meta));
          };
          r.readAsDataURL(f);
        } else if (f.size > 100 * 1024 * 1024) {
          dispatch(replyChannel, makePasteResult({ type: 4 }, meta));
        } else {
          var fr = new FileReader();
          fr.onload = function () {
            dispatch(replyChannel, makePasteResult({ type: 3, buf: new Uint8Array(fr.result), name: f.name }, meta));
          };
          fr.readAsArrayBuffer(f);
        }
      } else if (text !== null) {
        dispatch(replyChannel, makePasteResult({ type: 1, data: text }, meta));
      }
    }
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKey);
  }

  // ---------- 右键菜单 ----------
  function showContextMenu(menuId, template) {
    var old = document.getElementById('lz-context-menu');
    if (old) old.remove();
    var menu = document.createElement('div');
    menu.id = 'lz-context-menu';
    menu.style.cssText = 'position:fixed;z-index:2147483000;background:#fff;border:1px solid #e4e7ed;'
      + 'border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,.15);padding:5px 0;min-width:130px;font-size:14px;color:#333';
    (template || []).forEach(function (item) {
      if (!item) return;
      if (item.type === 'separator') {
        var sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:#e4e7ed;margin:5px 0';
        menu.appendChild(sep);
        return;
      }
      var el = document.createElement('div');
      el.textContent = item.label || '';
      el.style.cssText = 'padding:7px 18px;cursor:pointer;white-space:nowrap';
      el.onmouseenter = function () { el.style.background = '#f5f7fa'; };
      el.onmouseleave = function () { el.style.background = ''; };
      el.onclick = function () {
        menu.remove();
        dispatch('context-menu-command', { menuId: menuId, id: item.id });
      };
      menu.appendChild(el);
    });
    (document.body || document.documentElement).appendChild(menu);
    var pos = { x: 0, y: 0 };
    if (window.__LZ_LAST_MENU_POS__) pos = window.__LZ_LAST_MENU_POS__;
    var mw = menu.offsetWidth || 150, mh = menu.offsetHeight || 100;
    pos.x = Math.max(2, Math.min(pos.x, window.innerWidth - mw - 2));
    pos.y = Math.max(2, Math.min(pos.y, window.innerHeight - mh - 2));
    menu.style.left = pos.x + 'px';
    menu.style.top = pos.y + 'px';
    function remove() {
      if (menu.parentNode) menu.remove();
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onDown(ev) { if (!menu.contains(ev.target)) remove(); }
    function onKey(ev) { if (ev.key === 'Escape') remove(); }
    setTimeout(function () {
      document.addEventListener('mousedown', onDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  document.addEventListener('mousedown', function (ev) {
    if (ev.button === 2) window.__LZ_LAST_MENU_POS__ = { x: ev.clientX, y: ev.clientY };
  }, true);

  // ---------- 下载 ----------
  function triggerBrowserDownload(url, name) {
    var a = document.createElement('a');
    a.href = url;
    if (name) a.download = name;
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); }, 500);
  }

  function downloadFromBuffer(payload) {
    var buf = payload && payload.buffer;
    var blob = null;
    try {
      if (buf instanceof ArrayBuffer) blob = new Blob([buf]);
      else if (buf && typeof buf === 'object' && typeof buf.buffer === 'object' && buf.buffer instanceof ArrayBuffer) blob = new Blob([buf]);
      else if (Array.isArray(buf)) blob = new Blob([new Uint8Array(buf)]);
      else if (buf && typeof buf === 'object' && Array.isArray(buf.data)) blob = new Blob([new Uint8Array(buf.data)]);
      else if (typeof buf === 'string' && /^data:/i.test(buf)) blob = dataURLToBlob(buf);
      else if (typeof buf === 'string') {
        var bin = atob(buf), arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        blob = new Blob([arr]);
      }
    } catch (e) { blob = null; }
    if (!blob) { toast('下载失败：数据不可用'); return; }
    var url = URL.createObjectURL(blob);
    triggerBrowserDownload(url, payload.fileName || 'download');
    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
    if (payload.eventName) dispatch(payload.eventName);
  }

  function downloadFromUrl(payload) {
    var q = '/__download?url=' + encodeURIComponent(payload.url)
      + '&name=' + encodeURIComponent(payload.fileName || payload.name || 'download')
      + '&key=' + encodeURIComponent(payload.key || '')
      + '&win=' + encodeURIComponent(payload.winCode !== undefined && payload.winCode !== null ? payload.winCode : '-1')
      + '&event=' + encodeURIComponent(payload.eventName || '');
    triggerBrowserDownload(q, payload.fileName || payload.name);
  }

  function batchDownload(payload) {
    var files = payload.files || [];
    files.forEach(function (f, i) {
      var name = (f.type ? 'mp4' : 'png');
      var dt = new Date();
      var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
      var stamp = '' + dt.getFullYear() + pad(dt.getMonth() + 1) + pad(dt.getDate())
        + pad(dt.getHours()) + pad(dt.getMinutes()) + pad(dt.getSeconds());
      var fileName = stamp + String(i + 1) + '.' + name;
      setTimeout(function () {
        triggerBrowserDownload('/__download?url=' + encodeURIComponent(f.origin_url)
          + '&name=' + encodeURIComponent(fileName)
          + '&key=' + encodeURIComponent('batch-' + i)
          + '&win=-1&event=', fileName);
      }, i * 400);
    });
    dispatch('download-end');
  }

  // ---------- 子窗口 ----------
  var SUBWIN_FEATURES = {
    0: 'width=820,height=640', 1: 'width=750,height=400', 2: 'width=750,height=590',
    3: 'width=750,height=640', 4: 'width=750,height=590', 5: 'width=750,height=640',
    6: 'width=750,height=740', 7: 'width=750,height=740', 8: 'width=750,height=740',
    9: 'width=750,height=740', 10: 'width=750,height=640', 11: 'width=980,height=640'
  };

  function openSubWin(payload) {
    var w = null;
    try {
      w = window.open('/__pending.html', 'lz_subwin_' + Date.now(),
        SUBWIN_FEATURES[0] || 'width=800,height=640');
    } catch (e) { w = null; }
    postIpcJson('openSubWin', payload || {}, function (res) {
      var finalUrl = res && res.url;
      if (!finalUrl) {
        if (w) try { w.close(); } catch (e) {}
        toast('打开窗口失败');
        return;
      }
      try {
        if (w) w.location.href = finalUrl;
        else window.open(finalUrl, 'lz_subwin_' + Date.now());
      } catch (e) {
        toast('窗口被浏览器拦截，请允许弹出窗口');
      }
    });
  }

  // ---------- 本地通道处理器 ----------
  var localHandlers = {
    'min': function () {},
    'max': function () {},
    'hide': function () {},
    'close': function () { tryCloseWindow(); },
    'closeMainWin': function () { tryCloseWindow(); },
    'closeLoginWin': function (p) {
      if (p && p.type === 2) tryCloseWindow('应用已请求退出，请关闭标签页');
    },
    'openMainWin': function () {
      // 等价于打开一个全新的主窗口：回到首页并重新引导。
      // 延迟执行 reload：给登录流程中紧随其后的 set-custom-data /
      // closeLoginWin 等调用留出送达窗口（桌面端这些调用发生在旧窗口，
      // Web 端若立即 reload 会丢失在途请求）。
      setTimeout(function () {
        try {
          if ((location.hash || '').replace(/^#/, '') === '/') location.reload();
          else { location.hash = '#/'; location.reload(); }
        } catch (e) {}
      }, 300);
    },
    'openLoginWin': function () {
      setTimeout(function () {
        try {
          if ((location.hash || '').indexOf('#/user/login') === 0) location.reload();
          else { location.hash = '#/user/login'; location.reload(); }
        } catch (e) {}
      }, 300);
    },
    'checkMaximized': function (p) {
      // 桌面端回发给发起窗口本身；Web 端本地回发 false
      if (p && p.type === 1) dispatch('subwinMaximized', false);
      else dispatch('winMaximized', false);
    },
    'subWinEvent': function (p) {
      if (!p) return;
      if (p.type === 'close' && String(p.index) === String(WIN_CODE)) tryCloseWindow('请直接关闭此标签页');
    },
    'copyText': function (p) { copyTextLocal(typeof p === 'string' ? p : (p && p.text) || ''); },
    'copyImage': function (p) { copyImageLocal(typeof p === 'string' ? p : (p && p.url)); },
    'pasteData': function () { requestPaste('paste-data', {}); },
    'getClipboardData': function (p) {
      requestPaste('get-clipboard-data', { key: p && p.key, itemIndex: p && p.itemIndex });
    },
    'screenShot': function () {
      toast('Web 版不支持系统截图，请使用系统截图（如 Win+Shift+S）后粘贴');
    },
    'show-context-menu': function (p) { showContextMenu(p && p.menuId, p && p.template); },
    'receiveMsg': function (p) {
      try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'granted') {
          new Notification((p && p.fromNick) || '亮宅', {
            body: p && p.type === 'text' ? (p.text || '') : '发来了一条消息'
          });
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission();
        }
      } catch (e) { /* ignore */ }
    },
    'get-shortcut': function () {
      dispatch('set-shortcut', localStorage.getItem('lz_settings_shortcut_screenshot') || 'Alt+A');
    },
    'register-shortcut': function (p) {
      if (p) localStorage.setItem('lz_settings_shortcut_screenshot', p);
    },
    'open-webpage': function (p) {
      var u = p && p.url;
      if (u) window.open(u, '_blank');
    },
    'open-file': function (p) {
      var path = p && p.path;
      if (typeof path === 'string' && /^(https?:|blob:|data:)/i.test(path)) window.open(path, '_blank');
      else toast('该文件为本地文件，Web 版请通过下载功能获取');
    },
    'download-win-data': downloadFromBuffer,
    'download-subwin-data': downloadFromBuffer,
    'save-file-as': downloadFromUrl,
    'batch-save-as': batchDownload,
    'openSubWin': openSubWin,
    'update': function () {},
    'updateNow': function () {}
  };

  // preview-file：需要服务端先拉取缓存（带进度），再打开预览标签页。
  // 先同步打开占位页（保留用户手势，避免弹窗被拦），拿到地址后再跳转。
  localHandlers['preview-file'] = function (p) {
    var w = null;
    try { w = window.open('/__pending.html', 'lz_preview_' + Date.now()); } catch (e) { w = null; }
    postIpcJson('preview-file', p || {}, function (res) {
      if (res && res.url) {
        try {
          if (w) w.location.href = res.url;
          else window.open(res.url, '_blank');
        } catch (e) { toast('预览窗口被浏览器拦截，请允许弹出窗口'); }
      } else {
        if (w) { try { w.close(); } catch (e) {} }
        toast('预览失败，请稍后重试');
      }
    });
  };

  // ---------- ipcRenderer 实现 ----------
  var api = {
    on: function (channel, fn) {
      if (typeof fn !== 'function') return function () {};
      var set = listeners.get(channel);
      if (!set) { set = new Set(); listeners.set(channel, set); }
      set.add(fn);
      ensureChannelBridge(channel);
      ensureSSE();
      return function () { set.delete(fn); };
    },
    send: function (channel, payload) {
      try {
        var handler = localHandlers[channel];
        if (handler) { handler(payload); return; }
        postIpc(channel, payload);
      } catch (e) { /* ignore */ }
    },
    sendSync: function (channel, payload) {
      if (channel === 'get-shared-data-sync') {
        var v = syncIpc(channel, { win: WIN_CODE, payload: payload });
        return (v && v.value) || null;
      }
      return syncIpc(channel, payload);
    },
    removeListener: function (channel, fn) {
      var set = listeners.get(channel);
      if (set) set.delete(fn);
    },
    removeAllListeners: function (channel) {
      listeners.delete(channel);
    }
  };

  window.ipcRenderer = api;
})();
