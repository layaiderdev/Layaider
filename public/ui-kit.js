// ============================================================================
// Layaider UI kit — shared primitives, loaded before app.js (same global scope).
// Dependency-free, no build step. Self-contained: uses private _esc/_attr rather
// than relying on app.js, so load order never matters for definitions.
//
// Pass 1 exports:
//   notify(spec)                  — toast + persisted notification log + centre
//   lkApi(path, body, opts)       — one fetch wrapper (replaces per-page POSTers)
//   lkConfirm(spec)               — one confirm primitive (tap / slide / type)
//   lkArm(btn, label, fire)       — two-tap arm guard (fat-finger)
//   lkField(spec) / lkWireFields  — one labelled-input builder (foundation)
//
// The seven legacy toast functions in app.js are thin shims over notify().
// confirm()/field() are used by new Pass-1 code; the six legacy field builders
// and openSheet/attachSlide are migrated onto these incrementally in later passes.
// ============================================================================
(function () {
  'use strict';

  function _esc(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }
  function _attr(s) { return _esc(s).replace(/"/g, '&quot;'); }

  // ---- notifications --------------------------------------------------------
  // A notification carries a level (severity: info/ok/warn/error), a source
  // (origin page), and a type (general category the per-type controls key on).
  // Each type has a display rule; global conditions (Do Not Disturb, coalescing
  // of repeats, long-message handling, throttling) then modify how it surfaces.
  var NOTIF_KEY = 'layaider_notifs';
  var PREFS_KEY = 'layaider_notif_prefs';
  var NOTIF_CAP = 500;
  var NOTIF = { log: [], seq: 1 };

  // Channels, least to most intrusive — each higher one includes the lower:
  //   off    – not recorded at all
  //   log    – history only; NOT in the visible list; no badge, no toast
  //   silent – visible list + history; no badge, no toast ("no notice")
  //   badge  – list + history + bell count; no toast
  //   toast  – list + history + bell count + a transient popup at the bell
  var CHANNELS = ['off', 'log', 'silent', 'badge', 'toast'];
  function chRank(c) { var i = CHANNELS.indexOf(c); return i < 0 ? 4 : i; }
  function chDemote(c, cap) { return chRank(c) <= chRank(cap) ? c : cap; }

  // General notification types; level maps to one when type isn't given.
  var TYPES = ['error', 'warning', 'success', 'info', 'system'];
  function typeForLevel(level) {
    if (level === 'error') return 'error';
    if (level === 'warn') return 'warning';
    if (level === 'ok') return 'success';
    return 'info';
  }
  function levelForType(t) { return t === 'error' ? 'error' : t === 'warning' ? 'warn' : t === 'success' ? 'ok' : 'info'; }
  var SOURCES = ['git', 'sync', 'files', 'system', 'servers', 'aider', 'live', 'dev', 'app'];

  var DEFAULT_PREFS = {
    types: {
      error:   { channel: 'toast', persist: true,  ttl: 8000 },
      warning: { channel: 'toast', persist: true,  ttl: 8000 },
      success: { channel: 'toast', persist: false, ttl: 4800 },
      info:    { channel: 'toast', persist: false, ttl: 4800 },
      system:  { channel: 'log',   persist: false, ttl: 4800 }
    },
    mutedSources: {},        // source -> true  (muted = demote to 'silent')
    dnd: false,              // Do Not Disturb: demote every toast to a bell count
    coalesce: true,          // collapse identical repeats into one with a count…
    coalesceWindow: 8000,    // …when they recur within this many ms
    longChars: 140,          // messages longer than this count as "long"…
    longPersist: true,       // …and persist until dismissed (overrides ttl)
    throttleWindow: 10000,   // within this rolling window…
    throttleMax: 6           // …allow this many popups; demote the rest to a bell count
  };
  function clonePrefs(p) { return JSON.parse(JSON.stringify(p)); }
  var PREFS = clonePrefs(DEFAULT_PREFS);

  function prefsLoad() {
    try {
      var raw = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        PREFS = clonePrefs(DEFAULT_PREFS); // merge so new defaults appear for existing users
        if (raw.types) TYPES.forEach(function (t) { if (raw.types[t]) PREFS.types[t] = Object.assign(PREFS.types[t], raw.types[t]); });
        ['dnd', 'coalesce', 'coalesceWindow', 'longChars', 'longPersist', 'throttleWindow', 'throttleMax'].forEach(function (k) { if (raw[k] !== undefined) PREFS[k] = raw[k]; });
        if (raw.mutedSources) PREFS.mutedSources = raw.mutedSources;
      }
    } catch (e) {}
  }
  function prefsSave() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(PREFS)); } catch (e) {} }
  function prefsReset() { PREFS = clonePrefs(DEFAULT_PREFS); prefsSave(); }

  function notifLoad() {
    try {
      var raw = JSON.parse(localStorage.getItem(NOTIF_KEY) || '{}');
      if (raw && Array.isArray(raw.log)) NOTIF.log = raw.log;
      if (raw && raw.seq) NOTIF.seq = raw.seq;
    } catch (e) { NOTIF.log = []; }
  }
  function notifSave() {
    try { localStorage.setItem(NOTIF_KEY, JSON.stringify({ log: NOTIF.log, seq: NOTIF.seq })); } catch (e) {}
  }
  function notifTrim() {
    if (NOTIF.log.length <= NOTIF_CAP) return;
    var keep = NOTIF.log.filter(function (n) { return n.pinned || !n.read; });
    if (keep.length > NOTIF_CAP) keep = keep.slice(keep.length - NOTIF_CAP);
    NOTIF.log = keep;
  }
  // Badge counts unread items that actually asked for attention (toast/badge).
  function notifUnread() { return NOTIF.log.filter(function (n) { return !n.read && (n.channel === 'toast' || n.channel === 'badge'); }).length; }
  function notifBadge() {
    var b = document.getElementById('notifCount');
    if (!b) return;
    var n = notifUnread();
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n === 0;
    var btn = document.getElementById('notifBtn');
    if (btn) btn.classList.toggle('has-unread', n > 0);
  }

  var _toastTimes = [];
  function throttleOk() {
    var now = Date.now();
    _toastTimes = _toastTimes.filter(function (t) { return now - t < PREFS.throttleWindow; });
    if (_toastTimes.length >= PREFS.throttleMax) return false;
    _toastTimes.push(now); return true;
  }
  function relTime(ts) {
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ---- toasts (anchored under the bell, newest on top, cascading down) ------
  function ttlForEntry(entry, rule, override) {
    if (entry.pinned) return null;
    if (override !== undefined && override !== null) return override;
    if (PREFS.longPersist && entry.long) return null;
    if (rule.persist) return null;
    return rule.ttl || 4800;
  }
  function toastMsg(entry) { var m = entry.msg; if (entry.count > 1) m += ' \u00d7' + entry.count; return _esc(m); }
  function armToast(el, entry, rule, override) {
    if (el._timer) { clearTimeout(el._timer); el._timer = null; }
    var t = ttlForEntry(entry, rule, override);
    if (t) el._timer = setTimeout(function () { dismissToast(entry); }, t);
  }
  function dismissToast(entry) {
    var el = entry._el;
    if (el) { if (el._timer) clearTimeout(el._timer); if (el.parentNode) el.parentNode.removeChild(el); entry._el = null; }
  }
  function showToast(entry, rule, override) {
    var wrap = document.getElementById('notifToasts');
    if (!wrap) return;
    if (entry._el && entry._el.parentNode) { // coalesced: refresh in place
      entry._el.querySelector('.ntoast-msg').innerHTML = toastMsg(entry);
      armToast(entry._el, entry, rule, override);
      return;
    }
    var el = document.createElement('div');
    el.className = 'ntoast n-' + entry.level + (entry.pinned ? ' pinned' : '');
    el.innerHTML =
      '<span class="ntoast-msg">' + toastMsg(entry) + '</span>'
      + '<button class="ntoast-pin" title="pin — keep this open">' + (entry.pinned ? '\u25C9' : '\u25CB') + '</button>'
      + '<button class="ntoast-x" aria-label="dismiss">\u2715</button>';
    entry._el = el;
    wrap.insertBefore(el, wrap.firstChild); // newest nearest the bell
    el.querySelector('.ntoast-x').addEventListener('click', function () { dismissToast(entry); });
    el.querySelector('.ntoast-pin').addEventListener('click', function () {
      entry.pinned = !entry.pinned; notifSave();
      this.textContent = entry.pinned ? '\u25C9' : '\u25CB';
      el.classList.toggle('pinned', entry.pinned);
      armToast(el, entry, rule, override); notifRender();
    });
    armToast(el, entry, rule, override);
  }

  // ---- the notify entrypoint ------------------------------------------------
  // notify({ msg, level, source, type?, channel?, ttl?, pinned? })
  function notify(spec) {
    if (typeof spec === 'string') spec = { msg: spec };
    spec = spec || {};
    var level = spec.level || 'info';
    var type = spec.type || typeForLevel(level);
    if (TYPES.indexOf(type) < 0) type = 'info';
    var source = spec.source || '';
    var rule = PREFS.types[type] || DEFAULT_PREFS.types[type] || DEFAULT_PREFS.types.info;
    var msg = String(spec.msg == null ? '' : spec.msg);

    var channel = spec.channel || rule.channel;            // per-type base…
    if (source && PREFS.mutedSources[source]) channel = chDemote(channel, 'silent'); // …minus muted source…
    if (PREFS.dnd) channel = chDemote(channel, 'badge');   // …minus Do Not Disturb (no popups, bell still counts)
    if (channel === 'off') return null;

    var isLong = msg.length > PREFS.longChars;

    if (PREFS.coalesce) { // collapse identical repeats within the window
      var now = Date.now();
      for (var i = NOTIF.log.length - 1; i >= 0 && i > NOTIF.log.length - 40; i--) {
        var e = NOTIF.log[i];
        if (e.msg === msg && e.type === type && e.source === source && (now - e.ts) < PREFS.coalesceWindow) {
          e.count = (e.count || 1) + 1; e.ts = now; e.read = false; e.long = isLong; e.channel = channel;
          notifTrim(); notifSave();
          if (channel === 'toast' && (e._el || throttleOk())) showToast(e, rule, spec.ttl);
          notifBadge(); if (panelOpen()) notifRender();
          return e.id;
        }
      }
    }

    if (channel === 'toast' && !throttleOk()) channel = 'badge'; // throttle overflow → bell count

    var entry = {
      id: NOTIF.seq++, ts: Date.now(), level: level, type: type, source: source,
      msg: msg, count: 1, read: false, pinned: !!spec.pinned, channel: channel, long: isLong
    };
    NOTIF.log.push(entry);
    notifTrim(); notifSave();
    if (channel === 'toast') showToast(entry, rule, spec.ttl);
    notifBadge();
    if (panelOpen()) notifRender();
    return entry.id;
  }

  // ---- notification centre (the visible list) -------------------------------
  function panelOpen() { var p = document.getElementById('notifPanel'); return !!p && p.hidden === false; }
  function inList(n) { return n.channel === 'toast' || n.channel === 'badge' || n.channel === 'silent'; }
  function notifRender() {
    var list = document.getElementById('notifPanelList');
    if (!list) return;
    var filter = list.getAttribute('data-filter') || 'all';
    var items = NOTIF.log.filter(function (n) {
      if (filter === 'history') return true;          // full log incl. silent + log-only
      if (!inList(n)) return false;                   // active view excludes log-only
      if (filter === 'unread') return !n.read;
      if (filter !== 'all') return n.type === filter; // a type filter
      return true;
    });
    items.sort(function (a, b) { if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1; return b.ts - a.ts; });
    if (!items.length) { list.innerHTML = '<div class="notif-empty">No notifications.</div>'; return; }
    list.innerHTML = items.map(function (n) {
      var cnt = n.count > 1 ? ' <span class="notif-cnt">\u00d7' + n.count + '</span>' : '';
      var silent = n.channel === 'silent' || n.channel === 'log' ? ' <span class="notif-ch">' + _esc(n.channel) + '</span>' : '';
      return '<div class="notif-item n-' + n.level + (n.read ? '' : ' unread') + (n.pinned ? ' pinned' : '') + '" data-nid="' + n.id + '">'
        + '<span class="notif-dot"></span>'
        + '<div class="notif-main"><div class="notif-msg">' + _esc(n.msg) + cnt + '</div>'
        + '<div class="notif-meta">' + _esc(n.type) + (n.source ? ' \u00b7 ' + _esc(n.source) : '') + ' \u00b7 ' + relTime(n.ts) + silent + '</div></div>'
        + '<button class="notif-pin" data-npin="' + n.id + '" title="pin">' + (n.pinned ? '\u25C9' : '\u25CB') + '</button>'
        + '<button class="notif-del" data-ndel="' + n.id + '" title="delete permanently">\u2715</button>'
        + '</div>';
    }).join('');
    list.querySelectorAll('[data-ndel]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); notifDelete(+b.getAttribute('data-ndel')); }); });
    list.querySelectorAll('[data-npin]').forEach(function (b) { b.addEventListener('click', function (e) { e.stopPropagation(); notifTogglePin(+b.getAttribute('data-npin')); }); });
    list.querySelectorAll('.notif-item').forEach(function (it) { it.addEventListener('click', function () { notifMarkRead(+it.getAttribute('data-nid')); }); });
  }
  function findN(id) { return NOTIF.log.filter(function (x) { return x.id === id; })[0]; }
  function notifMarkRead(id) { var n = findN(id); if (n && !n.read) { n.read = true; notifSave(); notifBadge(); notifRender(); } }
  function notifMarkAllRead() { NOTIF.log.forEach(function (n) { n.read = true; }); notifSave(); notifBadge(); notifRender(); }
  function notifTogglePin(id) { var n = findN(id); if (n) { n.pinned = !n.pinned; notifSave(); notifRender(); } }
  function notifDelete(id) { var n = findN(id); if (n) dismissToast(n); NOTIF.log = NOTIF.log.filter(function (x) { return x.id !== id; }); notifSave(); notifBadge(); notifRender(); }
  function notifClearRead() { NOTIF.log = NOTIF.log.filter(function (n) { if (n.pinned || !n.read) return true; dismissToast(n); return false; }); notifSave(); notifBadge(); notifRender(); }

  function notifTogglePanel(open) {
    var p = document.getElementById('notifPanel'), sc = document.getElementById('notifScrim');
    if (!p) return;
    var show = open === undefined ? p.hidden : open;
    p.hidden = !show; if (sc) sc.hidden = !show;
    if (show) notifRender(); else notifPrefsToggle(false);
  }

  // ---- notification preferences (the per-type / per-condition controls) -----
  function notifPrefsToggle(open) {
    var pp = document.getElementById('notifPrefs'); if (!pp) return;
    var show = open === undefined ? pp.hidden : open;
    pp.hidden = !show;
    if (show) renderPrefs();
  }
  function renderPrefs() {
    var el = document.getElementById('notifPrefsBody'); if (!el) return;
    var chOpts = function (sel) { return CHANNELS.map(function (c) { return '<option value="' + c + '"' + (c === sel ? ' selected' : '') + '>' + c + '</option>'; }).join(''); };
    var typeRows = TYPES.map(function (t) {
      var r = PREFS.types[t];
      return '<tr data-type="' + t + '"><td class="np-t n-' + levelForType(t) + '">' + t + '</td>'
        + '<td><select class="np-ch">' + chOpts(r.channel) + '</select></td>'
        + '<td class="np-c"><input type="checkbox" class="np-persist"' + (r.persist ? ' checked' : '') + '></td>'
        + '<td><input type="number" class="np-ttl" min="500" step="500" value="' + (r.ttl || 4800) + '"></td></tr>';
    }).join('');
    var srcRows = SOURCES.map(function (s) {
      return '<label class="np-src"><input type="checkbox" class="np-mute" data-src="' + s + '"' + (PREFS.mutedSources[s] ? ' checked' : '') + '> <span class="mono">' + s + '</span></label>';
    }).join('');
    el.innerHTML =
      '<div class="np-global">'
      + '<label class="np-row"><input type="checkbox" id="np-dnd"' + (PREFS.dnd ? ' checked' : '') + '> <b>Do Not Disturb</b> — suppress all popups (bell still counts, everything still logged)</label>'
      + '<label class="np-row"><input type="checkbox" id="np-coalesce"' + (PREFS.coalesce ? ' checked' : '') + '> Coalesce repeats within <input type="number" id="np-cw" min="0" step="500" value="' + PREFS.coalesceWindow + '"> ms into one with a count</label>'
      + '<label class="np-row"><input type="checkbox" id="np-longp"' + (PREFS.longPersist ? ' checked' : '') + '> Long messages (over <input type="number" id="np-lc" min="20" step="10" value="' + PREFS.longChars + '"> chars) persist until dismissed</label>'
      + '<label class="np-row">Throttle: at most <input type="number" id="np-tmax" min="1" step="1" value="' + PREFS.throttleMax + '"> popups per <input type="number" id="np-tw" min="1000" step="500" value="' + PREFS.throttleWindow + '"> ms</label>'
      + '</div>'
      + '<table class="np-table"><thead><tr><th>type</th><th>channel</th><th>persist</th><th>ms</th></tr></thead><tbody>' + typeRows + '</tbody></table>'
      + '<div class="np-srch">Mute by source</div><div class="np-srcs">' + srcRows + '</div>'
      + '<div class="np-actions"><button class="clink" id="np-reset">reset to defaults</button></div>'
      + '<div class="np-legend"><b>channels:</b> toast = popup + bell + list + log · badge = bell + list + log · silent = list + log (no notice) · log = history only · off = ignore</div>';
    wirePrefs();
  }
  function wirePrefs() {
    var body = document.getElementById('notifPrefsBody'); if (!body) return;
    function save() { prefsSave(); notifBadge(); if (panelOpen()) notifRender(); }
    body.querySelectorAll('tr[data-type]').forEach(function (tr) {
      var t = tr.getAttribute('data-type'), r = PREFS.types[t];
      tr.querySelector('.np-ch').addEventListener('change', function () { r.channel = this.value; save(); });
      tr.querySelector('.np-persist').addEventListener('change', function () { r.persist = this.checked; save(); });
      tr.querySelector('.np-ttl').addEventListener('change', function () { r.ttl = Math.max(500, +this.value || 4800); save(); });
    });
    body.querySelectorAll('.np-mute').forEach(function (c) {
      c.addEventListener('change', function () { var s = c.getAttribute('data-src'); if (c.checked) PREFS.mutedSources[s] = true; else delete PREFS.mutedSources[s]; save(); });
    });
    var bind = function (id, key, num) { var e = document.getElementById(id); if (e) e.addEventListener('change', function () { PREFS[key] = num ? (+this.value || 0) : this.checked; save(); }); };
    bind('np-dnd', 'dnd'); bind('np-coalesce', 'coalesce'); bind('np-cw', 'coalesceWindow', 1);
    bind('np-longp', 'longPersist'); bind('np-lc', 'longChars', 1); bind('np-tmax', 'throttleMax', 1); bind('np-tw', 'throttleWindow', 1);
    var rb = document.getElementById('np-reset'); if (rb) rb.addEventListener('click', function () { prefsReset(); renderPrefs(); notifBadge(); });
  }

  function notifInit() {
    prefsLoad(); notifLoad(); notifBadge();
    var on = function (id, ev, fn) { var e = document.getElementById(id); if (e) e.addEventListener(ev, fn); };
    on('notifBtn', 'click', function () { notifTogglePanel(); });
    on('notifScrim', 'click', function () { notifTogglePanel(false); });
    on('notifClose', 'click', function () { notifTogglePanel(false); });
    on('notifMarkRead', 'click', notifMarkAllRead);
    on('notifClearRead', 'click', notifClearRead);
    on('devApiClear', 'click', lkApiLogClear);
    on('notifPrefsBtn', 'click', function () { notifPrefsToggle(); });
    on('notifPrefsClose', 'click', function () { notifPrefsToggle(false); });
    on('notifFilter', 'change', function () { var l = document.getElementById('notifPanelList'); if (l) { l.setAttribute('data-filter', this.value); notifRender(); } });
    window.addEventListener('error', function (e) {
      try { notify({ msg: 'JS error: ' + (e.message || 'unknown'), level: 'error', type: 'system', source: 'app' }); } catch (_) {}
    });
    window.addEventListener('unhandledrejection', function (e) {
      try { notify({ msg: 'Promise rejection: ' + ((e.reason && e.reason.message) || e.reason || 'unknown'), level: 'error', type: 'system', source: 'app' }); } catch (_) {}
    });
  }

  // ---- one fetch wrapper ----------------------------------------------------
  // lkApi('git/commit', { message }, { source:'git', method:'POST' }) -> json|null
  function lkApi(path, body, opts) {
    opts = opts || {};
    var method = opts.method || (body === undefined ? 'GET' : 'POST');
    var init = { method: method, cache: 'no-store' };
    if (method !== 'GET') { init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(body || {}); }
    var url = path.charAt(0) === '/' ? path : '/api/' + path;
    var src = opts.source || '';
    return fetch(url, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (res.status === 423) { notify({ msg: 'locked — aider is running', level: 'warn', source: src }); return null; }
        if (!res.ok || j.ok === false) {
          if (!opts.quiet) notify({ msg: 'failed: ' + (j.error || j.reason || j.output || res.status), level: 'error', source: src });
          return opts.returnError ? j : null;
        }
        return j;
      });
    }).catch(function () { if (!opts.quiet) notify({ msg: 'server error', level: 'error', source: src }); return null; });
  }

  // ---- slide behaviour (ported) ---------------------------------------------
  function lkSlide(track, onConfirm) {
    var knob = track.querySelector('.knob'), hint = track.querySelector('.hint');
    var drag = false, sx = 0, x = 0;
    function mx() { return Math.max(1, track.clientWidth - knob.offsetWidth - 8); }
    function setX(v) { x = Math.max(0, Math.min(mx(), v)); knob.style.transform = 'translateX(' + x + 'px)'; var p = x / mx(); if (hint) hint.style.opacity = String(1 - p); track.style.setProperty('--p', p.toFixed(3)); }
    function reset() { knob.style.transition = 'transform .2s'; setX(0); }
    knob.addEventListener('pointerdown', function (e) { drag = true; try { knob.setPointerCapture(e.pointerId); } catch (_) {} sx = e.clientX - x; knob.style.transition = 'none'; e.preventDefault(); });
    knob.addEventListener('pointermove', function (e) { if (drag) setX(e.clientX - sx); });
    function end() { if (!drag) return; drag = false; knob.style.transition = 'transform .2s'; if (x >= mx() * 0.92) { setX(mx()); onConfirm(); } else reset(); }
    knob.addEventListener('pointerup', end);
    knob.addEventListener('pointercancel', end);
    // Keyboard path: the slide is a touch idiom; on desktop Enter/Space confirms.
    knob.tabIndex = 0;
    knob.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); knob.style.transition = 'transform .2s'; setX(mx()); onConfirm(); } });
    setTimeout(function () { try { knob.focus(); } catch (_) {} }, 30);
  }

  // ---- one confirm primitive ------------------------------------------------
  // lkConfirm({ level:'tap'|'slide'|'type', op, detail, danger, match, confirmLabel, onConfirm })
  function lkConfirm(spec) {
    spec = spec || {};
    var level = spec.level || 'tap';
    var ov = document.createElement('div');
    ov.className = 'lk-confirm-ov' + (spec.danger ? ' danger' : '');
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function go() { close(); if (spec.onConfirm) spec.onConfirm(); }
    function onKey(e) { if (e.key === 'Escape') close(); }

    var inner = '<div class="lk-confirm-box">';
    if (spec.danger) inner += '<div class="lk-confirm-h">\u26A0 ' + _esc(spec.heading || 'Confirm') + '</div>';
    else if (spec.heading) inner += '<div class="lk-confirm-h">' + _esc(spec.heading) + '</div>';
    if (spec.op) inner += '<div class="lk-confirm-op">' + _esc(spec.op) + '</div>';
    if (spec.detail) inner += '<div class="lk-confirm-sub">' + _esc(spec.detail) + '</div>';

    if (level === 'slide') {
      inner += '<div class="track lk-confirm-track"><div class="fill"></div><span class="hint">slide to confirm \u2192</span><div class="knob" role="button" aria-label="Slide to confirm">\u2192</div></div>';
      inner += '<button class="lk-confirm-cancel">Cancel</button>';
    } else if (level === 'type') {
      inner += '<div class="lk-confirm-typehint">type <span class="mono">' + _esc(spec.match || '') + '</span> to confirm</div>';
      inner += '<input class="hinput lk-confirm-input" autocapitalize="off" autocorrect="off" spellcheck="false">';
      inner += '<div class="lk-confirm-acts"><button class="lk-confirm-cancel">Cancel</button><button class="lk-confirm-ok" disabled>' + _esc(spec.confirmLabel || 'Confirm') + '</button></div>';
    } else { // tap
      inner += '<div class="lk-confirm-acts"><button class="lk-confirm-cancel">Cancel</button><button class="lk-confirm-ok' + (spec.danger ? ' danger' : '') + '">' + _esc(spec.confirmLabel || 'Confirm') + '</button></div>';
    }
    inner += '</div>';
    ov.innerHTML = inner;
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    ov.addEventListener('pointerdown', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.lk-confirm-cancel').addEventListener('click', close);
    var okBtn = ov.querySelector('.lk-confirm-ok');
    if (okBtn) okBtn.addEventListener('click', go);
    if (level === 'slide') lkSlide(ov.querySelector('.lk-confirm-track'), go);
    if (level === 'type') {
      var inp = ov.querySelector('.lk-confirm-input');
      inp.addEventListener('input', function () { okBtn.disabled = inp.value.trim() !== String(spec.match || '').trim(); });
      setTimeout(function () { inp.focus(); }, 30);
    }
    return close;
  }

  // ---- one input modal (replaces native prompt) ----------------------------
  // lkPrompt({ heading, detail, label, placeholder, value, confirmLabel,
  //            required, onSubmit(value) }) — async-friendly; returns close fn.
  function lkPrompt(spec) {
    spec = spec || {};
    var ov = document.createElement('div');
    ov.className = 'lk-confirm-ov';
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); else if (e.key === 'Enter') submit(); }
    function submit() { var v = inp.value; if (spec.required && !v.trim()) { inp.focus(); return; } close(); if (spec.onSubmit) spec.onSubmit(v); }
    ov.innerHTML = '<div class="lk-confirm-box">'
      + (spec.heading ? '<div class="lk-confirm-h">' + _esc(spec.heading) + '</div>' : '')
      + (spec.detail ? '<div class="lk-confirm-sub">' + _esc(spec.detail) + '</div>' : '')
      + (spec.label ? '<div class="lk-confirm-typehint">' + _esc(spec.label) + '</div>' : '')
      + '<input class="hinput lk-confirm-input" autocapitalize="off" autocorrect="off" spellcheck="false"'
      + ' placeholder="' + _attr(spec.placeholder || '') + '" value="' + _attr(spec.value || '') + '">'
      + '<div class="lk-confirm-acts"><button class="lk-confirm-cancel">Cancel</button>'
      + '<button class="lk-confirm-ok">' + _esc(spec.confirmLabel || 'OK') + '</button></div>'
      + '</div>';
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey);
    ov.addEventListener('pointerdown', function (e) { if (e.target === ov) close(); });
    var inp = ov.querySelector('.lk-confirm-input');
    ov.querySelector('.lk-confirm-cancel').addEventListener('click', close);
    ov.querySelector('.lk-confirm-ok').addEventListener('click', submit);
    setTimeout(function () { inp.focus(); inp.select(); }, 30);
    return close;
  }

  // ---- two-tap arm (ported) -------------------------------------------------
  function lkArm(btn, confirmLabel, fire) {
    if (btn._armTimer) { clearTimeout(btn._armTimer); btn._armTimer = null; btn.textContent = btn._label; btn.classList.remove('armed'); fire(); return; }
    btn._label = btn.textContent; btn.textContent = confirmLabel; btn.classList.add('armed');
    btn._armTimer = setTimeout(function () { btn._armTimer = null; btn.textContent = btn._label; btn.classList.remove('armed'); }, 3000);
  }

  // ---- one labelled-input builder (foundation) ------------------------------
  // lkField({ id, prefix, label, type, placeholder, value, required, optional,
  //           info, mask, inline, write }) -> HTML string. Pair with lkWireFields.
  function lkField(spec) {
    spec = spec || {};
    var pid = (spec.prefix ? spec.prefix + '_' : '') + (spec.id || '');
    var type = spec.mask ? 'password' : (spec.type || 'text');
    var marker = spec.required ? ' <i class="req">required</i>' : (spec.optional ? ' <i class="opt">optional</i>' : '');
    var info = spec.info ? ' <button class="i-btn" data-info="' + _attr(spec.info) + '" aria-label="info" title="what is this?">\u24D8</button>' : '';
    var unmask = spec.mask ? '<button type="button" class="xlink lk-unmask" data-unmask="' + _attr(pid) + '">show</button>' : '';
    return '<label class="conn-field' + (spec.inline ? ' conn-field-inline' : '') + '">'
      + '<span class="conn-l">' + _esc(spec.label || '') + info + marker + '</span>'
      + '<span class="lk-field-input">'
      + '<input id="' + _attr(pid) + '" type="' + type + '" class="hinput' + (spec.mask ? ' lk-masked' : '') + '"'
      + ' placeholder="' + _attr(spec.placeholder || '') + '" value="' + _attr(spec.value || '') + '"'
      + ' autocapitalize="off" autocorrect="off" spellcheck="false"' + (spec.write ? ' data-write' : '') + '>'
      + unmask + '</span></label>';
  }
  function lkWireFields(scope) {
    (scope || document).querySelectorAll('[data-unmask]').forEach(function (b) {
      if (b._wired) return; b._wired = true;
      b.addEventListener('click', function () {
        var inp = document.getElementById(b.getAttribute('data-unmask'));
        if (!inp) return;
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        b.textContent = show ? 'hide' : 'show';
      });
    });
    if (typeof window.wireInfoButtons === 'function') window.wireInfoButtons(scope);
  }

  // ---- dev API-call log (read-only diagnostics; display gated to dev card) --
  // A defensive fetch wrapper that records /api/* calls (method, path, status,
  // ms, and any ok:false reason via response.clone()). It always passes the
  // request through untouched and never consumes a body, so it cannot affect
  // real calls. Buffer is in-memory only (ephemeral; no secret persistence).
  var APILOG = [];
  var APILOG_CAP = 150;
  function _redactLog(s) {
    return String(s).replace(/\b(sk-[A-Za-z0-9_\-]{6,}|gh[a-z]_[A-Za-z0-9_\-]{6,}|[A-Za-z0-9_\-]{32,})\b/g, '***').slice(0, 200);
  }
  function _logApi(e) { APILOG.push(e); if (APILOG.length > APILOG_CAP) APILOG.shift(); renderApiLog(); }
  function renderApiLog() {
    var el = document.getElementById('devApiLog');
    if (!el || el.offsetParent === null) return; // absent or not visible (user mode)
    if (!APILOG.length) { el.innerHTML = '<div class="gmuted">no API calls yet</div>'; return; }
    el.innerHTML = APILOG.slice().reverse().map(function (e) {
      return '<div class="al-row al-' + (e.ok ? 'ok' : 'bad') + '">'
        + '<span class="al-method">' + _esc(e.method) + '</span>'
        + '<span class="al-path">' + _esc(e.path) + '</span>'
        + '<span class="al-status">' + _esc(String(e.status || 'ERR')) + '</span>'
        + '<span class="al-ms">' + e.ms + 'ms</span>'
        + (e.err ? '<span class="al-err">' + _esc(e.err) + '</span>' : '')
        + '</div>';
    }).join('');
  }
  function lkApiLogClear() { APILOG = []; renderApiLog(); }
  (function installFetchLog() {
    if (window._lkFetchWrapped || typeof window.fetch !== 'function') return;
    window._lkFetchWrapped = true;
    var orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var t0 = Date.now(), url = '', method = 'GET', isApi = false;
      try {
        url = (typeof input === 'string') ? input : (input && input.url) || '';
        method = (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET';
        isApi = url.indexOf('/api/') !== -1;
      } catch (_) {}
      var p = orig(input, init);
      if (!isApi) return p;
      var path = url.replace(/^https?:\/\/[^/]+/, '');
      return p.then(function (res) {
        try {
          var e = { ts: Date.now(), method: method, path: path, status: res.status, ms: Date.now() - t0, ok: res.ok };
          _logApi(e);
          try { res.clone().json().then(function (j) { if (j && j.ok === false) { e.ok = false; e.err = _redactLog(j.error || j.reason || j.output || ''); renderApiLog(); } }).catch(function () {}); } catch (_) {}
        } catch (_) {}
        return res;
      }, function (err) {
        try { _logApi({ ts: Date.now(), method: method, path: path, status: 0, ms: Date.now() - t0, ok: false, err: 'network error' }); } catch (_) {}
        throw err;
      });
    };
  })();

  // ---- expose ---------------------------------------------------------------
  window.notify = notify;
  window.notifTogglePanel = notifTogglePanel;
  window.lkApi = lkApi;
  window.lkConfirm = lkConfirm;
  window.lkPrompt = lkPrompt;
  window.lkArm = lkArm;
  window.lkSlide = lkSlide;
  window.lkField = lkField;
  window.lkWireFields = lkWireFields;
  window.lkApiLog = function () { return APILOG.slice(); };
  window.lkApiLogClear = lkApiLogClear;
  window.lkRenderApiLog = renderApiLog;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', notifInit);
  else notifInit();
})();
