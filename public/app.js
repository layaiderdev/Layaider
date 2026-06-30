// DEV-AWARE: shows the DEV badge and the Developer diagnostics card only when the
// status poll reports mode === 'dev'. Hidden and inert in user mode.
const PAGES = ['status', 'git', 'sync', 'aider', 'live', 'chathistory', 'files', 'servers', 'system'];
const TITLES = { status:'Status', git:'Git', sync:'Sync', aider:'aider', live:'Live', chathistory:'Chat history', files:'Files', servers:'Servers', system:'System' };

// Servers-tab state — declared up here so route()/serversStop() (called during
// the initial top-level route()) never dereference it before it's initialized.
var SRV = { timer: null, data: null, addOpen: false };

const drawer = document.getElementById('drawer');
const scrim = document.getElementById('scrim');
const menuBtn = document.getElementById('menuBtn');

function openDrawer(open){
  drawer.classList.toggle('open', open);
  scrim.hidden = !open;
  drawer.setAttribute('aria-hidden', String(!open));
  // Keep closed-drawer links out of the tab order (they're off-screen).
  if ('inert' in drawer) drawer.inert = !open; else drawer.toggleAttribute('inert', !open);
  menuBtn.setAttribute('aria-expanded', String(open));
}
menuBtn.addEventListener('click', () => openDrawer(!drawer.classList.contains('open')));
scrim.addEventListener('click', () => openDrawer(false));
openDrawer(false);

// Unified Escape dispatcher: close the topmost open overlay. Priority order
// matches visual stacking so Esc peels one layer at a time and nothing gets
// "stuck" with no keyboard exit. lkConfirm/lkPrompt own their own Esc, so we
// defer to them when one is present.
function visible(id) { var e = document.getElementById(id); return e && !e.hidden ? e : null; }
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  if (document.querySelector('.lk-confirm-ov')) return;            // confirm/prompt handle their own
  if (document.body.classList.contains('live-zen')) { document.body.classList.remove('live-zen'); if (typeof liveZenViewport === 'function') liveZenViewport(); return; }
  if (visible('connModal')) { closeConnModal(); return; }
  if (visible('docsOverlay')) { closeDocs(); return; }
  if (visible('gitBackdrop')) { closeSheet(); return; }
  var np = document.getElementById('notifPanel');
  if (np && !np.hidden) { notifTogglePanel(false); return; }
  var layer = document.querySelector('.layer:not([hidden])');
  if (layer) { var back = layer.querySelector('.backbtn'); if (back) back.click(); return; }
  if (drawer.classList.contains('open')) openDrawer(false);
});

function route(){
  let page = (location.hash || '#status').slice(1);
  if (!PAGES.includes(page)) page = 'status';
  document.querySelectorAll('.page').forEach((s) => { s.hidden = s.dataset.page !== page; });
  document.querySelectorAll('.nav-item').forEach((a) => a.classList.toggle('current', a.getAttribute('href') === '#' + page));
  document.getElementById('pageTitle').textContent = TITLES[page];
  if (page === 'git') gitEnter();
  if (page === 'sync') syncEnter();
  if (page === 'files') filesEnter();
  if (page === 'servers') serversEnter(); else serversStop();
  if (page === 'system') systemEnter();
  if (page === 'aider') aiderEnter();
  if (page === 'live') liveEnter(); else { if (typeof liveStreamStop === 'function') liveStreamStop(); document.body.classList.remove('live-zen'); }
  if (page === 'chathistory') chatHistoryEnter();
  openDrawer(false);
}
window.addEventListener('hashchange', route);

(function devToggleWire() {
  var dt = document.getElementById('devToggle');
  if (!dt) return;
  dt.addEventListener('click', function () {
    var st = window._devState || {};
    if (!st.available) return;
    if (!st.suppressed) {
      lkConfirm({
        heading: 'Suppress developer mode?',
        detail: 'Dev surfaces (the diagnostics card and any dev panels) will hide, simulating user mode. Availability is unchanged — you can switch them back on from here any time.',
        confirmLabel: 'Suppress',
        onConfirm: function () {
          lkApi('system/dev-suppress', {}, { source: 'dev' }).then(function (r) {
            if (r) { notify({ msg: 'developer mode suppressed', level: 'ok', source: 'dev' }); poll(); }
          });
        },
      });
    } else {
      lkApi('system/dev-enable', {}, { source: 'dev' }).then(function (r) {
        if (r) { notify({ msg: 'developer mode enabled', level: 'ok', source: 'dev' }); poll(); }
      });
    }
  });
})();

function fmtDur(s){
  s = Math.floor(s);
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
function fmtBytes(b){
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1){ b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

async function poll(){
  let d;
  try { d = await (await fetch('/api/status', { cache:'no-store' })).json(); }
  catch (e) {
    document.getElementById('updated').textContent = 'server unreachable';
    document.body.classList.add('offline');
    // notify() coalesces the repeats from the 2s poll into one entry with a count.
    notify({ msg: 'server unreachable — retrying', level: 'warn', source: 'app' });
    return;
  }
  document.body.classList.remove('offline');

  const aiderOn = !!(d.aider && d.aider.active);
  window._lastAider = d.aider || { active: false, pids: [] };
  document.getElementById('pillAider').className = 'pill' + (aiderOn ? ' active' : '');
  document.body.classList.toggle('aider-active', aiderOn);
  syncLive(d.aider);

  var devB = document.getElementById('devBadge');
  if (devB) devB.hidden = (d.mode !== 'dev');
  // Persistent dev affordance: shown whenever dev is *available*, even while
  // suppressed, so it can always be switched back on from the UI. Availability
  // (the DEV sentinel) is file-only; this control only flips suppression.
  window._devState = { available: !!d.devAvailable, suppressed: !!d.devSuppressed };
  var devT = document.getElementById('devToggle');
  if (devT) {
    devT.hidden = !d.devAvailable;
    var on = d.devAvailable && !d.devSuppressed;
    devT.className = 'devtoggle ' + (on ? 'on' : 'off');
    devT.textContent = on ? 'dev: on' : 'dev: off';
    devT.title = on
      ? 'Developer mode is on — tap to suppress (hide dev surfaces)'
      : 'Developer mode available but suppressed — tap to enable';
  }
  var devCard = document.getElementById('devCard');
  if (devCard) {
    devCard.hidden = (d.mode !== 'dev');
    if (d.mode === 'dev' && d.dev) {
      var dv = d.dev;
      document.getElementById('devKv').innerHTML =
        kvRow('mode', d.mode) + kvRow('install', dv.install || '—') + kvRow('state dir', dv.state_dir || '—')
        + kvRow('workspace', dv.workspace || '—') + kvRow('active repo', dv.active_repo || '—')
        + kvRow('engine', dv.engine || '—');
    }
    if (d.mode === 'dev' && window.lkRenderApiLog) window.lkRenderApiLog();
  }

  const s = d.system;
  document.getElementById('sysUptime').textContent = fmtDur(s.uptime);
  document.getElementById('sysLoad').textContent = `${s.load[0]} (${s.cpus} cpu)`;
  document.getElementById('sysMem').textContent = `${fmtBytes(s.memUsed)} / ${fmtBytes(s.memTotal)}`;
  document.getElementById('sysDisk').textContent = d.disk ? `${fmtBytes(d.disk.used)} / ${fmtBytes(d.disk.total)} (${d.disk.capacity})` : '—';

  const g = d.git || {};
  if (g.repo){
    document.getElementById('gitBranch').textContent = g.branch;
    document.getElementById('gitAB').textContent = (g.ahead == null) ? 'no upstream' : `\u2191${g.ahead} \u2193${g.behind}`;
    document.getElementById('gitChanges').textContent = `${g.staged} staged \u00b7 ${g.modified} mod \u00b7 ${g.untracked} new`;
    document.getElementById('gitLast').textContent = (g.last && g.last.hash) ? `${g.last.hash} ${g.last.subject}` : '—';
  } else {
    document.getElementById('gitBranch').textContent = 'no repo';
  }

  // Handle dynamic listing under Processes card
  const processList = document.getElementById('processList');
  if (processList) {
    const aiderPids = (d.aider && d.aider.pids) || [];
    processList.innerHTML = `<dt>aider</dt><dd id="procAider">${aiderOn ? ('running' + (aiderPids.length ? ` (pid ${aiderPids.join(', ')})` : '')) : 'idle'}</dd>`;
    
    if (d.servers && d.servers.length) {
      d.servers.forEach(srv => {
        const dt = document.createElement('dt');
        dt.textContent = srv.name.toLowerCase();
        const dd = document.createElement('dd');
        dd.className = 'mono';
        if (srv.up) {
          dd.innerHTML = `<span style="color: var(--ok)">up :${srv.port}</span>`;
        } else {
          dd.innerHTML = `<span style="color: var(--bad)">down</span>`;
        }
        processList.appendChild(dt);
        processList.appendChild(dd);
      });
    }
  }

  // Configurable header pills: one per server that has a colour allocated.
  // hue = which server; bright dot = up, dull dot = down. Label optional.
  const pillWrap = document.getElementById('serverPills');
  if (pillWrap) {
    pillWrap.innerHTML = '';
    (d.serverPills || []).forEach(srv => {
      const pill = document.createElement('span');
      pill.className = 'pill spill' + (srv.up ? ' up' : '');
      pill.dataset.color = srv.color;
      pill.title = srv.name + ' :' + srv.port + (srv.up ? ' · up' : ' · down');
      const dot = document.createElement('span');
      dot.className = 'dot';
      pill.appendChild(dot);
      if (srv.pillLabel) {
        const lab = document.createElement('span');
        lab.className = 'plabel';
        lab.textContent = srv.pillLabel;
        pill.appendChild(lab);
      }
      pillWrap.appendChild(pill);
    });
  }

  const banner = document.getElementById('stubBanner');
  const hasStubs = !!(d.stubs && d.stubs.length);
  if (hasStubs){
    banner.className = 'stub-banner alert';
    banner.innerHTML = stubBannerInner(d.stubs);
  } else {
    banner.className = 'stub-banner clean';
    banner.textContent = '\u2713 no stubs detected';
  }

  const gs = document.getElementById('gitStub');
  if (gs) {
    if (hasStubs) {
      gs.innerHTML = '<div class="stub-banner alert">' + stubBannerInner(d.stubs)
        + '<button class="clink danger" id="stubToHistory" style="margin-top:8px">restore in history \u2192</button></div>';
      var sb = document.getElementById('stubToHistory');
      if (sb) sb.onclick = function () { var h = document.querySelector('.gtab[data-gtab="history"]'); if (h) h.click(); };
    } else {
      gs.innerHTML = '';
    }
  }

  document.getElementById('updated').textContent = new Date(d.time).toLocaleTimeString();
}

// Live-stream state must exist before the bootstrap route() below (route() may call
// liveStreamStop() on a non-live cold load).
var LIVE = { es: null, stick: true, buffer: '', offset: 0, view: 'rendered', committedOffset: 0, committedHtml: '', committedBlocks: [] };

// Command-builder state. Pinned commands float to the front; persisted client-side.
var CMD = { pins: [] };
try { CMD.pins = JSON.parse(localStorage.getItem('db_cmd_pins') || '[]') || []; } catch (e) { CMD.pins = []; }
function cmdSavePins() { try { localStorage.setItem('db_cmd_pins', JSON.stringify(CMD.pins)); } catch (e) { } }

// Live reading/typing chrome: transcript font size (persisted) + which input keys insert into.
var LIVEUI = { font: 14, lastInput: 'liveInput', kbdExpanded: false };
try { var _f = parseInt(localStorage.getItem('db_live_font') || '14', 10); if (_f >= 10 && _f <= 24) LIVEUI.font = _f; } catch (e) { }
function liveSaveFont() { try { localStorage.setItem('db_live_font', String(LIVEUI.font)); } catch (e) { } }

// A full page load boots on the base page. Deep routes (#chathistory, #git, …)
// are only entered via in-app navigation, which sets up their data correctly;
// reaching them via a cold reload left the dashboard without context. This does
// not touch in-page refresh (the per-page reload buttons), which works fine.
if (location.hash && location.hash !== '#status') {
  history.replaceState(null, '', location.pathname + location.search);
}
route();
poll();
setInterval(poll, 2000);
if (document.addEventListener) document.addEventListener('click', infoPopupClick);
// Wire the static ⓘ buttons that use the INFO_TEXT registry. Scoped per-section
// so we don't hijack the element-id-based data-info popovers (e.g. aider's).
['status', 'git'].forEach(function (p) { var s = document.querySelector('section[data-page="' + p + '"]'); if (s) wireInfoButtons(s); });

// ---- Git tool ----------------------------------------------------------

function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;'); }

// One renderer for the stub-warning banner, shared by the Status card and the
// Git changes panel (they previously hand-built near-identical, divergent markup).
function stubBannerInner(stubs) {
  return '⚠ ' + stubs.length + ' possible stub' + (stubs.length > 1 ? 's' : '') + ' detected'
    + '<span class="files">' + stubs.map(function (f) { return esc(f.file) + ' (' + f.lines + ' line' + (f.lines === 1 ? '' : 's') + ')'; }).join('<br>') + '</span>';
}

function gitToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'git' }); }

// Delegates to the shared lkApi (423-lock + error notify centralised). Returns
// the parsed json on success, null on lock/error — same contract as before.
function gitPost(action, body) { return lkApi('git/' + action, body, { source: 'git' }); }

function attachSlide(track, onConfirm) {
  var knob = track.querySelector('.knob'), hint = track.querySelector('.hint');
  var drag = false, sx = 0, x = 0;
  function mx() { return Math.max(1, track.clientWidth - knob.offsetWidth - 8); }
  function setX(v) { x = Math.max(0, Math.min(mx(), v)); knob.style.transform = 'translateX(' + x + 'px)'; var p = x / mx(); hint.style.opacity = String(1 - p); track.style.setProperty('--p', p.toFixed(3)); }
  function reset() { knob.style.transition = 'transform .2s'; setX(0); }
  knob.addEventListener('pointerdown', function (e) { drag = true; try { knob.setPointerCapture(e.pointerId); } catch (_) {} sx = e.clientX - x; knob.style.transition = 'none'; e.preventDefault(); });
  knob.addEventListener('pointermove', function (e) { if (drag) setX(e.clientX - sx); });
  function end() { if (!drag) return; drag = false; knob.style.transition = 'transform .2s'; if (x >= mx() * 0.92) { setX(mx()); onConfirm(); setTimeout(reset, 500); } else reset(); }
  knob.addEventListener('pointerup', end);
  knob.addEventListener('pointercancel', end);
  // Keyboard path so the slide isn't pointer-only (desktop a11y).
  knob.tabIndex = 0;
  knob.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); knob.style.transition = 'transform .2s'; setX(mx()); onConfirm(); setTimeout(reset, 500); } });
}

var sheetConfirm = null;
function openSheet(op, sub, onConfirm) {
  document.getElementById('sheetOp').textContent = op;
  document.getElementById('sheetSub').textContent = sub;
  sheetConfirm = onConfirm;
  document.getElementById('gitBackdrop').hidden = false;
  var k = document.querySelector('#sheetTrack .knob');
  if (k) setTimeout(function () { try { k.focus(); } catch (_) {} }, 30);
}
function closeSheet() {
  document.getElementById('gitBackdrop').hidden = true;
  sheetConfirm = null;
}

function renderDiff(text) {
  return text.split('\n').map(function (l) {
    var cls = 'ctx';
    if (l.startsWith('+') && !l.startsWith('+++')) cls = 'add';
    else if (l.startsWith('-') && !l.startsWith('---')) cls = 'del';
    else if (l.startsWith('@@') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('+++') || l.startsWith('---')) cls = 'meta';
    return '<div class="dl ' + cls + '">' + (esc(l) || ' ') + '</div>';
  }).join('');
}

function wireRow(unit) {
  var kind = unit.dataset.kind, file = decodeURIComponent(unit.dataset.file);
  var stageBtn = unit.querySelector('.stage');
  var fmain = unit.querySelector('.fmain');
  var trash = unit.querySelector('.trash');
  var diffbox = unit.querySelector('.diff');
  var slot = unit.querySelector('.slotline');

  if (stageBtn) stageBtn.addEventListener('click', async function () {
    var r = await gitPost(kind === 'staged' ? 'unstage' : 'stage', { file: file });
    if (r) gitLoadChanges();
  });

  // Untracked files get a 3-way decision (leave / commit / ignore) instead of a
  // bare stage checkbox — this is where accidental commits originate. Selections
  // are local until Commit applies them; "ignore" then writes the .gitignore line.
  var seg = unit.querySelector('.seg3');
  if (seg) {
    seg.querySelectorAll('.seg3btn').forEach(function (b) {
      b.addEventListener('click', function () {
        GITSEL[file] = b.dataset.d;
        seg.querySelectorAll('.seg3btn').forEach(function (x) { x.classList.toggle('on', x === b); });
        updateCommitSummary();
      });
    });
  }

  if (fmain) fmain.addEventListener('click', async function () {
    fmain.classList.toggle('open');
    if (diffbox.hidden) {
      diffbox.hidden = false;
      if (!diffbox.dataset.loaded) {
        diffbox.textContent = 'loading diff…';
        var res = await fetch('/api/git/diff?file=' + encodeURIComponent(file) + '&staged=' + (kind === 'staged' ? 1 : 0)).then(function (r) { return r.json(); }).catch(function () { return null; });
        diffbox.innerHTML = (res && res.diff) ? renderDiff(res.diff) : '<div class="gmuted">no diff</div>';
        diffbox.dataset.loaded = '1';
      }
    } else { diffbox.hidden = true; }
  });

  if (trash) {
    trash.addEventListener('click', function () {
      if (!slot.hidden) { slot.hidden = true; slot.innerHTML = ''; return; }
      slot.hidden = false;
      slot.innerHTML = '<div class="track"><div class="fill"></div><span class="hint">slide to discard \u2192</span><div class="knob" role="button" aria-label="Slide to discard">\u2192</div></div>';
      attachSlide(slot.querySelector('.track'), async function () {
        var r = await gitPost('discard', { file: file });
        if (r) { gitToast('discarded ' + file, true); gitLoadChanges(); }
      });
    });
  }
}

var GITSEL = {};      // untracked file -> 'leave' | 'commit' | 'ignore' (local until Commit)

async function gitLoadChanges() {
  var el = document.getElementById('gitFiles');
  var d = await fetch('/api/git/changes').then(function (r) { return r.json(); }).catch(function () { return null; });
  window._gitChanges = d;
  if (!d || !d.repo) {
    el.innerHTML = '<div class="gmuted">No repo selected. Choose one from the bar at the top — or type a path there and hit <b>new</b> to create one.</div>';
    var cb0 = document.getElementById('commitBtn'); cb0.disabled = true; cb0.textContent = 'Commit';
    var sum0 = document.getElementById('commitSummary'); if (sum0) sum0.hidden = true;
    return;
  }
  // prune decisions for files no longer untracked
  var untrackedSet = {};
  (d.untracked || []).forEach(function (f) { untrackedSet[f] = true; });
  Object.keys(GITSEL).forEach(function (f) { if (!untrackedSet[f]) delete GITSEL[f]; });

  function group(title, arr, kind) {
    if (!arr.length) return '';
    var batch = '';
    if (kind === 'untracked') batch = '<span class="fgroup-batch">all <button class="gbatch" data-ball="leave">leave</button><button class="gbatch g-commit" data-ball="commit">commit</button><button class="gbatch g-ignore" data-ball="ignore">ignore</button></span>';
    else if (kind === 'modified') batch = '<span class="fgroup-batch"><button class="gbatch" data-ballstage="stage">stage all</button></span>';
    else if (kind === 'staged') batch = '<span class="fgroup-batch"><button class="gbatch" data-ballstage="unstage">unstage all</button></span>';
    var hint = kind === 'untracked' ? ' <span class="fgroup-hint">— decide each: leave · commit · ignore</span>' : '';
    var h = '<div class="fgroup-h">' + title + hint + batch + '</div>';
    arr.forEach(function (item) {
      var file = item.file || item;
      var stat = (item.add != null) ? '<span class="stat"><span class="add">+' + item.add + '</span> <span class="del">\u2212' + item.del + '</span></span>' : '';
      if (kind === 'untracked') {
        var sel = GITSEL[file] || 'leave';
        var seg = '<div class="seg3" role="group" aria-label="decision">'
          + '<button class="seg3btn' + (sel === 'leave' ? ' on' : '') + '" data-d="leave">leave</button>'
          + '<button class="seg3btn seg3-commit' + (sel === 'commit' ? ' on' : '') + '" data-d="commit">commit</button>'
          + '<button class="seg3btn seg3-ignore' + (sel === 'ignore' ? ' on' : '') + '" data-d="ignore">ignore</button>'
          + '</div>';
        h += '<div class="funit untracked3" data-kind="untracked" data-file="' + encodeURIComponent(file) + '">'
          + '<div class="frow">' + seg
          + '<button class="fmain"><span class="fname">' + esc(file) + '</span>' + stat + '<span class="chev">\u25be</span></button>'
          + '</div><div class="diff" hidden></div>'
          + '</div>';
        return;
      }
      var staged = kind === 'staged';
      h += '<div class="funit" data-kind="' + kind + '" data-file="' + encodeURIComponent(file) + '">'
        + '<div class="frow">'
        + '<button class="stage" data-write aria-checked="' + staged + '" aria-label="' + (staged ? 'Unstage' : 'Stage') + '">' + (staged ? '\u2713' : '') + '</button>'
        + '<button class="fmain"><span class="fname">' + esc(file) + '</span>' + stat + '<span class="chev">\u25be</span></button>'
        + '<button class="trash" data-write aria-label="Discard changes">\u2715</button>'
        + '</div>'
        + '<div class="diff" hidden></div><div class="slotline" hidden></div>'
        + '</div>';
    });
    return h;
  }
  var html = group('Staged', d.staged, 'staged') + group('Changed', d.modified, 'modified') + group('Untracked', d.untracked.map(function (f) { return { file: f }; }), 'untracked');
  el.innerHTML = html || '<div class="gmuted">clean — nothing to commit</div>';
  el.querySelectorAll('.funit').forEach(wireRow);
  // Batch decisions for the untracked group (client-side until Commit applies them).
  el.querySelectorAll('[data-ball]').forEach(function (b) {
    b.addEventListener('click', function () {
      var dec = b.dataset.ball;
      (d.untracked || []).forEach(function (f) { GITSEL[f] = dec; });
      el.querySelectorAll('.funit.untracked3').forEach(function (u) {
        u.querySelectorAll('.seg3btn').forEach(function (x) { x.classList.toggle('on', x.dataset.d === dec); });
      });
      updateCommitSummary();
    });
  });
  // Bulk stage / unstage for the tracked groups.
  el.querySelectorAll('[data-ballstage]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var mode = b.dataset.ballstage;
      var files = (mode === 'unstage' ? (d.staged || []) : (d.modified || [])).map(function (x) { return x.file || x; });
      if (!files.length) return;
      b.disabled = true;
      for (var i = 0; i < files.length; i++) { await gitPost(mode === 'unstage' ? 'unstage' : 'stage', { file: files[i] }); }
      gitLoadChanges();
    });
  });
  updateCommitSummary();
}

// committing N · ignoring N · leaving N — reflects staged + the local untracked decisions
function updateCommitSummary() {
  var d = window._gitChanges;
  var cb = document.getElementById('commitBtn');
  var sum = document.getElementById('commitSummary');
  if (!d || !d.repo) { if (cb) { cb.disabled = true; cb.textContent = 'Commit'; } if (sum) sum.hidden = true; return; }
  var nCommit = 0, nIgnore = 0, nLeave = 0;
  (d.untracked || []).forEach(function (f) {
    var s = GITSEL[f] || 'leave';
    if (s === 'commit') nCommit++; else if (s === 'ignore') nIgnore++; else nLeave++;
  });
  var willCommit = d.staged.length + nCommit;
  if (sum) {
    if (willCommit || nIgnore || nLeave) {
      sum.hidden = false;
      sum.innerHTML = 'committing <b>' + willCommit + '</b> <span class="cs-sub">(' + d.staged.length + ' staged + ' + nCommit + ' new)</span>'
        + ' · ignoring <b>' + nIgnore + '</b> · leaving <b>' + nLeave + '</b> new';
    } else { sum.hidden = true; }
  }
  if (cb) {
    if (willCommit > 0) { cb.disabled = false; cb.textContent = 'Commit ' + willCommit; }
    else if (nIgnore > 0) { cb.disabled = false; cb.textContent = 'Apply ignore (' + nIgnore + ')'; }
    else { cb.disabled = true; cb.textContent = 'Commit'; }
  }
}


function wireCommit(row) {
  row.addEventListener('click', function () { openCommit(row.dataset.hash); });
}

// ---- drill-in: commit detail ----
function statusBadge(s) {
  var k = s[0];
  var cls = k === 'A' ? 'ok' : k === 'D' ? 'bad' : k === 'R' ? 'warn' : 'mod';
  return '<span class="sbadge ' + cls + '">' + esc(s) + '</span>';
}

function renderCommitDetail(d) {
  var head = '<div class="cdhead"><div class="cdsubj">' + esc(d.subject) + '</div>'
    + '<div class="cdmeta">' + esc(d.short) + ' · ' + esc(d.author) + ' · ' + esc(d.date) + ' (' + esc(d.rel) + ')</div>'
    + (d.tags && d.tags.length ? '<div class="crowmeta">' + d.tags.map(function (t) { return '<span class="ctag">' + esc(t) + '</span>'; }).join(' ') + '</div>' : '')
    + '</div>';
  var summary = '<div class="cdsum"><span class="sumfiles">' + d.stat.files + ' file' + (d.stat.files === 1 ? '' : 's') + ' changed</span>'
    + '<span class="sumadd">+' + d.stat.additions + '</span><span class="sumdel">−' + d.stat.deletions + '</span></div>';
  var bodyhtml = d.body ? '<div class="cdbody">' + esc(d.body).replace(/\n/g, '<br>') + '</div>' : '';
  var files = '<div class="dfiles">' + d.files.map(function (f) {
    var counts = f.binary ? '<span class="fbin">binary</span>'
      : '<span class="sumadd">+' + (f.additions || 0) + '</span><span class="sumdel">−' + (f.deletions || 0) + '</span>';
    var name = f.old ? (esc(f.old) + ' → ' + esc(f.file)) : esc(f.file);
    return '<button class="dfile" data-file="' + encodeURIComponent(f.file) + '">'
      + statusBadge(f.status) + '<span class="dfname">' + name + '</span><span class="dfcounts">' + counts + '</span></button>';
  }).join('') + '</div>';
  var actions = '<div class="cdactions">'
    + '<button class="clink" data-tag data-write>tag this commit</button>'
    + '<button class="clink danger" data-reset data-write>reset to here…</button></div>';
  return head + summary + bodyhtml + files + actions;
}

async function openCommit(hash) {
  var body = document.getElementById('commitBody');
  document.getElementById('commitTitle').textContent = hash;
  body.innerHTML = '<div class="gmuted">loading…</div>';
  document.getElementById('commitLayer').hidden = false;
  var d = await fetch('/api/git/commit?hash=' + encodeURIComponent(hash)).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!d || d.error) { body.innerHTML = '<div class="gmuted">could not load commit</div>'; return; }
  body.innerHTML = renderCommitDetail(d);
  body.querySelectorAll('.dfile').forEach(function (b) {
    b.addEventListener('click', function () { openFile(hash, decodeURIComponent(b.dataset.file)); });
  });
  body.querySelector('[data-reset]').addEventListener('click', function () {
    openSheet('git reset --hard ' + hash,
      'Resets your files and branch to ' + hash + ', dropping any commits after it. A stash checkpoint is taken first; dropped commits stay in the reflog.',
      async function () { var r = await gitPost('reset-hard', { hash: hash }); if (r) { gitToast('reset to ' + hash, true); closeSheet(); document.getElementById('commitLayer').hidden = true; gitLoadChanges(); gitLoadLog(); } });
  });
  body.querySelector('[data-tag]').addEventListener('click', function () {
    lkPrompt({
      heading: 'Tag this commit',
      detail: 'Creating a tag at ' + hash + '.',
      label: 'Tag name',
      placeholder: 'e.g. v1.0.0',
      confirmLabel: 'Create tag',
      required: true,
      onSubmit: async function (name) {
        name = (name || '').trim(); if (!name) return;
        var r = await gitPost('tag', { hash: hash, name: name });
        if (r) gitToast('tagged ' + hash, true);
      },
    });
  });
}

// ---- drill-in: file view (Diff + Content modes) ----
var FV = null;

function metaSecHTML(file, meta) {
  var rows = [];
  function row(k, v) { if (v === null || v === undefined || v === '') return; rows.push('<div class="mrow"><span class="mk">' + k + '</span><span class="mv">' + esc(String(v)) + '</span></div>'); }
  row('path', file);
  row('mode', meta.mode);
  row('size', meta.size != null ? meta.size + ' bytes' : null);
  row('lines', meta.lines);
  if (meta.binary) row('binary', 'yes');
  return '<div class="metasec"><button class="metahead"><span class="vgchev">▸</span>file details</button><div class="metabody">' + rows.join('') + '</div></div>';
}

function fvParseAdded(diff) {
  var added = {}, nl = 0, inHunk = false;
  (diff || '').split('\n').forEach(function (l) {
    if (l.slice(0, 2) === '@@') { var m = /\+(\d+)/.exec(l); nl = m ? parseInt(m[1], 10) - 1 : nl; inHunk = true; return; }
    if (!inHunk) return;
    var c = l[0];
    if (c === '+') { nl++; added[nl] = true; }
    else if (c === '-' || c === '\\') { /* old side / no-newline marker */ }
    else { nl++; }
  });
  return added;
}

function fvComputeFolds(text) {
  var lines = text.split('\n'), depth = 0, folds = [], openLine = null;
  var inStr = false, strCh = '', inBlock = false;
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i], lineNo = i + 1, inLine = false;
    for (var j = 0; j < ln.length; j++) {
      var ch = ln[j], nx = ln[j + 1];
      if (inLine) break;
      if (inBlock) { if (ch === '*' && nx === '/') { inBlock = false; j++; } continue; }
      if (inStr) { if (ch === '\\') { j++; continue; } if (ch === strCh) inStr = false; continue; }
      if (ch === '/' && nx === '/') { inLine = true; break; }
      if (ch === '/' && nx === '*') { inBlock = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; continue; }
      if (ch === '{') { if (depth === 0) openLine = lineNo; depth++; }
      else if (ch === '}') { depth--; if (depth < 0) depth = 0; if (depth === 0 && openLine !== null) { if (lineNo > openLine) folds.push({ open: openLine, close: lineNo }); openLine = null; } }
    }
  }
  return folds;
}

function fvOutline(text) {
  var lines = text.split('\n'), out = [];
  var re = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/;
  for (var i = 0; i < lines.length; i++) { var m = re.exec(lines[i]); if (m) out.push({ line: i + 1, kind: m[1], name: m[2] }); }
  return out;
}

function fvHighlight(raw, q) {
  if (!q) return esc(raw) || ' ';
  var out = '', low = raw.toLowerCase(), ql = q.toLowerCase(), i = 0;
  while (true) {
    var idx = low.indexOf(ql, i);
    if (idx < 0) { out += esc(raw.slice(i)); break; }
    out += esc(raw.slice(i, idx)) + '<mark>' + esc(raw.slice(idx, idx + ql.length)) + '</mark>';
    i = idx + ql.length;
  }
  return out || ' ';
}

function isImage(f) { return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f || ''); }

function fvRenderContent() {
  if (FV.content == null) return '<div class="gmuted">loading…</div>';
  if (FV.binary) {
    if (FV.work && isImage(FV.file)) return '<div class="imgwrap"><img class="imgview" src="/api/files/raw?path=' + encodeURIComponent(FV.file) + '" alt=""></div>';
    return '<div class="gmuted">binary file — no text to show</div>';
  }
  var lines = FV.content.split('\n');
  var hidden = {}, fbo = {};
  FV.folds.forEach(function (f) { fbo[f.open] = f; if (FV.collapsed[f.open]) for (var n = f.open + 1; n <= f.close; n++) hidden[n] = true; });
  var html = '<div class="code">';
  for (var i = 0; i < lines.length; i++) {
    var no = i + 1;
    if (hidden[no]) continue;
    var fold = fbo[no];
    var toggle = fold ? '<span class="foldt' + (FV.collapsed[no] ? ' collapsed' : '') + '" data-fold="' + no + '">▾</span>' : '<span class="foldt empty"></span>';
    var tail = (fold && FV.collapsed[no]) ? '<span class="foldmore">⋯ }</span>' : '';
    var cls = 'cline' + (FV.added[no] ? ' added' : '') + (no === FV.curLine ? ' current' : '');
    html += '<div class="' + cls + '" data-line="' + no + '"><span class="lno">' + no + '</span>' + toggle + '<span class="ltext">' + fvHighlight(lines[i], FV.query) + tail + '</span></div>';
  }
  return html + '</div>';
}

function fvRenderMain() {
  var main = document.getElementById('fvMain');
  if (FV.mode === 'diff') {
    main.innerHTML = FV.diff ? '<div class="diff">' + renderDiff(FV.diff) + '</div>' : '<div class="gmuted">this commit did not change this file</div>';
  } else {
    main.innerHTML = fvRenderContent();
  }
}

function fvUpdateCount() {
  var el = document.getElementById('fvCount');
  if (el) el.textContent = FV.query ? (FV.matches.length ? (FV.mi + 1) + '/' + FV.matches.length : '0') : '';
}

function fvJump(line) {
  FV.folds.forEach(function (f) { if (line > f.open && line <= f.close) FV.collapsed[f.open] = false; });
  FV.curLine = line;
  fvRenderMain();
  var row = document.querySelector('#fvMain [data-line="' + line + '"]');
  if (row) row.scrollIntoView({ block: 'center' });
}

function fvSearch(q) {
  FV.query = q;
  FV.matches = [];
  if (q && FV.content != null && !FV.binary) {
    var lines = FV.content.split('\n'), ql = q.toLowerCase();
    for (var i = 0; i < lines.length; i++) if (lines[i].toLowerCase().indexOf(ql) >= 0) FV.matches.push(i + 1);
  }
  FV.mi = 0;
  if (FV.matches.length) fvJump(FV.matches[0]); else { FV.curLine = 0; fvRenderMain(); }
  fvUpdateCount();
}

function fvNav(d) {
  if (!FV.matches.length) return;
  FV.mi = (FV.mi + d + FV.matches.length) % FV.matches.length;
  fvJump(FV.matches[FV.mi]);
  fvUpdateCount();
}

function fvRenderOutline() {
  var el = document.getElementById('fvOutline');
  if (!FV.outline || !FV.outline.length) { el.innerHTML = '<div class="gmuted">no top-level symbols</div>'; return; }
  el.innerHTML = FV.outline.map(function (s) {
    return '<button class="olrow" data-oline="' + s.line + '"><span class="olkind">' + esc(s.kind) + '</span><span class="olname">' + esc(s.name) + '</span><span class="olline">' + s.line + '</span></button>';
  }).join('');
  el.querySelectorAll('.olrow').forEach(function (b) { b.addEventListener('click', function () { fvJump(parseInt(b.dataset.oline, 10)); }); });
}

async function fvLoadContent() {
  var d;
  if (FV.work) {
    d = await fetch('/api/files/read?path=' + encodeURIComponent(FV.file)).then(function (r) { return r.json(); }).catch(function () { return null; });
  } else {
    var q = 'hash=' + encodeURIComponent(FV.hash) + '&file=' + encodeURIComponent(FV.file);
    d = await fetch('/api/git/show?' + q).then(function (r) { return r.json(); }).catch(function () { return null; });
  }
  if (!d || d.error) { FV.content = ''; FV.binary = false; document.getElementById('fvMain').innerHTML = '<div class="gmuted">' + esc((d && d.error) || 'could not load file') + '</div>'; return; }
  FV.content = d.content || '';
  FV.binary = !!d.binary;
  FV.folds = FV.binary ? [] : fvComputeFolds(FV.content);
  FV.outline = FV.binary ? [] : fvOutline(FV.content);
  fvRenderOutline();
  fvRenderMain();
  if (FV.pendingJump) { var l = FV.pendingJump; FV.pendingJump = 0; fvJump(l); }
}

function fvSetMode(m) {
  FV.mode = m;
  document.querySelectorAll('.fvtab').forEach(function (t) { t.classList.toggle('current', t.dataset.fvmode === m); });
  document.getElementById('fvToolbar').hidden = (m !== 'content');
  if (m !== 'content') document.getElementById('fvOutline').hidden = true;
  if (m === 'content' && FV.content == null) { document.getElementById('fvMain').innerHTML = '<div class="gmuted">loading…</div>'; fvLoadContent(); }
  else fvRenderMain();
}

function fvToolbarHTML() {
  return '<div class="fvtoolbar" id="fvToolbar" hidden>'
    + '<div class="fvsearch"><input id="fvSearch" class="hinput" placeholder="find in file…" autocapitalize="off" autocorrect="off" spellcheck="false"><span class="fvcount" id="fvCount"></span><button class="fvnav" id="fvPrev">▲</button><button class="fvnav" id="fvNext">▼</button></div>'
    + '<div class="fvtools"><button class="clink" id="fvFoldAll">fold all</button><button class="clink" id="fvUnfoldAll">unfold all</button><button class="clink" id="fvOutlineBtn">outline</button></div>'
    + '</div>';
}

function wireViewerCommon() {
  var body = document.getElementById('fileBody');
  var mh = body.querySelector('.metahead');
  if (mh) mh.addEventListener('click', function () { mh.parentElement.classList.toggle('open'); });
  body.querySelectorAll('.fvtab').forEach(function (t) { t.addEventListener('click', function () { fvSetMode(t.dataset.fvmode); }); });
  document.getElementById('fvMain').addEventListener('click', function (e) {
    var ft = e.target.closest && e.target.closest('[data-fold]');
    if (ft) { var n = parseInt(ft.dataset.fold, 10); FV.collapsed[n] = !FV.collapsed[n]; fvRenderMain(); }
  });
  document.getElementById('fvSearch').addEventListener('input', debounce(function () { fvSearch(this.value); }, 250));
  document.getElementById('fvPrev').addEventListener('click', function () { fvNav(-1); });
  document.getElementById('fvNext').addEventListener('click', function () { fvNav(1); });
  document.getElementById('fvFoldAll').addEventListener('click', function () { FV.folds.forEach(function (f) { FV.collapsed[f.open] = true; }); fvRenderMain(); });
  document.getElementById('fvUnfoldAll').addEventListener('click', function () { FV.collapsed = {}; fvRenderMain(); });
  document.getElementById('fvOutlineBtn').addEventListener('click', function () { var o = document.getElementById('fvOutline'); o.hidden = !o.hidden; });
}

async function openFile(hash, file) {
  var body = document.getElementById('fileBody');
  document.getElementById('fileBack').textContent = '← commit';
  document.getElementById('fileTitle').textContent = file.split('/').pop();
  body.innerHTML = '<div class="gmuted">loading…</div>';
  document.getElementById('fileLayer').hidden = false;
  var q = 'hash=' + encodeURIComponent(hash) + '&file=' + encodeURIComponent(file);
  var diff = await fetch('/api/git/filediff?' + q).then(function (r) { return r.json(); }).catch(function () { return null; });
  var meta = await fetch('/api/git/filemeta?' + q).then(function (r) { return r.json(); }).catch(function () { return null; });
  var diffText = (diff && diff.diff) || '';
  FV = {
    work: false, hash: hash, file: file, diff: diffText, meta: meta || {}, content: null, binary: false,
    folds: [], outline: [], collapsed: {}, query: '', matches: [], mi: 0, curLine: 0, mode: 'diff',
    added: fvParseAdded(diffText),
  };
  body.innerHTML =
    metaSecHTML(file, FV.meta)
    + '<div class="fvtabs"><button class="fvtab current" data-fvmode="diff">Diff</button><button class="fvtab" data-fvmode="content">Content</button></div>'
    + fvToolbarHTML()
    + '<div class="outlinesec" id="fvOutline" hidden></div>'
    + '<div id="fvMain"></div>'
    + '<div class="cdactions"><button class="clink danger" data-restore data-write>restore this file to here…</button></div>';
  wireViewerCommon();
  body.querySelector('[data-restore]').addEventListener('click', function () {
    openSheet('git checkout ' + hash + ' -- ' + file,
      'Restores ' + file + ' from ' + hash + ', overwriting the current copy. A stash checkpoint is taken first.',
      async function () { var r = await gitPost('restore', { file: file, hash: hash }); if (r) { gitToast('restored ' + file, true); closeSheet(); gitLoadChanges(); } });
  });
  fvRenderMain();
}

var H = { commits: [], skip: 0, n: 30, mode: 'message', query: '', type: '', path: '', since: '', until: '', sort: 'desc', busy: false, done: false };

function debounce(fn, ms) {
  var t;
  return function () { clearTimeout(t); var a = arguments, th = this; t = setTimeout(function () { fn.apply(th, a); }, ms); };
}

function hParams() {
  var p = new URLSearchParams();
  p.set('n', H.n); p.set('skip', H.skip);
  if (H.query) { if (H.mode === 'code') p.set('pickaxe', H.query); else p.set('grep', H.query); }
  if (H.type) p.set('type', H.type);
  if (H.path) p.set('path', H.path);
  if (H.since) p.set('since', H.since);
  if (H.until) p.set('until', H.until);
  return p.toString();
}

async function loadHistory() {          // appends a page at the current skip
  if (H.busy || H.done) return;
  H.busy = true;
  var d = await fetch('/api/git/log?' + hParams()).then(function (r) { return r.json(); }).catch(function () { return null; });
  H.busy = false;
  var got = (d && d.commits) || [];
  H.commits = H.commits.concat(got);
  H.done = got.length < H.n;
  H.skip += got.length;
  renderHistory();
}

function gitLoadLog() {                  // reset + load (called on enter and after writes)
  H.commits = []; H.skip = 0; H.done = false;
  document.getElementById('gitLog').innerHTML = '<div class="gmuted">loading…</div>';
  loadHistory();
}

function groupCommits(list) {
  var hasTags = list.some(function (c) { return (c.tags || []).some(function (t) { return /^v\d/.test(t); }); });
  var groups = [], cur = null;
  if (hasTags) {
    list.forEach(function (c) {
      var vt = (c.tags || []).filter(function (t) { return /^v\d/.test(t); })[0] || (c.tags || [])[0];
      if (vt) { cur = { name: vt, commits: [c] }; groups.push(cur); }
      else { if (!cur) { cur = { name: 'Unreleased', commits: [] }; groups.push(cur); } cur.commits.push(c); }
    });
  } else {
    var by = {};
    list.forEach(function (c) {
      var m = (c.date || '').slice(0, 7) || 'undated';
      if (!by[m]) { by[m] = { name: m, commits: [] }; groups.push(by[m]); }
      by[m].commits.push(c);
    });
  }
  return groups;
}

function commitRowHTML(c) {
  var tagb = (c.tags && c.tags.length) ? '<div class="crowmeta">' + c.tags.map(function (t) { return '<span class="ctag">' + esc(t) + '</span>'; }).join(' ') + '</div>' : '';
  var tm = /^([a-z]+)(\([^)]*\))?:/i.exec(c.subject || '');
  var typeb = tm ? '<span class="tbadge">' + esc(tm[1].toLowerCase()) + '</span>' : '';
  var stat = '<div class="crow-stat">' + typeb
    + '<span class="rfiles">' + (c.files || 0) + ' file' + ((c.files === 1) ? '' : 's') + '</span>'
    + '<span class="sumadd">+' + (c.additions || 0) + '</span>'
    + '<span class="sumdel">−' + (c.deletions || 0) + '</span></div>';
  return '<button class="crow" data-hash="' + c.hash + '">'
    + '<div class="crow-top"><span class="chash">' + c.hash + '</span><span class="cmsg">' + esc(c.subject) + '</span><span class="ctime">' + esc(c.rel) + '</span></div>'
    + stat
    + tagb
    + '<span class="crowgo">›</span></button>';
}

function renderHistory() {
  var el = document.getElementById('gitLog');
  var lm = document.getElementById('loadMore');
  if (!H.commits.length) {
    var filtered = H.query || H.type || H.path || H.since || H.until;
    el.innerHTML = '<div class="gmuted">' + (filtered ? 'no commits match' : 'no commits yet') + '</div>';
    lm.hidden = true;
    return;
  }
  var groups = groupCommits(H.commits);
  if (H.sort === 'asc') { groups.reverse(); groups.forEach(function (g) { g.commits.reverse(); }); }
  el.innerHTML = groups.map(function (g, i) {
    if (!g.commits.length) return '';
    var open = i === 0;
    return '<div class="vgroup' + (open ? ' open' : '') + '">'
      + '<button class="vghead"><span class="vgchev">▸</span><span class="vgname">' + esc(g.name) + '</span><span class="vgcount">' + g.commits.length + '</span></button>'
      + '<div class="vgbody">' + g.commits.map(commitRowHTML).join('') + '</div></div>';
  }).join('');
  el.querySelectorAll('.vghead').forEach(function (h) {
    h.addEventListener('click', function () { h.parentElement.classList.toggle('open'); });
  });
  el.querySelectorAll('.crow').forEach(wireCommit);
  lm.hidden = H.done;
}

function gitEnter() { gitLoadChanges(); gitLoadLog(); }

(function gitWire() {
  document.querySelectorAll('.gtab').forEach(function (t) {
    t.addEventListener('click', function () {
      var name = t.dataset.gtab;
      document.querySelectorAll('.gtab').forEach(function (x) { var on = x === t; x.classList.toggle('current', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); });
      document.querySelectorAll('.gpanel').forEach(function (p) { p.hidden = p.dataset.gpanel !== name; });
    });
  });
  document.getElementById('commitBtn').addEventListener('click', function () {
    var d = window._gitChanges;
    // Defensive: if the changes state isn't loaded for any reason, fall back to a
    // plain commit of whatever git already has staged (the pre-gate behaviour) so
    // the button can never silently do nothing.
    if (!d || !d.repo) {
      var m0 = document.getElementById('commitMsg').value.trim();
      if (!m0) { gitToast('enter a commit message', false); return; }
      applyDecisions([], [], m0);
      return;
    }
    var commits = [], ignores = [];
    (d.untracked || []).forEach(function (f) {
      var s = GITSEL[f] || 'leave';
      if (s === 'commit') commits.push(f); else if (s === 'ignore') ignores.push(f);
    });
    var willCommit = (d.staged ? d.staged.length : 0) + commits.length;

    // ignore-only: no commit to make, just write the .gitignore lines
    if (willCommit === 0 && ignores.length) {
      applyDecisions(commits, ignores, null);
      return;
    }
    var msg = document.getElementById('commitMsg').value.trim();
    if (!msg) { gitToast('enter a commit message', false); return; }

    // New files entering version control for the first time get an explicit
    // review step — the place accidental commits (build output, secrets,
    // local-only files) are caught.
    if (commits.length) {
      lkConfirm({
        heading: 'Add ' + commits.length + ' new file' + (commits.length === 1 ? '' : 's') + ' to the commit?',
        detail: 'First time in version control: ' + commits.join(', ') + '. Confirm these belong in git — not build output, secrets, or local-only files.',
        confirmLabel: 'Add & commit',
        onConfirm: function () { applyDecisions(commits, ignores, msg); },
      });
    } else {
      applyDecisions(commits, ignores, msg);
    }
  });

  // Apply the untracked decisions (ignore-adds + stage), then optionally commit.
  async function applyDecisions(commits, ignores, msg) {
    for (var i = 0; i < ignores.length; i++) {
      var ri = await filesPost('ignore-add', { path: ignores[i] });
      if (ri && ri.ok) notify({ msg: 'ignored ' + ignores[i], level: 'ok', source: 'git' });
    }
    for (var j = 0; j < commits.length; j++) {
      var rs = await gitPost('stage', { file: commits[j] });
      if (!rs) { gitLoadChanges(); return; } // stage failed (e.g. protected) — stop, surfaced by gitPost
    }
    GITSEL = {};
    if (msg === null) { gitLoadChanges(); return; } // ignore-only path
    var r = await gitPost('commit', { message: msg });
    if (r) { document.getElementById('commitMsg').value = ''; notify({ msg: 'committed', level: 'ok', source: 'git' }); gitLoadChanges(); gitLoadLog(); }
    else { gitLoadChanges(); }
  }
  var undoTrack = document.getElementById('undoTrack');
  document.getElementById('undoBtn').addEventListener('click', function () { undoTrack.hidden = !undoTrack.hidden; });
  attachSlide(undoTrack, async function () {
    var r = await gitPost('undo', {});
    if (r) { gitToast('un-committed last (changes kept)', true); undoTrack.hidden = true; gitLoadChanges(); gitLoadLog(); }
  });
  // --- history controls ---
  var sp = document.getElementById('searchPanel'), fp = document.getElementById('filterPanel');
  var st = document.getElementById('searchToggle'), ft = document.getElementById('filterToggle');
  function updateFilterBadge() {
    var n = (H.type ? 1 : 0) + (H.path ? 1 : 0) + (H.since ? 1 : 0) + (H.until ? 1 : 0);
    ft.classList.toggle('active', n > 0);
    ft.setAttribute('data-count', n ? String(n) : '');
  }
  st.addEventListener('click', function () { sp.hidden = !sp.hidden; st.classList.toggle('open', !sp.hidden); });
  ft.addEventListener('click', function () { fp.hidden = !fp.hidden; ft.classList.toggle('open', !fp.hidden); });
  var si = document.getElementById('searchInput');
  si.addEventListener('input', debounce(function () {
    H.query = si.value.trim(); st.classList.toggle('active', !!H.query); gitLoadLog();
  }, 300));
  document.querySelectorAll('#searchPanel .segbtn').forEach(function (b) {
    b.addEventListener('click', function () {
      document.querySelectorAll('#searchPanel .segbtn').forEach(function (x) { x.classList.toggle('current', x === b); });
      H.mode = b.dataset.mode;
      si.placeholder = H.mode === 'code' ? 'find code added or removed…' : 'search messages…';
      if (H.query) gitLoadLog();
    });
  });
  document.querySelectorAll('#typeChips .chip').forEach(function (c) {
    c.addEventListener('click', function () {
      document.querySelectorAll('#typeChips .chip').forEach(function (x) { x.classList.toggle('current', x === c); });
      H.type = c.dataset.type; updateFilterBadge(); gitLoadLog();
    });
  });
  var pi = document.getElementById('pathInput');
  pi.addEventListener('input', debounce(function () { H.path = pi.value.trim(); updateFilterBadge(); gitLoadLog(); }, 350));
  var sin = document.getElementById('sinceInput'), uin = document.getElementById('untilInput');
  sin.addEventListener('change', function () { H.since = sin.value; updateFilterBadge(); gitLoadLog(); });
  uin.addEventListener('change', function () { H.until = uin.value; updateFilterBadge(); gitLoadLog(); });
  document.getElementById('sortSel').addEventListener('change', function () { H.sort = this.value; renderHistory(); });
  document.getElementById('loadMore').addEventListener('click', function () { loadHistory(); });

  document.getElementById('commitBack').addEventListener('click', function () { document.getElementById('commitLayer').hidden = true; });
  document.getElementById('fileBack').addEventListener('click', function () { document.getElementById('fileLayer').hidden = true; });

  var backdrop = document.getElementById('gitBackdrop');
  backdrop.addEventListener('pointerdown', function (e) { if (e.target === backdrop) closeSheet(); });
  document.getElementById('sheetCancel').addEventListener('click', closeSheet);
  attachSlide(document.getElementById('sheetTrack'), function () { if (sheetConfirm) sheetConfirm(); });
})();

// ---- Repo switcher -----------------------------------------------------

async function loadRepos() {
  var d = await fetch('/api/repos').then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!d) return;
  var active = d.active || '';
  var found = !!d.active_valid && (d.repos || []).some(function (r) { return r.path === active; });
  document.getElementById('repoName').textContent = found ? (active.split('/').filter(Boolean).pop() || active) : 'select a repo';
  var list = document.getElementById('repoList');
  var items = (d.repos || []).map(function (r) {
    var pe = encodeURIComponent(r.path);
    return '<div class="repoitem-row' + (r.path === active ? ' current' : '') + '">'
      + '<button class="repoitem" data-path="' + pe + '">'
      + '<span class="rname">' + esc(r.name) + '</span>'
      + '<span class="rbranch">' + (r.branch ? esc(r.branch) : '') + '</span></button>'
      + '<button class="repodel" data-path="' + pe + '" data-name="' + escAttr(r.name) + '" title="delete this git" aria-label="delete this git">✕</button>'
      + '</div>';
  }).join('') || '<div class="gmuted">none found — type a path below to use or create one</div>';
  list.innerHTML = items
    + '<div class="repoadd">'
    + '<input id="repoPathInput" class="repoinput" placeholder="/root/your-repo" autocapitalize="off" autocorrect="off" spellcheck="false">'
    + '<button id="repoUseBtn" class="repoaddbtn">use</button>'
    + '<button id="repoNewBtn" class="repoaddbtn new">new</button>'
    + '</div>';
  list.querySelectorAll('.repoitem').forEach(function (b) {
    b.addEventListener('click', function () { switchRepo(decodeURIComponent(b.dataset.path)); });
  });
  list.querySelectorAll('.repodel').forEach(function (b) {
    b.addEventListener('click', function (e) { e.stopPropagation(); deleteRepo(decodeURIComponent(b.dataset.path), b.dataset.name); });
  });
  var input = document.getElementById('repoPathInput');
  document.getElementById('repoUseBtn').addEventListener('click', function () { if (input.value.trim()) switchRepo(input.value.trim()); });
  document.getElementById('repoNewBtn').addEventListener('click', function () { if (input.value.trim()) createRepo(input.value.trim()); });
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && this.value.trim()) switchRepo(this.value.trim()); });
  if (!found) list.hidden = false;  // no valid repo: surface the picker so the page is usable
}

async function switchRepo(p) {
  var res = await fetch('/api/repo', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
  }).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (res && res.ok) {
    document.getElementById('repoList').hidden = true;
    loadRepos(); poll();
    if (location.hash === '#git') { gitLoadChanges(); gitLoadLog(); }
  } else { gitToast('not a git repo: ' + p, false); }
}

async function createRepo(p) {
  var res = await fetch('/api/repo/init', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
  }).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (res && res.ok) {
    document.getElementById('repoList').hidden = true;
    gitToast('created repo at ' + p, true);
    loadRepos(); poll();
    if (location.hash === '#git') { gitLoadChanges(); gitLoadLog(); }
  } else { gitToast('could not create: ' + ((res && res.error) || p), false); }
}

function deleteRepo(p, name) {
  lkConfirm({
    level: 'type', danger: true, heading: 'Delete the git in ' + (name || 'this repo') + '?',
    match: 'delete',
    detail: 'Removes the .git folder (git history + remote links) from this repo. Your files stay on disk — this just un-inits the repo so you can start its git over. Type "delete" to confirm.',
    confirmLabel: 'Delete .git',
    onConfirm: async function () {
      var r = await fetch('/api/repo/deinit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })
        .then(function (x) { return x.json(); }).catch(function () { return null; });
      if (r && r.ok) {
        gitToast('git removed from ' + (name || p), true);
        loadRepos(); poll();
        if (location.hash === '#sync') loadSync();
        if (location.hash === '#git') { gitLoadChanges(); gitLoadLog(); }
      } else { gitToast((r && r.error) || 'delete failed', false); }
    },
  });
}

document.getElementById('repoBtn').addEventListener('click', function () {
  var l = document.getElementById('repoList'); l.hidden = !l.hidden;
});
document.addEventListener('click', function (e) {
  var w = document.querySelector('.repobar-wrap');
  if (w && !w.contains(e.target)) document.getElementById('repoList').hidden = true;
});
loadRepos();

// ===== Sync tool =====
function syncToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'sync' }); }

async function syncPost(action, body) {
  try {
    var res = await fetch('/api/sync/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    var j = await res.json().catch(function () { return {}; });
    if (res.status === 423) { syncToast('locked — aider is running', false); return null; }
    if (!res.ok) { syncToast('failed: ' + (j.error || j.output || res.status), false); return null; }
    return j; // may carry ok:false (e.g. ff refused) with real output — caller decides
  } catch (e) { syncToast('server error', false); return null; }
}

function ageStr(epoch) {
  if (!epoch) return 'never';
  var s = Math.max(0, Math.floor(Date.now() / 1000 - epoch));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function kvRow(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd>'; }

function maskUrl(u) {
  if (!u) return u || '';
  // Hide an embedded credential: //user:token@host -> //user:***@host ; //token@host -> //***@host
  return u.replace(/\/\/([^/@]+)@/, function (m, cred) {
    return cred.indexOf(':') >= 0 ? '//' + cred.split(':')[0] + ':***@' : '//***@';
  });
}

var SYNC = { method: 'https', last: null, showUrl: false, dry: false,
             auths: [], authEdit: null, authShow: {}, prefill: null, modalStep: 1 };

function maskToken(t) { if (!t) return ''; return t.length <= 8 ? '\u2022\u2022\u2022\u2022' : (t.slice(0, 4) + '\u2026' + t.slice(-4)); }
function authF(id, label, ph, val) {
  return '<label class="conn-field"><span class="conn-l">' + esc(label) + '</span>'
    + '<input id="' + id + '" class="hinput" placeholder="' + escAttr(ph) + '" value="' + escAttr(val || '') + '" autocapitalize="off" autocorrect="off" spellcheck="false" data-write></label>';
}
function authPw(id, label, ph) {
  return '<label class="conn-field"><span class="conn-l">' + esc(label) + '</span>'
    + '<input id="' + id + '" type="password" class="hinput" placeholder="' + escAttr(ph) + '" autocapitalize="off" autocorrect="off" spellcheck="false" data-write></label>';
}
function syncAuthsHTML() {
  var list = (SYNC.auths || []).map(function (a) {
    var tok = a.token ? (SYNC.authShow[a.id] ? esc(a.token) : esc(maskToken(a.token))) : '—';
    var scopes = (a.scopes || []).length ? esc((a.scopes || []).join(', ')) : 'any repo';
    return '<div class="auth-row">'
      + '<div class="auth-main"><span class="auth-label">' + esc(a.label) + '</span> '
      + '<span class="gmuted">' + esc(a.method || 'https') + ' · ' + esc(a.host || '') + (a.username ? (' · ' + esc(a.username)) : '') + '</span></div>'
      + '<div class="auth-tok"><span class="mono">' + tok + '</span>' + (a.token ? ' <button class="xlink" data-authmask="' + a.id + '">' + (SYNC.authShow[a.id] ? 'hide' : 'show') + '</button>' : '') + '</div>'
      + '<div class="gmuted auth-scopes">repos: ' + scopes + '</div>'
      + '<div class="auth-acts"><button class="clink" data-authuse="' + a.id + '">use for this repo</button>'
      + '<button class="clink" data-authedit="' + a.id + '">edit</button>'
      + '<button class="clink danger" data-authdel="' + a.id + '">delete</button></div>'
      + '</div>';
  }).join('') || '<div class="gmuted">No saved logins yet.</div>';
  var form = '';
  if (SYNC.authEdit !== null) {
    var a = SYNC.authEdit === 'new' ? {} : ((SYNC.auths || []).filter(function (x) { return x.id === SYNC.authEdit; })[0] || {});
    form = '<div class="auth-form">'
      + authF('al_label', 'Label', 'e.g. GitHub (octocat)', a.label || '')
      + authF('al_host', 'Host', 'github.com', a.host || 'github.com')
      + authF('al_user', 'Username', 'e.g. octocat', a.username || '')
      + authPw('al_token', 'Token', a.id != null ? 'leave blank to keep the stored token' : 'github_pat_\u2026 / ghp_\u2026')
      + authF('al_name', 'Commit name (optional)', 'e.g. Octo Cat', a.name || '')
      + authF('al_email', 'Commit email (optional)', 'octo@example.com', a.email || '')
      + authF('al_scopes', 'Repos this login is for (optional, comma-separated)', 'owner/repo, owner/other', (a.scopes || []).join(', '))
      + '<div class="conn-actions"><button class="clink primary" id="authSaveBtn" data-write>save login</button><button class="clink" id="authCancelBtn">cancel</button></div>'
      + '</div>';
  }
  return '<details class="auth-card"><summary>Saved logins (' + (SYNC.auths || []).length + ')</summary>'
    + '<div class="auth-body">'
    + '<p class="gmuted">Store credentials once and reuse them across repos — useful when you work with several gits or accounts. Tokens are kept on this device (0600) and masked here. Scope a login to the repos it\u2019s for.</p>'
    + list
    + (SYNC.authEdit === null ? '<button class="clink" id="authAddBtn">+ add login</button>' : form)
    + '</div></details>';
}

function connTab(id, label) {
  var on = SYNC.method === id;
  return '<button class="conn-tab' + (on ? ' on' : '') + '" data-method="' + id + '" role="tab" aria-selected="' + (on ? 'true' : 'false') + '">' + label + '</button>';
}
function connField(id, label, ph, val, req) {
  return '<label class="conn-field"><span class="conn-l">' + esc(label)
    + (req ? ' <i class="req">required</i>' : ' <i class="opt">optional</i>') + '</span>'
    + '<input id="cf_' + id + '" class="hinput" placeholder="' + escAttr(ph) + '" value="' + escAttr(val || '')
    + '" autocapitalize="off" autocorrect="off" spellcheck="false" data-write></label>';
}
function connFieldI(id, label, ph, val, req, info) {
  var lab = esc(label) + (info ? ' ' + iBtn(info) : '') + (req ? ' <i class="req">required</i>' : ' <i class="opt">optional</i>');
  return '<label class="conn-field"><span class="conn-l">' + lab + '</span>'
    + '<input id="cf_' + id + '" class="hinput" placeholder="' + escAttr(ph) + '" value="' + escAttr(val || '')
    + '" autocapitalize="off" autocorrect="off" spellcheck="false" data-write></label>';
}
function connPw(id, label, ph, req, val) {
  return '<label class="conn-field"><span class="conn-l">' + esc(label) + (req ? ' <i class="req">required</i>' : '') + '</span>'
    + '<input id="cf_' + id + '" type="password" class="hinput" placeholder="' + escAttr(ph) + '" value="' + escAttr(val || '') + '"'
    + ' autocapitalize="off" autocorrect="off" spellcheck="false" data-write></label>';
}
function connPwI(id, label, ph, req, val, info) {
  var lab = esc(label) + (info ? ' ' + iBtn(info) : '') + (req ? ' <i class="req">required</i>' : '');
  return '<label class="conn-field"><span class="conn-l">' + lab + '</span>'
    + '<input id="cf_' + id + '" type="password" class="hinput" placeholder="' + escAttr(ph) + '" value="' + escAttr(val || '') + '"'
    + ' autocapitalize="off" autocorrect="off" spellcheck="false" data-write></label>';
}
function connActions() {
  return '<div class="conn-actions"><button class="clink" id="connTestBtn">test connection</button>'
    + '<button class="clink primary" id="connSaveBtn" data-write>save &amp; connect</button></div>';
}
function syncFormHttps() {
  var p = SYNC.prefill || {};
  var host = p.host || 'github.com';
  var owner = p.owner || '';
  var repo = p.repo || '';
  var user = p.user || (SYNC.last && SYNC.last.ghuser) || '';
  var token = p.token || '';
  var savedHint = p.label ? '<p class="conn-lead">Prefilled from saved login <strong>' + esc(p.label) + '</strong>. Add the owner and repository.</p>' : '';
  return '<div class="conn-form">'
    + savedHint
    + '<p class="conn-lead">Enter the parts — Layaider builds the URL, so you don\u2019t need to remember the '
    + '<span class="mono">/OWNER/REPO.git</span> format. Use a '
    + '<a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">fine-grained token</a> '
    + '(repository \u2192 Contents: read &amp; write) or a '
    + '<a href="https://github.com/settings/tokens" target="_blank" rel="noopener">classic token</a> (scope <span class="mono">repo</span>) as the password.</p>'
    + connFieldI('host', 'Host', 'github.com', host, false, 'host')
    + connFieldI('owner', 'Owner / user', 'e.g. octocat', owner, true, 'owner')
    + connFieldI('repo', 'Repository', 'e.g. layaider', repo, true, 'repo')
    + connFieldI('user', 'Your GitHub username', 'e.g. octocat', user, true, null)
    + connPwI('token', 'Access token (used as the password)', 'github_pat_\u2026 or ghp_\u2026', true, token, 'token')
    + connFieldI('rname', 'Remote name', 'origin (or set your own)', 'origin', false, 'rname')
    + '<label class="conn-save"><input type="checkbox" id="cf_savelogin"> save this login for reuse'
    + ' <input id="cf_savelabel" class="hinput hinput-inline" placeholder="label, e.g. GitHub (octocat)" value="' + escAttr(p.label || '') + '" autocapitalize="off" autocorrect="off" spellcheck="false"></label>'
    + '<div class="conn-preview" id="connPreview"></div>' + connActions() + '</div>';
}
function syncFormSsh(s) {
  var tools = (s && s.tools) || {};
  var gen = tools.sshKeygen !== false
    ? '<div class="conn-actions"><button class="clink" id="sshGenBtn">show / generate key</button></div><div class="conn-pubkey" id="sshPubkey"></div>'
    : '<p class="gmuted">ssh-keygen isn\u2019t on this device \u2014 install openssh, or use the HTTPS method.</p>';
  var p = SYNC.prefill || {};
  return '<div class="conn-form">'
    + '<p class="conn-lead">1 \u2014 generate a key here \u00b7 2 \u2014 add the public key to '
    + '<a href="https://github.com/settings/keys" target="_blank" rel="noopener">GitHub \u2192 SSH keys</a> \u00b7 3 \u2014 test. No token needed.</p>'
    + gen
    + connFieldI('host', 'Host', 'github.com', p.host || 'github.com', false, 'host')
    + connFieldI('owner', 'Owner / user', 'e.g. octocat', p.owner || '', true, 'owner')
    + connFieldI('repo', 'Repository', 'e.g. layaider', p.repo || '', true, 'repo')
    + connFieldI('rname', 'Remote name', 'origin (or set your own)', 'origin', false, 'rname')
    + '<div class="conn-preview" id="connPreview"></div>' + connActions() + '</div>';
}
function syncFormManual() {
  var p = SYNC.prefill || {};
  return '<div class="conn-form">'
    + '<p class="conn-lead">Paste a complete remote URL (any host or protocol). HTTPS embeds credentials; SSH uses your key.</p>'
    + connField('url', 'Remote URL', 'https://USER:TOKEN@github.com/OWNER/REPO.git', p.url || '', true)
    + connFieldI('rname', 'Remote name', 'origin (or set your own)', 'origin', false, 'rname')
    + connActions() + '</div>';
}
function syncConnectHTML(s) {
  var m = SYNC.method, tools = (s && s.tools) || {};
  var tabs = '<div class="conn-tabs" role="tablist" aria-label="Connection method">' + connTab('https', 'HTTPS + token') + connTab('ssh', 'SSH key') + connTab('manual', 'Manual URL') + '</div>';
  var gh = tools.gh ? '<div class="gmuted conn-ghhint">GitHub CLI detected \u2014 you can also run <span class="mono">gh auth login</span> in a terminal for a browser login.</div>' : '';
  var form = m === 'ssh' ? syncFormSsh(s) : m === 'manual' ? syncFormManual() : syncFormHttps();
  return '<div class="card-h">Connect a remote</div>' + tabs + gh + form + '<div class="conn-result" id="connResult"></div>';
}
function connVal(id) { var e = document.getElementById('cf_' + id); return e ? e.value.trim() : ''; }
function buildRemoteUrl() {
  var m = SYNC.method;
  if (m === 'manual') return connVal('url');
  var host = connVal('host') || 'github.com', owner = connVal('owner'), repo = connVal('repo').replace(/\.git$/, '');
  if (!owner || !repo) return '';
  if (m === 'ssh') return 'git@' + host + ':' + owner + '/' + repo + '.git';
  var user = connVal('user'), token = connVal('token');
  var auth = user ? (encodeURIComponent(user) + (token ? ':' + encodeURIComponent(token) : '') + '@') : '';
  return 'https://' + auth + host + '/' + owner + '/' + repo + '.git';
}
function updateConnPreview() {
  var el = document.getElementById('connPreview'); if (!el) return;
  var u = buildRemoteUrl();
  el.innerHTML = u ? '<span class="conn-plabel">resulting URL</span> <span class="mono">' + esc(maskUrl(u)) + '</span>'
    : '<span class="gmuted">fill owner + repository to preview the URL</span>';
}
function connResult(msg, ok) {
  var el = document.getElementById('connResult'); if (!el) return;
  el.className = 'conn-result ' + (ok ? 'ok' : 'bad');
  el.innerHTML = (ok ? '\u2713 ' : '\u2717 ') + esc(msg);
}
function connResultByKind(j) {
  if (!j) { connResult('no response', false); return; }
  if (j.ok) { connResult('connected' + (j.heads != null ? ' \u2014 ' + j.heads + ' branch(es) visible' : ''), true); return; }
  var m = {
    auth: 'authentication failed \u2014 check your username and token (and that the token grants repo access)',
    notfound: 'repository not found or no access \u2014 check owner/repo and the token\u2019s repository permission',
    sshkey: 'SSH key not accepted \u2014 add the public key above at GitHub \u2192 SSH keys',
    hostkey: 'host key issue \u2014 test again to accept the host key',
    network: 'could not reach the host \u2014 check connectivity and the host name'
  };
  connResult(m[j.kind] || j.message || 'failed', false);
}

var SYNC_NEXT = [];
function recCls(id) { return SYNC_NEXT.indexOf(id) >= 0 ? ' rec' : ''; }

function syncStateInfo(s) {
  if (!s.remote) return { label: 'not connected', cls: 'muted',
    text: 'No remote is set. Use the wizard below to link this repo to a GitHub (or other) repository.',
    steps: ['Set up a connection below.'] };
  if (!s.hasCommits) return { label: 'empty repo', cls: 'muted',
    text: 'This repo has no commits yet, but a remote is connected.',
    steps: ['Pull the remote in to fill this repo (Publish, below) — or make your first commit, then push.'] };
  if (!s.upstream) return { label: 'connected · not linked', cls: 'warn',
    text: 'A remote is set, but this branch isn\u2019t tracking a remote branch yet — so there\u2019s nothing to compare (no ahead/behind).',
    steps: ['Press Fetch, then Set upstream to ' + esc(s.remote) + '/' + esc(s.branch) + '.',
            'If the remote has no \u201c' + esc(s.branch) + '\u201d branch yet, Push to publish it (that also links it).'] };
  if (s.unrelated) return { label: 'unrelated histories', cls: 'bad',
    text: 'Your local history and the remote share no common starting point — usually a fresh local repo meeting a non-empty remote. Pull/merge refuses this by default.',
    steps: ['To take the remote\u2019s content: back up local work, then reset this branch to the remote.',
            'To keep local and overwrite the remote: push with force — destructive to the remote, only if you\u2019re sure.'] };
  if (s.ahead && s.behind) return { label: s.ahead + ' ahead · ' + s.behind + ' behind (diverged)', cls: 'bad',
    text: 'You and the remote each have commits the other doesn\u2019t.',
    steps: ['Pull with rebase to replay your commits on top of the remote, then Push.',
            'Resolve conflicts if prompted; Abort backs out.'] };
  if (s.behind) return { label: s.behind + ' behind', cls: 'warn',
    text: 'The remote has commits you don\u2019t have yet.',
    steps: ['Pull to bring them in (fast-forward is safe — it won\u2019t rewrite anything).'] };
  if (s.ahead) return { label: s.ahead + ' ahead', cls: 'warn',
    text: 'You have local commits not yet on the remote.', steps: ['Push to upload them.'] };
  return { label: 'up to date', cls: 'ok', text: 'Your branch and the remote match.', steps: [] };
}
function syncNext(s) {
  if (!s.remote) return ['connect'];
  if (!s.upstream) return s.lastFetch ? ['setupstream', 'push'] : ['fetch', 'setupstream'];
  if (s.unrelated) return [];
  if (s.ahead && s.behind) return ['pull', 'push'];
  if (s.behind) return ['pull'];
  if (s.ahead) return ['push'];
  return [];
}

function renderSyncStatus(s, br, inc, out) {
  var el = document.getElementById('syncStatus');
  if (!s || !s.repo) { el.innerHTML = '<div class="gmuted">No repo selected — pick one in the Git tool.</div>'; return; }
  SYNC.last = s;
  SYNC_NEXT = syncNext(s);
  var info = syncStateInfo(s);
  var stepsHtml = info.steps.length
    ? '<ul class="state-steps">' + info.steps.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>' : '';
  var stateBlock = '<div class="syncstate ' + info.cls + '">' + esc(info.label) + '</div>'
    + '<p class="state-text">' + info.text + '</p>' + stepsHtml;

  var rows = '<dl class="kv">' + kvRow('branch', s.branch);
  rows += '</dl>';
  // remote URL row carries a mask/unmask toggle (verify what's stored across gits).
  var remoteRow = '';
  if (s.remote) {
    var shown = SYNC.showUrl ? esc(s.url || '') : esc(maskUrl(s.url) || '—');
    remoteRow = '<dl class="kv"><dt>remote (' + esc(s.remote) + ')</dt><dd class="urlcell">'
      + '<span class="mono">' + shown + '</span> '
      + (s.url ? '<button class="clink xlink" id="urlMaskBtn">' + (SYNC.showUrl ? 'hide' : 'show') + '</button>' : '')
      + '</dd>'
      + kvRow('upstream', s.upstream || '— none —')
      + kvRow('fetched', ageStr(s.lastFetch))
      + '</dl>';
  }
  var idRow = '<dl class="kv">' + kvRow('identity', (s.name || s.email) ? (s.name + ' <' + s.email + '>') : '— not set —') + '</dl>';

  // Action bar: real buttons, each with a one-line description; the recommended
  // next step(s) are highlighted. Dry-run toggle gates pull/push.
  var actions = '';
  if (s.remote) {
    actions = '<div class="sync-actions">'
      + '<label class="dryrow"><input type="checkbox" id="dryRun"' + (SYNC.dry ? ' checked' : '') + '> dry run (preview pull/push — change nothing)</label>'
      + '<div class="sbtn-row">'
      + '<button class="sbtn' + recCls('fetch') + '" id="fetchBtn">Fetch<small>download remote commits; updates counts; no file changes</small></button>'
      + '<button class="sbtn" id="testWriteBtn">Check push access<small>dry-run push to the remote; transfers nothing</small></button>'
      + '<button class="sbtn danger" id="remoteRemoveBtn" data-write>Remove remote<small>disconnect this repo from "' + esc(s.remote) + '"</small></button>'
      + '</div></div>';
  }

  var fields = '<div class="sync-fields">'
    + '<div class="sync-field"><label class="sync-flabel">upstream (tracking) ' + iBtn('upstream') + '</label>'
    +   '<div class="remote-edit">'
    +     '<input id="upstreamInput" class="hinput" placeholder="' + escAttr(s.remote || 'origin') + '/' + escAttr(s.branch || 'main') + '" value="' + escAttr(s.upstream || '') + '" data-write autocapitalize="off" autocorrect="off" spellcheck="false">'
    +     '<button class="clink' + recCls('setupstream') + '" id="upstreamBtn" data-write>set</button>'
    +     '<div class="remote-help gmuted">The remote branch this branch pushes to / pulls from. Format <span class="mono">REMOTE/BRANCH</span>; empty + set clears it. A first push can set it for you.</div>'
    +   '</div></div>'
    + '<div class="sync-field"><label class="sync-flabel">git identity ' + iBtn('identity') + '</label>'
    +   '<div class="remote-edit">'
    +     '<input id="gitName" class="hinput" placeholder="Your Name" value="' + escAttr(s.name || '') + '" data-write autocapitalize="off" autocorrect="off" spellcheck="false">'
    +     '<input id="gitEmail" class="hinput" placeholder="you@example.com" value="' + escAttr(s.email || '') + '" data-write autocapitalize="off" autocorrect="off" spellcheck="false">'
    +     '<button class="clink" id="identityBtn" data-write>save</button>'
    +     '<div class="remote-help gmuted">Author recorded on commits; a missing identity can get pushes rejected or mis-attributed.</div>'
    +   '</div></div>'
    + '</div>';

  var hasRemote = !!s.remote;
  var connectBtn = '<button class="sbtn' + recCls('connect') + '" id="connSetupBtn" data-write>'
    + (hasRemote ? 'Edit connection' : 'Set up connection')
    + '<small>' + (hasRemote ? 'change the remote, credentials, or method' : 'link this repo to a remote (GitHub or any git host)') + '</small></button>';

  el.innerHTML = '<div class="card-h">Remote &amp; sync</div>'
    + stateBlock
    + rows + remoteRow + idRow
    + actions
    + '<div class="conn-launch">' + connectBtn + '</div>'
    + syncAuthsHTML()
    + branchBarHTML(s, br)
    + pullHTML(s, inc)
    + pushHTML(s, out)
    + fields;
  el.querySelectorAll('.crow').forEach(wireCommit);
}

// The Sync page is one panel: these return HTML strings that renderSyncStatus
// composes into #syncStatus (each its own .sync-group). Empty string => the group
// simply isn't there, so nothing appears/moves unexpectedly.
function branchBarHTML(s, br) {
  if (!s || !s.repo) return '';
  br = br || { local: [], remote: [] };
  var opts = '';
  (br.local || []).forEach(function (b) { opts += '<option value="' + esc(b) + '"' + (b === br.current ? ' selected' : '') + '>' + esc(b) + '</option>'; });
  (br.remote || []).forEach(function (b) { var sh = b.replace(/^origin\//, ''); if ((br.local || []).indexOf(sh) < 0) opts += '<option value="' + esc(b) + '">' + esc(b) + ' (remote)</option>'; });
  return '<div class="sync-group syncbranch">'
    + '<span class="sbcur">branch</span>'
    + '<select id="branchSel" data-write>' + opts + '</select>'
    + '<input id="newBranch" class="hinput sbnew" placeholder="new branch" data-write autocapitalize="off" autocorrect="off" spellcheck="false">'
    + '<button class="clink" id="newBranchBtn" data-write>create</button>'
    + '</div>';
}

function pullHTML(s, incoming) {
  if (!s || !s.repo || !s.upstream) return '';
  incoming = incoming || [];
  var n = s.behind || 0;
  var list = incoming.length ? '<div class="cgroup">' + incoming.map(commitRowHTML).join('') + '</div>' : '<div class="gmuted">nothing incoming</div>';
  return '<div class="sync-group"><div class="synch">Pull <span class="syncn">' + n + ' to pull</span></div>'
    + '<p class="sync-sub gmuted">Brings the remote\u2019s commits into your branch (changes files). Fast-forward is safe; rebase replays your commits on top.</p>'
    + list
    + '<div class="syncctrl">'
    + '<button class="sbtn' + recCls('pull') + '" id="pullBtn" data-write' + (n ? '' : ' disabled') + '>Pull (ff-only)<small>integrate remote commits</small></button>'
    + '<label class="rebasechk"><input type="checkbox" id="rebaseChk" data-write> rebase</label>'
    + '<button class="sbtn danger" id="abortBtn" data-write hidden>Abort</button>'
    + '</div></div>';
}

function pushHTML(s, outgoing) {
  if (!s || !s.repo || !s.remote) return '';
  outgoing = outgoing || [];
  if (!s.hasCommits) {
    return '<div class="sync-group"><div class="synch">Publish</div>'
      + '<p class="sync-sub gmuted">This repo has no commits yet. Pull the remote’s content in to fill it, then work from here.</p>'
      + '<button class="sbtn rec" id="populateBtn" data-write>Pull remote into this repo<small>fetch + check out the remote branch here (fills an empty repo)</small></button>'
      + '</div>';
  }
  var n = s.ahead || 0;
  var noUp = !s.upstream;
  var list = outgoing.length ? '<div class="cgroup">' + outgoing.map(commitRowHTML).join('') + '</div>' : '<div class="gmuted">nothing to push</div>';
  var canPush = n > 0 || noUp;
  var btn = '<button class="sbtn' + recCls('push') + '" id="pushBtn" data-write>Push' + (noUp ? ' &amp; set upstream' : '') + ' \u2192<small>upload your local commits to the remote</small></button>';
  return '<div class="sync-group"><div class="synch">Push <span class="syncn">' + n + ' to push' + (noUp ? ' · sets upstream' : '') + '</span></div>'
    + '<p class="sync-sub gmuted">Uploads your commits to the remote. With dry run on (above), this only previews.</p>'
    + list
    + '<input id="pushTag" class="hinput" placeholder="tag this push, e.g. v0.086 (optional)" data-write autocapitalize="off" autocorrect="off" spellcheck="false">'
    + (canPush ? btn : '')
    + '<button class="sbtn danger" id="forcePushBtn" data-write>Overwrite remote (force push)<small>replace the remote history with this repo — destructive; for publishing over a different or old repo</small></button>'
    + '</div>';
}

function wireSync(s) {
  var fb = document.getElementById('fetchBtn');
  if (fb) fb.addEventListener('click', async function () { fb.textContent = 'fetching…'; var j = await syncPost('fetch'); if (j) syncToast(j.ok ? 'fetched' : (j.output || 'fetch failed'), j.ok); loadSync(); });
  var rrb = document.getElementById('remoteRemoveBtn');
  if (rrb) rrb.addEventListener('click', function () { var nm = (s && s.remote) || 'origin'; openSheet('remove ' + nm, 'Disconnects this repo from its remote. Re-add one to reconnect.', async function () { closeSheet(); var j = await syncPost('remote-remove', { name: nm }); if (j && j.ok) { syncToast(nm + ' removed', true); loadSync(); } else if (j) syncToast(j.output || 'failed', false); }); });
  var ub = document.getElementById('upstreamBtn');
  if (ub) ub.addEventListener('click', async function () { var u = document.getElementById('upstreamInput').value.trim(); var j = await syncPost('set-upstream', { upstream: u }); if (j && j.ok) { syncToast(u ? 'upstream set' : 'upstream cleared', true); loadSync(); } else if (j) syncToast(j.error || j.output || 'failed', false); });
  var ib = document.getElementById('identityBtn');
  if (ib) ib.addEventListener('click', async function () { var name = document.getElementById('gitName').value.trim(); var email = document.getElementById('gitEmail').value.trim(); if (!name || !email) { syncToast('name and email required', false); return; } var j = await syncPost('identity', { name: name, email: email }); if (j && j.ok) { syncToast('identity saved', true); loadSync(); } else if (j) syncToast(j.error || j.output || 'failed', false); });
  var bs = document.getElementById('branchSel');
  if (bs) bs.addEventListener('change', async function () { var b = this.value; var j = await syncPost('switch', { branch: b }); if (j && j.ok) syncToast('on ' + b, true); else if (j) syncToast(j.output || 'switch failed', false); loadSync(); });
  var nb = document.getElementById('newBranchBtn');
  if (nb) nb.addEventListener('click', async function () { var name = document.getElementById('newBranch').value.trim(); if (!name) return; var j = await syncPost('create', { name: name }); if (j && j.ok) { syncToast('created ' + name, true); loadSync(); } else if (j) syncToast(j.output || 'create failed', false); });
  var pullBtn = document.getElementById('pullBtn');
  if (pullBtn) pullBtn.addEventListener('click', function () {
    var rebase = document.getElementById('rebaseChk').checked;
    if (rebase) {
      openSheet('git pull --rebase', 'Replays your local commits on top of the upstream. A conflict pauses it — you can then abort.', async function () { closeSheet(); await doPull('rebase'); });
    } else { doPull('ff'); }
  });
  var abortBtn = document.getElementById('abortBtn');
  if (abortBtn) abortBtn.addEventListener('click', async function () { var j = await syncPost('abort'); if (j) syncToast('aborted', true); loadSync(); });
  var pushBtn = document.getElementById('pushBtn');
  if (pushBtn) pushBtn.addEventListener('click', function () { doPush(false); });
  var fpb = document.getElementById('forcePushBtn');
  if (fpb) fpb.addEventListener('click', function () {
    var rem = (s && s.remote) || 'origin';
    lkConfirm({
      level: 'type', danger: true, heading: 'Overwrite ' + rem + '?', match: 'overwrite',
      detail: 'Force-pushes this branch and REPLACES the remote’s history. Anything on the remote that isn’t in this repo is lost. Use this to publish over a different or old repo. Type "overwrite" to confirm.',
      confirmLabel: 'Force push', onConfirm: function () { doPush(true); },
    });
  });
  var pop = document.getElementById('populateBtn');
  if (pop) pop.addEventListener('click', function () {
    lkConfirm({
      heading: 'Pull remote into this repo?', confirmLabel: 'Pull in',
      detail: 'Fetches the remote and checks out its branch here, filling this empty repo with the remote’s content.',
      onConfirm: doPopulate,
    });
  });
  var umb = document.getElementById('urlMaskBtn');
  if (umb) umb.addEventListener('click', function () { SYNC.showUrl = !SYNC.showUrl; renderSyncStatus(SYNC.last); wireSync(SYNC.last); });
  var dry = document.getElementById('dryRun');
  if (dry) dry.addEventListener('change', function () { SYNC.dry = this.checked; });
  var tw = document.getElementById('testWriteBtn');
  if (tw) tw.addEventListener('click', async function () {
    tw.disabled = true; var old = tw.textContent; tw.textContent = 'checking…';
    var j = await syncPost('test-write', {});
    tw.disabled = false; tw.textContent = old;
    syncToast(j ? (j.ok ? 'push access OK (dry run)' : (j.message || 'no push access')) : 'failed', j && j.ok);
  });
  wireAuths();
  wireConnect();
  var setup = document.getElementById('connSetupBtn');
  if (setup) setup.addEventListener('click', function () {
    openConnModal(SYNC.last && SYNC.last.remote ? parseRemoteUrl(SYNC.last.url) : null);
  });
  wireInfoButtons();
}

function _v(id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; }

function wireAuths() {
  function rerender() { renderSyncStatus(SYNC.last); wireSync(SYNC.last); }
  var add = document.getElementById('authAddBtn');
  if (add) add.addEventListener('click', function () { SYNC.authEdit = 'new'; rerender(); });
  var cancel = document.getElementById('authCancelBtn');
  if (cancel) cancel.addEventListener('click', function () { SYNC.authEdit = null; rerender(); });
  var save = document.getElementById('authSaveBtn');
  if (save) save.addEventListener('click', async function () {
    var body = {
      id: SYNC.authEdit === 'new' ? undefined : SYNC.authEdit,
      label: _v('al_label'), host: _v('al_host'), username: _v('al_user'), token: _v('al_token'),
      name: _v('al_name'), email: _v('al_email'), method: 'https',
      scopes: _v('al_scopes').split(',').map(function (x) { return x.trim(); }).filter(Boolean)
    };
    if (!body.label) { syncToast('label required', false); return; }
    var j = await syncPost('auth-save', body);
    if (j && j.ok) { SYNC.auths = j.auths || []; SYNC.authEdit = null; syncToast('login saved', true); rerender(); }
    else syncToast((j && j.error) || 'failed', false);
  });
  document.querySelectorAll('[data-authedit]').forEach(function (b) {
    b.addEventListener('click', function () { SYNC.authEdit = parseInt(b.getAttribute('data-authedit'), 10); rerender(); });
  });
  document.querySelectorAll('[data-authmask]').forEach(function (b) {
    b.addEventListener('click', function () { var id = parseInt(b.getAttribute('data-authmask'), 10); SYNC.authShow[id] = !SYNC.authShow[id]; rerender(); });
  });
  document.querySelectorAll('[data-authdel]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = parseInt(b.getAttribute('data-authdel'), 10);
      openSheet('delete login', 'Removes this saved login from the device.', async function () {
        closeSheet(); var j = await syncPost('auth-delete', { id: id });
        if (j && j.ok) { SYNC.auths = j.auths || []; rerender(); }
      });
    });
  });
  document.querySelectorAll('[data-authuse]').forEach(function (b) {
    b.addEventListener('click', function () {
      var id = parseInt(b.getAttribute('data-authuse'), 10);
      var a = (SYNC.auths || []).filter(function (x) { return x.id === id; })[0];
      if (!a) return;
      openConnModal({ method: 'https', host: a.host, user: a.username, token: a.token, label: a.label });
    });
  });
}

function wireConnect() {
  var box = document.getElementById('connectBox');
  if (!box) return;
  box.querySelectorAll('.conn-tab').forEach(function (t) {
    t.addEventListener('click', function () {
      SYNC.method = t.getAttribute('data-method');
      SYNC.prefill = null;
      box.innerHTML = syncConnectHTML(SYNC.last);
      wireConnect();
    });
  });
  ['cf_host', 'cf_owner', 'cf_repo', 'cf_user', 'cf_token', 'cf_url'].forEach(function (id) {
    var i = document.getElementById(id);
    if (i) i.addEventListener('input', updateConnPreview);
  });
  updateConnPreview();
  var tb = document.getElementById('connTestBtn');
  if (tb) tb.addEventListener('click', async function () {
    var u = buildRemoteUrl();
    if (!u) { connResult('fill the required fields first', false); return; }
    tb.disabled = true; var old = tb.textContent; tb.textContent = 'testing…';
    var j = await syncPost('test', { url: u });
    tb.disabled = false; tb.textContent = old;
    connResultByKind(j);
  });
  var sb = document.getElementById('connSaveBtn');
  if (sb) sb.addEventListener('click', async function () {
    var u = buildRemoteUrl();
    if (!u) { connResult('fill the required fields first', false); return; }
    var name = connVal('rname') || 'origin';
    // optionally remember this login (HTTPS) for reuse, scoped to this repo
    var saveChk = document.getElementById('cf_savelogin');
    if (saveChk && saveChk.checked && SYNC.method === 'https') {
      var owner = connVal('owner'), repo = connVal('repo').replace(/\.git$/, '');
      await syncPost('auth-save', {
        label: (_v('cf_savelabel') || (connVal('user') + '@' + (connVal('host') || 'github.com'))),
        method: 'https', host: connVal('host') || 'github.com', username: connVal('user'),
        token: connVal('token'), scopes: (owner && repo) ? [owner + '/' + repo] : []
      });
    }
    sb.disabled = true; var old = sb.textContent; sb.textContent = 'connecting…';
    var j = await syncPost('connect', { url: u, name: name });
    sb.disabled = false; sb.textContent = old;
    if (j && j.ok && (j.stage === 'linked')) { syncToast('connected — tracking ' + j.upstream, true); closeConnModal(); loadSync(); }
    else if (j && j.ok && j.stage === 'nobranch') { connResult(j.message || 'fetched; push to publish', true); SYNC.prefill = null; loadSync(); }
    else if (j && j.ok) { syncToast('saved', true); closeConnModal(); loadSync(); }
    else if (j) connResultByKind(j);
  });
  var gb = document.getElementById('sshGenBtn');
  if (gb) gb.addEventListener('click', async function () {
    gb.disabled = true; var old = gb.textContent; gb.textContent = 'working…';
    var j = await syncPost('ssh-keygen', {});
    gb.disabled = false; gb.textContent = old;
    var pk = document.getElementById('sshPubkey');
    if (!pk) return;
    if (j && j.ok) {
      pk.innerHTML = '<p class="gmuted">Public key — copy and add at GitHub → SSH keys:</p>'
        + '<textarea class="conn-pub mono" readonly rows="3">' + esc(j.pubkey) + '</textarea>'
        + '<div class="conn-actions"><button class="clink" id="sshCopyBtn">copy</button></div>';
      var cb = document.getElementById('sshCopyBtn');
      if (cb) cb.addEventListener('click', function () {
        var ta = pk.querySelector('.conn-pub');
        try { navigator.clipboard.writeText(j.pubkey); syncToast('copied', true); }
        catch (e) { if (ta) ta.select(); syncToast('select and copy', true); }
      });
    } else {
      pk.innerHTML = '<span class="syncbad">' + esc((j && j.output) || 'failed') + '</span>';
    }
  });
}

async function doPull(mode) {
  var body = { mode: mode };
  if (SYNC.dry) body.dry = true;
  var j = await syncPost('pull', body);
  if (!j) return;
  if (j.dry) { syncToast(j.output || 'dry run done', j.ok); return; }
  if (j.ok) { syncToast('pulled', true); loadSync(); }
  else { syncToast(j.output || 'pull failed', false); var a = document.getElementById('abortBtn'); if (a) a.hidden = false; }
}

async function doPush(force) {
  var tag = document.getElementById('pushTag') ? document.getElementById('pushTag').value.trim() : '';
  var body = {};
  if (tag) body.tag = tag;
  if (SYNC.dry) body.dry = true;
  if (force) body.force = true;
  var j = await syncPost('push', body);
  if (!j) return;
  if (j.dry) { syncToast(j.output || 'dry run done', j.ok); return; }
  if (j.ok) {
    var msg = force ? 'force-pushed — remote overwritten' : 'pushed';
    if (j.tag) msg += j.tagOk ? (' · tagged ' + j.tag) : (' · push ok, tag failed');
    syncToast(msg, true);
    loadSync();
  } else { syncToast(j.output || 'push failed', false); }
}

async function doPopulate() {
  var j = await syncPost('populate', {});
  if (!j) return;
  if (j.ok) { syncToast('pulled remote in' + (j.branch ? ' (' + j.branch + ')' : ''), true); loadSync(); }
  else { syncToast(j.message || j.output || 'could not pull remote in', false); }
}

async function loadSync() {
  var s = await fetch('/api/sync/status').then(function (r) { return r.json(); }).catch(function () { return null; });
  var br = await fetch('/api/sync/branches').then(function (r) { return r.json(); }).catch(function () { return { local: [], remote: [] }; });
  var al = await syncPost('auth-list');
  SYNC.auths = (al && al.auths) || [];
  var inc = { commits: [] }, out = { commits: [] };
  if (s && s.repo && s.upstream) {
    inc = await fetch('/api/sync/incoming').then(function (r) { return r.json(); }).catch(function () { return { commits: [] }; });
    out = await fetch('/api/sync/outgoing').then(function (r) { return r.json(); }).catch(function () { return { commits: [] }; });
  }
  renderSyncStatus(s, br || { local: [], remote: [] }, inc.commits || [], out.commits || []);
  wireSync(s);
}

// ===== Docs overlay (read-only, in-app) =====
function mdRender(src) {
  function e(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }
  function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function inline(t) {
    t = e(t);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, txt, url) {
      if (/^https?:\/\//.test(url)) return '<a href="' + url.replace(/"/g, '') + '" target="_blank" rel="noopener">' + txt + '</a>';
      return '<a href="#" data-doclink="' + url.replace(/"/g, '&quot;') + '">' + txt + '</a>';
    });
    return t;
  }
  var lines = src.split('\n'), out = [], inCode = false, codeBuf = [], list = null;
  function closeList() { if (list) { out.push('</' + list + '>'); list = null; } }
  for (var i = 0; i < lines.length; i++) {
    var ln = lines[i];
    if (/^```/.test(ln)) { if (inCode) { out.push('<pre><code>' + e(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; inCode = false; } else { closeList(); inCode = true; } continue; }
    if (inCode) { codeBuf.push(ln); continue; }
    var h = ln.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push('<h' + h[1].length + ' id="' + slug(h[2]) + '">' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
    if (/^\s*[-*]\s+/.test(ln)) { if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; } out.push('<li>' + inline(ln.replace(/^\s*[-*]\s+/, '')) + '</li>'); continue; }
    if (/^\s*\d+\.\s+/.test(ln)) { if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; } out.push('<li>' + inline(ln.replace(/^\s*\d+\.\s+/, '')) + '</li>'); continue; }
    if (/^\s*>\s?/.test(ln)) { closeList(); out.push('<blockquote>' + inline(ln.replace(/^\s*>\s?/, '')) + '</blockquote>'); continue; }
    if (/^\s*---\s*$/.test(ln)) { closeList(); out.push('<hr>'); continue; }
    if (/^\s*$/.test(ln)) { closeList(); continue; }
    closeList(); out.push('<p>' + inline(ln) + '</p>');
  }
  if (inCode) out.push('<pre><code>' + e(codeBuf.join('\n')) + '</code></pre>');
  closeList();
  return out.join('\n');
}
async function openDocs(path, anchor) {
  var ov = document.getElementById('docsOverlay'); if (!ov) return;
  ov.hidden = false;
  var body = document.getElementById('docsBody'), title = document.getElementById('docsTitle');
  if (!path) {
    var j = await fetch('/api/docs').then(function (r) { return r.json(); }).catch(function () { return { docs: [] }; });
    title.textContent = 'Docs';
    body.innerHTML = '<ul class="docs-index">' + (j.docs || []).map(function (d) { return '<li><a href="#" data-doclink="' + d.path + '">' + esc(d.title) + '</a></li>'; }).join('') + '</ul>'
      + '<p class="gmuted">Read-only here — edit the files directly via the Files tool or your editor.</p>';
    wireDocLinks(body); return;
  }
  title.textContent = path;
  body.innerHTML = '<div class="gmuted">loading…</div>';
  var jd = await fetch('/api/docs?path=' + encodeURIComponent(path)).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!jd || jd.error) { body.innerHTML = '<div class="gmuted">could not load ' + esc(path) + '</div>'; return; }
  body.innerHTML = '<p class="gmuted docs-note">Read-only view — edit the file directly to change it.</p>' + mdRender(jd.text);
  wireDocLinks(body);
  if (anchor) { var t = document.getElementById(anchor); if (t) { t.scrollIntoView(); return; } }
  body.scrollTop = 0;
}
function wireDocLinks(scope) {
  scope.querySelectorAll('[data-doclink]').forEach(function (a) {
    a.addEventListener('click', function (ev) { ev.preventDefault(); var p = a.getAttribute('data-doclink'), anc = ''; if (p.indexOf('#') >= 0) { anc = p.split('#')[1]; p = p.split('#')[0]; } openDocs(p, anc); });
  });
}
function closeDocs() { var ov = document.getElementById('docsOverlay'); if (ov) ov.hidden = true; }

// ===== Info popovers (modeless; one pinned + one transient; scroll with page) =====
var INFO = { pinned: null, transient: null };
var INFO_TEXT = {
  token: { title: 'Access token', body: 'Used as your password over HTTPS. A GitHub <strong>fine-grained</strong> token (repository → Contents: read &amp; write) or a <strong>classic</strong> token with the <code>repo</code> scope. Stored on this device only, masked here. <em>Format:</em> <code>github_pat_…</code> or <code>ghp_…</code>.', doc: { path: 'docs/SETUP.md', anchor: 'method-1-https-token-simplest' } },
  owner: { title: 'Owner / user', body: 'The account or organization that owns the repo — the part before the slash in <code>owner/repo</code>. For <code>github.com/octocat/layaider</code> the owner is <code>octocat</code>.' },
  repo: { title: 'Repository', body: 'The repository name — the part after the slash. For <code>github.com/octocat/layaider</code> it is <code>layaider</code>. Don\u2019t add <code>.git</code>; Layaider does.' },
  host: { title: 'Host', body: 'The git host. <code>github.com</code> for GitHub; change it for GitHub Enterprise, GitLab, Bitbucket, or a private server.' },
  rname: { title: 'Remote name', body: 'The local name git gives this remote. <code>origin</code> is the conventional default, but you can set your own — handy when a repo has more than one remote.' },
  upstream: { title: 'Upstream (tracking)', body: 'The remote branch your branch compares against for ahead/behind. Format <code>REMOTE/BRANCH</code>, e.g. <code>origin/main</code>. A first push can set it for you.' },
  identity: { title: 'Git identity', body: 'The author name and email recorded on your commits. A missing or wrong identity can get pushes rejected or mis-attributed. Stored in git config on this device.' },
  ssh: { title: 'SSH key', body: 'A key pair on this device; you add the <strong>public</strong> key to GitHub once, and no token is needed afterwards. The private key never leaves the device.', doc: { path: 'docs/SETUP.md', anchor: 'method-2-ssh-key-no-token-good-for-repeated-use' } },
  // --- general registry: keys reused across Status / Git / other tabs ---
  changes: { title: 'Working changes', body: '<code>staged</code> = ready to commit · <code>mod</code> = tracked files changed but not staged · <code>new</code> = untracked files git isn’t following yet. Stage and commit on the <strong>Git</strong> tab.' },
  aborigin: { title: 'vs origin', body: 'How far your branch is from its upstream: <code>↑N</code> commits ahead (yours, not pushed) and <code>↓N</code> behind (theirs, not pulled). Reconcile on the <strong>Sync</strong> tab.' },
  stub: { title: 'Possible stubs', body: 'Files that look like placeholders — very short, or matching stub markers — which may be unfinished work accidentally committed. Review them before committing or restore a fuller version from history.' },
  aiderlock: { title: 'aider lock', body: 'While an aider session is running, file and git writes are locked (HTTP 423) so the two can’t clobber each other. The lock clears when aider exits.' }
};
function closeInfo(which) {
  var s = INFO[which];
  if (s && s.el) {
    if (s.el._repos) { window.removeEventListener('scroll', s.el._repos, true); window.removeEventListener('resize', s.el._repos); }
    if (s.el.parentNode) s.el.parentNode.removeChild(s.el);
  }
  INFO[which] = null;
}
// Position a popover against its anchor: clamp horizontally, and flip above the
// anchor when it would overflow the viewport bottom.
function positionInfo(el, anchorEl) {
  var r = anchorEl.getBoundingClientRect();
  var w = el.offsetWidth || 300, h = el.offsetHeight || 0;
  var vw = document.documentElement.clientWidth, vh = window.innerHeight || document.documentElement.clientHeight;
  var left = r.left + window.scrollX;
  var maxLeft = window.scrollX + vw - 10 - w;
  if (left > maxLeft) left = maxLeft;
  if (left < window.scrollX + 8) left = window.scrollX + 8;
  var top = (h && (r.bottom + 6 + h > vh) && (r.top - 6 - h > 0)) ? (r.top - 6 - h) : (r.bottom + 6);
  el.style.top = (top + window.scrollY) + 'px';
  el.style.left = left + 'px';
}
function buildInfoEl(key, pinned) {
  var d = INFO_TEXT[key] || { title: key, body: '' };
  var el = document.createElement('div');
  el.className = 'ipop' + (pinned ? ' pinned' : '');
  el.innerHTML = '<div class="ipop-h"><span class="ipop-t">' + esc(d.title) + '</span>'
    + '<button class="ipop-pin">' + (pinned ? 'unpin' : 'pin') + '</button>'
    + '<button class="ipop-x" aria-label="close">✕</button></div>'
    + '<div class="ipop-b">' + d.body + '</div>'
    + (d.doc ? '<div class="ipop-f"><a href="#" class="ipop-doc">full docs →</a></div>' : '');
  el.querySelector('.ipop-x').addEventListener('click', function () { closeInfo(pinned ? 'pinned' : 'transient'); });
  el.querySelector('.ipop-pin').addEventListener('click', function () {
    var anc = el._anchor;
    if (pinned) { closeInfo('pinned'); openInfoEl(key, anc, false); }
    else { closeInfo('transient'); openInfoEl(key, anc, true); }
  });
  if (d.doc) el.querySelector('.ipop-doc').addEventListener('click', function (ev) { ev.preventDefault(); openDocs(d.doc.path, d.doc.anchor); });
  return el;
}
function openInfoEl(key, anchorEl, pinned) {
  closeInfo(pinned ? 'pinned' : 'transient');
  var el = buildInfoEl(key, pinned); el._anchor = anchorEl;
  document.body.appendChild(el);
  INFO[pinned ? 'pinned' : 'transient'] = { key: key, el: el };
  positionInfo(el, anchorEl);
  // Track scroll (capture phase catches scrolling ancestors like the modal body)
  // and resize so the popover stays glued to its anchor.
  var repos = function () { positionInfo(el, anchorEl); };
  el._repos = repos;
  window.addEventListener('scroll', repos, true);
  window.addEventListener('resize', repos);
}
function openInfo(key, anchorEl) { openInfoEl(key, anchorEl, false); }
function wireInfoButtons(scope) {
  (scope || document).querySelectorAll('[data-info]').forEach(function (b) {
    if (b._wired) return; b._wired = true;
    b.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); openInfo(b.getAttribute('data-info'), b); });
  });
}
function iBtn(key) { return '<button class="i-btn" data-info="' + key + '" aria-label="info" title="what is this?">\u24D8</button>'; }

// ===== Stepped connection modal =====
function parseRemoteUrl(u) {
  if (!u) return null;
  var m = u.match(/^https?:\/\/(?:([^:@\/]+)(?::([^@\/]+))?@)?([^\/]+)\/(.+?)\/([^\/]+?)(?:\.git)?\/?$/);
  if (m) return { method: 'https', user: m[1] || '', token: m[2] || '', host: m[3], owner: m[4], repo: m[5] };
  var s = u.match(/^git@([^:]+):(.+?)\/([^\/]+?)(?:\.git)?\/?$/);
  if (s) return { method: 'ssh', host: s[1], owner: s[2], repo: s[3] };
  return null;
}
function syncFormFor(method, s) { return method === 'ssh' ? syncFormSsh(s) : method === 'manual' ? syncFormManual() : syncFormHttps(); }
function step1HTML() {
  var auths = SYNC.auths || [];
  var saved = auths.length ? '<div class="wz-saved"><div class="wz-sub">or use a saved login</div>' + auths.map(function (a) {
    return '<button class="wz-auth" data-wzauth="' + a.id + '"><strong>' + esc(a.label) + '</strong><small>' + esc(a.host || '') + (a.username ? (' · ' + esc(a.username)) : '') + '</small></button>';
  }).join('') + '</div>' : '';
  return '<div class="wz-step"><div class="wz-stepn">Step 1 of 2 · choose how to connect</div>'
    + '<div class="wz-methods">'
    + '<button class="wz-method" data-wzm="https"><strong>HTTPS + token ' + iBtn('token') + '</strong><small>Simplest. Paste a personal access token. Best if you\u2019re not sure.</small></button>'
    + '<button class="wz-method" data-wzm="ssh"><strong>SSH key ' + iBtn('ssh') + '</strong><small>No token. Generate a key here, add it to GitHub once.</small></button>'
    + '<button class="wz-method" data-wzm="manual"><strong>Manual URL</strong><small>Paste a full remote URL for any host.</small></button>'
    + '</div>'
    + '<div class="wz-or">or paste a repo URL to autofill the fields</div>'
    + '<div class="remote-edit"><input id="wzAuto" class="hinput" placeholder="https://github.com/OWNER/REPO or git@github.com:OWNER/REPO.git" autocapitalize="off" autocorrect="off" spellcheck="false"><button class="clink" id="wzAutoBtn">autofill</button></div>'
    + saved
    + '</div>';
}
function syncConnectFormOnly() { return syncFormFor(SYNC.method, SYNC.last || {}) + '<div class="conn-result" id="connResult"></div>'; }
function renderConnModal() {
  closeInfo('transient'); closeInfo('pinned');
  var body = document.getElementById('connModalBody'); if (!body) return;
  var title = document.getElementById('connModalTitle');
  if (SYNC.modalStep === 1) {
    title.textContent = 'Connect a remote';
    body.innerHTML = step1HTML();
    wireStep1();
  } else {
    title.textContent = (SYNC.method === 'ssh' ? 'SSH key' : SYNC.method === 'manual' ? 'Manual URL' : 'HTTPS + token') + ' setup';
    body.innerHTML = '<div class="wz-stepn">Step 2 of 2 · <button class="clink" id="wzBack">← back</button></div>'
      + '<div id="connectBox" class="conn">' + syncConnectFormOnly() + '</div>';
    wireConnect();
    wireInfoButtons(body);
    var bk = document.getElementById('wzBack'); if (bk) bk.addEventListener('click', function () { SYNC.modalStep = 1; renderConnModal(); });
  }
}
function wireStep1() {
  var body = document.getElementById('connModalBody');
  body.querySelectorAll('[data-wzm]').forEach(function (b) {
    b.addEventListener('click', function () { SYNC.method = b.getAttribute('data-wzm'); SYNC.prefill = null; SYNC.modalStep = 2; renderConnModal(); });
  });
  body.querySelectorAll('[data-wzauth]').forEach(function (b) {
    b.addEventListener('click', function () {
      var a = (SYNC.auths || []).filter(function (x) { return x.id === parseInt(b.getAttribute('data-wzauth'), 10); })[0];
      if (!a) return;
      SYNC.method = 'https'; SYNC.prefill = { host: a.host, user: a.username, token: a.token, label: a.label };
      SYNC.modalStep = 2; renderConnModal();
    });
  });
  var ab = document.getElementById('wzAutoBtn');
  if (ab) ab.addEventListener('click', function () {
    var p = parseRemoteUrl(document.getElementById('wzAuto').value.trim());
    if (!p) { syncToast('couldn\u2019t parse that URL', false); return; }
    SYNC.method = p.method; SYNC.prefill = p; SYNC.modalStep = 2; renderConnModal();
  });
  wireInfoButtons(body);
}
var _connModalOpener = null;
function openConnModal(prefill) {
  SYNC.prefill = prefill || null;
  if (prefill && prefill.method) SYNC.method = prefill.method;
  SYNC.modalStep = prefill ? 2 : 1;
  var m = document.getElementById('connModal'); if (!m) return;
  var titleEl = document.getElementById('connModalTitle');
  if (titleEl) titleEl.textContent = prefill ? 'Edit connection' : 'Connect a remote';
  _connModalOpener = document.activeElement;
  m.hidden = false; renderConnModal();
  // Move focus into the modal so keyboard users land inside it, not behind it.
  setTimeout(function () { var f = m.querySelector('input,select,button:not(.cmodal-x)'); if (f) { try { f.focus(); } catch (_) {} } }, 30);
}
function closeConnModal() {
  closeInfo('transient'); closeInfo('pinned');
  var m = document.getElementById('connModal'); if (m) m.hidden = true; SYNC.prefill = null;
  if (_connModalOpener && _connModalOpener.focus) { try { _connModalOpener.focus(); } catch (_) {} }
  _connModalOpener = null;
}

(function () {
  var x = document.getElementById('connModalX'); if (x) x.addEventListener('click', closeConnModal);
  var dx = document.getElementById('docsX'); if (dx) dx.addEventListener('click', closeDocs);
  var di = document.getElementById('docsIndexBtn'); if (di) di.addEventListener('click', function () { openDocs(null); });
})();

function syncEnter() { loadSync(); }

// ===== Files tool =====
var FB = {
  path: '', show: false, sort: 'name', sortDir: 1, view: 'list', mode: 'name', filter: '',
  entries: [], loaded: false, timer: null,
  flt: { status: 'all', ignored: 'all', stub: false },
  tree: {}, // dirpath -> { loaded, open, entries }
};

// True when any meta filter (beyond name) narrows the listing — drives the badge.
function fltActiveCount() {
  var n = 0;
  if (FB.flt.status !== 'all') n++;
  if (FB.flt.ignored !== 'all') n++;
  if (FB.flt.stub) n++;
  if (FB.show) n++;
  return n;
}

// Apply the meta filter (status / ignored / stub) + the name filter to a level's
// entries. In list view (keepDirs falsy) folders are filtered like everything
// else — it's the current directory only. In tree view (keepDirs truthy) folders
// always survive name/status/stub filters so the path to a match stays reachable;
// only "hide ignored" can drop a folder. Files are filtered fully in both modes.
function applyMetaFilter(items, keepDirs) {
  var f = FB.filter.toLowerCase();
  var st = FB.flt.status, ig = FB.flt.ignored, stub = FB.flt.stub;
  return items.filter(function (e) {
    if (e.dir) {
      if (keepDirs) return !(ig === 'hide' && e.ignored);
      if (f && e.name.toLowerCase().indexOf(f) < 0) return false;
      if (ig === 'only' && !e.ignored) return false;
      if (ig === 'hide' && e.ignored) return false;
      return st === 'all' && !stub; // status/stub don't apply to folders
    }
    if (f && e.name.toLowerCase().indexOf(f) < 0) return false;
    if (ig === 'only' && !e.ignored) return false;
    if (ig === 'hide' && e.ignored) return false;
    if (stub && !e.stub) return false;
    if (st !== 'all') {
      var s = e.status || 'clean';
      if (st === 'clean') { if (e.status) return false; }
      else if (st === 'staged') { if (s.indexOf('staged') < 0) return false; }
      else if (st === 'modified') { if (s.indexOf('modified') < 0) return false; }
      else if (s !== st) return false;
    }
    return true;
  });
}

var STATUS_RANK = { 'staged+modified': 0, staged: 1, modified: 2, untracked: 3 };
function sortEntries(items) {
  var dir = FB.sortDir;
  return items.slice().sort(function (a, b) {
    if (a.dir !== b.dir) return a.dir ? -1 : 1; // folders first, always
    var r;
    if (FB.sort === 'size') r = (a.size || 0) - (b.size || 0);
    else if (FB.sort === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
    else if (FB.sort === 'status') r = (STATUS_RANK[a.status] != null ? STATUS_RANK[a.status] : 9) - (STATUS_RANK[b.status] != null ? STATUS_RANK[b.status] : 9);
    else r = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : (a.name.toLowerCase() > b.name.toLowerCase() ? 1 : 0);
    if (r === 0 && FB.sort !== 'name') r = a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    return r * dir;
  });
}

function filesToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'files' }); }

async function filesPost(action, body) {
  try {
    var res = await fetch('/api/files/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    var j = await res.json().catch(function () { return {}; });
    if (res.status === 423) { filesToast('locked — aider is running', false); return null; }
    if (!res.ok) { filesToast('failed: ' + (j.error || j.output || res.status), false); return null; }
    return j;
  } catch (e) { filesToast('server error', false); return null; }
}

function filesGitPost(action, body) { return lkApi('git/' + action, body, { source: 'files' }); }

function sizeStr(n) { if (n == null) return ''; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' K'; return (n / 1048576).toFixed(1) + ' M'; }
function statusShort(s) { return s === 'untracked' ? 'U' : s === 'modified' ? 'M' : s === 'staged' ? 'S' : s === 'staged+modified' ? 'S+M' : s; }
function statusCls(s) { return s === 'untracked' ? 'warn' : (s && s.indexOf('staged') >= 0) ? 'ok' : 'mod'; }

async function fetchLevel(path) {
  var url = '/api/files/list?path=' + encodeURIComponent(path) + '&show=' + (FB.show ? '1' : '0');
  var d = await fetch(url).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!d || d.error) return { error: (d && d.error) || 'no repo yet' };
  return { entries: d.entries || [] };
}

function fileRetry() {
  if (location.hash === '#files' && FB.mode === 'name') FB.timer = setTimeout(loadFiles, 2000);
}

async function loadFiles() {
  clearTimeout(FB.timer);
  renderCrumb();
  if (FB.view === 'tree') { FB.tree = {}; await loadTreeLevel(''); return; }
  var el = document.getElementById('fileList');
  var r = await fetchLevel(FB.path);
  if (r.error) {
    FB.loaded = false;
    el.className = '';
    el.innerHTML = '<div class="gmuted">' + esc(r.error) + ' — rechecking…</div>';
    fileRetry();
    return;
  }
  FB.loaded = true;
  FB.entries = r.entries;
  renderFileList();
}

async function loadTreeLevel(path) {
  var node = FB.tree[path];
  if (node && node.loaded) { node.open = true; renderTree(); return; }
  if (!node) node = FB.tree[path] = { loaded: false, open: true, entries: [] };
  var r = await fetchLevel(path);
  if (r.error) {
    if (path === '') {
      FB.loaded = false;
      var el = document.getElementById('fileList');
      el.className = '';
      el.innerHTML = '<div class="gmuted">' + esc(r.error) + ' — rechecking…</div>';
      fileRetry();
    }
    return;
  }
  node.loaded = true; node.open = true; node.entries = r.entries;
  FB.loaded = true;
  renderTree();
}

function toggleTreeDir(path) {
  var node = FB.tree[path];
  if (node && node.loaded) { node.open = !node.open; renderTree(); }
  else loadTreeLevel(path);
}

function fileBadges(e) {
  var b = '';
  if (e.status) b += '<span class="fbadge ' + statusCls(e.status) + '">' + statusShort(e.status) + '</span>';
  if (e.stub) b += '<span class="fbadge stub">stub</span>';
  if (e.ignored) b += '<span class="fbadge ign">ign</span>';
  return b;
}

function emptyMsg() { return (fltActiveCount() || FB.filter) ? 'no matches' : 'empty'; }

function renderTree() {
  var el = document.getElementById('fileList');
  el.className = 'fl-tree';
  var rows = [];
  function walk(path, depth) {
    var node = FB.tree[path];
    if (!node || !node.loaded) return;
    sortEntries(applyMetaFilter(node.entries, true)).forEach(function (e) {
      var pad = ' style="padding-left:' + (12 + depth * 17) + 'px"';
      if (e.dir) {
        var child = FB.tree[e.path];
        var open = !!(child && child.open && child.loaded);
        rows.push('<button class="frow dir ftnode" data-tdir="' + encodeURIComponent(e.path) + '"' + pad + '><span class="fic tchev' + (open ? ' open' : '') + '">▸</span><span class="fname">' + esc(e.name) + '</span>' + (e.ignored ? '<span class="fbadge ign">ign</span>' : '') + '</button>');
        if (open) walk(e.path, depth + 1);
      } else {
        rows.push('<button class="frow file ftnode" data-file="' + encodeURIComponent(e.path) + '"' + pad + '><span class="fic">·</span><span class="fname">' + esc(e.name) + '</span>' + fileBadges(e) + '<span class="fsize">' + sizeStr(e.size) + '</span></button>');
      }
    });
  }
  walk('', 0);
  if (!rows.length) { el.innerHTML = '<div class="gmuted">' + emptyMsg() + '</div>'; return; }
  el.innerHTML = rows.join('');
  el.querySelectorAll('.frow.dir').forEach(function (b) { b.addEventListener('click', function () { toggleTreeDir(decodeURIComponent(b.dataset.tdir)); }); });
  el.querySelectorAll('.frow.file').forEach(function (b) { b.addEventListener('click', function () { openWorkingFile(decodeURIComponent(b.dataset.file)); }); });
}

async function doGrep(qstr) {
  var el = document.getElementById('fileList');
  el.className = '';
  if (!qstr) { el.innerHTML = '<div class="gmuted">type to search file contents…</div>'; return; }
  el.innerHTML = '<div class="gmuted">searching…</div>';
  var d = await fetch('/api/files/grep?q=' + encodeURIComponent(qstr)).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!d) { el.innerHTML = '<div class="gmuted">search failed</div>'; return; }
  var matches = d.matches || [];
  if (!matches.length) { el.innerHTML = '<div class="gmuted">no matches</div>'; return; }
  el.innerHTML = matches.map(function (m) {
    var hits = m.hits.map(function (h) {
      return '<button class="grhit" data-file="' + encodeURIComponent(m.file) + '" data-line="' + h.line + '"><span class="grln">' + h.line + '</span><span class="grtext">' + esc(h.text) + '</span></button>';
    }).join('');
    return '<div class="grfile"><div class="grname">' + esc(m.file) + ' <span class="grcount">' + m.hits.length + '</span></div>' + hits + '</div>';
  }).join('') + (d.truncated ? '<div class="gmuted">results truncated</div>' : '');
  el.querySelectorAll('.grhit').forEach(function (b) {
    b.addEventListener('click', function () { openWorkingFile(decodeURIComponent(b.dataset.file), parseInt(b.dataset.line, 10)); });
  });
}

function filesSearch() {
  if (FB.mode === 'content') doGrep(FB.filter);
  else if (FB.view === 'tree') renderTree();
  else renderFileList();
}

function renderCrumb() {
  var el = document.getElementById('fileCrumb');
  if (FB.mode === 'content' || FB.view === 'tree') { el.innerHTML = ''; return; }
  var parts = FB.path ? FB.path.split('/') : [];
  var html = '<button class="crumbseg" data-cp="">repo</button>';
  var acc = '';
  parts.forEach(function (p) { acc = acc ? acc + '/' + p : p; html += '<span class="crumbsep">/</span><button class="crumbseg" data-cp="' + encodeURIComponent(acc) + '">' + esc(p) + '</button>'; });
  el.innerHTML = html;
  el.querySelectorAll('.crumbseg').forEach(function (b) { b.addEventListener('click', function () { FB.path = decodeURIComponent(b.dataset.cp); loadFiles(); }); });
}

function renderFileList() {
  var el = document.getElementById('fileList');
  el.className = 'fl-list';
  var items = sortEntries(applyMetaFilter(FB.entries));
  var arrow = FB.sortDir < 0 ? '▾' : '▴';
  function hcol(key, label) {
    var on = FB.sort === key;
    return '<button class="fhcol c-' + key + (on ? ' on' : '') + '" data-sort="' + key + '">' + label + (on ? '<span class="sarrow">' + arrow + '</span>' : '') + '</button>';
  }
  var head = '<div class="fhead">' + hcol('name', 'name') + hcol('status', 'status') + hcol('size', 'size') + hcol('mtime', 'modified') + '</div>';
  if (!items.length) { el.innerHTML = head + '<div class="gmuted">' + emptyMsg() + '</div>'; wireHead(el); return; }
  el.innerHTML = head + items.map(function (e) {
    var mt = e.mtime ? ageStr(e.mtime) : '';
    if (e.dir) return '<button class="frow dir flrow" data-dir="' + encodeURIComponent(e.path) + '"><span class="c-name"><span class="fic">▸</span><span class="fname">' + esc(e.name) + '</span>' + (e.ignored ? '<span class="fbadge ign">ign</span>' : '') + '</span><span class="c-status"></span><span class="c-size"></span><span class="c-mtime">' + mt + '</span></button>';
    return '<button class="frow file flrow" data-file="' + encodeURIComponent(e.path) + '"><span class="c-name"><span class="fic">·</span><span class="fname">' + esc(e.name) + '</span></span><span class="c-status">' + fileBadges(e) + '</span><span class="c-size">' + sizeStr(e.size) + '</span><span class="c-mtime">' + mt + '</span></button>';
  }).join('');
  wireHead(el);
  el.querySelectorAll('.frow.dir').forEach(function (b) { b.addEventListener('click', function () { FB.path = decodeURIComponent(b.dataset.dir); loadFiles(); }); });
  el.querySelectorAll('.frow.file').forEach(function (b) { b.addEventListener('click', function () { openWorkingFile(decodeURIComponent(b.dataset.file)); }); });
}

function wireHead(el) {
  el.querySelectorAll('.fhcol').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.dataset.sort;
      if (FB.sort === k) FB.sortDir = -FB.sortDir;
      else { FB.sort = k; FB.sortDir = (k === 'name') ? 1 : -1; }
      renderFileList();
    });
  });
}

function metaEditHTML(file, meta) {
  var ro = [];
  function row(k, v) { if (v === null || v === undefined || v === '') return; ro.push('<div class="mrow"><span class="mk">' + k + '</span><span class="mv">' + esc(String(v)) + '</span></div>'); }
  row('size', meta.size != null ? meta.size + ' bytes' : null);
  row('lines', meta.lines);
  row('modified', meta.mtime ? ageStr(meta.mtime) : null);
  row('status', meta.status || 'clean');
  if (meta.binary) row('binary', 'yes');
  var ig;
  if (!meta.ignored) {
    ig = '<span class="mv mvedit">not ignored <button class="clink" id="fvIgnoreAdd" data-write>add to .gitignore</button></span>';
  } else if (meta.ignoredRepoLevel) {
    ig = '<span class="mv mvedit"><span class="fbadge warn">ignored</span> <button class="clink" id="fvIgnoreRemove" data-write>remove from .gitignore</button> <button class="clink danger" id="fvForceAdd" data-write>force add…</button></span>';
  } else {
    ig = '<span class="mv mvedit"><span class="fbadge warn">ignored by default</span> <span class="gmuted">(' + esc(meta.ignoreSource || 'global') + ')</span> <button class="clink danger" id="fvForceAdd" data-write>force add…</button></span>';
  }
  return '<div class="metasec open"><button class="metahead"><span class="vgchev">▸</span>file details</button><div class="metabody">'
    + ro.join('')
    + '<div class="mrow edit"><span class="mk">gitignore</span>' + ig + '</div>'
    + '<div class="mrow edit"><span class="mk">rename</span><span class="mv mvedit"><input id="fvRename" class="hinput" value="' + esc(file) + '" data-write autocapitalize="off" autocorrect="off" spellcheck="false"><button class="clink" id="fvRenameBtn" data-write>apply</button></span></div>'
    + '<div class="mrow edit"><span class="mk">exec</span><span class="mv"><label class="execlbl"><input type="checkbox" id="fvExec" ' + (meta.exec ? 'checked' : '') + ' data-write> executable</label></span></div>'
    + '<div class="mrow edit"><span class="mk">git</span><span class="mv" id="fvActions"></span></div>'
    + '</div></div>';
}

function fvQuickActionsHTML(meta) {
  var s = meta.status || '';
  var b = [];
  if (s.indexOf('staged') >= 0) b.push('<button class="clink" data-qa="unstage" data-write>unstage</button>');
  if (s === 'untracked' || s.indexOf('modified') >= 0) b.push('<button class="clink" data-qa="stage" data-write>stage</button>');
  if (!b.length) b.push('<span class="gmuted">clean</span>');
  return b.join(' ');
}

async function openWorkingFile(file, gotoLine) {
  var body = document.getElementById('fileBody');
  document.getElementById('fileBack').textContent = '← files';
  document.getElementById('fileTitle').textContent = file.split('/').pop();
  body.innerHTML = '<div class="gmuted">loading…</div>';
  document.getElementById('fileLayer').hidden = false;
  var diff = await fetch('/api/files/diff?path=' + encodeURIComponent(file)).then(function (r) { return r.json(); }).catch(function () { return null; });
  var meta = await fetch('/api/files/meta?path=' + encodeURIComponent(file)).then(function (r) { return r.json(); }).catch(function () { return null; });
  var diffText = (diff && diff.diff) || '';
  FV = {
    work: true, hash: null, file: file, diff: diffText, meta: meta || {}, content: null, binary: false,
    folds: [], outline: [], collapsed: {}, query: '', matches: [], mi: 0, curLine: 0, mode: 'content',
    added: fvParseAdded(diffText), pendingJump: gotoLine || 0,
  };
  body.innerHTML =
    metaEditHTML(file, FV.meta)
    + '<div class="fvtabs"><button class="fvtab" data-fvmode="diff">Diff</button><button class="fvtab current" data-fvmode="content">Content</button></div>'
    + fvToolbarHTML()
    + '<div class="outlinesec" id="fvOutline" hidden></div>'
    + '<div id="fvMain"></div>'
    + '<div class="cdactions" id="fvDanger"></div>';
  wireViewerCommon();
  document.getElementById('fvActions').innerHTML = fvQuickActionsHTML(FV.meta);
  document.getElementById('fvActions').querySelectorAll('[data-qa]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var r = await filesGitPost(b.dataset.qa, { file: file });
      if (r) { filesToast(b.dataset.qa + 'd', true); openWorkingFile(file); if (location.hash === '#files') loadFiles(); }
    });
  });
  document.getElementById('fvRenameBtn').addEventListener('click', async function () {
    var to = document.getElementById('fvRename').value.trim();
    if (!to || to === file) return;
    var r = await filesPost('rename', { path: file, to: to });
    if (r && r.ok) { filesToast('renamed → ' + to, true); openWorkingFile(r.to || to); if (location.hash === '#files') loadFiles(); }
    else if (r) filesToast(r.output || 'rename failed', false);
  });
  document.getElementById('fvExec').addEventListener('change', async function () {
    var r = await filesPost('chmod', { path: file, exec: this.checked });
    if (r && r.ok) filesToast('mode updated', true); else if (r) { filesToast(r.output || 'chmod failed', false); this.checked = !this.checked; }
  });
  var igAdd = document.getElementById('fvIgnoreAdd');
  if (igAdd) igAdd.addEventListener('click', function () {
    function addRule() {
      return filesPost('ignore-add', { path: file }).then(function (r) {
        if (r && r.ok) { filesToast('added to .gitignore', true); openWorkingFile(file); if (location.hash === '#files') loadFiles(); }
        else if (r) filesToast(r.output || 'failed', false);
      });
    }
    var tracked = !!(FV && FV.meta && FV.meta.tracked);
    if (!tracked) { addRule(); return; }
    // A .gitignore rule alone does NOT stop git tracking an already-tracked file,
    // and history/remote still hold it. The correct action is untrack + ignore.
    lkConfirm({
      heading: file + ' is already tracked',
      detail: 'Adding it to .gitignore won\u2019t stop git from tracking it, and if it\u2019s been pushed the remote and past commits still contain it. "Untrack & ignore" runs git rm --cached \u2014 it stops tracking the file and adds the ignore rule, while keeping the file on disk. History and any remote are not rewritten.',
      confirmLabel: 'Untrack & ignore',
      onConfirm: async function () {
        var u = await filesPost('untrack', { path: file });
        if (!u || !u.ok) { if (u) filesToast(u.output || 'untrack failed', false); return; }
        filesToast('untracked ' + file, true);
        await addRule();
      },
    });
  });
  var igRem = document.getElementById('fvIgnoreRemove');
  if (igRem) igRem.addEventListener('click', async function () { var r = await filesPost('ignore-remove', { path: file }); if (r && r.ok) { filesToast('removed from .gitignore', true); openWorkingFile(file); if (location.hash === '#files') loadFiles(); } else if (r) filesToast(r.output || 'failed', false); });
  var fAdd = document.getElementById('fvForceAdd');
  if (fAdd) fAdd.addEventListener('click', function () {
    openSheet('git add -f -- ' + file, 'Force-adds ' + file + ', overriding the ignore rule. Ignored files are usually ignored on purpose (build output, deps, secrets) — only do this for a file you mean to commit.',
      async function () { var r = await filesPost('force-add', { path: file }); if (r && r.ok) { filesToast('force-added ' + file, true); closeSheet(); openWorkingFile(file); if (location.hash === '#files') loadFiles(); } else if (r) filesToast(r.output || 'failed', false); });
  });
  var danger = '';
  if ((FV.meta.status || '').indexOf('modified') >= 0) danger += '<button class="clink danger" id="fvDiscard" data-write>discard changes…</button>';
  danger += '<button class="clink danger" id="fvDelete" data-write>delete file…</button>';
  document.getElementById('fvDanger').innerHTML = danger;
  var disc = document.getElementById('fvDiscard');
  if (disc) disc.addEventListener('click', function () {
    openSheet('git stash push -- ' + file, 'Stashes your working changes to ' + file + '. Recoverable from the stash.',
      async function () { var r = await filesGitPost('discard', { file: file }); if (r) { filesToast('discarded changes', true); closeSheet(); openWorkingFile(file); if (location.hash === '#files') loadFiles(); } });
  });
  document.getElementById('fvDelete').addEventListener('click', function () {
    openSheet('delete ' + file, 'Removes ' + file + '. Tracked files are git-rm\u2019d (recoverable from history); untracked files are gone for good.',
      async function () { var r = await filesPost('delete', { path: file }); if (r && r.ok) { filesToast('deleted ' + file, true); closeSheet(); document.getElementById('fileLayer').hidden = true; if (location.hash === '#files') loadFiles(); } else if (r) filesToast(r.output || 'delete failed', false); });
  });
  fvSetMode('content');
}

// Reflect FB.flt / FB.show / view state into the bar + filter panel chrome.
function updateFltUI() {
  document.querySelectorAll('#fileFilterPanel .fltchips').forEach(function (g) {
    var cur = FB.flt[g.dataset.flt];
    g.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('current', c.dataset.v === cur); });
  });
  var stub = document.getElementById('fltStub'); if (stub) stub.checked = FB.flt.stub;
  var hid = document.getElementById('fltHidden'); if (hid) hid.checked = FB.show;
  var btn = document.getElementById('fileFilterBtn');
  if (btn) { var n = fltActiveCount(); btn.textContent = n ? 'filter · ' + n : 'filter'; btn.classList.toggle('on', !!n); }
  document.querySelectorAll('#fileView .segbtn').forEach(function (b) { b.classList.toggle('current', b.dataset.view === FB.view); });
}

function filesEnter() {
  clearTimeout(FB.timer);
  FB.path = ''; FB.filter = ''; FB.mode = 'name';
  var ff = document.getElementById('fileFilter'); if (ff) { ff.value = ''; ff.placeholder = 'filter by name…'; }
  var fm = document.getElementById('fileMode'); if (fm) fm.value = 'name';
  updateFltUI();
  loadFiles();
}

(function filesWire() {
  var ff = document.getElementById('fileFilter');
  if (!ff) return;
  ff.addEventListener('input', debounce(function () { FB.filter = ff.value.trim(); filesSearch(); }, 250));
  document.getElementById('fileMode').addEventListener('change', function () {
    FB.mode = this.value;
    ff.placeholder = FB.mode === 'content' ? 'search file contents…' : 'filter by name…';
    renderCrumb();
    if (FB.mode === 'content') doGrep(FB.filter); else loadFiles();
  });
  document.querySelectorAll('#fileView .segbtn').forEach(function (b) {
    b.addEventListener('click', function () {
      if (FB.view === b.dataset.view) return;
      FB.view = b.dataset.view;
      updateFltUI();
      if (FB.mode === 'name') loadFiles();
    });
  });
  var fbtn = document.getElementById('fileFilterBtn');
  fbtn.addEventListener('click', function () {
    var p = document.getElementById('fileFilterPanel');
    p.hidden = !p.hidden;
    fbtn.setAttribute('aria-expanded', String(!p.hidden));
  });
  document.querySelectorAll('#fileFilterPanel .fltchips').forEach(function (g) {
    g.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        FB.flt[g.dataset.flt] = c.dataset.v;
        updateFltUI();
        filesSearch();
      });
    });
  });
  document.getElementById('fltStub').addEventListener('change', function () { FB.flt.stub = this.checked; updateFltUI(); filesSearch(); });
  document.getElementById('fltHidden').addEventListener('change', function () { FB.show = this.checked; updateFltUI(); loadFiles(); });
  document.getElementById('fltReset').addEventListener('click', function () {
    FB.flt = { status: 'all', ignored: 'all', stub: false };
    var reload = FB.show; FB.show = false;
    updateFltUI();
    if (reload) loadFiles(); else filesSearch();
  });
  document.getElementById('newBtn').addEventListener('click', function () {
    lkPrompt({
      heading: 'New file or folder',
      detail: 'Created in: ' + (FB.path || 'repo root') + '. End the name with / for a folder.',
      label: 'Name',
      placeholder: 'name or name/',
      confirmLabel: 'Create',
      required: true,
      onSubmit: async function (name) {
        var isDir = /\/$/.test(name);
        name = (name || '').replace(/\/+$/, '').trim();
        if (!name) return;
        var full = FB.path ? FB.path + '/' + name : name;
        var j = await filesPost(isDir ? 'mkdir' : 'new', { path: full });
        if (j && j.ok) { filesToast('created ' + full, true); loadFiles(); } else if (j) filesToast(j.output || 'create failed', false);
      },
    });
  });
  document.getElementById('refreshBtn').addEventListener('click', function () { if (FB.mode === 'content') doGrep(FB.filter); else loadFiles(); });
  document.getElementById('fileBack').addEventListener('click', function () { document.getElementById('fileLayer').hidden = true; });
})();

// ===== Servers tool =====
// (SRV state is declared near the top of the file — see the note there.)

function srvToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'servers' }); }
function serversPost(action, body) { return lkApi('servers/' + action, body, { source: 'servers' }); }
function serversStop() { clearTimeout(SRV.timer); SRV.timer = null; }
function serversEnter() { serversLoad(); }
function srvById(id) { return (SRV.data && SRV.data.servers || []).filter(function (s) { return s.id === id; })[0]; }

async function serversLoad() {
  clearTimeout(SRV.timer);
  var d = await fetch('/api/servers').then(function (r) { return r.json(); }).catch(function () { return null; });
  if (d && !d.error) SRV.data = d;
  renderServers();
  if (location.hash === '#servers') SRV.timer = setTimeout(serversLoad, 2500);
}

function srvStatus(s) {
  var st = s.status || {};
  return { cls: st.up ? (st.health === 'down' ? 'warn' : 'up') : 'down', up: !!st.up, uptime: st.uptime, pid: st.pid, health: st.health };
}
function srvLine(s) {
  var bits = [esc(s.type)];
  if (s.port) bits.push(':' + s.port);
  var st = srvStatus(s);
  if (st.up && st.uptime != null) bits.push(dur(st.uptime));
  if (st.health === 'ok') bits.push('healthy'); else if (st.health === 'down') bits.push('not responding');
  if (s.autostart) bits.push('autostart');
  return bits.join(' · ');
}

function srvCardHTML(s) {
  var st = srvStatus(s);
  var badge = s.self ? '<span class="srv-tag self">this dashboard</span>'
    : s.state === 'managed' ? '<span class="srv-tag managed">managed</span>'
    : '<span class="srv-tag watch">watch</span>';
  var c = '';
  if (s.self) {
    c = '<button class="clink srv-act" data-act="restart-dash">restart dashboard</button>';
  } else if (s.state === 'managed') {
    c += st.up ? '<button class="clink danger srv-act" data-act="stop" data-write>stop</button><button class="clink srv-act" data-act="restart" data-write>restart</button>'
               : '<button class="clink srv-act" data-act="start" data-write>start</button>';
    c += '<button class="clink srv-act" data-act="logs">logs</button>'
       + '<button class="clink srv-act" data-act="edit" data-write>edit</button>'
       + '<button class="clink srv-act" data-act="watch">→ watch</button>'
       + '<button class="clink srv-act" data-act="ignored">ignore</button>'
       + '<button class="clink danger srv-act" data-act="delete" data-write>delete</button>';
  } else {
    c += '<button class="clink srv-act" data-act="managed">manage</button>'
       + '<button class="clink srv-act" data-act="edit" data-write>edit</button>'
       + '<button class="clink srv-act" data-act="ignored">ignore</button>'
       + '<button class="clink danger srv-act" data-act="delete" data-write>delete</button>';
  }
  return '<div class="srv-card" data-id="' + escAttr(s.id) + '">'
    + '<div class="srv-head"><span class="sdot ' + st.cls + '"></span><span class="srv-name">' + esc(s.name) + '</span>' + badge
    + '<span class="gmuted srv-meta">' + srvLine(s) + '</span></div>'
    + '<div class="srv-ctrls">' + c + '</div><div class="srv-panel" hidden></div></div>';
}

function srvFoundHTML(s) {
  var disc = s.discovered || {};
  return '<div class="srv-card found" data-id="' + escAttr(s.id) + '">'
    + '<div class="srv-head"><span class="srv-name">' + esc(s.name) + '</span><span class="gmuted srv-meta">:' + s.port + (disc.proc ? ' · ' + esc(disc.proc) : '') + '</span></div>'
    + (disc.cmd ? '<div class="srv-disc mono">' + esc(disc.cmd) + '</div>' : '')
    + '<div class="srv-ctrls"><button class="clink srv-act" data-act="managed">manage</button>'
    + '<button class="clink srv-act" data-act="watch">watch</button>'
    + '<button class="clink srv-act" data-act="ignored">ignore</button>'
    + '<button class="clink srv-act" data-act="edit">edit</button></div><div class="srv-panel" hidden></div></div>';
}

function srvIgnoredHTML(s) {
  return '<div class="srv-ig-row" data-id="' + escAttr(s.id) + '"><span class="srv-name">' + esc(s.name) + '</span>'
    + '<span class="gmuted srv-meta">:' + s.port + '</span>'
    + '<span class="srv-ctrls"><button class="clink srv-act" data-act="unreviewed">review</button>'
    + '<button class="clink danger srv-act" data-act="delete">delete</button></span></div>';
}

function renderServers() {
  var body = document.getElementById('serversBody');
  if (!body) return;
  var d = SRV.data;
  if (!d) { body.innerHTML = '<div class="gmuted">could not load servers — is the dashboard reachable?</div>'; return; }
  var servers = d.servers || [];
  var hideIg = (d.settings || {}).hideIgnoredCount;
  var managed = servers.filter(function (s) { return s.state === 'managed' || s.state === 'watch'; });
  var found = servers.filter(function (s) { return s.state === 'unreviewed'; });
  var ignored = servers.filter(function (s) { return s.state === 'ignored'; });

  var html = '<div class="srv-section"><div class="card-h">Servers <span class="gmuted">' + managed.length + '</span></div>'
    + (managed.length ? managed.map(srvCardHTML).join('') : '<div class="gmuted">None yet. <b>Scan</b> to find what’s running, or <b>add</b> one.</div>') + '</div>';

  if (found.length) {
    html += '<div class="srv-section srv-found-sec"><div class="card-h">Found — needs review <span class="fbadge warn">' + found.length + '</span>'
      + '<span class="srv-bulk">set all: <button class="gbatch" data-bulk="watch">watch</button><button class="gbatch" data-bulk="ignored">ignore</button></span></div>'
      + found.map(srvFoundHTML).join('') + '</div>';
  }
  if (ignored.length) {
    html += '<div class="srv-section"><button class="srv-ighead" id="srvIgToggle" aria-expanded="false"><span class="vgchev">▸</span> Ignored'
      + (hideIg ? '' : ' <span class="gmuted">' + ignored.length + '</span>') + '</button>'
      + '<div class="srv-iglist" hidden>' + ignored.map(srvIgnoredHTML).join('') + '</div></div>';
  }
  body.innerHTML = html;
  wireServers(body);
}

function wireServers(body) {
  body.querySelectorAll('.srv-act').forEach(function (b) {
    b.addEventListener('click', function () {
      var card = b.closest('[data-id]');
      srvAction(b.dataset.act, card ? card.dataset.id : null, card);
    });
  });
  body.querySelectorAll('[data-bulk]').forEach(function (b) {
    b.addEventListener('click', async function () {
      var ids = (SRV.data.servers || []).filter(function (s) { return s.state === 'unreviewed'; }).map(function (s) { return s.id; });
      if (!ids.length) return;
      var r = await serversPost('set-state', { ids: ids, state: b.dataset.bulk });
      if (r && r.ok) { srvToast('moved ' + r.count + ' → ' + b.dataset.bulk, true); serversLoad(); }
    });
  });
  var ig = document.getElementById('srvIgToggle');
  if (ig) ig.addEventListener('click', function () {
    var list = ig.parentNode.querySelector('.srv-iglist');
    list.hidden = !list.hidden;
    ig.classList.toggle('open', !list.hidden);
    ig.setAttribute('aria-expanded', list.hidden ? 'false' : 'true');
  });
}

async function srvAction(act, id, card) {
  if (act === 'restart-dash') { restartDashboard(); return; }
  if (act === 'edit') { srvTogglePanel(id, card, 'edit'); return; }
  if (act === 'logs') { srvTogglePanel(id, card, 'logs'); return; }
  if (act === 'delete') {
    var s = srvById(id);
    lkConfirm({ heading: 'Delete ' + (s ? s.name : 'server') + '?', danger: true, confirmLabel: 'Delete',
      detail: 'Removes it from the registry only. If it’s running it keeps running — this just forgets it.',
      onConfirm: async function () { var r = await serversPost('delete', { id: id }); if (r && r.ok) { srvToast('deleted', true); serversLoad(); } } });
    return;
  }
  if (act === 'start' || act === 'restart') { srvRun(act, id); return; }
  if (act === 'stop') {
    var s2 = srvById(id);
    lkConfirm({ heading: 'Stop ' + (s2 ? s2.name : 'server') + '?', danger: true, confirmLabel: 'Stop',
      detail: 'Sends SIGTERM to its process. Anything connected will be dropped.',
      onConfirm: function () { srvRun('stop', id); } });
    return;
  }
  var r = await serversPost('set-state', { id: id, state: act });   // managed/watch/ignored/unreviewed
  if (r && r.ok) { srvToast('moved → ' + act, true); serversLoad(); }
}

async function srvRun(act, id) {
  var r = await serversPost(act, { id: id });
  if (r && r.ok) { srvToast(act + (act === 'stop' ? 'ped' : act === 'start' ? 'ed' : 'ed'), true); serversLoad(); }
  else if (r) srvToast(r.output || (act + ' failed'), false);
}

async function srvTogglePanel(id, card, kind) {
  var panel = card.querySelector('.srv-panel');
  if (!panel.hidden && panel.dataset.kind === kind) { panel.hidden = true; return; }
  panel.dataset.kind = kind; panel.hidden = false;
  if (kind === 'logs') {
    panel.innerHTML = '<div class="gmuted">loading logs…</div>';
    var r = await serversPost('logs', { id: id });
    panel.innerHTML = '<div class="srv-logs mono">' + (r && r.log ? esc(r.log) : '<span class="gmuted">no log yet (only managed servers Layaider started have logs)</span>') + '</div>';
  } else {
    panel.innerHTML = srvFormHTML(srvById(id));
    wireSrvForm(panel, id);
  }
}

function srvTypeOpts(sel) { return ['static-http', 'python-app', 'node', 'ssh', 'generic'].map(function (t) { return '<option value="' + t + '"' + (t === sel ? ' selected' : '') + '>' + t + '</option>'; }).join(''); }
function srvHealthOpts(sel) { return ['none', 'port', 'http'].map(function (t) { return '<option value="' + t + '"' + (t === sel ? ' selected' : '') + '>' + t + '</option>'; }).join(''); }
function srvFld(cls, label, val) { return '<label class="srvf"><span>' + label + '</span><input class="hinput sf-' + cls + '" value="' + escAttr(val || '') + '" autocapitalize="off" autocorrect="off" spellcheck="false"></label>'; }

function srvFormHTML(s) {
  s = s || {}; var h = s.health || {};
  return '<div class="srv-form">'
    + srvFld('name', 'name', s.name)
    + '<label class="srvf"><span>type</span><select class="hinput sf-type">' + srvTypeOpts(s.type) + '</select></label>'
    + srvFld('host', 'host', s.host || '127.0.0.1')
    + '<label class="srvf"><span>port</span><span class="sf-portrow"><input class="hinput sf-port" inputmode="numeric" value="' + (s.port || '') + '"><button class="clink sf-suggest" type="button">suggest</button><button class="clink sf-check" type="button">check</button><span class="sf-portmsg gmuted"></span></span></label>'
    + srvFld('directory', 'working directory', s.directory)
    + srvFld('command', 'command', s.command)
    + srvFld('args', 'args (space-separated)', (s.args || []).join(' '))
    + '<label class="srvf srvf-row"><input type="checkbox" class="sf-auto"' + (s.autostart ? ' checked' : '') + '> <span>start on Layaider boot (autostart)</span></label>'
    + '<label class="srvf"><span>health check</span><select class="hinput sf-htype">' + srvHealthOpts(h.type) + '</select></label>'
    + srvFld('hpath', 'health path (http)', h.path || '/')
    + srvFld('notes', 'notes', s.notes)
    + '<div class="srvf-act"><button class="clink sf-save" data-write>save</button><button class="clink sf-cancel">cancel</button></div></div>';
}

function srvCollect(panel) {
  function v(c) { var e = panel.querySelector('.sf-' + c); return e ? e.value.trim() : ''; }
  var argsStr = v('args');
  return {
    name: v('name'), type: panel.querySelector('.sf-type').value, host: v('host'),
    port: parseInt(v('port'), 10) || 0, directory: v('directory'), command: v('command'),
    args: argsStr ? argsStr.split(/\s+/) : [], autostart: panel.querySelector('.sf-auto').checked,
    health: { type: panel.querySelector('.sf-htype').value, path: v('hpath') || '/' }, notes: v('notes'),
  };
}

function wireSrvForm(panel, id) {
  var portInput = panel.querySelector('.sf-port'), msg = panel.querySelector('.sf-portmsg');
  panel.querySelector('.sf-suggest').addEventListener('click', async function () {
    var r = await serversPost('port-suggest', {});
    if (r && r.ok && r.port) { portInput.value = r.port; msg.textContent = 'suggested a free port'; msg.className = 'sf-portmsg ok'; }
  });
  panel.querySelector('.sf-check').addEventListener('click', async function () {
    var r = await serversPost('port-check', { port: parseInt(portInput.value, 10) });
    if (r && r.ok) { msg.textContent = r.free ? '✓ free' : '✗ in use'; msg.className = 'sf-portmsg ' + (r.free ? 'ok' : 'bad'); }
    else if (r) { msg.textContent = r.error || 'bad port'; msg.className = 'sf-portmsg bad'; }
  });
  panel.querySelector('.sf-cancel').addEventListener('click', function () {
    if (id) panel.hidden = true; else { document.getElementById('srvAddPanel').hidden = true; SRV.addOpen = false; }
  });
  panel.querySelector('.sf-save').addEventListener('click', async function () {
    var vals = srvCollect(panel);
    if (!vals.name) { srvToast('name required', false); return; }
    var r = id ? await serversPost('update', { id: id, values: vals }) : await serversPost('add', { values: vals });
    if (r && r.ok) {
      srvToast(id ? 'saved' : 'added', true);
      if (!id) { document.getElementById('srvAddPanel').hidden = true; SRV.addOpen = false; }
      serversLoad();
    }
  });
}

(function serversWire() {
  var disc = document.getElementById('srvDiscover');
  if (!disc) return;
  disc.addEventListener('click', async function () {
    var label = disc.textContent; disc.disabled = true; disc.textContent = 'scanning…';
    var r = await serversPost('discover', {});
    disc.disabled = false; disc.textContent = label;
    if (r && r.ok) {
      var openN = (r.open || []).length;
      srvToast('scanned ' + (r.scanned || 0) + ' ports · ' + openN + ' listening · ' + r.added + ' new', true);
      serversLoad();
    }
  });
  document.getElementById('srvAdd').addEventListener('click', function () {
    var p = document.getElementById('srvAddPanel');
    SRV.addOpen = !SRV.addOpen; p.hidden = !SRV.addOpen;
    if (SRV.addOpen) { p.innerHTML = '<div class="card-h">Add a server</div>' + srvFormHTML(null); wireSrvForm(p, null); }
  });
  document.getElementById('srvSettings').addEventListener('click', function () {
    var p = document.getElementById('srvSettingsPanel');
    if (!p.hidden) { p.hidden = true; return; }
    var hide = !!(SRV.data && SRV.data.settings && SRV.data.settings.hideIgnoredCount);
    p.hidden = false;
    p.innerHTML = '<label class="srvf srvf-row"><input type="checkbox" id="srvHideIg"' + (hide ? ' checked' : '') + '> <span>Hide the ignored-servers count</span></label>';
    document.getElementById('srvHideIg').addEventListener('change', async function () {
      var r = await serversPost('settings', { settings: { hideIgnoredCount: this.checked } });
      if (r && r.ok) { if (SRV.data) SRV.data.settings = r.settings; renderServers(); }
    });
  });
})();

// ===== System tool =====
var SYS = { timer: null };

function sysToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'system' }); }

function pct(used, total) { return total ? Math.round(used / total * 100) : 0; }
function gb(n) { return (n / 1073741824).toFixed(1) + 'G'; }
function mb(n) { return (n / 1048576).toFixed(0) + 'M'; }
function dur(s) { if (s == null) return '—'; var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm'; }

function renderSystem(d) {
  var el = document.getElementById('sysMetrics');
  if (!d) { el.innerHTML = '<div class="gmuted">could not read system</div>'; return; }
  var m = d.mem || {};
  var bars = '<dl class="kv">'
    + '<dt>uptime</dt><dd>' + dur(d.uptime) + '</dd>'
    + '<dt>load</dt><dd>' + (d.load || []).join(' · ') + '  <span class="gmuted">(' + d.cpus + ' cpu)</span></dd>'
    + '<dt>memory</dt><dd>' + mb(m.used) + ' / ' + mb(m.total) + ' <span class="gmuted">(' + pct(m.used, m.total) + '%)</span></dd>'
    + (m.swapTotal ? '<dt>swap</dt><dd>' + mb(m.swapTotal - m.swapFree) + ' / ' + mb(m.swapTotal) + '</dd>' : '')
    + '</dl>';
  var disks = (d.disks || []).map(function (k) {
    return '<div class="usebar"><div class="barlabel">' + esc(k.path) + '</div><div class="bartrack"><div class="barfill" style="width:' + pct(k.used, k.total) + '%"></div></div><div class="barval">' + gb(k.used) + '/' + gb(k.total) + '</div></div>';
  }).join('');
  el.innerHTML = '<div class="card-h">Host</div>' + bars + disks;

  var a = d.aider || {};
  var ael = document.getElementById('sysAider');
  if (a.active && a.procs.length) {
    ael.innerHTML = '<div class="card-h">aider <span class="fbadge warn">running</span></div>' + a.procs.map(function (p) {
      return '<div class="proc"><div class="procline"><span class="ppid">' + p.pid + '</span><span class="pcmd">' + esc(p.cmd) + '</span></div><div class="pmeta">' + dur(p.runtime) + (p.cwd ? ' · ' + esc(p.cwd) : '') + '</div></div>';
    }).join('');
  } else {
    ael.innerHTML = '<div class="card-h">aider</div><div class="gmuted">not running</div>';
  }

  var sel = document.getElementById('sysServers');
  var servers = d.servers || [];
  if (!serverEditOpen()) {
    sel.innerHTML = '<div class="card-h">Servers</div><div class="gmuted" style="margin-bottom:6px">Discover, control, and create servers on the <a href="#servers" class="xlink">Servers</a> tab.</div>' + (servers.length ? servers.map(function (s) {
      var ctrl;
      if (s.dash) ctrl = '<button class="clink srvbtn" data-act="restart" data-id="' + escAttr(s.id) + '">restart</button>';
      else if (s.up) ctrl = '<button class="clink danger srvbtn" data-act="server-stop" data-id="' + escAttr(s.id) + '" data-name="' + escAttr(s.name) + '">stop</button>';
      else ctrl = '<button class="clink srvbtn" data-act="server-start" data-id="' + escAttr(s.id) + '" data-name="' + escAttr(s.name) + '">start</button>';
      var addr = (s.host ? esc(s.host) : '') + ':' + s.port + ' ' + esc(s.type) + (s.auto ? ' · auto' : '') + (s.dash ? ' · this dashboard' : '');
      return '<div class="srvitem" data-id="' + escAttr(s.id) + '" data-name="' + escAttr(s.name) + '" data-port="' + s.port + '">'
        + '<div class="srow"><span class="sdot ' + (s.up ? 'up' : 'down') + '"></span><span class="sname">' + esc(s.name) + '</span>'
        + '<span class="gmuted">' + addr + '</span>'
        + ctrl + '<button class="clink srvedit-btn" title="edit">edit</button></div>'
        + (s.detail ? '<div class="srvdetail">' + esc(s.detail) + '</div>' : '')
        + (s.file ? '<div class="srvmeta">source: <span class="mono">' + esc(s.file) + '</span></div>' : '')
        + (s.boot ? '<div class="srvmeta">autostart: <span class="mono">' + esc(s.boot) + '</span></div>' : '')
        + '<div class="srvedit" hidden>'
        + '<label class="srvf"><span>name</span><input class="hinput srv-name" value="' + escAttr(s.name) + '"></label>'
        + '<label class="srvf"><span>host / IP</span><input class="hinput srv-host" value="' + escAttr(s.host || '') + '" placeholder="display only — e.g. 127.0.0.1"></label>'
        + '<label class="srvf"><span>port</span><input class="hinput srv-port" value="' + s.port + '" inputmode="numeric"></label>'
        + '<label class="srvf"><span>source file</span><input class="hinput srv-file" value="' + escAttr(s.file || '') + '" placeholder="path to the file that sets this server up"></label>'
        + '<label class="srvf"><span>autostart</span><input class="hinput srv-boot" value="' + escAttr(s.boot || '') + '" placeholder="where the auto-launch is configured"></label>'
        + '<label class="srvf"><span>notes</span><input class="hinput srv-det" value="' + escAttr(s.detail || '') + '" maxlength="500"></label>'
        + '<div class="srvf"><span>header pill</span><div class="swatches">'
        +   '<button type="button" class="swatch none' + (s.color ? '' : ' sel') + '" data-color="">\u2205</button>'
        +   ['blue', 'cyan', 'teal', 'amber', 'orange', 'pink'].map(function (c) {
              return '<button type="button" class="swatch' + (s.color === c ? ' sel' : '') + '" data-color="' + c + '" title="' + c + '"></button>';
            }).join('')
        + '</div></div>'
        + '<label class="srvf"><span>pill label</span><input class="hinput srv-pill" value="' + escAttr(s.pillLabel || '') + '" maxlength="40" placeholder="optional — blank = dot only"></label>'
        + '<div class="srvf-act"><button class="clink srv-save">save</button><button class="clink srv-cancel">cancel</button></div>'
        + '</div></div>';
    }).join('') : '');
    sel.querySelectorAll('.srvbtn').forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.dataset.act === 'restart') restartDashboard();
        else serverAction(b.dataset.act, b.dataset.id, b.dataset.name);
      });
    });
    sel.querySelectorAll('.srvedit-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        var panel = b.closest('.srvitem').querySelector('.srvedit');
        panel.hidden = !panel.hidden;
        if (!panel.hidden) { var f = panel.querySelector('.srv-name'); if (f) f.focus(); }
      });
    });
    sel.querySelectorAll('.srv-cancel').forEach(function (b) {
      b.addEventListener('click', function () { b.closest('.srvedit').hidden = true; systemLoad(); });
    });
    sel.querySelectorAll('.srv-save').forEach(function (b) {
      b.addEventListener('click', function () { saveServer(b.closest('.srvitem')); });
    });
    sel.querySelectorAll('.swatches').forEach(function (grp) {
      grp.querySelectorAll('.swatch').forEach(function (sw) {
        sw.addEventListener('click', function () {
          grp.querySelectorAll('.swatch').forEach(function (x) { x.classList.remove('sel'); });
          sw.classList.add('sel');
        });
      });
    });
  }

  var pel = document.getElementById('sysPorts');
  pel.innerHTML = '<div class="card-h">Listening ports</div><div class="ports">' + (d.ports || []).map(function (p) { return '<span class="port">' + p + '</span>'; }).join('') + '</div>';
}

function renderProcs(procs) {
  var el = document.getElementById('sysProcs');
  document.getElementById('sysProcN').textContent = procs.length ? 'top ' + procs.length + ' by memory' : '';
  if (!procs.length) { el.innerHTML = '<div class="gmuted">no processes</div>'; return; }
  var dev = /aider|python|node|git|rclone|dashboard/i;
  el.innerHTML = procs.map(function (p) {
    return '<div class="proc' + (dev.test(p.cmd) ? ' devp' : '') + '">'
      + '<div class="procline"><span class="ppid">' + p.pid + '</span><span class="pcmd">' + esc(p.cmd || p.name) + '</span>'
      + '<span class="prss">' + mb(p.rss) + '</span>'
      + '<button class="clink danger pkill" data-pid="' + p.pid + '" data-name="' + esc(p.name) + '">kill</button></div></div>';
  }).join('');
  el.querySelectorAll('.pkill').forEach(function (b) {
    b.addEventListener('click', function () {
      var pid = b.dataset.pid, name = b.dataset.name;
      openSheet('kill ' + pid + ' (' + name + ')', 'Sends SIGTERM to process ' + pid + '. Use this to stop a stuck aider or server; killing the wrong process can lose unsaved work.',
        async function () {
          var res = await fetch('/api/system/kill', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: parseInt(pid, 10) }) });
          var j = await res.json().catch(function () { return {}; });
          if (j.ok) { sysToast('killed ' + pid, true); closeSheet(); systemLoad(); }
          else sysToast(j.error || j.output || 'kill failed', false);
        });
    });
  });
}

async function serverAction(act, id, name) {
  async function run() {
    var res = await fetch('/api/system/' + act, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id }) });
    var j = await res.json().catch(function () { return {}; });
    if (j && j.ok) { sysToast((act === 'server-start' ? 'started ' : 'stopped ') + name, true); systemLoad(); }
    else sysToast((j && (j.error || j.output)) || 'failed', false);
  }
  if (act === 'server-stop') {
    openSheet('stop ' + name, 'Stops the ' + name + ' server (pkill on its process). Anyone connected to it will be dropped.',
      async function () { closeSheet(); await run(); });
  } else { run(); }
}

function serverEditOpen() {
  var sel = document.getElementById('sysServers');
  if (!sel) return false;
  if (sel.querySelector('.srvedit:not([hidden])')) return true;
  var a = document.activeElement;
  return !!(a && sel.contains(a) && a.tagName === 'INPUT');
}

async function saveServer(item) {
  var id = item.dataset.id;
  var name = item.querySelector('.srv-name').value.trim();
  var host = item.querySelector('.srv-host').value.trim();
  var portStr = item.querySelector('.srv-port').value.trim();
  var file = item.querySelector('.srv-file').value.trim();
  var boot = item.querySelector('.srv-boot').value.trim();
  var detail = item.querySelector('.srv-det').value.trim();
  var pillLabel = (item.querySelector('.srv-pill') || {}).value || '';
  pillLabel = pillLabel.trim();
  var swatch = item.querySelector('.swatch.sel');
  var color = swatch ? (swatch.dataset.color || '') : '';
  var port = parseInt(portStr, 10);
  if (!name) { sysToast('name required', false); return; }
  if (!(port >= 1 && port <= 65535)) { sysToast('port must be 1–65535', false); return; }
  var ok = true;
  if (name !== (item.dataset.name || '') || String(port) !== (item.dataset.port || '')) {
    var r = await fetch('/api/system/server-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, name: name, port: port }) })
      .then(function (x) { return x.json(); }).catch(function () { return null; });
    if (!r || !r.ok) { ok = false; sysToast((r && (r.error || r.output)) || 'config save failed', false); }
  }
  await fetch('/api/system/server-meta', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id, host: host, file: file, boot: boot, detail: detail, color: color, pillLabel: pillLabel }) })
    .catch(function () {});
  item.querySelector('.srvedit').hidden = true;
  if (ok) sysToast('saved', true);
  systemLoad();
}

// ===== aider chat-history parser + shared chat renderer =====
// parseAiderHistory() turns .aider.chat.history.md into a normalized block
// model; renderBlocks() draws it. The live Chat page will feed renderBlocks()
// from a different parser later, so keep these two concerns separate.

// A `> ` aider prompt line: "<question>? (opts) [default]: <answer>".
// (Form may vary; this covers the common case, refine as new ones appear.)
function aiderPromptParse(t) {
  var m = t.match(/^(.+?\?)\s*\(.*\[[^\]]*\]:\s*(.*)$/);
  return m ? { question: m[1].trim(), answer: m[2].trim() } : null;
}

// Fold whitespace-only `gap` blocks into the preceding block (leading ones into
// the next), so the stream has no standalone blanks and same-type blocks sit adjacent.
function mergeWhitespace(blocks) {
  var out = [], pending = null;
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.type === 'gap') {
      if (out.length) { var p = out[out.length - 1]; p.to = b.to; p.raw = p.raw + '\n' + b.raw; }
      else if (pending) { pending.to = b.to; pending.raw = pending.raw + '\n' + b.raw; }
      else pending = b;
      continue;
    }
    if (pending) { b.from = pending.from; b.raw = pending.raw + '\n' + b.raw; pending = null; }
    out.push(b);
  }
  if (pending) out.push(pending);
  return out;
}

function parseAiderHistory(text) {
  var src = (text || '').replace(/\r\n/g, '\n');
  var lines = src.split('\n');
  var n = lines.length, blocks = [], i = 0;

  function emit(type, from, to, extra, rule) {
    if (to <= from) return;                       // never emit empty ranges
    var b = { type: type, rule: rule || type, from: from, to: to, raw: lines.slice(from, to).join('\n') };
    if (extra) { for (var k in extra) b[k] = extra[k]; }
    blocks.push(b);
  }
  function isMarker(s) { return /^# aider chat started/.test(s) || /^#### /.test(s); }
  function isBanner(t) {
    return /^Aider v/i.test(t) || /^Model:/i.test(t) || /^Git repo:/i.test(t)
        || /^Repo-map:/i.test(t) || (/aider/i.test(t) && /\s--/.test(t));
  }
  function coverStray(from) {                      // gather a non-marker run; classify gap vs unmatched
    var g = from;
    while (g < n && !isMarker(lines[g]) && !/^>/.test(lines[g])) g++;
    var ch = lines.slice(from, g).join('\n');
    emit(ch.trim() ? 'unmatched' : 'gap', from, g, null, ch.trim() ? 'unmatched' : 'whitespace');
    return g;
  }

  while (i < n) {
    var line = lines[i];

    // ---- session header + startup banner ----
    if (/^# aider chat started at /.test(line)) {
      var s = i; i++;
      while (i < n && !isMarker(lines[i]) &&
             (lines[i].trim() === '' || (/^>/.test(lines[i]) && isBanner(lines[i].replace(/^>\s?/, ''))))) i++;
      emit('session', s, i, parseSessionBanner(lines, s, i), 'session');
      while (i < n && !isMarker(lines[i])) {       // remaining banner: 'Added X' notices + blank runs
        var mb = lines[i].match(/^>\s?(.*)/);
        if (mb) {
          var prB = aiderPromptParse(mb[1]);
          if (prB) emit('prompt', i, i + 1, prB, 'prompt');
          else emit('notice', i, i + 1, { kind: noticeKind(mb[1]), text: mb[1] }, 'session-notice');
          i++;
        } else { i = coverStray(i); }
      }
      continue;
    }

    // ---- turn / slash-command ----
    var mTurn = line.match(/^#### ?(.*)/);
    if (mTurn) {
      var head = mTurn[1], bodyStart = i + 1, j = bodyStart;
      while (j < n && !isMarker(lines[j])) j++;
      if (head.charAt(0) === '/') {
        var out = lines.slice(bodyStart, j).map(function (x) { var m = x.match(/^>\s?(.*)/); return m ? m[1] : x; })
                       .join('\n').replace(/^\s+|\s+$/g, '');
        emit('command', i, j, { cmd: head.trim(), output: out }, 'command');
      } else {
        emit('user', i, bodyStart, { text: head.trim() }, 'user');
        parseAssistantTurnRanged(lines, bodyStart, j, emit);
      }
      i = j;
      continue;
    }

    // ---- stray top-level '>' line (orphan notice / prompt) ----
    var mTop = line.match(/^>\s?(.*)/);
    if (mTop) {
      var prT = aiderPromptParse(mTop[1]);
      if (prT) emit('prompt', i, i + 1, prT, 'prompt');
      else emit('notice', i, i + 1, { kind: noticeKind(mTop[1]), text: mTop[1] }, 'orphan-notice');
      i++; continue;
    }

    // ---- anything else at top level: covered, never silently dropped ----
    i = coverStray(i);
  }
  return mergeWhitespace(blocks);
}

function parseSessionBanner(lines, from, to) {
  var info = { startedAt: '', version: '', model: '', repo: '', launchCmd: '' };
  var m0 = lines[from].match(/^# aider chat started at (.*)/);
  if (m0) info.startedAt = m0[1].trim();
  for (var k = from + 1; k < to; k++) {
    var mb = lines[k].match(/^>\s?(.*)/);
    if (!mb) continue;
    var t = mb[1];
    if (/^Aider v/i.test(t)) info.version = t.replace(/^Aider\s*/i, '');
    else if (/^Model:/i.test(t)) info.model = t.replace(/^Model:\s*/i, '');
    else if (/^Git repo:/i.test(t)) info.repo = t.replace(/^Git repo:\s*/i, '');
    else if (/aider/i.test(t) && /\s--/.test(t)) info.launchCmd = t;
  }
  return info;
}

function parseAssistantTurnRanged(lines, from, to, emit) {
  var i = from, proseFrom = -1;
  function flushProse(end) {
    if (proseFrom < 0 || end <= proseFrom) { proseFrom = -1; return; }
    var raw = lines.slice(proseFrom, end).join('\n');
    if (raw.trim()) emit('assistant', proseFrom, end, { text: raw.replace(/^\s+|\s+$/g, '') }, 'assistant');
    else emit('gap', proseFrom, end, null, 'whitespace');
    proseFrom = -1;
  }
  while (i < to) {
    var line = lines[i];

    if (/^<thinking-content-[0-9a-f]+>/i.test(line)) {
      flushProse(i);
      var s = i; i++;
      while (i < to && !/^<\/thinking-content-/i.test(lines[i])) i++;
      if (i < to) i++;
      var inner = lines.slice(s, i).join('\n')
        .replace(/^<thinking-content-[0-9a-f]+>/i, '')
        .replace(/<\/thinking-content-[0-9a-f]+>\s*$/i, '');
      emit('reasoning', s, i, { text: inner.replace(/^\s+|\s+$/g, '') }, 'reasoning');
      continue;
    }

    var mF = line.match(/^```(\w*)\s*$/);
    if (mF) {
      var fenceStart = i, k = i + 1;
      while (k < to && !/^```\s*$/.test(lines[k])) k++;
      var fenceEnd = (k < to) ? k + 1 : k;
      var fbody = lines.slice(fenceStart + 1, k).join('\n');
      if (/<<<<<<< SEARCH/.test(fbody) && />>>>>>> REPLACE/.test(fbody)) {
        var editFrom = fenceStart, file = '';
        if (proseFrom >= 0) {
          var p = fenceStart - 1;
          while (p >= proseFrom && lines[p].trim() === '') p--;
          if (p >= proseFrom) { file = lines[p].trim(); editFrom = p; }
          flushProse(editFrom);
        }
        var ed = parseSearchReplace(fbody);
        emit('edit', editFrom, fenceEnd, { file: file, lang: mF[1] || '', search: ed.search, replace: ed.replace }, 'edit');
        i = fenceEnd;
        continue;
      }
      if (proseFrom < 0) proseFrom = i;            // ordinary code block stays in prose
      i = fenceEnd;
      continue;
    }

    var mN = line.match(/^>\s?(.*)/);
    if (mN) {
      flushProse(i);
      var prN = aiderPromptParse(mN[1]);
      if (prN) emit('prompt', i, i + 1, prN, 'prompt');
      else emit('notice', i, i + 1, { kind: noticeKind(mN[1]), text: mN[1] }, 'notice');
      i++; continue;
    }

    if (proseFrom < 0) proseFrom = i;
    i++;
  }
  flushProse(to);
}

function parseSearchReplace(fbody) {
  var lines = fbody.split('\n'), search = [], replace = [], where = 0;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    if (/^<<<<<<< SEARCH/.test(l)) { where = 1; continue; }
    if (/^=======\s*$/.test(l)) { where = 2; continue; }
    if (/^>>>>>>> REPLACE/.test(l)) { where = 0; continue; }
    if (where === 1) search.push(l);
    else if (where === 2) replace.push(l);
  }
  return { search: search.join('\n'), replace: replace.join('\n') };
}

function noticeKind(t) {
  if (/^Tokens:/i.test(t)) return 'tokens';
  if (/^Applied edit/i.test(t)) return 'edit';
  if (/to the chat\b/i.test(t)) return 'file';
  if (/^Commit\b/i.test(t)) return 'commit';
  if (/error|fail|exception|traceback/i.test(t)) return 'error';
  return 'info';
}

// ---- live (raw terminal) parser ------------------------------------------------
// Emits the SAME block schema as parseAiderHistory so the shared renderer handles both.
// The live capture has no '####'/'>' markers: it's prompts (`architect multi> …`),
// the banner without prefixes, the launch echo, spinner residue, multi-line litellm
// JSON errors, Tokens lines, and assistant prose. Built to run on the in-flight tail
// (commit-on-boundary parks finished turns), but it parses arbitrary text safely.
var LIVE_PROMPT_RE = /^(code|ask|architect|help|context|multi)(?: multi)?>\s?(.*)$/;
var LIVE_BANNER_RE = /^(?:Aider v|Main model:|Model:|Editor model:|Weak model:|Git repo:|Repo-map:|Multiline mode:)/;
var LIVE_PREAMBLE_RE = /^(?:\uD83D\uDE80|\uD83D\uDD11|\u2699\uFE0F?|-{5,}|Initializing|Loaded \w+ Key:|Invoking Command:)/;
var LIVE_ERRSTART_RE = /^(?:litellm\.\w+|[\w.]*Exception\b|Traceback \(most recent call last\))/;
var LIVE_NOTICE_RE = /^(?:Retrying in \d|Added .+ to (?:the chat|read-only)|Added [\/~].+ to read-only|Removed .+ from|Dropped |Restored previous|No matches found for:|The API provider|Repo-map: |Initial repo scan|Scanning repo|Commit [0-9a-f]{6,}|Applied edit to |Can't initialize|Warning: )/;
var LIVE_TOKENS_RE = /^Tokens:/;
var LIVE_THINK_OPEN_RE = /^<thinking-content-[0-9a-f]+>/i;
var LIVE_CONFIRM_RE = /\(Y\)es\/\(N\)o|Add .+ to the chat\?|Do you want to |Run shell command|\(A\)ll|Skip all|Don't ask again/i;
// aider reprints the in-chat file list before prompts: a bare path, optionally "(read only)".
// Excludes URLs (no ':' in the class) and anything with spaces (whole-line anchored).
var LIVE_FILE_RE = /^([\w./@+-]+\.[A-Za-z0-9]+)( \(read only\))?$/;

function liveIsStructural(line) {
  return LIVE_PROMPT_RE.test(line) || LIVE_BANNER_RE.test(line) || LIVE_PREAMBLE_RE.test(line)
      || LIVE_ERRSTART_RE.test(line) || LIVE_NOTICE_RE.test(line) || LIVE_TOKENS_RE.test(line)
      || LIVE_THINK_OPEN_RE.test(line) || LIVE_CONFIRM_RE.test(line) || LIVE_FILE_RE.test(line);
}

function parseAiderLive(text) {
  var src = String(text || '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')        // CSI escapes (if not pre-stripped)
    .replace(/\x1b\][^\x07]*\x07/g, '')            // OSC escapes
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')  // other control (keep \t and \n)
    .replace(/\r/g, '')
    .replace(/[\u2580-\u259F]/g, '')               // block-drawing spinner glyphs
    .replace(/Updating repo map:.*?(?=\s{2,}\S|\n|$)/g, ' '); // strip progress (recovers text concatenated after it)
  var lines = src.split('\n'), n = lines.length, i = 0, blocks = [];

  function emit(type, raw, extra) {
    var b = { type: type, rule: 'live-' + type, raw: raw };
    if (extra) for (var k in extra) b[k] = extra[k];
    blocks.push(b);
  }

  while (i < n) {
    var line = lines[i];
    if (line.trim() === '') { i++; continue; }                 // live: blanks aren't blocks

    // session banner + launch preamble (a contiguous run, no '>' prefix)
    if (LIVE_PREAMBLE_RE.test(line) || LIVE_BANNER_RE.test(line)) {
      var s = i;
      while (i < n) {
        if (LIVE_PREAMBLE_RE.test(lines[i]) || LIVE_BANNER_RE.test(lines[i]) || lines[i].trim() === '') { i++; continue; }
        // wrapped banner continuation: a non-structural line sandwiched before another banner line
        if (i + 1 < n && (LIVE_BANNER_RE.test(lines[i + 1]) || LIVE_PREAMBLE_RE.test(lines[i + 1])) && !liveIsStructural(lines[i])) { i++; continue; }
        break;
      }
      var rawSess = lines.slice(s, i).join('\n');
      emit('session', rawSess, parseLiveSession(lines.slice(s, i)));
      continue;
    }

    // prompt line carries the user's command/message inline
    var mp = line.match(LIVE_PROMPT_RE);
    if (mp) {
      var pmode = mp[1], rest = (mp[2] || '').trim();
      if (rest === '') { i++; continue; }                      // idle prompt, no content
      if (rest.charAt(0) === '/') emit('command', line, { cmd: rest, output: '', mode: pmode });
      else emit('user', line, { text: rest, mode: pmode });
      i++; continue;
    }

    // y/n confirmations (apply edit? add file? run shell?) — interactive, first-class
    if (LIVE_CONFIRM_RE.test(line)) { emit('confirmation', line, { text: line.trim() }); i++; continue; }

    // litellm / exception errors: gather the message + any continuation (JSON) lines
    if (LIVE_ERRSTART_RE.test(line)) {
      var es = i; i++;
      while (i < n && lines[i].trim() !== '' && !liveIsStructural(lines[i])) i++;
      var rawE = lines.slice(es, i).join('\n');
      emit('error', rawE, { text: rawE.trim() });
      continue;
    }

    if (LIVE_TOKENS_RE.test(line)) { emit('tokens', line, { text: line.trim() }); i++; continue; }

    if (LIVE_NOTICE_RE.test(line)) { emit('notice', line, { kind: noticeKind(line), text: line.trim() }); i++; continue; }

    // thinking blocks, if the model streams them inline
    if (LIVE_THINK_OPEN_RE.test(line)) {
      var ts = i; i++;
      while (i < n && !/^<\/thinking-content-/i.test(lines[i])) i++;
      if (i < n) i++;
      var inner = lines.slice(ts, i).join('\n')
        .replace(/^<thinking-content-[0-9a-f]+>/i, '')
        .replace(/<\/thinking-content-[0-9a-f]+>\s*$/i, '');
      emit('reasoning', lines.slice(ts, i).join('\n'), { text: inner.trim() });
      continue;
    }

    // in-chat file list (reprinted before prompts): bare path, optionally read-only
    var mfile = line.match(LIVE_FILE_RE);
    if (mfile) { emit('file', line, { path: mfile[1], readonly: !!mfile[2] }); i++; continue; }

    // otherwise: assistant prose — gather until the next structural line (internal blanks ok)
    var as = i;
    while (i < n && !liveIsStructural(lines[i])) i++;
    var rawA = lines.slice(as, i).join('\n');
    var at = rawA.trim();
    if (at) emit('assistant', rawA, { text: at });
  }
  return blocks;
}

function parseLiveSession(lines) {
  var info = { startedAt: '', version: '', model: '', editor: '', weak: '', repo: '', launchCmd: '' };
  lines.forEach(function (t) {
    if (/^Aider v/i.test(t)) info.version = t.replace(/^Aider\s*/i, '').trim();
    else if (/^Main model:/i.test(t)) info.model = t.replace(/^Main model:\s*/i, '').trim();
    else if (/^Model:/i.test(t)) info.model = t.replace(/^Model:\s*/i, '').trim();
    else if (/^Editor model:/i.test(t)) info.editor = t.replace(/^Editor model:\s*/i, '').trim();
    else if (/^Weak model:/i.test(t)) info.weak = t.replace(/^Weak model:\s*/i, '').trim();
    else if (/^Git repo:/i.test(t)) info.repo = t.replace(/^Git repo:\s*/i, '').trim();
    else if (/Invoking Command:/.test(t)) info.launchCmd = t.replace(/^.*Invoking Command:\s*/, '').trim();
  });
  return info;
}

// "Tokens: 8.3k sent, 124 received." (optionally "Cost: $0.0123...") -> structured
function parseTokens(text) {
  var t = String(text || '');
  var sent = (t.match(/([\d.]+k?)\s*sent/i) || [])[1] || '';
  var recv = (t.match(/([\d.]+k?)\s*received/i) || [])[1] || '';
  var cost = (t.match(/\$[\d.]+/) || [])[0] || '';
  return { sent: sent, received: recv, cost: cost, raw: t.replace(/^Tokens:\s*/i, '').trim() };
}

// Fold the typed block list into the CURRENT session state. This is the single source the
// status panels read (files, mode, models, tokens, pending confirmation). Reads blocks only —
// format-agnostic, so it works the same on history or live blocks.
function reduceSession(blocks) {
  var st = { models: { main: '', editor: '', weak: '' }, repo: '', version: '', mode: '', files: [], tokens: null, pending: null };
  var run = null; // current contiguous run of file-list lines (aider reprints the full set)
  function flush() { if (run) { st.files = run; run = null; } }
  (blocks || []).forEach(function (b) {
    if (b.type !== 'file') flush();
    switch (b.type) {
      case 'session':
        if (b.model) st.models.main = b.model;
        if (b.editor) st.models.editor = b.editor;
        if (b.weak) st.models.weak = b.weak;
        if (b.repo) st.repo = b.repo;
        if (b.version) st.version = b.version;
        break;
      case 'command': {
        var c = (b.cmd || '').trim();
        var m = c.match(/^\/chat-mode\s+(\w+)/) || c.match(/^\/(code|ask|architect|context|help)\b/);
        if (m) st.mode = m[1];
        var mm = c.match(/^\/model\s+(.+)/); if (mm) st.models.main = mm[1].trim();
        var me = c.match(/^\/editor-model\s+(.+)/); if (me) st.models.editor = me[1].trim();
        var mw = c.match(/^\/weak-model\s+(.+)/); if (mw) st.models.weak = mw[1].trim();
        st.pending = null; // issuing a command resolves any prior y/n
        break;
      }
      case 'user':
        if (b.mode && b.mode !== 'multi') st.mode = b.mode;
        st.pending = null;
        break;
      case 'file':
        (run || (run = [])).push({ path: b.path, readonly: !!b.readonly });
        break;
      case 'tokens':
        st.tokens = parseTokens(b.text);
        break;
      case 'confirmation':
        st.pending = b.text;
        break;
      case 'assistant':
        st.pending = null; // a response means the prompt was answered
        break;
    }
  });
  flush();
  return st;
}

// Reference catalog for the command builder + help menu (Stage 4). name, args, group, help.
// Conservative subset of aider's slash-commands; args use <required> / [optional].
var AIDER_COMMANDS = [
  { name: '/add', args: '<files…>', group: 'files', help: 'Add files to the chat so aider can edit them.' },
  { name: '/drop', args: '[files…]', group: 'files', help: 'Remove files from the chat (no args drops all).' },
  { name: '/read-only', args: '<files…>', group: 'files', help: 'Add files as read-only reference (not edited).' },
  { name: '/ls', args: '', group: 'files', help: 'List files known to aider and which are in the chat.' },
  { name: '/chat-mode', args: '<code|ask|architect|context|help>', group: 'mode', help: 'Switch the chat mode.' },
  { name: '/code', args: '[message]', group: 'mode', help: 'Switch to code mode (make edits directly).' },
  { name: '/ask', args: '[message]', group: 'mode', help: 'Ask about the code without editing.' },
  { name: '/architect', args: '[message]', group: 'mode', help: 'Plan with the architect model, edits via editor model.' },
  { name: '/model', args: '<name>', group: 'models', help: 'Switch the main model.' },
  { name: '/editor-model', args: '<name>', group: 'models', help: 'Switch the editor model.' },
  { name: '/weak-model', args: '<name>', group: 'models', help: 'Switch the weak model (commits, summaries).' },
  { name: '/models', args: '[query]', group: 'models', help: 'Search available models.' },
  { name: '/commit', args: '[message]', group: 'git', help: 'Commit edits made outside the chat.' },
  { name: '/diff', args: '', group: 'git', help: 'Show the diff of changes since the last message.' },
  { name: '/undo', args: '', group: 'git', help: 'Undo the last aider git commit.' },
  { name: '/run', args: '<cmd>', group: 'shell', help: 'Run a shell command and optionally add the output.' },
  { name: '/test', args: '[cmd]', group: 'shell', help: 'Run a test command; add output to chat on failure.' },
  { name: '/lint', args: '[files…]', group: 'shell', help: 'Lint and fix provided files (or in-chat files).' },
  { name: '/tokens', args: '', group: 'context', help: 'Report token counts for the current context.' },
  { name: '/clear', args: '', group: 'context', help: 'Clear the chat history.' },
  { name: '/reset', args: '', group: 'context', help: 'Drop all files and clear the chat history.' },
  { name: '/map', args: '', group: 'context', help: 'Print the current repo map.' },
  { name: '/map-refresh', args: '', group: 'context', help: 'Force a refresh of the repo map.' },
  { name: '/web', args: '<url>', group: 'context', help: 'Scrape a webpage and add its content to the chat.' },
  { name: '/paste', args: '', group: 'context', help: 'Paste clipboard text/image into the chat.' },
  { name: '/help', args: '[question]', group: 'meta', help: 'Ask for help about using aider.' },
  { name: '/exit', args: '', group: 'meta', help: 'Exit aider.' }
];
function aiderCommand(name) {
  name = String(name || '').trim();
  for (var i = 0; i < AIDER_COMMANDS.length; i++) if (AIDER_COMMANDS[i].name === name) return AIDER_COMMANDS[i];
  return null;
}

function chatDiffRows(searchStr, replaceStr) {
  var a = searchStr.split('\n'), b = replaceStr.split('\n');
  var pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  var aE = a.length, bE = b.length;
  while (aE > pre && bE > pre && a[aE - 1] === b[bE - 1]) { aE--; bE--; }
  var rows = [];
  for (var i = 0; i < pre; i++) rows.push({ t: 'ctx', s: a[i] });
  for (var i = pre; i < aE; i++) rows.push({ t: 'del', s: a[i] });
  for (var i = pre; i < bE; i++) rows.push({ t: 'add', s: b[i] });
  for (var i = aE; i < a.length; i++) rows.push({ t: 'ctx', s: a[i] });
  return rows;
}

function chatMdLite(src) {
  var out = [], parts = String(src).split('```');
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      out.push('<pre><code>' + esc(parts[i].replace(/^(\w+)\n/, '')) + '</code></pre>');
    } else {
      var t = esc(parts[i]);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
      t = t.replace(/\n/g, '<br>');
      out.push(t);
    }
  }
  return out.join('');
}

// type -> css class (block type names differ from class suffixes)
var CH_CLS = { user: 'ch-user', assistant: 'ch-assistant', command: 'ch-cmd', edit: 'ch-edit', reasoning: 'ch-reason', unmatched: 'ch-unmatched' };
// default open state per type: the conversation (user/assistant) is open, machinery collapsed
function chTypeOpenDefault(t) { return t === 'user' || t === 'assistant'; }
function chIsOpen(t, opts) {
  if (opts && opts.forceOpen) return true;
  var m = opts && opts.typeOpen;
  if (m && Object.prototype.hasOwnProperty.call(m, t)) return !!m[t];
  return chTypeOpenDefault(t);
}

// searchable text per block, for the chat-controls search bar
function chBlockText(b) {
  if (b.type === 'command') return (b.cmd || '') + ' ' + (b.output || '');
  if (b.type === 'edit') return (b.file || '') + ' ' + (b.search || '') + ' ' + (b.replace || '');
  if (b.type === 'prompt') return (b.question || '') + ' ' + (b.answer || '');
  if (b.type === 'session') return (b.startedAt || '') + ' ' + (b.model || '');
  if (b.type === 'file') return b.path || '';
  if (b.type === 'unmatched') return b.raw || '';
  return b.text || b.raw || '';
}
function chMatch(b, q) { return chBlockText(b).toLowerCase().indexOf(q) !== -1; }

function chFirstLine(text) {
  var t = String(text), nl = t.indexOf('\n');
  return nl < 0 ? { head: t, rest: '' } : { head: t.slice(0, nl), rest: t.slice(nl + 1) };
}

// head line is always shown; body (the rest) collapses. No body => just a line.
function chatFold(headHtml, bodyHtml, cls, open, attrs) {
  if (!bodyHtml) return '<div class="ch-line ' + cls + '"' + (attrs ? ' ' + attrs : '') + '>' + headHtml + '</div>';
  return '<div class="ch-fold ' + cls + '"' + (attrs ? ' ' + attrs : '') + '><div class="ch-foldhead' + (open ? '' : ' collapsed') + '" data-collapse role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '">'
    + headHtml + '<span class="chev">\u25be</span></div>'
    + '<div class="ch-foldbody' + (open ? '' : ' hidden') + '">' + bodyHtml + '</div></div>';
}
function chatRestHtml(s) { return '<span class="ch-text">' + esc(s).replace(/\n/g, '<br>') + '</span>'; }

// Per-type block renderers. This registry is the shared extension point: a plugin can
// add a new block type or override one, and both the history and live views pick it up.
var LEAF_RENDERERS = {
  user: function (b, op) {
    return chatFold('<span class="ch-label">user</span>', b.text ? chatRestHtml(b.text) : '', 'ch-user', op);
  },
  command: function (b, op) {
    return chatFold('<span class="ch-label">command</span>',
      '<div class="ch-cmd-line">' + esc(b.cmd) + '</div>' + ((b.output || '').trim() ? '<pre>' + esc(b.output) + '</pre>' : ''),
      'ch-cmd', op);
  },
  assistant: function (b, op) {
    return chatFold('<span class="ch-label">assistant</span>', b.text ? chatMdLite(b.text) : '', 'ch-assistant', op);
  },
  reasoning: function (b, op) {
    return chatFold('<span class="ch-think-tag">thinking</span>', b.text ? chatRestHtml(b.text) : '', 'ch-reason', op);
  },
  edit: function (b, op) {
    var rows = chatDiffRows(b.search, b.replace).map(function (x) {
      var sym = x.t === 'add' ? '+' : x.t === 'del' ? '-' : ' ';
      return '<div class="' + x.t + '">' + esc(sym + ' ' + x.s) + '</div>';
    }).join('');
    return chatFold('<span class="ch-file">' + esc(b.file || '(edit)') + '</span>',
      '<div class="ch-diff">' + rows + '</div>', 'ch-edit', op);
  },
  notice: function (b) {
    return '<div class="ch-line ch-notice ' + esc(b.kind) + '"><span class="dot"></span><span>' + esc(b.text) + '</span></div>';
  },
  prompt: function (b) {
    var ans = b.answer ? '<div class="ch-a"><span class="ch-text">' + esc(b.answer) + '</span></div>' : '';
    return '<div class="ch-promptpair"><div class="ch-q"><span class="ch-text">' + esc(b.question) + '</span></div>' + ans + '</div>';
  },
  unmatched: function (b, op) {
    return chatFold('<span class="ch-utag">unparsed</span>', '<pre>' + esc(b.raw) + '</pre>', 'ch-unmatched', op);
  },
  // --- additive types the live parser emits (history output is unaffected) ---
  error: function (b, op) {
    return chatFold('<span class="ch-err-tag">error</span>', b.text ? '<pre>' + esc(b.text) + '</pre>' : '', 'ch-error', op);
  },
  tokens: function (b) {
    return '<div class="ch-line ch-tokens"><span class="dot"></span><span>' + esc(b.text) + '</span></div>';
  },
  session: function (b, op) {
    var bits = [];
    if (b.model) bits.push('model ' + b.model);
    if (b.editor) bits.push('editor ' + b.editor);
    if (b.weak) bits.push('weak ' + b.weak);
    if (b.repo) bits.push('repo ' + b.repo);
    var body = bits.length ? '<div class="ch-sess-body">' + bits.map(function (x) { return '<div>' + esc(x) + '</div>'; }).join('') + '</div>' : '';
    var when = b.startedAt || b.version || '';
    return chatFold('<span class="ch-sess-tag">session</span>' + (when ? '<span class="ch-sess-when">' + esc(when) + '</span>' : ''), body, 'ch-session', op);
  },
  confirmation: function (b) {
    return '<div class="ch-line ch-confirm"><span class="ch-confirm-tag">prompt</span><span>' + esc(b.text) + '</span></div>';
  },
  file: function (b) {
    return '<div class="ch-line ch-file-line"><span class="dot"></span><span>' + esc(b.path)
      + (b.readonly ? ' <span class="ch-ro">(read only)</span>' : '') + '</span></div>';
  }
};

function renderLeaf(b, opts) {
  var op = chIsOpen(b.type, opts);
  var fn = LEAF_RENDERERS[b.type];
  return fn ? fn(b, op, opts) : '';
}

function chatLoc(b) {
  return 'L' + (b.from + 1) + (b.to > b.from + 1 ? '\u2013' + b.to : '');
}

function renderBlock(b, opts) {
  opts = opts || {};
  if (b.type === 'reasoning' && opts.hideReasoning && !opts.inspect) return '';
  var leaf = renderLeaf(b, opts);
  if (!opts.inspect) return leaf;
  return '<div class="ch-insp">'
    + '<div class="ch-insp-bar"><span class="ch-rule">' + esc(b.rule || b.type) + '</span>'
    + '<span class="ch-loc">' + chatLoc(b) + '</span>'
    + '<button class="ch-rawbtn" data-rawtoggle>raw</button></div>'
    + '<div class="ch-insp-parsed">' + leaf + '</div>'
    + '<div class="ch-insp-raw hidden"><pre>' + esc(b.raw) + '</pre></div></div>';
}

// Consecutive same-type blocks (>=2) collapse into one group. Skipped in inspect
// mode so every block stays individually visible.
function renderItems(items, opts) {
  var html = [], k = 0;
  while (k < items.length) {
    var t = items[k].type, run = [items[k]];
    k++;
    while (k < items.length && items[k].type === t) { run.push(items[k]); k++; }
    var inner = run.map(function (b) { return renderBlock(b, opts); }).join('');
    if (run.length >= 2 && !opts.inspect && !opts.noGroup) {
      var side = (t === 'user' || t === 'command') ? ' ch-side-user' : '';
      html.push(chatFold('<span class="ch-runlabel">' + esc(t) + ' \u00d7' + run.length + '</span>',
        inner, 'ch-run' + side, chIsOpen(t, opts), 'data-runtype="' + t + '"'));
    } else {
      html.push(inner);
    }
  }
  return html.join('');
}

function renderBlocks(blocks, opts) {
  opts = opts || {};
  var q = (opts.query || '').trim().toLowerCase();
  var hideR = opts.hideReasoning && !opts.inspect;
  var ropts = q ? Object.assign({}, opts, { forceOpen: true, noGroup: true }) : opts;
  var groups = [], cur = null;
  blocks.forEach(function (b) {
    if (b.type === 'session') { cur = { session: b, items: [] }; groups.push(cur); }
    else { if (!cur) { cur = { session: null, items: [] }; groups.push(cur); } cur.items.push(b); }
  });

  var html = groups.map(function (g) {
    var items = g.items;
    if (q) {
      var sessMatch = g.session && chMatch(g.session, q);
      items = items.filter(function (b) {
        return chMatch(b, q) && !(hideR && b.type === 'reasoning');
      });
      if (!items.length && !sessMatch) return '';
    }
    var inner = renderItems(items, ropts);
    var s = g.session || {};
    var msgs = g.items.filter(function (b) { return b.type === 'user'; }).length;
    var label = [s.startedAt ? 'chat \u00b7 ' + s.startedAt : 'chat'];
    if (s.model) label.push(s.model);
    label.push(msgs + ' msg' + (msgs === 1 ? '' : 's'));
    var badge = (opts.inspect && g.session)
      ? ' <span class="ch-rule">session</span> <span class="ch-loc">' + chatLoc(g.session) + '</span>' : '';
    var gc = q ? '' : ' collapsed', gb = q ? '' : ' hidden';
    return '<div class="ch-group"><div class="ch-foldhead ch-grouphead' + gc + '" data-collapse role="button" tabindex="0" aria-expanded="' + (q ? 'true' : 'false') + '">'
      + '<span class="ch-grouplabel">' + esc(label.join('  \u00b7  ')) + '</span>' + badge
      + '<span class="ch-grpctrls">'
      + '<button class="ch-grpbtn" data-grpall="1" title="expand group">+</button>'
      + '<button class="ch-grpbtn" data-grpall="0" title="collapse group">\u2212</button>'
      + '</span>'
      + '<span class="chev">\u25be</span></div>'
      + '<div class="ch-foldbody ch-groupbody' + gb + '">' + inner + '</div></div>';
  }).filter(Boolean).join('');

  if (q && !html) html = '<div class="ch-empty">no matches for \u201c' + esc(opts.query.trim()) + '\u201d</div>';
  return '<div class="chstream">' + html + '</div>';
}

var CH = {
  blocks: [], src: '', hideReasoning: true, inspect: false, query: '',
  typeOpen: { user: true, assistant: true, command: false, edit: false, reasoning: false, unmatched: false }
};

function chatHistoryEnter() {
  chatHistoryLoad();
  var rb = document.getElementById('chRefresh');
  if (rb && !rb._wired) { rb._wired = 1; rb.addEventListener('click', chatHistoryLoad); }
  var tb = document.getElementById('chThinking');
  if (tb && !tb._wired) {
    tb._wired = 1;
    tb.addEventListener('click', function () {
      CH.hideReasoning = !CH.hideReasoning;
      tb.classList.toggle('current', !CH.hideReasoning);
      chatHistoryRender();
    });
  }
  var ib = document.getElementById('chInspect');
  if (ib && !ib._wired) {
    ib._wired = 1;
    ib.addEventListener('click', function () {
      CH.inspect = !CH.inspect;
      ib.classList.toggle('current', CH.inspect);
      chatHistoryRender();
    });
  }
  var ea = document.getElementById('chExpandAll');
  if (ea && !ea._wired) { ea._wired = 1; ea.addEventListener('click', function () { chBulkAll(true); }); }
  var ca = document.getElementById('chCollapseAll');
  if (ca && !ca._wired) { ca._wired = 1; ca.addEventListener('click', function () { chBulkAll(false); }); }
  var chips = document.getElementById('chTypeChips');
  if (chips && !chips._wired) {
    chips._wired = 1;
    chips.addEventListener('click', function (e) {
      var btn = e.target.closest('.chtype'); if (!btn) return;
      var t = btn.dataset.type;
      CH.typeOpen[t] = !CH.typeOpen[t];
      chBulkType(t, CH.typeOpen[t]);
      btn.classList.toggle('open', CH.typeOpen[t]);
    });
  }
  var tg = document.getElementById('chTopToggle');
  if (tg && !tg._wired) {
    tg._wired = 1;
    tg.addEventListener('click', function () {
      var top = document.getElementById('chTop');
      var nowCollapsed = top.classList.toggle('collapsed');
      chTopForcedOpen = !nowCollapsed && (window.scrollY || 0) > 4;
      chSyncSticky();
    });
  }
  var sb = document.getElementById('chSearch');
  if (sb && !sb._wired) {
    sb._wired = 1;
    sb.addEventListener('input', function () { CH.query = sb.value; chatHistoryRender(); });
  }
  if (!CH._scrollWired) {
    CH._scrollWired = 1;
    window.addEventListener('scroll', chTopScroll, { passive: true });
    window.addEventListener('resize', chSyncSticky, { passive: true });
  }
  chTopScroll();
  chSyncSticky();
}

async function chatHistoryLoad() {
  var c = document.getElementById('chatHistory');
  c.innerHTML = '<div class="gmuted">loading\u2026</div>';
  try {
    var d = await fetch('/api/aider/history', { cache: 'no-store' }).then(function (r) { return r.json(); });
    if (!d.ok) { c.innerHTML = '<div class="ch-empty">couldn\u2019t read history: ' + esc(d.error || '') + '</div>'; return; }
    if (!d.exists || !(d.text || '').trim()) {
      c.innerHTML = '<div class="ch-empty">No aider chat history yet in this repo.</div>';
      document.getElementById('chMeta').textContent = '';
      CH.blocks = []; CH.src = '';
      return;
    }
    CH.src = (d.text || '').replace(/\r\n/g, '\n');
    CH.blocks = parseAiderHistory(d.text);
    var unmatched = CH.blocks.filter(function (b) { return b.type === 'unmatched'; }).length;
    var lossless = CH.blocks.map(function (b) { return b.raw; }).join('\n') === CH.src;
    document.getElementById('chMeta').textContent =
      fmtBytes(d.size || 0)
      + (d.mtime ? '  \u00b7  ' + new Date(d.mtime * 1000).toLocaleString() : '')
      + '  \u00b7  ' + (lossless ? 'lossless \u2713' : '\u26a0 coverage mismatch')
      + (unmatched ? '  \u00b7  \u26a0 ' + unmatched + ' unparsed' : '');
    chatHistoryRender();
  } catch (e) {
    c.innerHTML = '<div class="ch-empty">error loading history</div>';
  }
}

function chatHistoryRender() {
  var c = document.getElementById('chatHistory');
  c.innerHTML = renderBlocks(CH.blocks, { hideReasoning: CH.hideReasoning, inspect: CH.inspect, typeOpen: CH.typeOpen, query: CH.query });
  c.querySelectorAll('[data-collapse]').forEach(function (head) {
    function toggle() {
      var collapsed = head.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      var body = head.nextElementSibling;
      if (body) body.classList.toggle('hidden');
    }
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  });
  c.querySelectorAll('[data-rawtoggle]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var box = btn.closest('.ch-insp');
      if (!box) return;
      box.querySelector('.ch-insp-parsed').classList.toggle('hidden');
      box.querySelector('.ch-insp-raw').classList.toggle('hidden');
      btn.classList.toggle('current');
    });
  });
  // per-group expand/collapse-all — stop the click from also toggling the group
  c.querySelectorAll('.ch-grpbtn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var head = btn.closest('.ch-grouphead');
      if (head && head.nextElementSibling) chBulkFolds(head.nextElementSibling, btn.dataset.grpall === '1');
    });
  });
  chRenderTypeChips();
  chSyncSticky();
}

// ---- collapse controls (imperative bulk toggles; last action wins) ----
function chFoldSet(head, open) {
  head.classList.toggle('collapsed', !open);
  var b = head.nextElementSibling;
  if (b && b.classList.contains('ch-foldbody')) b.classList.toggle('hidden', !open);
}
function chBulkFolds(scope, open) {
  scope.querySelectorAll('.ch-foldhead').forEach(function (h) { chFoldSet(h, open); });
}
function chBulkType(type, open) {
  var c = document.getElementById('chatHistory'); if (!c) return;
  var cls = CH_CLS[type] || ('ch-' + type);
  c.querySelectorAll('.' + cls + '>.ch-foldhead, .ch-run[data-runtype="' + type + '"]>.ch-foldhead')
    .forEach(function (h) { chFoldSet(h, open); });
}
function chBulkAll(open) {
  var c = document.getElementById('chatHistory'); if (!c) return;
  c.querySelectorAll('.ch-foldhead').forEach(function (h) { chFoldSet(h, open); });
  Object.keys(CH.typeOpen).forEach(function (t) { CH.typeOpen[t] = open; });
  chRenderTypeChips();
}
function chRenderTypeChips() {
  var box = document.getElementById('chTypeChips'); if (!box) return;
  var present = {};
  CH.blocks.forEach(function (b) { if (CH_CLS[b.type] && b.type !== 'reasoning') present[b.type] = 1; });
  var order = ['user', 'assistant', 'command', 'edit', 'unmatched'];
  var disp = { unmatched: 'unparsed' };
  box.innerHTML = order.filter(function (t) { return present[t]; }).map(function (t) {
    var open = chIsOpen(t, { typeOpen: CH.typeOpen });
    return '<button class="chtype' + (open ? ' open' : '') + '" data-type="' + t + '">' + esc(disp[t] || t) + '</button>';
  }).join('');
}

// ---- sticky offsets + auto-collapsing top stack ----
function chSyncSticky() {
  var bar = document.querySelector('header.bar'), top = document.getElementById('chTop');
  var barH = bar ? Math.round(bar.getBoundingClientRect().height) : 54;
  var topH = top ? Math.round(top.getBoundingClientRect().height) : 0;
  var root = document.documentElement.style;
  root.setProperty('--ch-bar-h', barH + 'px');
  root.setProperty('--ch-stick', (barH + topH) + 'px');
}
var chTopForcedOpen = false, chScrollRAF = 0;
function chTopScroll() {
  if (chScrollRAF) return;
  chScrollRAF = requestAnimationFrame(function () {
    chScrollRAF = 0;
    var top = document.getElementById('chTop'); if (!top) return;
    var y = window.scrollY || document.documentElement.scrollTop || 0;
    if (y <= 4) chTopForcedOpen = false;
    top.classList.toggle('collapsed', y > 4 && !chTopForcedOpen);
    chSyncSticky();
  });
}

function restartDashboard() {
  openSheet('restart dashboard', 'Restarts this dashboard server. The screen locks while it goes down and comes back; it reloads automatically once a fresh instance has been answering steadily (usually a few seconds).',
    function () {
      closeSheet();
      var ov = document.getElementById('restartOverlay');
      var sub = document.getElementById('restartSub');
      var manual = document.getElementById('restartManual');
      if (manual) manual.hidden = true;
      ov.hidden = false;
      sub.textContent = 'reading current instance…';

      // Establish the current pid:boot, retrying a few times so one transient
      // failure doesn't leave us with no baseline to compare the new instance against.
      function readBaseline(tries, done) {
        fetch('/api/ping', { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .catch(function () { return null; })
          .then(function (j) {
            if (j) return done(j.pid + ':' + j.boot);
            if (tries > 1) return setTimeout(function () { readBaseline(tries - 1, done); }, 300);
            done(null);
          });
      }

      readBaseline(3, function (oldKey) {
        sub.textContent = 'queuing restart…';
        fetch('/api/system/restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(function () {});

        var started = Date.now();
        var sawDown = false;   // we witnessed the server actually go offline
        var good = 0;          // consecutive healthy answers from a *new* instance

        function check() {
          var secs = Math.round((Date.now() - started) / 1000);
          sub.textContent = (sawDown ? 'fresh instance answering… (' : 'waiting for it to go down… (') + secs + 's)';
          fetch('/api/ping', { cache: 'no-store' })
            .then(function (r) { if (!r.ok) throw 0; return r.json(); })
            .then(function (j) {
              var key = j.pid + ':' + j.boot;
              var isNew = (oldKey === null) || (key !== oldKey);
              // Only trust an answer once the port has actually gone down AND the
              // responder reports a different pid:boot than the one we started on.
              // Two in a row confirms it's serving steadily, not a half-warmed bind.
              if (sawDown && isNew) {
                if (++good >= 2) {
                  sub.textContent = 'back up — reloading';
                  setTimeout(function () { location.reload(); }, 400);
                  return;
                }
              } else {
                good = 0;
              }
              setTimeout(check, 700);
            })
            .catch(function () { sawDown = true; good = 0; setTimeout(check, 700); });
        }

        setTimeout(check, 500);   // start early so we don't miss the outage
        setTimeout(function () { if (manual && !ov.hidden) manual.hidden = false; }, 25000);
      });
    });
}

async function systemLoad() {
  var info = await fetch('/api/system').then(function (r) { return r.json(); }).catch(function () { return null; });
  renderSystem(info);
  var pr = await fetch('/api/system/procs').then(function (r) { return r.json(); }).catch(function () { return { procs: [] }; });
  renderProcs(pr.procs || []);
}

function systemPoll() {
  if (location.hash !== '#system') return;
  systemLoad().then(function () { if (location.hash === '#system') SYS.timer = setTimeout(systemPoll, 3000); });
}

function systemEnter() { clearTimeout(SYS.timer); systemPoll(); }

/* ===================== aider config (Phase 1a: store + catalogs) ========== */
var AID = { store: null };
var BP = { index: -1, files: [], origName: '', opts: {}, keys: { arch: '', editor: '', weak: '' } };

function yamlVal(v) {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  var s = String(v);
  if (/[:#]/.test(s) || /^\s|\s$/.test(s)) return '"' + s.replace(/"/g, '\\"') + '"';
  return s;
}

function effectiveHTML(eff) {
  var prov = {};
  ['base', 'roles', 'blueprint', 'override'].forEach(function (layer) {
    var tag = layer === 'roles' ? 'role' : layer;
    Object.keys(eff.layers[layer] || {}).forEach(function (k) { prov[k] = tag; });
  });
  var lines = Object.keys(eff.options).sort().map(function (k) {
    var v = eff.options[k], tag = prov[k] || 'base';
    var chip = '<span class="efftag eff-' + tag + '">' + tag + '</span>';
    if (Array.isArray(v)) {
      var head = '<div class="yline"><span class="ytext">' + esc(k) + ':</span>' + chip + '</div>';
      return head + v.map(function (it) { return '<div class="yline"><span class="ytext">  - ' + esc(yamlVal(it)) + '</span></div>'; }).join('');
    }
    return '<div class="yline"><span class="ytext">' + esc(k) + ': ' + esc(yamlVal(v)) + '</span>' + chip + '</div>';
  }).join('');
  var extra = '';
  if (eff.flags) extra += '<div class="yline ycomment"><span class="ytext"># + cli flags: ' + esc(eff.flags) + '</span></div>';
  if (eff.files) extra += '<div class="yline ycomment"><span class="ytext"># + files: ' + esc(eff.files) + '</span></div>';
  return '<div class="effview"><div class="effh">.aider.conf.yml — effective for ' + esc(eff.name) + '</div>'
    + layerLegendHTML()
    + '<div class="yaml">' + (lines || '<div class="gmuted"># no options set</div>') + extra + '</div></div>';
}

function aiderToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'aider' }); }

function aiderPost(path, body) { return lkApi('aider/' + path, body, { source: 'aider' }); }

function aiderEnter() { aiderLoad(); }

async function aiderLoad() {
  var body = document.getElementById('aiderBody');
  try {
    var res = await fetch('/api/aider/store', { cache: 'no-store' });
    AID.store = await res.json();
  } catch (e) { body.innerHTML = '<div class="gmuted">could not load config store</div>'; return; }
  aiderRender();
}

function fieldInput(f, val, listRef) {
  val = val || '';
  if (f.type === 'score') return '<input class="hinput af" data-f="' + f.name + '" data-score="1" inputmode="numeric" maxlength="1" pattern="[0-9]" value="' + escAttr(val) + '" oninput="this.value=this.value.replace(/[^0-9]/g,\'\').slice(0,1)">';
  if (f.type === 'bool01') return '<select class="hinput af" data-f="' + f.name + '"><option value="0"' + (val === '1' ? '' : ' selected') + '>0 — no value</option><option value="1"' + (val === '1' ? ' selected' : '') + '>1 — takes value</option></select>';
  var dl = f.suggest ? ' list="dl-' + f.suggest + '"' : '';
  return '<input class="hinput af" data-f="' + f.name + '"' + dl + ' value="' + escAttr(val) + '" autocapitalize="off" autocorrect="off" spellcheck="false">';
}

function editPanelHTML(fields, row) {
  var inner = fields.map(function (f) {
    return '<label class="afield"><span>' + esc(f.name) + '</span>' + fieldInput(f, row ? row[fields.indexOf(f)] : '') + '</label>';
  }).join('');
  return '<div class="aedit" hidden>' + inner + '<div class="af-act"><button class="clink asave" data-write>save</button><button class="clink acancel">cancel</button></div></div>';
}

var ASEC = [
  { id: 'blueprints', title: 'Blueprints', sub: 'launch configurations' },
  { id: 'defaults', title: 'Defaults', sub: 'base → blueprint → override' },
  { id: 'blocks', title: 'Building blocks', sub: 'models · flags · files' },
  { id: 'keys', title: 'API keys', sub: 'keys.list' },
];
var ASEC_DEFAULT_OPEN = { blueprints: true };

function aiderOpenState() {
  var st = {};
  try { st = JSON.parse(localStorage.getItem('aiderSections') || '{}') || {}; } catch (e) { st = {}; }
  var out = {};
  ASEC.forEach(function (s) { out[s.id] = (s.id in st) ? !!st[s.id] : !!ASEC_DEFAULT_OPEN[s.id]; });
  return out;
}
function aiderSaveOpen(st) { try { localStorage.setItem('aiderSections', JSON.stringify(st)); } catch (e) {} }

function aiderRender() {
  var d = AID.store, body = document.getElementById('aiderBody');
  var dls = '';
  (d.order || []).forEach(function (n) {
    (d.lists[n].fields || []).forEach(function (f) {
      if (f.suggest && d.lists[f.suggest]) {
        var opts = (d.lists[f.suggest].rows || []).map(function (r) { return '<option value="' + escAttr(r[0]) + '">'; }).join('');
        dls += '<datalist id="dl-' + f.suggest + '">' + opts + '</datalist>';
      }
    });
  });
  var head = '<div class="aintro">Configuration store <span class="mono">' + esc(d.dir) + '</span>'
    + (d.exists ? '' : ' <span class="fbadge warn">will be created on first add</span>')
    + '<div class="gmuted">Read by aider at launch. Writes lock while aider runs.</div></div>';

  var open = aiderOpenState();
  var nav = '<div class="asecnav">' + ASEC.map(function (s) {
    return '<button class="aseclink" data-go="' + s.id + '">' + esc(s.title) + '</button>';
  }).join('') + '<button class="aseclink aexpand" data-all="1">expand all</button><button class="aseclink aexpand" data-all="0">collapse all</button></div>';

  var sections = ASEC.map(function (s) {
    var isOpen = open[s.id];
    return '<section class="asec" data-sec="' + s.id + '"' + (isOpen ? ' data-open="1"' : '') + '>'
      + '<button class="asec-head" aria-expanded="' + (isOpen ? 'true' : 'false') + '"><span class="asec-chev">' + (isOpen ? '▾' : '▸') + '</span>'
      + '<span class="asec-title">' + esc(s.title) + '</span><span class="asec-sub gmuted">' + esc(s.sub) + '</span></button>'
      + '<div class="asec-body">' + (isOpen ? sectionBodyHTML(s.id) : '') + '</div></section>';
  }).join('');

  body.innerHTML = dls + head + nav + sections;
  body.querySelectorAll('.asec').forEach(function (sec) {
    sec.querySelector('.asec-head').addEventListener('click', function () { toggleSection(sec.dataset.sec); });
    if (sec.dataset.open) wireSection(sec.dataset.sec, sec.querySelector('.asec-body'));
  });
  body.querySelectorAll('.aseclink[data-go]').forEach(function (b) { b.addEventListener('click', function () { gotoSection(b.dataset.go); }); });
  body.querySelectorAll('.aseclink[data-all]').forEach(function (b) { b.addEventListener('click', function () { setAllSections(b.dataset.all === '1'); }); });
}

var SECTION_DESC = {
  blueprints: 'A blueprint is one launch configuration — which model plays each role, plus flag-sets, files and aider options. The top blueprint is the default. Build or edit one, then Preview to see exactly what would run.',
  defaults: 'Options here layer around every blueprint. Base is the floor a blueprint can override; Override always wins over the blueprint. Effective order: base → blueprint → override.',
  blocks: 'The reference data blueprints are built from. You rarely edit these directly.',
  keys: 'API keys live in keys.list. Each is a reference, a supplier var (e.g. GEMINI_API_KEY), the key, and a note. A blueprint attaches keys by reference; at launch the keys are written to the repo’s .env. Values are masked here.',
  tools: 'Live provider integrations, added after the config layer: aider’s own tools first, then OpenRouter, then others.',
};

function sectionBodyHTML(id) {
  var desc = SECTION_DESC[id] ? '<div class="asec-desc gmuted">' + esc(SECTION_DESC[id]) + '</div>' : '';
  if (id === 'blueprints') return desc + blueprintsCardHTML();
  if (id === 'defaults') return desc + layerLegendHTML() + defaultsCardHTML();
  if (id === 'blocks') return desc + blocksBodyHTML();
  if (id === 'keys') return desc + keysCardHTML();
  if (id === 'tools') return desc + placeholdersHTML();
  return '';
}

function layerLegendHTML() {
  return '<div class="efflegend"><span class="efftag eff-base">base</span><span class="efftag eff-role">role</span>'
    + '<span class="efftag eff-blueprint">blueprint</span><span class="efftag eff-override">override</span>'
    + '<span class="gmuted">later layers win</span></div>';
}

function wireSection(id, scope) {
  if (id === 'blueprints') wireBlueprints(scope);
  else if (id === 'defaults') wireDefaults(scope);
  else if (id === 'blocks') wireBlocks(scope);
  else if (id === 'keys') wireKeys(scope);
}

function toggleSection(id) {
  var st = aiderOpenState();
  var sec = document.querySelector('.asec[data-sec="' + id + '"]');
  var bodyEl = sec.querySelector('.asec-body');
  var nowOpen = !st[id];
  st[id] = nowOpen; aiderSaveOpen(st);
  sec.querySelector('.asec-chev').textContent = nowOpen ? '▾' : '▸';
  sec.querySelector('.asec-head').setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
  if (nowOpen) { sec.dataset.open = '1'; bodyEl.innerHTML = sectionBodyHTML(id); wireSection(id, bodyEl); }
  else { delete sec.dataset.open; bodyEl.innerHTML = ''; }
}

function gotoSection(id) {
  var st = aiderOpenState();
  if (!st[id]) toggleSection(id);
  var sec = document.querySelector('.asec[data-sec="' + id + '"]');
  if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function setAllSections(open) {
  var st = {};
  ASEC.forEach(function (s) { st[s.id] = open; });
  aiderSaveOpen(st);
  aiderRender();
}

function blocksBodyHTML() {
  return blocksSubgroup('Models', ['models', 'modelstrings'], 'A model gives an id to a model string; blueprints pick models by id.')
    + blocksSubgroup('Flags', ['flags', 'aiderflags'], 'Flag-sets are built from the aider-flag catalog, then attached to a blueprint.')
    + blocksSubgroup('Files', ['files', 'filemodes'], 'A file pairs with a mode (--read / --file) inside a blueprint.')
    + blocksSubgroup('Environment', ['envvars'], 'Reference catalog of provider env-var names.');
}
function blocksSubgroup(title, names, desc) {
  return '<div class="ablock"><div class="ablock-h">' + esc(title) + '</div><div class="ablock-d gmuted">' + esc(desc) + '</div>'
    + names.map(function (n) { return listCardHTML(n, AID.store.lists[n]); }).join('') + '</div>';
}

function keysCardHTML() {
  var ks = AID.store.keys || { rows: [], path: '' };
  var rows = (ks.rows || []).map(function (k) {
    return '<div class="arow" data-nick="' + escAttr(k.nick) + '">'
      + '<div class="acells"><span class="mono">' + esc(k.nick) + '</span> '
      + '<span class="keychip">' + esc(k.var) + '</span> '
      + (k.present ? '<span class="gmuted">' + esc(k.masked) + '</span>' : '<span class="fbadge warn">not set</span>')
      + (k.desc ? ' <span class="gmuted">' + esc(k.desc) + '</span>' : '') + '</div>'
      + '<div class="aactions"><button class="clink keyedit-btn" data-write>edit</button><button class="clink danger keydel-btn" data-write>del</button></div>'
      + '<div class="aedit" hidden>'
      + '<label class="afield"><span>supplier var</span><input class="hinput akeyvar" value="' + escAttr(k.var) + '" autocapitalize="characters" autocorrect="off" spellcheck="false"></label>'
      + '<label class="afield"><span>key (blank = keep)</span><input class="hinput akeytok" type="password" autocomplete="off" placeholder="\u2022\u2022\u2022 unchanged"></label>'
      + '<label class="afield"><span>note</span><input class="hinput akeydesc" value="' + escAttr(k.desc || '') + '"></label>'
      + '<div class="af-act"><button class="clink keysave" data-write>save</button><button class="clink acancel">cancel</button></div></div>'
      + '</div>';
  }).join('');
  return '<div class="alist" data-list="keys"><div class="card-h">API keys <span class="gmuted mono">' + esc(ks.path) + '</span>'
    + '<button class="clink aaddkey" data-write>+ key</button></div>'
    + '<div class="aaddkeyrow" hidden>'
    + '<label class="afield"><span>reference</span><input class="hinput akeynick" placeholder="gem1_key1" autocorrect="off" spellcheck="false"></label>'
    + '<label class="afield"><span>supplier var</span><input class="hinput akeyvar" placeholder="GEMINI_API_KEY" autocapitalize="characters" autocorrect="off" spellcheck="false"></label>'
    + '<label class="afield"><span>key</span><input class="hinput akeytok" type="password" autocomplete="off"></label>'
    + '<label class="afield"><span>note</span><input class="hinput akeydesc" placeholder="optional"></label>'
    + '<div class="af-act"><button class="clink keyaddsave" data-write>save</button><button class="clink acancel">cancel</button></div></div>'
    + '<div class="arows">' + (rows || '<div class="gmuted">no keys yet</div>') + '</div></div>';
}

function placeholdersHTML() {
  return '<div class="placeholder aext">aider tools — version, model list, launch check <span class="aext-tag">next</span></div>'
    + '<div class="placeholder aext">OpenRouter — live catalog &amp; quota <span class="aext-tag">planned</span></div>'
    + '<div class="placeholder aext">Other providers <span class="aext-tag">planned</span></div>';
}

function optionWidgetHTML(o, val) {
  var has = val !== undefined;
  if (o.type === 'bool') {
    var b = has ? (val ? 'true' : 'false') : '';
    return '<select class="opt" data-opt="' + o.key + '" data-type="bool">'
      + '<option value=""' + (b === '' ? ' selected' : '') + '>— unset —</option>'
      + '<option value="true"' + (b === 'true' ? ' selected' : '') + '>true</option>'
      + '<option value="false"' + (b === 'false' ? ' selected' : '') + '>false</option></select>';
  }
  if (o.type === 'enum') {
    return '<select class="opt" data-opt="' + o.key + '" data-type="enum"><option value=""' + (has ? '' : ' selected') + '>— unset —</option>'
      + (o.enum || []).map(function (e) { return '<option value="' + escAttr(e) + '"' + (val === e ? ' selected' : '') + '>' + esc(e) + '</option>'; }).join('') + '</select>';
  }
  if (o.type === 'int') {
    return '<input class="opt hinput" data-opt="' + o.key + '" data-type="int" inputmode="numeric" value="' + (has ? escAttr(String(val)) : '') + '" placeholder="unset">';
  }
  if (o.type === 'list') {
    var text = has && Array.isArray(val) ? val.join('\n') : '';
    return '<textarea class="opt hinput" data-opt="' + o.key + '" data-type="list" rows="2" placeholder="one per line; empty = unset" autocapitalize="off" autocorrect="off" spellcheck="false">' + esc(text) + '</textarea>';
  }
  return '<input class="opt hinput" data-opt="' + o.key + '" data-type="text" value="' + (has ? escAttr(String(val)) : '') + '" placeholder="unset" autocapitalize="off" autocorrect="off" spellcheck="false">';
}

function optionsEditorHTML(values) {
  values = values || {};
  var reg = AID.store.options_registry || [];
  var groups = [];
  reg.forEach(function (o) { if (groups.indexOf(o.group) < 0) groups.push(o.group); });
  var bar = '<div class="opttoolbar"><input class="hinput optsearch" placeholder="filter options…" autocapitalize="off" autocorrect="off" spellcheck="false">'
    + '<label class="optonlyset"><input type="checkbox" class="optset"> only set</label></div>';
  return '<div class="optseditor">' + bar + groups.map(function (g) {
    var inGroup = reg.filter(function (o) { return o.group === g; });
    var setCount = inGroup.filter(function (o) { return values[o.key] !== undefined; }).length;
    var rows = inGroup.map(function (o) {
      var warnOpen = (o.safe && values[o.key] === true);
      var warn = o.safe ? '<div class="optwarn"' + (warnOpen ? '' : ' hidden') + '>⚠ ' + esc(o.safe) + '</div>' : '';
      var meta = '<div class="optmeta"><span class="mono">' + esc(o.cli || ('--' + o.key)) + '</span>'
        + (o.default ? ' <span class="optdef">default: ' + esc(o.default) + '</span>' : '')
        + (o.safe ? ' <span class="optsafe">safety</span>' : '')
        + ((AID.store.docs_url) ? ' <a class="optdocs" href="' + escAttr(AID.store.docs_url) + '" target="_blank" rel="noopener">docs ↗</a>' : '')
        + '</div>';
      return '<div class="optrow" data-search="' + escAttr((o.key + ' ' + o.help).toLowerCase()) + '"><div class="optlabel"><span class="mono">' + esc(o.key) + '</span>'
        + '<div class="opthelp">' + esc(o.help) + '</div>' + meta + '</div>'
        + optionWidgetHTML(o, values[o.key]) + warn + '</div>';
    }).join('');
    return '<details class="optgroup"><summary>' + esc(g) + (setCount ? ' <span class="optcount">' + setCount + ' set</span>' : '') + '</summary>' + rows + '</details>';
  }).join('') + '</div>';
}

function collectOptions(container) {
  var out = {};
  container.querySelectorAll('.opt').forEach(function (el) {
    var key = el.dataset.opt, t = el.dataset.type, v = el.value;
    if (t === 'bool') { if (v === 'true') out[key] = true; else if (v === 'false') out[key] = false; }
    else if (t === 'enum') { if (v) out[key] = v; }
    else if (t === 'int') { v = v.trim(); if (v !== '') { var n = parseInt(v, 10); if (!isNaN(n)) out[key] = n; } }
    else if (t === 'list') { var arr = v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean); if (arr.length) out[key] = arr; }
    else { v = v.trim(); if (v !== '') out[key] = v; }
  });
  return out;
}

function optIsSet(row) {
  var el = row.querySelector('.opt');
  if (!el) return false;
  var t = el.dataset.type, v = el.value;
  if (t === 'bool') return v === 'true' || v === 'false';
  if (t === 'list') return v.trim() !== '';
  return v.trim() !== '';
}

function wireOptions(container) {
  container.querySelectorAll('select.opt[data-type="bool"]').forEach(function (sel) {
    var warn = sel.parentElement.querySelector('.optwarn');
    if (warn) sel.addEventListener('change', function () { warn.hidden = sel.value !== 'true'; });
  });
  var editor = container.querySelector('.optseditor') || (container.classList && container.classList.contains('optseditor') ? container : null);
  if (!editor) editor = container;
  var search = editor.querySelector('.optsearch');
  var onlySet = editor.querySelector('.optset');
  if (!search && !onlySet) return;
  function apply() {
    var q = (search && search.value.trim().toLowerCase()) || '';
    var setOnly = onlySet && onlySet.checked;
    var filtering = q || setOnly;
    editor.querySelectorAll('.optgroup').forEach(function (g) {
      var anyVisible = false;
      g.querySelectorAll('.optrow').forEach(function (row) {
        var matchQ = !q || (row.dataset.search || '').indexOf(q) >= 0;
        var matchSet = !setOnly || optIsSet(row);
        var show = matchQ && matchSet;
        row.hidden = !show;
        if (show) anyVisible = true;
      });
      g.hidden = filtering && !anyVisible;
      if (filtering) g.open = anyVisible;
    });
  }
  if (search) search.addEventListener('input', apply);
  if (onlySet) onlySet.addEventListener('change', apply);
}

function defaultsCardHTML() {
  var d = AID.store.defaults || { base: {}, override: {} };
  return '<div class="alist" data-defaults="1"><div class="card-h">Defaults <span class="gmuted">base → blueprint → override</span></div>'
    + '<details class="defsec"><summary>Base <span class="gmuted">a blueprint overrides these</span></summary>'
    + '<div class="defwrap" data-scope="base">' + optionsEditorHTML(d.base) + '</div>'
    + '<div class="af-act"><button class="clink defsave" data-scope="base" data-write>save base</button></div></details>'
    + '<details class="defsec"><summary>Override <span class="gmuted">these win over the blueprint</span></summary>'
    + '<div class="defwrap" data-scope="override">' + optionsEditorHTML(d.override) + '</div>'
    + '<div class="af-act"><button class="clink defsave" data-scope="override" data-write>save override</button></div></details>'
    + '</div>';
}

function bpModelStr(id) {
  if (!id) return '';
  var r = (AID.store.lists.models.rows || []).find(function (x) { return x[0] === id; });
  return r ? r[1] : id;
}

// Mirrors storage.py provider_env_var: first path segment + _API_KEY.
function bpProviderVar(modelId) {
  var ms = bpModelStr(modelId);
  if (!ms) return '';
  var i = ms.indexOf('/');
  var prov = i >= 0 ? ms.slice(0, i) : 'openai';
  return prov.toUpperCase() + '_API_KEY';
}

// Render a key control per role, driven by that role's (effective) model provider:
// 0 keys -> warning, 1 key -> auto, 2+ -> a dropdown limited to that provider.
function renderBpKeys(panel) {
  var body = panel.querySelector('.bpkeys-body');
  if (!body) return;
  var sel = {
    arch: panel.querySelector('.bpf-arch').value,
    editor: panel.querySelector('.bpf-editor').value,
    weak: panel.querySelector('.bpf-weak').value,
  };
  var keyRows = (AID.store.keys && AID.store.keys.rows) || [];
  body.innerHTML = ['arch', 'editor', 'weak'].map(function (role) {
    var own = sel[role];
    var inherit = role !== 'arch' && !own;
    var eff = role === 'arch' ? own : (own || sel.arch);
    var label = role + (inherit ? ' <span class="adot">↳</span>' : '');
    if (!eff) {
      BP.keys[role] = '';
      return '<div class="bpkrow"><span class="bpklabel">' + label + '</span><div class="bpkbody gmuted">choose architect first</div></div>';
    }
    var vvar = bpProviderVar(eff);
    var matches = keyRows.filter(function (k) { return k.var === vvar; });
    var chip = '<span class="keychip">' + esc(vvar) + '</span>';
    var ctrl;
    if (matches.length === 0) {
      BP.keys[role] = '';
      ctrl = '<span class="fbadge warn">no key</span>';
    } else if (matches.length === 1) {
      BP.keys[role] = matches[0].nick;
      ctrl = '<span class="gmuted">' + esc(matches[0].nick) + (matches[0].present ? '' : ' <span class="fbadge warn">not set</span>') + '</span>';
    } else {
      var cur = BP.keys[role];
      if (!matches.some(function (k) { return k.nick === cur; })) cur = matches[0].nick;
      BP.keys[role] = cur;
      ctrl = '<select class="hinput bpf-key" data-role="' + role + '">' + matches.map(function (k) {
        return '<option value="' + escAttr(k.nick) + '"' + (k.nick === cur ? ' selected' : '') + '>' + esc(k.nick) + (k.present ? '' : ' (not set)') + '</option>';
      }).join('') + '</select>';
    }
    return '<div class="bpkrow"><span class="bpklabel">' + label + '</span><div class="bpkbody">' + chip + ctrl + '</div></div>';
  }).join('');
  body.querySelectorAll('.bpf-key').forEach(function (s) {
    s.addEventListener('change', function () { BP.keys[s.dataset.role] = s.value; });
  });
}

function launcherBarHTML() {
  var bps = (AID.store && AID.store.blueprints) || [];
  var ready = [];
  bps.forEach(function (b, i) {
    var ok = !!(b.readiness && b.readiness.length && b.readiness.every(function (r) { return r.present; }));
    if (ok) ready.push({ i: i, name: b.name });
  });
  var running = document.body.classList.contains('aider-active');
  var defReady = ready.some(function (x) { return x.i === 0; });
  var preName = defReady ? bps[0].name : (ready.length ? ready[0].name : '');
  var opts = '<option value="">— no blueprint —</option>' + ready.map(function (x) {
    return '<option value="' + escAttr(x.name) + '"' + (x.name === preName ? ' selected' : '') + '>'
      + esc(x.name) + (x.i === 0 ? ' (default)' : '') + '</option>';
  }).join('');
  var note = ready.length ? '' : '<div class="gmuted launch-note">No ready blueprint — finish one (models + keys) on the aider tab.</div>';
  return '<div class="launchbar" data-launch="bar">'
    + '<select id="launchSelect" class="hinput" data-write' + (running ? ' disabled' : '') + '>' + opts + '</select>'
    + '<button id="launchBtn" class="clink launchbtn" data-write' + (running || !preName ? ' disabled' : '') + '>launch</button>'
    + '</div>' + note;
}

// Drives the Live tab from each poll: launcher enable/disable + the session banner.
function syncLive(aider) {
  aider = aider || { active: false, pids: [] };
  var sel = document.getElementById('launchSelect');
  var btn = document.getElementById('launchBtn');
  if (sel && btn) {
    sel.disabled = aider.active;
    btn.disabled = aider.active || !sel.value;
  }
  var sp = document.getElementById('liveSession');
  if (sp) {
    if (aider.active) {
      var bits = [];
      if (aider.blueprint) bits.push(esc(aider.blueprint));
      bits.push('session ' + esc(aider.session || 'la-aider'));
      if (aider.started) bits.push('up ' + esc(fmtDur((Date.now() / 1000) - aider.started)));
      if (aider.pids && aider.pids.length) bits.push('pid ' + esc(aider.pids.join(', ')));
      sp.className = 'live-session running';
      sp.innerHTML = '<span class="live-dot"></span><span>running — ' + bits.join(' <span class="adot">·</span> ') + '</span>';
    } else {
      sp.className = 'live-session idle';
      sp.innerHTML = '<span class="live-dot"></span><span class="gmuted">no session running</span>';
    }
  }
  // Live output stream: follow while running, release when idle/away.
  if (document.getElementById('liveLog')) {
    if (aider.active) liveStreamStart(); else liveStreamStop();
  }
  var inWrap = document.getElementById('liveInputWrap');
  if (inWrap) inWrap.hidden = !aider.active;
  // swap the shared panel: launcher when idle, session info when live (collapse stays manual)
  var launchPane = document.getElementById('liveLaunchPane'), sessPane = document.getElementById('liveSessionPane');
  if (launchPane) launchPane.hidden = !!aider.active;
  if (sessPane) sessPane.hidden = !aider.active;
  if (!aider.active) liveSheetClose();
}

function liveEnter() {
  var body = document.getElementById('liveBody');
  if (!body) return; // index.html has no #live section yet
  if (AID.store) { liveRender(); return; }
  body.innerHTML = '<div class="gmuted" style="padding:1rem">loading…</div>';
  fetch('/api/aider/store', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (j) { AID.store = j; liveRender(); })
    .catch(function () { body.innerHTML = '<div class="gmuted" style="padding:1rem">could not load blueprints.</div>'; });
}

function liveRender() {
  var body = document.getElementById('liveBody');
  if (!body) return;
  body.innerHTML =
    '<div class="alist live-card"><div class="card-h">Session'
    + '<button class="info-i" data-info="sessInfo" aria-label="info">\u24d8</button>'
    + '<button class="card-fold" data-cardfold="liveCardBody" aria-label="collapse">\u25be</button></div>'
    + '<div class="card-info" id="sessInfo" hidden>When idle this panel launches a blueprint — it writes the effective <span class="mono">.aider.conf.yml</span> (forced <span class="mono">--no-pretty</span>) and launches it in a tmux session via the configured engine. While live it shows the running session and model. <span class="mono">view</span> toggles rendered \u21c4 raw; the <span class="mono">\u22ef</span> menu holds commands, files and session controls; <span class="mono">\u2328</span> is a symbol keyboard. Attach with <span class="mono">tmux attach -t la-aider</span>.</div>'
    + '<div class="card-foldbody" id="liveCardBody">'
    + '<div id="liveLaunchPane">' + launcherBarHTML() + '</div>'
    + '<div id="liveSessionPane" hidden>'
    + '<div id="liveSession" class="live-session idle"><span class="live-dot"></span><span class="gmuted">no session running</span></div>'
    + '<div id="liveSessInfo" class="live-sessinfo"></div>'
    + '</div></div>'
    + '<div id="liveState" class="live-state" hidden></div>'
    + '<div class="live-toolbar"><button id="liveFontDn" class="lc-btn" title="smaller text">A\u2212</button>'
    + '<button id="liveFontUp" class="lc-btn" title="larger text">A+</button>'
    + '<button id="liveKbdToggle" class="lc-btn" title="symbol keyboard">\u2328</button>'
    + '<button id="liveViewToggle" class="lc-btn" title="rendered / raw">view: raw</button>'
    + '<button id="liveZen" class="lc-btn" title="full-screen reading">\u26f6</button>'
    + '<button id="liveFilesBtn" class="lc-btn ls-filesbtn" data-opensheet="files" title="files in chat">files 0</button></div>'
    + '<div id="liveRendered" class="live-rendered"><div id="liveCommitted"></div><div id="liveTail"></div></div>'
    + '<div id="liveLog" class="live-log" hidden></div>'
    + '<div id="liveKbd" class="live-kbd" hidden></div>'
    + '<div id="liveInputWrap" class="live-inputwrap" hidden>'
    + '<button id="liveSheetBtn" class="lc-btn live-menu" title="commands & controls" aria-label="menu">\u22ef</button>'
    + '<input id="liveInput" class="hinput" placeholder="message aider… (Enter to send)" autocapitalize="off" autocorrect="off" spellcheck="false">'
    + '<button id="liveSend" class="clink launchbtn">send</button>'
    + '</div>'
    + '</div>'
    + '<div id="liveSheet" class="sheet" hidden>'
    + '<div class="sheet-scrim" data-sheetclose></div>'
    + '<div class="sheet-panel">'
    + '<div class="sheet-tabs">'
    + '<button class="sheet-tab on" data-tab="cmd">commands</button>'
    + '<button class="sheet-tab" data-tab="files">files</button>'
    + '<button class="sheet-tab" data-tab="session">session</button>'
    + '<button class="sheet-close" data-sheetclose aria-label="close">\u00d7</button>'
    + '</div>'
    + '<div class="sheet-body">'
    + '<div class="sheet-pane" data-pane="cmd">'
    + '<div id="cmdTip" class="cmd-tip" hidden></div>'
    + '<div id="cmdPalette" class="cmd-palette"></div>'
    + '</div>'
    + '<div class="sheet-pane" data-pane="files" hidden>'
    + '<div id="liveFileAdd" class="live-fileadd">'
    + '<input id="liveAddInput" class="hinput" placeholder="path to add…" autocapitalize="off" autocorrect="off" spellcheck="false">'
    + '<button id="liveAddBtn" class="clink lc-btn">/add</button>'
    + '<button id="liveAddRoBtn" class="clink lc-btn">/read-only</button>'
    + '</div>'
    + '<div id="liveFiles" class="live-files"></div>'
    + '</div>'
    + '<div class="sheet-pane" data-pane="session" hidden>'
    + '<div id="liveControls" class="live-controls">'
    + '<button id="liveInterrupt" class="clink lc-btn">interrupt (Ctrl-C)</button>'
    + '<button id="liveExit" class="clink lc-btn">/exit</button>'
    + '<button id="liveTerm" class="clink lc-btn lc-warn">end aider (PID)</button>'
    + '<button id="liveKill" class="clink lc-btn lc-bad">kill session</button>'
    + '</div>'
    + '</div></div></div>';
  wireLive(body);
  wireCmd(body);
  // restore both views from persisted state (survives tab switches)
  var lg0 = document.getElementById('liveLog');
  if (lg0) lg0.textContent = LIVE.buffer;
  var cm = document.getElementById('liveCommitted');
  if (cm) cm.innerHTML = LIVE.committedHtml;
  var rd = document.getElementById('liveRendered');
  if (rd) rd.addEventListener('click', liveFoldClick); // one delegated handler for [data-collapse]
  var ls = document.getElementById('liveState');
  if (ls) ls.addEventListener('click', liveStateClick); // confirmation responses + open-files
  var lf = document.getElementById('liveFiles');
  if (lf) lf.addEventListener('click', liveStateClick);  // drop-file buttons
  ['liveLog', 'liveRendered'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.onscroll = function () { LIVE.stick = (el.scrollTop + el.clientHeight >= el.scrollHeight - 8); };
  });
  if (window.visualViewport && !LIVE._vvBound) {
    LIVE._vvBound = true;
    window.visualViewport.addEventListener('resize', liveZenViewport);
    window.visualViewport.addEventListener('scroll', liveZenViewport);
  }
  liveRenderedUpdate();      // commit any completed turns + build the in-flight tail
  liveApplyView();
  applyLiveFont();
  LIVE.stick = true; liveScrollBottom();
  syncLive((window._lastAider) || { active: document.body.classList.contains('aider-active'), pids: [] });
}

// Delegated fold toggle for the rendered view (committed DOM is append-only, so a single
// listener beats re-attaching per element).
function liveFoldClick(e) {
  var head = e.target.closest && e.target.closest('[data-collapse]');
  if (!head || !document.getElementById('liveRendered').contains(head)) return;
  head.classList.toggle('collapsed');
  var body = head.nextElementSibling;
  if (body) body.classList.toggle('hidden');
}

// Render the catalog as a palette: pinned commands first, each with pin (★) and help (?) toggles.
function renderCmdPalette() {
  var el = document.getElementById('cmdPalette');
  if (!el) return;
  var pins = CMD.pins;
  var cmds = AIDER_COMMANDS.slice().sort(function (a, b) {
    var pa = pins.indexOf(a.name), pb = pins.indexOf(b.name);
    if ((pa >= 0) !== (pb >= 0)) return pa >= 0 ? -1 : 1; // pinned first
    if (pa >= 0 && pb >= 0) return pa - pb;               // by pin order
    return 0;                                             // otherwise catalog order
  });
  el.innerHTML = cmds.map(function (c) {
    var pinned = pins.indexOf(c.name) >= 0;
    var chips = c.name === '/chat-mode'
      ? '<div class="cmd-vals">' + ['code', 'ask', 'architect', 'context'].map(function (v) {
          return '<button class="cmd-val" data-val="/chat-mode ' + v + '">' + v + '</button>';
        }).join('') + '</div>' : '';
    return '<div class="cmd-item">'
      + '<button class="cmd-pick" data-pick="' + esc(c.name) + '">' + esc(c.name) + '</button>'
      + '<button class="cmd-star' + (pinned ? ' on' : '') + '" data-star="' + esc(c.name) + '" title="pin">\u2605</button>'
      + '<button class="cmd-help" data-help="' + esc(c.name) + '" title="help">?</button>'
      + '<div class="cmd-helprow" data-helprow="' + esc(c.name) + '" hidden>'
      + '<span class="cmd-args mono">' + esc(c.args || '(no args)') + '</span> — ' + esc(c.help) + chips
      + '</div></div>';
  }).join('');
}

// Contextual nudge based on reduced state — tappable to stage the suggested command.
function liveCmdTip(st) {
  var el = document.getElementById('cmdTip');
  if (!el) return;
  var cmd = '', label = '';
  if (st && !st.pending) {
    if (!st.files.length) { cmd = '/add '; label = 'no files in chat — add one to start'; }
    else if (st.mode === 'architect') { cmd = '/code'; label = 'architect mode — /code to make edits directly'; }
  }
  if (label) { el.innerHTML = '<button class="cmd-tipbtn" data-tipcmd="' + esc(cmd) + '">tip</button> ' + esc(label); el.hidden = false; }
  else { el.hidden = true; el.innerHTML = ''; }
}

function wireCmd(scope) {
  var pal = scope.querySelector('#cmdPalette');
  var tip = scope.querySelector('#cmdTip');
  // Stage the chosen command into the main message input, then close the sheet so the
  // user reviews/sends from the single send row (no second input line).
  function stage(text) {
    var inp = document.getElementById('liveInput');
    if (!inp) return;
    inp.value = text;
    liveSheetClose();
    inp.focus();
  }
  if (pal) pal.addEventListener('click', function (e) {
    var t = e.target, b;
    if ((b = t.closest('[data-pick]'))) {
      var c = aiderCommand(b.getAttribute('data-pick'));
      stage(c && c.args ? c.name + ' ' : (c ? c.name : b.getAttribute('data-pick')));
    } else if ((b = t.closest('[data-val]'))) {
      stage(b.getAttribute('data-val'));
    } else if ((b = t.closest('[data-star]'))) {
      var name = b.getAttribute('data-star'), k = CMD.pins.indexOf(name);
      if (k >= 0) CMD.pins.splice(k, 1); else CMD.pins.push(name);
      cmdSavePins(); renderCmdPalette();
    } else if ((b = t.closest('[data-help]'))) {
      var row = pal.querySelector('[data-helprow="' + b.getAttribute('data-help') + '"]');
      if (row) row.hidden = !row.hidden;
    }
  });
  if (tip) tip.addEventListener('click', function (e) {
    var b = e.target.closest('[data-tipcmd]');
    if (b) stage(b.getAttribute('data-tipcmd'));
  });
  renderCmdPalette();
}

// --- transcript font size ---
function applyLiveFont() {
  var px = LIVEUI.font + 'px';
  ['liveRendered', 'liveLog'].forEach(function (id) { var el = document.getElementById(id); if (el) el.style.fontSize = px; });
}
function liveFontStep(d) {
  LIVEUI.font = Math.max(10, Math.min(24, LIVEUI.font + d));
  liveSaveFont(); applyLiveFont();
}

// Keep the full-screen view sized to the *visible* area (above the soft keyboard) so the
// input and latest messages aren't hidden under it. Driven by visualViewport on mobile.
function liveZenViewport() {
  var page = document.querySelector('.page[data-page="live"]');
  if (!page) return;
  if (!document.body.classList.contains('live-zen')) { page.style.height = ''; page.style.top = ''; return; }
  var vv = window.visualViewport;
  if (vv) { page.style.height = vv.height + 'px'; page.style.top = vv.offsetTop + 'px'; }
  else { page.style.height = window.innerHeight + 'px'; page.style.top = '0px'; }
  if (LIVE.stick) liveScrollBottom();
}

// --- symbol keyboard overlay (insert into the last-focused live input) ---
var KBD_STD = ['/', '-', '_', '.', ':', '|', '~', '*', '=', '#', '@'];
var KBD_EXP = ['{', '}', '[', ']', '(', ')', '<', '>', '$', '&', '"', "'", '\\', '`'];
function liveFocusInput() {
  return document.getElementById(LIVEUI.lastInput) || document.getElementById('liveInput');
}
function insertAtCursor(el, text) {
  if (!el) return;
  var s = el.selectionStart, e = el.selectionEnd;
  if (typeof s === 'number') {
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    var p = s + text.length; try { el.setSelectionRange(p, p); } catch (x) { }
  } else { el.value += text; }
  el.focus();
}
function moveCursor(el, dir) {
  if (!el || typeof el.selectionStart !== 'number') return;
  var p = Math.max(0, Math.min(el.value.length, el.selectionStart + dir));
  try { el.setSelectionRange(p, p); } catch (x) { }
  el.focus();
}
function renderKbd() {
  var el = document.getElementById('liveKbd');
  if (!el) return;
  function row(keys) { return keys.map(function (k) { return '<button class="kbd-key" data-key="' + esc(k) + '">' + esc(k) + '</button>'; }).join(''); }
  var html = '<div class="kbd-row">' + row(KBD_STD)
    + '<button class="kbd-key kbd-nav" data-nav="-1">\u2190</button>'
    + '<button class="kbd-key kbd-nav" data-nav="1">\u2192</button>'
    + '<button class="kbd-key kbd-more" data-more="1">' + (LIVEUI.kbdExpanded ? 'less' : 'more') + '</button></div>';
  if (LIVEUI.kbdExpanded) html += '<div class="kbd-row kbd-exp">' + row(KBD_EXP) + '</div>';
  el.innerHTML = html;
}

function liveApplyView() {
  var rd = document.getElementById('liveRendered'), raw = document.getElementById('liveLog');
  var btn = document.getElementById('liveViewToggle');
  var rendered = LIVE.view !== 'raw';
  if (rd) rd.hidden = !rendered;
  if (raw) raw.hidden = rendered;
  if (btn) btn.textContent = 'view: ' + (rendered ? 'raw' : 'rendered');
}

// --- bottom sheet (commands / files / session) ---
function liveSheetOpen(tab) {
  var s = document.getElementById('liveSheet');
  if (!s) return;
  s.hidden = false;
  (window.requestAnimationFrame || function (f) { f(); })(function () { s.classList.add('open'); });
  if (tab) liveSheetTab(tab);
}
function liveSheetClose() {
  var s = document.getElementById('liveSheet');
  if (!s) return;
  s.classList.remove('open');
  setTimeout(function () { if (s && !s.classList.contains('open')) s.hidden = true; }, 220);
}
function liveSheetTab(tab) {
  var s = document.getElementById('liveSheet');
  if (!s) return;
  s.querySelectorAll('.sheet-tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
  s.querySelectorAll('.sheet-pane').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== tab; });
}

// --- global helper-text popup (used everywhere via data-info icons) ---
function ensureInfoPopup() {
  var p = document.getElementById('infoPopup');
  if (p) return p;
  p = document.createElement('div');
  p.id = 'infoPopup'; p.className = 'info-pop'; p.hidden = true;
  p.innerHTML = '<div class="info-pop-back" data-infoclose></div>'
    + '<div class="info-pop-box"><button class="info-pop-x" data-infoclose aria-label="close">\u00d7</button>'
    + '<div class="info-pop-body"></div></div>';
  document.body.appendChild(p);
  return p;
}
function showInfoPopup(html) {
  var p = ensureInfoPopup();
  p.querySelector('.info-pop-body').innerHTML = html;
  p.hidden = false;
}
function hideInfoPopup() { var p = document.getElementById('infoPopup'); if (p) p.hidden = true; }
// Delegated on document: any [data-info] icon opens the popup; outside click / × closes it.
function infoPopupClick(e) {
  var t = e.target;
  var info = t.closest && t.closest('[data-info]');
  if (info) { var src = document.getElementById(info.getAttribute('data-info')); if (src) showInfoPopup(src.innerHTML); return; }
  if (t.closest && t.closest('[data-infoclose]')) { hideInfoPopup(); return; }
}

function shortModel(m) { m = String(m || '').replace(/\s+with\s+.*edit format.*$/i, ''); var p = m.split('/'); return p[p.length - 1].slice(0, 30); }

// Read-only readout of the reduced session state (mode · files · model · tokens · pending).
function liveApplyState(st) {
  var si = document.getElementById('liveSessInfo');
  var el = document.getElementById('liveState');
  var fl = document.getElementById('liveFiles');
  var fb = document.getElementById('liveFilesBtn');
  var has = st && (st.files.length || st.mode || st.tokens || st.pending || st.models.main);
  if (fb) fb.textContent = 'files ' + ((st && st.files.length) || 0);
  // model / mode / tokens summary lives in the session panel
  if (si) {
    var bits = [];
    if (has) {
      if (st.mode) bits.push('<span class="ls-k">mode</span> ' + esc(st.mode));
      if (st.models.main) bits.push('<span class="ls-k">model</span> ' + esc(shortModel(st.models.main)));
      if (st.tokens) bits.push('<span class="ls-k">tok</span> ' + esc(st.tokens.sent + '\u2191 ' + st.tokens.received + '\u2193'));
    }
    si.innerHTML = bits.length ? '<div class="ls-row">' + bits.join(' <span class="adot">\u00b7</span> ') + '</div>' : '';
  }
  // pending confirmation + responder stays prominent in the main view
  if (el) {
    if (st && st.pending) {
      el.innerHTML = '<div class="ls-pending">awaiting \u2192 ' + esc(st.pending) + '</div>'
        + '<div class="ls-confirm">' + liveConfirmButtons(st.pending) + '</div>';
      el.hidden = false;
    } else { el.innerHTML = ''; el.hidden = true; }
  }
  // file chips (with drop) live in the sheet's files pane
  if (fl) {
    fl.innerHTML = (st && st.files.length) ? st.files.map(function (f) {
      return '<span class="ls-file' + (f.readonly ? ' ro' : '') + '">' + esc(f.path)
        + (f.readonly ? ' <span class="ls-ro">ro</span>' : '')
        + '<button class="ls-drop" data-drop="' + esc(f.path) + '" title="drop ' + esc(f.path) + '">\u00d7</button></span>';
    }).join('') : '<span class="gmuted">no files in chat</span>';
  }
  liveCmdTip(st);
}

// Build responder buttons from the option letters present in a confirmation prompt.
function liveConfirmButtons(pending) {
  var p = String(pending || ''), opts = [];
  if (/\(Y\)es/i.test(p) || /\[Yes\]/i.test(p)) opts.push(['y', 'Yes']);
  if (/\(N\)o/i.test(p)) opts.push(['n', 'No']);
  if (/\(A\)ll/i.test(p)) opts.push(['a', 'All']);
  if (/Skip all|\(S\)kip/i.test(p)) opts.push(['s', 'Skip all']);
  if (/Don't ask again|\(D\)on't/i.test(p)) opts.push(['d', "Don't ask"]);
  if (!opts.length) { opts.push(['y', 'Yes']); opts.push(['n', 'No']); } // sensible default
  return opts.map(function (o) {
    return '<button class="ls-cbtn" data-confirm="' + o[0] + '">' + esc(o[1]) + '</button>';
  }).join('');
}

// Byte offset (in LIVE.buffer) of the start of the last aider prompt line — the boundary
// between completed turns (everything before) and the in-flight turn (from here on).
function liveLastPromptOffset(buf) {
  var off = 0, last = -1, nl;
  for (var pos = 0; pos <= buf.length;) {
    nl = buf.indexOf('\n', pos);
    var end = nl < 0 ? buf.length : nl;
    if (LIVE_PROMPT_RE.test(buf.slice(pos, end))) last = pos;
    if (nl < 0) break;
    pos = nl + 1;
  }
  return last;
}

// Commit-on-boundary: completed turns are parsed/rendered ONCE and appended to #liveCommitted
// (stable DOM, fold states preserved, never recomputed). Only the in-flight tail re-renders.
function liveRenderedUpdate(tailOnly) {
  var cm = document.getElementById('liveCommitted'), tl = document.getElementById('liveTail');
  if (!cm || !tl) return;
  var bound = liveLastPromptOffset(LIVE.buffer);
  if (!tailOnly && bound > LIVE.committedOffset) {
    var seg = LIVE.buffer.slice(LIVE.committedOffset, bound);
    var segBlocks = parseAiderLive(seg);
    cm.insertAdjacentHTML('beforeend', renderItems(segBlocks, { hideReasoning: false })); // append; existing DOM untouched
    LIVE.committedHtml = cm.innerHTML;
    LIVE.committedBlocks = LIVE.committedBlocks.concat(segBlocks);
    LIVE.committedOffset = bound;
  }
  var tail = LIVE.buffer.slice(LIVE.committedOffset);
  var tailBlocks = tail.trim() ? parseAiderLive(tail) : [];
  tl.innerHTML = renderItems(tailBlocks, { hideReasoning: false });
  liveApplyState(reduceSession(LIVE.committedBlocks.concat(tailBlocks)));
}

// ---- live output stream (SSE) ----  (LIVE state is declared near the bootstrap)

function liveScrollBottom() {
  var el = LIVE.view === 'raw' ? document.getElementById('liveLog') : document.getElementById('liveRendered');
  if (el) el.scrollTop = el.scrollHeight;
}

function liveStreamStart() {
  if (LIVE.es) return;
  if (!document.getElementById('liveLog')) return; // not on the live tab
  var es = new EventSource('/api/aider/stream?offset=' + (LIVE.offset || 0));
  LIVE.es = es;
  es.onmessage = function (e) {
    LIVE.buffer += e.data;
    if (e.lastEventId) { var n = parseInt(e.lastEventId, 10); if (!isNaN(n)) LIVE.offset = n; }
    var lg = document.getElementById('liveLog');
    if (lg) lg.textContent += e.data;     // raw view: append
    liveRenderedUpdate();                  // rendered view: commit completed turns, re-render tail
    if (LIVE.stick) liveScrollBottom();
  };
  es.addEventListener('end', function () { liveStreamStop(); });
  es.onerror = function () { if (es.readyState === 2) LIVE.es = null; }; // closed: allow restart
}

function liveStreamReset() {
  // New session: drop the old transcript (both views) and rewind offsets before (re)streaming.
  liveStreamStop();
  LIVE.buffer = ''; LIVE.offset = 0;
  LIVE.committedOffset = 0; LIVE.committedHtml = ''; LIVE.committedBlocks = [];
  var lg = document.getElementById('liveLog'); if (lg) lg.textContent = '';
  var cm = document.getElementById('liveCommitted'); if (cm) cm.innerHTML = '';
  var tl = document.getElementById('liveTail'); if (tl) tl.innerHTML = '';
  var ls = document.getElementById('liveState'); if (ls) { ls.hidden = true; ls.innerHTML = ''; }
}

function liveStreamStop() {
  if (LIVE && LIVE.es) { try { LIVE.es.close(); } catch (e) { } LIVE.es = null; }
}

function liveToast(msg, ok) { notify({ msg: msg, level: ok ? 'ok' : 'error', source: 'live' }); }

function liveCtrl(name) {
  return fetch('/api/aider/' + name, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (j) {
      if (!res.ok || j.ok === false) liveToast(j.error || (name + ' failed ' + res.status), false);
      else liveToast(name + ' sent', true);
      poll();
    });
  }).catch(function () { liveToast(name + ' failed', false); });
}

// Two-tap confirm for destructive buttons (mobile fat-finger guard).
function armButton(btn, confirmLabel, fire) {
  if (btn._armTimer) {
    clearTimeout(btn._armTimer); btn._armTimer = null;
    btn.textContent = btn._label; btn.classList.remove('armed');
    fire();
    return;
  }
  btn._label = btn.textContent;
  btn.textContent = confirmLabel;
  btn.classList.add('armed');
  btn._armTimer = setTimeout(function () {
    btn._armTimer = null; btn.textContent = btn._label; btn.classList.remove('armed');
  }, 3000);
}

// Send a line of text/command to the running aider (literal text + Enter, server-side).
function liveSendText(text) {
  return fetch('/api/aider/input', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text }),
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (j) {
      if (!res.ok || j.ok === false) liveToast(j.error || ('send failed ' + res.status), false);
    });
  }).catch(function () { liveToast('send failed', false); });
}

function liveSend() {
  var inp = document.getElementById('liveInput');
  if (!inp) return;
  var text = inp.value;
  inp.value = '';
  liveSendText(text);
  inp.focus();
}

// Delegated handler for the state bar's interactive bits: drop-file ✕ and confirmation responses.
function liveStateClick(e) {
  var t = e.target;
  var drop = t.closest && t.closest('[data-drop]');
  if (drop) { liveSendText('/drop ' + drop.getAttribute('data-drop')); return; }
  var conf = t.closest && t.closest('[data-confirm]');
  if (conf) { liveSendText(conf.getAttribute('data-confirm')); return; }
  var open = t.closest && t.closest('[data-opensheet]');
  if (open) { liveSheetOpen(open.getAttribute('data-opensheet')); return; }
}

function wireLive(scope) {
  // Input row (live control — works while aider runs; wire it independently of the launcher).
  var inp = scope.querySelector('#liveInput');
  var sendBtn = scope.querySelector('#liveSend');
  if (sendBtn) sendBtn.addEventListener('click', function () { liveSend(); });
  if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); liveSend(); } });

  // Session controls (escalation ladder). Destructive two require a confirming second tap.
  var bI = scope.querySelector('#liveInterrupt');
  var bX = scope.querySelector('#liveExit');
  var bT = scope.querySelector('#liveTerm');
  var bK = scope.querySelector('#liveKill');
  if (bI) bI.addEventListener('click', function () { liveCtrl('interrupt'); });
  if (bX) bX.addEventListener('click', function () { liveCtrl('exit'); });
  if (bT) bT.addEventListener('click', function () { armButton(bT, 'confirm — end aider?', function () { liveCtrl('terminate'); }); });
  if (bK) bK.addEventListener('click', function () { armButton(bK, 'confirm — kill session?', function () { liveCtrl('kill'); }); });
  var bV = scope.querySelector('#liveViewToggle');
  if (bV) bV.addEventListener('click', function () {
    LIVE.view = (LIVE.view === 'raw') ? 'rendered' : 'raw';
    liveApplyView(); liveScrollBottom();
  });
  var addInp = scope.querySelector('#liveAddInput');
  function sendAdd(cmd) {
    if (!addInp) return;
    var v = addInp.value.trim();
    if (!v) return;
    liveSendText(cmd + ' ' + v);
    addInp.value = ''; addInp.focus();
  }
  var bAdd = scope.querySelector('#liveAddBtn');
  var bAddRo = scope.querySelector('#liveAddRoBtn');
  if (bAdd) bAdd.addEventListener('click', function () { sendAdd('/add'); });
  if (bAddRo) bAddRo.addEventListener('click', function () { sendAdd('/read-only'); });
  if (addInp) addInp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); sendAdd('/add'); } });

  // Track which live input symbol keys insert into.
  ['liveInput', 'cmdInput', 'liveAddInput'].forEach(function (id) {
    var el = scope.querySelector('#' + id);
    if (el) el.addEventListener('focus', function () { LIVEUI.lastInput = id; });
  });
  // Font controls.
  var fDn = scope.querySelector('#liveFontDn'), fUp = scope.querySelector('#liveFontUp');
  if (fDn) fDn.addEventListener('click', function () { liveFontStep(-1); });
  if (fUp) fUp.addEventListener('click', function () { liveFontStep(1); });
  // Symbol keyboard overlay.
  var kbdToggle = scope.querySelector('#liveKbdToggle');
  if (kbdToggle) kbdToggle.addEventListener('click', function () {
    var el = document.getElementById('liveKbd');
    if (el) { el.hidden = !el.hidden; if (!el.hidden) renderKbd(); }
  });
  var zen = scope.querySelector('#liveZen');
  if (zen) zen.addEventListener('click', function () {
    var on = document.body.classList.toggle('live-zen');
    liveZenViewport();
    if (on) { LIVE.stick = true; liveScrollBottom(); }
  });
  // bottom sheet: ⋯ opens/closes; tabs switch panes; scrim/handle close
  var sheetBtn = scope.querySelector('#liveSheetBtn');
  if (sheetBtn) sheetBtn.addEventListener('click', function () {
    var s = document.getElementById('liveSheet');
    if (s && s.classList.contains('open')) liveSheetClose(); else liveSheetOpen('cmd');
  });
  var sheet = scope.querySelector('#liveSheet');
  if (sheet) sheet.addEventListener('click', function (e) {
    if (e.target.closest('[data-sheetclose]')) { liveSheetClose(); return; }
    var tb = e.target.closest('.sheet-tab');
    if (tb) liveSheetTab(tb.getAttribute('data-tab'));
  });
  // collapsible card headers (info icons handled globally by the popup)
  if (scope.addEventListener) scope.addEventListener('click', function (e) {
    var cf = e.target.closest && e.target.closest('[data-cardfold]');
    if (cf) { var bd = document.getElementById(cf.getAttribute('data-cardfold')); if (bd) { bd.hidden = !bd.hidden; cf.classList.toggle('folded', bd.hidden); } }
  });
  var filesBtn = scope.querySelector('#liveFilesBtn');
  if (filesBtn) filesBtn.addEventListener('click', function () { liveSheetOpen('files'); });
  var kbd = scope.querySelector('#liveKbd');
  if (kbd) kbd.addEventListener('mousedown', function (e) {
    // mousedown (not click) so the focused input doesn't blur before we insert
    var t = e.target, b;
    if ((b = t.closest('[data-key]'))) { e.preventDefault(); insertAtCursor(liveFocusInput(), b.getAttribute('data-key')); }
    else if ((b = t.closest('[data-nav]'))) { e.preventDefault(); moveCursor(liveFocusInput(), parseInt(b.getAttribute('data-nav'), 10)); }
    else if (t.closest('[data-more]')) { e.preventDefault(); LIVEUI.kbdExpanded = !LIVEUI.kbdExpanded; renderKbd(); }
  });

  var sel = scope.querySelector('#launchSelect');
  var btn = scope.querySelector('#launchBtn');
  if (!sel || !btn) return;
  sel.addEventListener('change', function () {
    btn.disabled = document.body.classList.contains('aider-active') || !sel.value;
  });
  // Own fetch (not aiderPost) so both success and error surface in #liveToast — the
  // shared aiderToast lives inside the hidden aider section and wouldn't render here.
  btn.addEventListener('click', async function () {
    if (btn.disabled) return;
    var name = sel.value;
    if (!name) return;
    btn.disabled = true;
    try {
      var res = await fetch('/api/aider/launch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blueprint: name }),
      });
      var j = await res.json().catch(function () { return {}; });
      if (res.status === 423) { liveToast('aider already running', false); syncLive(window._lastAider); return; }
      if (!res.ok || j.ok === false) { liveToast(j.error || ('error ' + res.status), false); btn.disabled = !sel.value; return; }
      liveToast('launched ' + name, true);
      liveStreamReset(); // fresh session: clear old transcript/offset before the new stream
      document.body.classList.add('aider-active'); // optimistic; next poll confirms
      syncLive({ active: true, session: j.session, blueprint: j.blueprint, started: Math.floor(Date.now() / 1000), pids: [] });
      poll();
    } catch (e) {
      liveToast('server error', false);
      btn.disabled = !sel.value;
    }
  });
}

function blueprintsCardHTML() {
  var bps = AID.store.blueprints || [];
  var rows = bps.map(function (b, i) {
    var roles = esc(bpModelStr(b.arch)) + ' <span class="adot">/</span> ' + esc(bpModelStr(b.editor) || '(arch)') + ' <span class="adot">/</span> ' + esc(bpModelStr(b.weak) || '(arch)');
    var meta = [];
    if (b.flags) meta.push('flags: ' + esc(b.flags));
    if (b.files) meta.push('files: ' + esc(b.files));
    var kp = [];
    if (b.arch_key) kp.push('A:' + b.arch_key);
    if (b.editor_key) kp.push('E:' + b.editor_key);
    if (b.weak_key) kp.push('W:' + b.weak_key);
    if (kp.length) meta.push('keys ' + esc(kp.join(' ')));
    var ready = (b.readiness || []).map(function (r) {
      return '<span class="keychip ' + (r.present ? 'ok' : 'bad') + '">' + (r.present ? '✓ ' : '✗ ') + esc(r.env) + '</span>';
    }).join('');
    return '<div class="bprow" data-i="' + i + '">'
      + '<div class="bphead"><span class="bpname">' + esc(b.name) + '</span>' + (i === 0 ? ' <span class="fbadge">default</span>' : '') + '</div>'
      + (b.desc ? '<div class="gmuted bpdesc">' + esc(b.desc) + '</div>' : '')
      + '<div class="bproles">🧠 ' + roles + '</div>'
      + (meta.length ? '<div class="gmuted bpmeta">' + meta.join(' <span class="adot">·</span> ') + '</div>' : '')
      + (ready ? '<div class="bpkeys">' + ready + '</div>' : '')
      + '<div class="aactions"><button class="clink bpedit" data-write>edit</button>'
      + '<button class="clink bppreview">preview</button>'
      + '<button class="clink bpclone" data-write>clone</button>'
      + '<button class="clink bpmove" data-dir="-1" data-write' + (i === 0 ? ' disabled' : '') + '>↑</button>'
      + '<button class="clink bpmove" data-dir="1" data-write' + (i === bps.length - 1 ? ' disabled' : '') + '>↓</button>'
      + (i !== 0 ? '<button class="clink bpdefault" data-write>set default</button>' : '')
      + '<button class="clink danger bpdel" data-write>del</button></div>'
      + '<div class="effwrap" hidden></div>'
      + '</div>';
  }).join('');
  var empty;
  if (!bps.length) {
    var noModels = !((AID.store.lists.models.rows || []).length);
    empty = noModels
      ? '<div class="aempty">No models yet. Add one under <button class="clink alink" data-go="blocks">Building blocks → Models</button>, then build a blueprint.</div>'
      : '<div class="aempty">No blueprints yet — tap <span class="mono">+ build</span> to make your first launch config.</div>';
  }
  return '<div class="alist" data-bp="card"><div class="card-h">Blueprints <span class="gmuted">' + bps.length + '</span>'
    + '<button class="clink bpnew" data-write>+ build</button></div>'
    + '<div class="bpbuilder" hidden></div>'
    + '<div class="bprows">' + (rows || empty) + '</div></div>';
}

function bpModelOptions(role, selected, allowInherit) {
  var scoreIdx = { arch: 2, editor: 3, weak: 4 }[role];
  var models = (AID.store.lists.models.rows || []).slice();
  models.sort(function (a, b) { return (parseInt(b[scoreIdx], 10) || 0) - (parseInt(a[scoreIdx], 10) || 0); });
  var opts = allowInherit ? '<option value="">— inherit architect —</option>' : '<option value="">— choose —</option>';
  opts += models.map(function (r) {
    return '<option value="' + escAttr(r[0]) + '"' + (r[0] === selected ? ' selected' : '') + '>' + esc(r[0]) + ' — ' + esc(r[1]) + ' [' + esc(r[scoreIdx] || '0') + ']</option>';
  }).join('');
  return opts;
}

function bpFilesHTML() {
  var files = AID.store.lists.files.rows || [];
  var modes = AID.store.lists.filemodes.rows || [];
  var cur = BP.files.map(function (p, idx) {
    return '<div class="bpfile"><span>' + esc(p.fid) + ' <span class="gmuted">' + esc(p.mid || '(default)') + '</span></span><button class="clink danger bpfile-del" data-i="' + idx + '">remove</button></div>';
  }).join('');
  var fopts = files.map(function (r) { return '<option value="' + escAttr(r[0]) + '">' + esc(r[0]) + ' — ' + esc(r[1]) + '</option>'; }).join('');
  var mopts = modes.map(function (r) { return '<option value="' + escAttr(r[0]) + '">' + esc(r[0]) + ' (' + esc(r[1]) + ')</option>'; }).join('');
  return '<div class="bpfiles">' + cur + '</div>'
    + '<div class="bpfile-add"><select class="hinput bpf-file">' + fopts + '</select><select class="hinput bpf-mode">' + mopts + '</select><button class="clink bpfile-add-btn">add file</button></div>';
}

// One collapsible builder sub-section. The header is a real button (keyboard +
// aria); collapsing hides everything but the header (CSS). Toggling is wired via
// delegation in wireBuilder so it survives sub-section re-renders (e.g. files).
function bpSec(title, bodyHtml, collapsed, extraCls) {
  return '<div class="bpsec' + (collapsed ? ' collapsed' : '') + (extraCls ? ' ' + extraCls : '') + '">'
    + '<button type="button" class="bpsec-h" aria-expanded="' + (collapsed ? 'false' : 'true') + '"><span class="bpsec-chev">▾</span>' + title + '</button>'
    + bodyHtml + '</div>';
}

function bpBuilderHTML() {
  var b = BP.index >= 0 ? (AID.store.blueprints[BP.index] || {}) : {};
  var flags = AID.store.lists.flags.rows || [];
  var checked = (b.flags || '').split(',').map(function (s) { return s.trim(); });
  var flagBoxes = flags.length ? flags.map(function (r) {
    return '<label class="bpflag"><input type="checkbox" class="bpf-flag" value="' + escAttr(r[0]) + '"' + (checked.indexOf(r[0]) >= 0 ? ' checked' : '') + '> ' + esc(r[0]) + ' <span class="gmuted">' + esc(r[2] || '') + '</span></label>';
  }).join('') : '<span class="gmuted">no flag sets defined</span>';
  return '<div class="bpedit">'
    + '<label class="afield"><span>name</span><input class="hinput bpf-name" value="' + escAttr(b.name || '') + '" autocapitalize="off" autocorrect="off" spellcheck="false"></label>'
    + '<label class="afield"><span>description</span><input class="hinput bpf-desc" value="' + escAttr(b.desc || '') + '"></label>'
    + '<label class="afield"><span>architect</span><select class="hinput bpf-arch">' + bpModelOptions('arch', b.arch, false) + '</select></label>'
    + '<label class="afield"><span>editor</span><select class="hinput bpf-editor">' + bpModelOptions('editor', b.editor, true) + '</select></label>'
    + '<label class="afield"><span>weak</span><select class="hinput bpf-weak">' + bpModelOptions('weak', b.weak, true) + '</select></label>'
    + bpSec('flag sets', '<div class="bpflags">' + flagBoxes + '</div>', true)
    + bpSec('read / edit files', bpFilesHTML(), false)
    + bpSec('keys <span class="gmuted">(per provider — auto when only one)</span>', '<div class="bpkeys-body"></div>', false, 'bpkeys-sec')
    + bpSec('aider options <span class="gmuted">(unset = inherit defaults)</span>', optionsEditorHTML(BP.opts), true)
    + '<div class="af-act"><button class="clink bpsave" data-write>' + (BP.index >= 0 ? 'save' : 'create') + '</button><button class="clink bpcancel">cancel</button></div>'
    + '</div>';
}

function openBuilder(i) {
  BP.index = i;
  BP.files = [];
  BP.dirty = false;
  BP.origName = '';
  BP.opts = {};
  BP.keys = { arch: '', editor: '', weak: '' };
  if (i >= 0) {
    var b = AID.store.blueprints[i] || {};
    BP.origName = b.name;
    BP.opts = (AID.store.blueprint_options || {})[b.name] || {};
    BP.keys = { arch: b.arch_key || '', editor: b.editor_key || '', weak: b.weak_key || '' };
    (b.files || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (spec) {
      var parts = spec.split(':');
      BP.files.push({ fid: parts[0], mid: parts[1] || '' });
    });
  }
  var panel = document.querySelector('.bpbuilder');
  panel.innerHTML = bpBuilderHTML();
  panel.hidden = false;
  wireBuilder(panel);
  panel.scrollIntoView({ block: 'nearest' });
}

function renderBpFiles(panel) {
  var sec = panel.querySelectorAll('.bpsec')[1];
  // replace the files block (everything after the section header)
  var header = sec.querySelector('.bpsec-h');
  sec.innerHTML = '';
  sec.appendChild(header);
  sec.insertAdjacentHTML('beforeend', bpFilesHTML());
  wireBpFiles(panel);
}

function wireBpFiles(panel) {
  panel.querySelectorAll('.bpfile-del').forEach(function (b) {
    b.addEventListener('click', function () { BP.files.splice(parseInt(b.dataset.i, 10), 1); renderBpFiles(panel); });
  });
  var addBtn = panel.querySelector('.bpfile-add-btn');
  if (addBtn) addBtn.addEventListener('click', function () {
    var fid = panel.querySelector('.bpf-file').value;
    var mid = panel.querySelector('.bpf-mode').value;
    if (fid) { BP.files.push({ fid: fid, mid: mid }); renderBpFiles(panel); }
  });
}

function wireBuilder(panel) {
  wireBpFiles(panel);
  renderBpKeys(panel);
  ['.bpf-arch', '.bpf-editor', '.bpf-weak'].forEach(function (s) {
    var el = panel.querySelector(s);
    if (el) el.addEventListener('change', function () { renderBpKeys(panel); });
  });
  wireOptions(panel);
  // Collapsible sub-sections (delegated so it survives sub-section re-renders).
  panel.addEventListener('click', function (e) {
    var h = e.target.closest && e.target.closest('.bpsec-h');
    if (!h || !panel.contains(h)) return;
    var col = h.parentNode.classList.toggle('collapsed');
    h.setAttribute('aria-expanded', col ? 'false' : 'true');
  });
  // Save is disabled until the required fields (name + architect) are set; any
  // edit marks the form dirty so cancel can warn before discarding.
  var saveBtn = panel.querySelector('.bpsave');
  function bpValid() { return !!(panel.querySelector('.bpf-name').value.trim() && panel.querySelector('.bpf-arch').value); }
  function refreshSave() { saveBtn.disabled = !bpValid(); }
  refreshSave();
  panel.addEventListener('input', function () { BP.dirty = true; refreshSave(); });
  panel.addEventListener('change', function () { BP.dirty = true; refreshSave(); });
  panel.querySelector('.bpcancel').addEventListener('click', function () {
    function discard() { panel.hidden = true; panel.innerHTML = ''; BP.dirty = false; }
    if (BP.dirty) lkConfirm({ heading: 'Discard changes?', detail: 'This blueprint has unsaved edits.', danger: true, confirmLabel: 'Discard', onConfirm: discard });
    else discard();
  });
  panel.querySelector('.bpsave').addEventListener('click', async function () {
    var flagsSel = [];
    panel.querySelectorAll('.bpf-flag:checked').forEach(function (c) { flagsSel.push(c.value); });
    var filesCsv = BP.files.map(function (p) { return p.mid ? p.fid + ':' + p.mid : p.fid; }).join(',');
    var values = {
      name: panel.querySelector('.bpf-name').value.trim(),
      desc: panel.querySelector('.bpf-desc').value.trim(),
      arch: panel.querySelector('.bpf-arch').value,
      editor: panel.querySelector('.bpf-editor').value,
      weak: panel.querySelector('.bpf-weak').value,
      arch_key: BP.keys.arch || '',
      editor_key: BP.keys.editor || '',
      weak_key: BP.keys.weak || '',
      flags: flagsSel.join(','),
      files: filesCsv,
    };
    if (!values.name) { aiderToast('name required', false); return; }
    if (!values.arch) { aiderToast('architect model required', false); return; }
    var op = BP.index >= 0 ? 'update' : 'add';
    var body = { op: op, values: values };
    if (op === 'update') body.index = BP.index;
    var r = await aiderPost('blueprint', body);
    if (!r) return;
    var opts = collectOptions(panel.querySelector('.optseditor'));
    await aiderPost('options', { scope: 'blueprint', name: values.name, oldName: BP.origName, values: opts });
    aiderToast(op === 'add' ? 'created' : 'saved', true);
    BP.dirty = false;
    aiderLoad();
  });
}

function listCardHTML(name, ld) {
  var fields = ld.fields || [];
  var rows = (ld.rows || []).map(function (row, i) {
    var summary = row.map(function (v, idx) { return v ? esc(v) : ''; }).filter(Boolean).join(' <span class="adot">·</span> ');
    return '<div class="arow" data-i="' + i + '">'
      + '<div class="acells">' + (summary || '<span class="gmuted">(empty)</span>') + '</div>'
      + '<div class="aactions"><button class="clink aedit-btn" data-write>edit</button><button class="clink danger adel-btn" data-write>del</button></div>'
      + editPanelHTML(fields, row)
      + '</div>';
  }).join('');
  return '<div class="alist" data-list="' + name + '"><div class="card-h">' + esc(ld.label)
    + ' <span class="gmuted">' + (ld.rows || []).length + '</span>'
    + '<button class="clink aadd" data-write>+ add</button></div>'
    + '<div class="aaddrow" hidden>' + editPanelHTML(fields, null).replace('class="aedit" hidden', 'class="aedit"') + '</div>'
    + '<div class="arows">' + (rows || '<div class="gmuted">none</div>') + '</div></div>';
}

function collectEdit(panel) {
  var vals = [];
  panel.querySelectorAll('.af').forEach(function (el) {
    var v = el.value.trim();
    if (el.dataset.score) v = v.replace(/[^0-9]/g, '').slice(0, 1); // score is 0–9
    vals.push(v);
  });
  return vals;
}

function wireBlueprints(scope) {
  var bpCard = scope.querySelector('[data-bp="card"]');
  if (!bpCard) return;
  bpCard.querySelector('.bpnew').addEventListener('click', function () { openBuilder(-1); });
  var goLink = bpCard.querySelector('.alink[data-go]');
  if (goLink) goLink.addEventListener('click', function () { gotoSection(goLink.dataset.go); });
  bpCard.querySelectorAll('.bprow').forEach(function (rowEl) {
    var i = parseInt(rowEl.dataset.i, 10);
    rowEl.querySelector('.bpedit').addEventListener('click', function () { openBuilder(i); });
    rowEl.querySelector('.bpclone').addEventListener('click', async function () {
      var r = await aiderPost('blueprint', { op: 'clone', index: i });
      if (r) { aiderToast('cloned', true); aiderLoad(); }
    });
    rowEl.querySelectorAll('.bpmove').forEach(function (mb) {
      mb.addEventListener('click', async function () {
        if (mb.disabled) return;
        var to = i + parseInt(mb.dataset.dir, 10);
        var r = await aiderPost('blueprint', { op: 'move', index: i, to: to });
        if (r) { aiderToast('moved', true); aiderLoad(); }
      });
    });
    var dflt = rowEl.querySelector('.bpdefault');
    if (dflt) dflt.addEventListener('click', async function () {
      var r = await aiderPost('blueprint', { op: 'default', index: i });
      if (r) { aiderToast('set as default', true); aiderLoad(); }
    });
    rowEl.querySelector('.bpdel').addEventListener('click', function () {
      openSheet('delete blueprint', 'Removes this blueprint from blueprints.list.', async function () {
        closeSheet();
        var r = await aiderPost('blueprint', { op: 'delete', index: i });
        if (r) { aiderToast('deleted', true); aiderLoad(); }
      });
    });
    rowEl.querySelector('.bppreview').addEventListener('click', async function () {
      var wrap = rowEl.querySelector('.effwrap');
      if (!wrap.hidden) { wrap.hidden = true; return; }
      wrap.innerHTML = '<div class="gmuted">computing…</div>';
      wrap.hidden = false;
      try {
        var eff = await fetch('/api/aider/effective?bp=' + i, { cache: 'no-store' }).then(function (x) { return x.json(); });
        wrap.innerHTML = effectiveHTML(eff);
      } catch (e) { wrap.innerHTML = '<div class="gmuted">preview failed</div>'; }
    });
  });
}

function wireDefaults(scope) {
  var defCard = scope.querySelector('[data-defaults="1"]');
  if (!defCard) return;
  defCard.querySelectorAll('.defsave').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      var wrap = defCard.querySelector('.defwrap[data-scope="' + btn.dataset.scope + '"]');
      var r = await aiderPost('options', { scope: btn.dataset.scope, values: collectOptions(wrap) });
      if (r) { aiderToast('saved ' + btn.dataset.scope + ' defaults', true); aiderLoad(); }
    });
  });
  defCard.querySelectorAll('.defwrap').forEach(function (w) { wireOptions(w); });
}

function wireBlocks(scope) {
  scope.querySelectorAll('.alist[data-list]:not([data-list="keys"])').forEach(function (card) {
    var name = card.dataset.list;
    card.querySelector('.aadd').addEventListener('click', function () {
      var ar = card.querySelector('.aaddrow'); ar.hidden = !ar.hidden;
      if (!ar.hidden) { var f = ar.querySelector('.af'); if (f) f.focus(); }
    });
    var addRow = card.querySelector('.aaddrow');
    addRow.querySelector('.asave').addEventListener('click', async function () {
      var r = await aiderPost('list/' + name, { op: 'add', values: collectEdit(addRow) });
      if (r) { aiderToast('added', true); aiderLoad(); }
    });
    addRow.querySelector('.acancel').addEventListener('click', function () { addRow.hidden = true; });

    card.querySelectorAll('.arow[data-i]').forEach(function (rowEl) {
      var i = parseInt(rowEl.dataset.i, 10);
      rowEl.querySelector('.aedit-btn').addEventListener('click', function () {
        var p = rowEl.querySelector('.aedit'); p.hidden = !p.hidden;
      });
      rowEl.querySelector('.acancel').addEventListener('click', function () { rowEl.querySelector('.aedit').hidden = true; });
      rowEl.querySelector('.asave').addEventListener('click', async function () {
        var r = await aiderPost('list/' + name, { op: 'update', index: i, values: collectEdit(rowEl.querySelector('.aedit')) });
        if (r) { aiderToast('saved', true); aiderLoad(); }
      });
      rowEl.querySelector('.adel-btn').addEventListener('click', function () {
        openSheet('delete row', 'Removes this row from ' + name + '.list.', async function () {
          closeSheet();
          var r = await aiderPost('list/' + name, { op: 'delete', index: i });
          if (r) { aiderToast('deleted', true); aiderLoad(); }
        });
      });
    });
  });
}

function wireKeys(scope) {
  var card = scope.querySelector('.alist[data-list="keys"]');
  if (!card) return;
  var addRow = card.querySelector('.aaddkeyrow');
  card.querySelector('.aaddkey').addEventListener('click', function () {
    addRow.hidden = !addRow.hidden;
    if (!addRow.hidden) addRow.querySelector('.akeynick').focus();
  });
  addRow.querySelector('.acancel').addEventListener('click', function () { addRow.hidden = true; });
  addRow.querySelector('.keyaddsave').addEventListener('click', async function () {
    var nick = addRow.querySelector('.akeynick').value.trim();
    var v = addRow.querySelector('.akeyvar').value.trim();
    var tok = addRow.querySelector('.akeytok').value;
    var note = addRow.querySelector('.akeydesc').value.trim();
    if (!nick) { aiderToast('reference required', false); return; }
    if (!v) { aiderToast('supplier var required', false); return; }
    var r = await aiderPost('keys', { op: 'set', nick: nick, var: v, token: tok, desc: note });
    if (r) { aiderToast('saved ' + nick, true); aiderLoad(); }
  });
  card.querySelectorAll('.arow[data-nick]').forEach(function (rowEl) {
    var nick = rowEl.dataset.nick;
    rowEl.querySelector('.keyedit-btn').addEventListener('click', function () {
      var p = rowEl.querySelector('.aedit'); p.hidden = !p.hidden;
      if (!p.hidden) p.querySelector('.akeytok').focus();
    });
    rowEl.querySelector('.acancel').addEventListener('click', function () { rowEl.querySelector('.aedit').hidden = true; });
    rowEl.querySelector('.keysave').addEventListener('click', async function () {
      var v = rowEl.querySelector('.akeyvar').value.trim();
      var tok = rowEl.querySelector('.akeytok').value;
      var note = rowEl.querySelector('.akeydesc').value.trim();
      if (!v) { aiderToast('supplier var required', false); return; }
      var r = await aiderPost('keys', { op: 'set', nick: nick, var: v, token: tok, desc: note });
      if (r) { aiderToast('saved ' + nick, true); aiderLoad(); }
    });
    rowEl.querySelector('.keydel-btn').addEventListener('click', function () {
      openSheet('delete key', 'Removes ' + nick + ' from keys.list.', async function () {
        closeSheet();
        var r = await aiderPost('keys', { op: 'delete', nick: nick });
        if (r) { aiderToast('deleted', true); aiderLoad(); }
      });
    });
  });
}
