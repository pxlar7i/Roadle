/* Roadle — game shell: build mode, test/official runs, traffic-light sequencer,
   results, sharing, persistence and the hidden developer panel. */
(function (root) {
  'use strict';
  var R = root.Roadle, U = R.util, NET = R.net, A = R.audio;
  var $ = function (s) { return document.querySelector(s); };
  var TPS = 4;                       // ticks per real second at 1×
  var STORE_KEY = 'roadle.v1';
  var SAMPLES = ['A', 'B', 'C', 'D', 'E'];
  var ENTRY_COLORS = R.render.ENTRY_COLORS;
  var LHT = ['GB', 'IE', 'AU', 'NZ', 'JP', 'IN', 'ZA', 'HK', 'SG', 'MY', 'TH', 'ID', 'PK', 'BD', 'LK', 'KE', 'TZ', 'UG', 'MT', 'CY', 'JM', 'NP', 'ZW', 'ZM', 'BW', 'NA', 'MZ', 'FJ', 'TT', 'BB', 'MU'];

  var S = {
    level: null, config: null, net: null, plainNet: null, mode: 'build', runKind: 'test', sim: null, acc: 0, speed: 1,
    sample: 0, tool: 'select', hover: null, slots: [], seqNode: 0, forecast: false, forecastEntry: null,
    mirror: false, dev: false, devOpts: {}, parJob: null, lastTick: -1, skipping: false, testResult: null, lastSeqIdx: -1
  };
  var store = load();
  var ren, tl, tlCtx;

  /* ---------------- persistence ---------------- */
  function load() {
    var d = null;
    try { d = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { d = null; }
    d = d || {};
    d.settings = d.settings || { sound: true, hand: 'auto', calm: false, speed: 1 };
    d.days = d.days || {};
    d.stats = d.stats || { played: 0, streak: 0, maxStreak: 0, lastNumber: 0, stars: [0, 0, 0, 0], best: 0 };
    return d;
  }
  function save() {
    try {
      var keys = Object.keys(store.days);
      if (keys.length > 40) keys.sort().slice(0, keys.length - 40).forEach(function (k) { delete store.days[k]; });
      localStorage.setItem(STORE_KEY, JSON.stringify(store));
    } catch (e) { /* private mode etc. */ }
  }
  function day() { return store.days[S.level.id] || (store.days[S.level.id] = {}); }

  /* ---------------- tools ---------------- */
  function svg(inner) { return '<svg viewBox="0 0 40 40" aria-hidden="true">' + inner + '</svg>'; }
  var ICON = {
    select: svg('<circle cx="17" cy="17" r="9" fill="#e7f5ff" stroke="#3d4050" stroke-width="3"/><path d="M24 24l8 8" stroke="#3d4050" stroke-width="4" stroke-linecap="round"/>'),
    give: svg('<path d="M20 34L5 8h30z" fill="#e03131" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><path d="M20 26l-8-14h16z" fill="#fff"/>'),
    stop: svg('<path d="M13 5h14l8 8v14l-8 8H13l-8-8V13z" fill="#e03131" stroke="#fff" stroke-width="2"/><rect x="11" y="17.500" width="18" height="5" rx="1.500" fill="#fff"/>'),
    signal: svg('<rect x="12" y="3" width="16" height="34" rx="6" fill="#2f3242"/><circle cx="20" cy="10.500" r="4" fill="#ff5a5a"/><circle cx="20" cy="20" r="4" fill="#ffc53d"/><circle cx="20" cy="29.500" r="4" fill="#52e07a"/>'),
    mini: svg('<circle cx="20" cy="20" r="15" fill="#666b82"/><circle cx="20" cy="20" r="4.500" fill="#fff"/><path d="M20 9a11 11 0 0 1 9.500 5.500M31 20a11 11 0 0 1-5.500 9.500M9 20a11 11 0 0 1 5.500-9.500" fill="none" stroke="#fff4d8" stroke-width="2.500" stroke-linecap="round"/>'),
    rbt: svg('<circle cx="20" cy="20" r="17" fill="#666b82"/><circle cx="20" cy="20" r="8.500" fill="#8fd18a" stroke="#f4f1e6" stroke-width="2"/><circle cx="17" cy="18" r="1.500" fill="#fff"/><circle cx="23" cy="22" r="1.500" fill="#ffd43b"/><circle cx="20" cy="20" r="13" fill="none" stroke="#fff4d8" stroke-width="1.500" stroke-dasharray="4 4"/>'),
    box: svg('<rect x="5" y="5" width="30" height="30" rx="5" fill="#666b82"/><path d="M8 8l24 24M32 8L8 32M20 8l12 12M8 20l12 12M20 8L8 20M32 20L20 32" stroke="#ffd43b" stroke-width="2"/><rect x="8" y="8" width="24" height="24" fill="none" stroke="#ffd43b" stroke-width="2.500"/>'),
    banL: svg('<circle cx="20" cy="20" r="15" fill="#fff" stroke="#e03131" stroke-width="4.500"/><path d="M24 29V19h-9" fill="none" stroke="#2f3242" stroke-width="3.500" stroke-linejoin="round"/><path d="M18 14l-5 5 5 5" fill="none" stroke="#2f3242" stroke-width="3.500" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 10l20 20" stroke="#e03131" stroke-width="4"/>'),
    banR: svg('<circle cx="20" cy="20" r="15" fill="#fff" stroke="#e03131" stroke-width="4.500"/><path d="M16 29V19h9" fill="none" stroke="#2f3242" stroke-width="3.500" stroke-linejoin="round"/><path d="M22 14l5 5-5 5" fill="none" stroke="#2f3242" stroke-width="3.500" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 10l20 20" stroke="#e03131" stroke-width="4"/>'),
    bump: svg('<rect x="3" y="12" width="34" height="16" rx="4" fill="#666b82"/><path d="M13 12v16M20 12v16M27 12v16" stroke="#ffd43b" stroke-width="4"/><path d="M16.500 12v16M23.500 12v16" stroke="#3d4050" stroke-width="3"/>'),
    bay: svg('<rect x="4" y="11" width="32" height="17" rx="5" fill="#ff922b"/><rect x="8" y="14" width="18" height="7" rx="2" fill="#ffe8cc"/><rect x="28" y="14" width="5" height="7" rx="1.500" fill="#3d4663"/><circle cx="12" cy="29" r="3.500" fill="#2f3242"/><circle cx="28" cy="29" r="3.500" fill="#2f3242"/>'),
    erase: svg('<path d="M9 25l13-15 10 8-11 13h-7z" fill="#faa2c1" stroke="#3d4050" stroke-width="2.500" stroke-linejoin="round"/><path d="M15 18l10 8" stroke="#3d4050" stroke-width="2.500"/><path d="M8 34h24" stroke="#3d4050" stroke-width="3" stroke-linecap="round"/>')
  };
  var TOOLS = [
    { id: 'select', name: 'Inspect', cost: '', target: 'none', help: '<b>Inspect</b> — tap a road badge to see where its traffic is heading, or tap traffic lights to edit them.' },
    { id: 'give', name: 'Give way', cost: NET.COST.yield, target: 'app', help: '<b>Give way</b> — drivers on this road wait for a gap. Cheap, but risky when it is busy or they cannot see.' },
    { id: 'stop', name: 'Stop sign', cost: NET.COST.stop, target: 'app', help: '<b>Stop sign</b> — a full stop before going: safer on blind corners, a little slower. One on every road makes an all-way stop.' },
    { id: 'signal', name: 'Traffic lights', cost: NET.COST.signalHead + '/road', target: 'node', help: '<b>Traffic lights</b> — paint each road\'s green ticks on the timeline. Greens that cross each other cause crashes.' },
    { id: 'mini', name: 'Mini-roundabout', cost: NET.COST.mini, target: 'node', help: '<b>Mini-roundabout</b> — a painted dot. Everyone gives way to the circle. Fits tight corners, not tram lines.' },
    { id: 'rbt', name: 'Roundabout', cost: NET.COST.rbt, target: 'node', help: '<b>Roundabout</b> — smooth and safe, but it needs open ground around the junction and costs the most.' },
    { id: 'box', name: 'Box junction', cost: NET.COST.box, target: 'node', help: '<b>Box junction</b> — nobody enters unless their exit is clear, so queues never block the crossing.' },
    { id: 'banL', name: 'No left turn', cost: NET.COST.noturn, target: 'app', help: '<b>Turn bans</b> — those drivers go round the block instead (a long detour), but stop holding up everyone behind them.' },
    { id: 'banR', name: 'No right turn', cost: NET.COST.noturn, target: 'app' },
    { id: 'bump', name: 'Speed bump', cost: NET.COST.bump, target: 'app', help: '<b>Speed bump</b> — slows a road down so that crossing drivers judge gaps better.' },
    { id: 'bay', name: 'Bus bay', cost: NET.COST.bay, target: 'bus', help: '<b>Bus bay</b> — the bus pulls off the road at its stop instead of blocking it.' },
    { id: 'erase', name: 'Remove', cost: '', target: 'any', help: '<b>Remove</b> — take something away and get its cost back.' }
  ];
  function simBan(tool) { // screen-left is sim-right when the map is mirrored for left-hand traffic
    var left = tool === 'banL';
    if (S.mirror) left = !left;
    return left ? 'noL' : 'noR';
  }

  function buildToolbox() {
    var g = $('#toolgrid'); g.innerHTML = '';
    TOOLS.forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tool'; b.dataset.tool = t.id; b.title = t.name;
      b.innerHTML = ICON[t.id] + '<span class="nm">' + t.name + '</span><span class="ct">' + (t.cost === '' ? '&nbsp;' : t.cost) + '</span>';
      b.addEventListener('click', function () { A.init(); A.play('click'); setTool(S.tool === t.id && t.id !== 'select' ? 'select' : t.id); });
      g.appendChild(b);
    });
    $('#helpTools').innerHTML = TOOLS.filter(function (t) { return t.help && t.id !== 'select' && t.id !== 'erase'; })
      .map(function (t) { return '<li>' + ICON[t.id] + '<span>' + t.help + '</span></li>'; }).join('');
  }
  function setTool(id) {
    if (S.mode !== 'build') return;
    S.tool = id;
    document.querySelectorAll('.tool').forEach(function (b) { b.classList.toggle('sel', b.dataset.tool === id); });
    var t = TOOLS.filter(function (x) { return x.id === id; })[0];
    $('#toolHint').textContent = id === 'select' ? 'pick a tool, then tap the map' : 'tap a glowing spot to place · tap again to remove';
    refreshSlots();
  }
  function refreshCounts() {
    var c = S.net.cost.counts, m = { give: c.yield, stop: c.stop, signal: c.signals, mini: c.mini, rbt: c.rbt, box: c.box, bump: c.bump, bay: c.bay };
    var nl = 0, nr = 0;
    Object.keys(S.config.app).forEach(function (k) { if (S.config.app[k].noL) nl++; if (S.config.app[k].noR) nr++; });
    m.banL = S.mirror ? nr : nl; m.banR = S.mirror ? nl : nr;
    document.querySelectorAll('.tool').forEach(function (b) {
      var n = m[b.dataset.tool] || 0, el = b.querySelector('.cnt');
      if (n && !el) { el = document.createElement('span'); el.className = 'cnt'; b.appendChild(el); }
      if (el) { if (n) el.textContent = n; else el.remove(); }
    });
  }

  /* ---------------- level ---------------- */
  function today() { var d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); }

  function loadDay(opts) {
    stopRun(true);
    S.devOpts = opts || {};
    var date = S.devOpts.date || today();
    S.level = R.level.generate({ date: date, weekday: S.devOpts.weekday, seed: S.devOpts.seed });
    S.plainNet = NET.build(S.level, NET.defaultConfig(S.level));
    var rec = day();
    S.config = NET.normConfig(S.level, rec.config);
    S.testResult = null; S.forecast = false; S.forecastEntry = null; S.seqNode = 0; S.sample = 0;
    $('#sampleName').textContent = SAMPLES[0];
    ren.setLevel(S.level);
    rebuild(true);
    // header
    var L = S.level;
    $('#dayName').textContent = U.DAY_NAMES[L.weekday];
    $('#dayNo').textContent = '#' + L.number;
    var dots = '';
    for (var i = 0; i < 7; i++) dots += '<i class="' + (i <= L.weekday ? 'on' : '') + (i === L.weekday ? ' today' : '') + '"></i>';
    $('#dots').innerHTML = dots;
    $('#jname').textContent = L.name;
    var chips = [];
    function chip(t, title, warn) { chips.push('<span class="chip' + (warn ? ' warn' : '') + '" title="' + title + '">' + t + '</span>'); }
    chip(cap(L.kind), 'Today\'s junction');
    chip(trafficWord(L) + ' traffic', 'About ' + R.level.makeDemand(L, 'official').arrivals.length + ' vehicles in the rush hour');
    if (L.features.indexOf('bus') >= 0) chip('🚌 Bus stop', 'Buses stop on the road unless you build a bus bay');
    if (L.features.indexOf('tram') >= 0) chip('🚊 Tram line', 'Trams never give way. No roundabouts on a tram line');
    if (L.features.indexOf('rail') >= 0) chip('🚂 Level crossing', 'The barriers hold traffic whenever a train passes');
    if (L.features.indexOf('blind') >= 0) chip('🏢 Blind corners', 'Drivers cannot see round the tall buildings: give-way is risky', true);
    if (L.features.indexOf('heavyturn') >= 0) chip('↪ Heavy turn', 'One road has an unusually heavy turning flow');
    $('#chips').innerHTML = chips.join('');
    $('#brief').innerHTML = briefText(L);
    renderResultCard();
    updateSubmitUI();
    drawTimeline();
    startPar();
    refreshDev();
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function trafficWord(L) { return L.q < 0.42 ? 'Light' : L.q < 0.55 ? 'Steady' : L.q < 0.66 ? 'Heavy' : 'Very heavy'; }
  function briefText(L) {
    var f = L.features, lines = [];
    var open = L.nodes.some(function (n) { return n.space === 'open'; });
    if (f.indexOf('double') >= 0) lines.push('Two junctions sit close together — a queue at one soon blocks the other.');
    if (f.indexOf('rail') >= 0) lines.push('Trains close the crossing; queues can reach back into the junction. A <b>box junction</b> keeps it clear.');
    if (f.indexOf('tram') >= 0) lines.push('Trams run straight through and never give way. With <b>lights</b>, the tram gets its own row.');
    if (f.indexOf('bus') >= 0) lines.push('Buses stop in the road and hold up everyone behind — unless you build a <b>bus bay</b>.');
    if (f.indexOf('blind') >= 0) lines.push('Tall buildings hide the corners, so give-way drivers misjudge more. <b>Stop signs</b> or lights are safer.');
    if (!lines.length) lines.push(L.weekday === 0 ? 'A gentle start to the week. Often a sign or two is all it takes.' : 'No special trouble today — just more cars.');
    lines.push(open ? 'There is open ground here: room for a <b>roundabout</b>.' : 'No room for a full roundabout.');
    return '<b>' + U.DAY_NAMES[L.weekday] + ' · ' + cap(L.kind) + '.</b> ' + lines.slice(0, 3).join(' ') +
      '<span class="hint">Unmarked junctions are slow and dangerous — nobody knows who goes first.</span>';
  }

  function rebuild(first) {
    S.config = NET.normConfig(S.level, S.config);
    S.net = NET.build(S.level, S.config);
    ren.setNet(S.net);
    if (!first) { day().config = S.config; save(); }
    $('#stCost').textContent = S.net.cost.total;
    refreshCounts(); refreshSlots(); renderSeq();
  }
  function designChanged() {
    if (S.testResult) { S.testResult = null; renderResultCard(); }
    $('#stDelay').textContent = '–'; $('#stCrash').textContent = '–'; $('#stDone').textContent = '–';
    $('#stCrash').classList.remove('bad');
  }

  /* ---------------- slots: where the current tool can be used ---------------- */
  var _p = {};
  function refreshSlots() {
    var out = [], L = S.level, net = S.net, tool = S.tool;
    S.slots = out; S.hover = null;
    if (S.mode !== 'build' || tool === 'select') return;
    var T = TOOLS.filter(function (x) { return x.id === tool; })[0];
    var wantApp = T.target === 'app' || tool === 'erase', wantNode = T.target === 'node' || tool === 'erase', wantBus = T.target === 'bus' || tool === 'erase';
    if (wantNode) L.nodes.forEach(function (nd, i) {
      var nc = S.config.nodes[i], s = { kind: 'node', node: i, x: nd.c + 0.5, y: nd.r + 0.5, ok: true, active: false };
      if (tool === 'erase') { if (nc.type === 'plain' && !nc.box) return; s.active = true; }
      else if (tool === 'box') { s.active = nc.box; if (nc.type === 'rbt' || nc.type === 'mini') { s.ok = false; s.why = 'A roundabout cannot be a box junction.'; } }
      else {
        s.active = nc.type === tool;
        if (!NET.canPlace(L, i, tool)) { s.ok = false; s.why = tool === 'rbt' ? 'No room for a roundabout here — buildings or tram tracks are in the way.' : 'A mini-roundabout cannot sit on a tram line.'; }
      }
      out.push(s);
    });
    if (wantApp) NET.approachList(L).forEach(function (a) {
      var node = net.nodes[a.node], lane = node.apps[a.dir].lane, ac = S.config.app[a.key] || {};
      NET.posAt(lane.path, lane.len - 0.55, _p);
      var s = { kind: 'app', key: a.key, node: a.node, dir: a.dir, x: _p.x, y: _p.y, ok: true, active: false };
      var nd = L.nodes[a.node];
      if (tool === 'erase') { if (!(ac.sign || ac.bump || ac.noL || ac.noR)) return; s.active = true; }
      else if (tool === 'give' || tool === 'stop') {
        s.active = ac.sign === (tool === 'give' ? 'yield' : 'stop');
        if (node.type !== 'plain') { s.ok = false; s.why = 'Signs only work on a plain junction — remove the ' + (node.type === 'signal' ? 'lights' : 'roundabout') + ' first.'; }
      } else if (tool === 'bump') s.active = !!ac.bump;
      else {
        var f = simBan(tool), arm = f === 'noL' ? (a.dir + 1) % 4 : (a.dir + 3) % 4;
        s.active = !!ac[f];
        if (nd.arms[arm] < 0) return;
      }
      out.push(s);
    });
    if (wantBus) net.segs.forEach(function (sg) {
      sg.stops.forEach(function (bs) {
        if (tool === 'erase' && !bs.bay) return;
        NET.posAt(sg.path, bs.s - 0.38, _p);
        out.push({ kind: 'bus', id: bs.id, x: _p.x, y: _p.y, ok: true, active: bs.bay });
      });
    });
    if (tool === 'bay' && !out.length) toast('No bus stops on today\'s junction.');
  }
  function slotAt(w) {
    var best = null, bd = 1e9;
    S.slots.forEach(function (s) {
      var d = Math.hypot(s.x - w.x, s.y - w.y), lim = s.kind === 'node' ? 0.72 : 0.5;
      if (d < lim && d < bd) { bd = d; best = s; }
    });
    return best;
  }

  function applyTool(s) {
    var tool = S.tool, cfg = S.config, pan = panOf(s.x);
    if (!s.ok) { toast(s.why); A.play('error'); return; }
    var placed = true, popKey = null;
    if (s.kind === 'node') {
      var nc = cfg.nodes[s.node];
      if (tool === 'erase') { nc.type = 'plain'; nc.box = false; nc.sig = null; placed = false; }
      else if (tool === 'box') { nc.box = !nc.box; placed = nc.box; }
      else if (nc.type === tool) {
        if (tool === 'signal') { S.seqNode = s.node; renderSeq(); toast('Lights are already here — edit their timing in the panel.'); return; }
        nc.type = 'plain'; nc.sig = null; placed = false;
      } else {
        var hadSigns = NET.approachList(S.level).some(function (a) { return a.node === s.node && cfg.app[a.key] && cfg.app[a.key].sign; });
        nc.type = tool; nc.sig = tool === 'signal' ? smartSignal(s.node) : null;
        if (tool === 'signal') { S.seqNode = s.node; popKey = 'sig' + s.node; }
        if (hadSigns) toast('The signs here were taken down.');
      }
      ren.spawn('puff', s.x, s.y, { n: 10, color: '#fff', size: 0.16, speed: 0.9, life: 0.5, spread: 0.3 });
    } else if (s.kind === 'app') {
      var ac = cfg.app[s.key] || (cfg.app[s.key] = { sign: null, bump: false, noL: false, noR: false });
      if (tool === 'erase') { delete cfg.app[s.key]; placed = false; }
      else if (tool === 'give' || tool === 'stop') {
        var k = tool === 'give' ? 'yield' : 'stop';
        if (ac.sign === k) { ac.sign = null; placed = false; } else { ac.sign = k; popKey = 'sign' + s.key; }
      } else if (tool === 'bump') { ac.bump = !ac.bump; placed = ac.bump; }
      else {
        var f = simBan(tool); ac[f] = !ac[f]; placed = ac[f]; popKey = f + s.key;
        var norm = NET.normConfig(S.level, cfg), after = norm.app[s.key] || {};
        if (placed && !after[f]) { toast('You cannot ban every way out of a road.'); A.play('error'); S.config = norm; rebuild(); return; }
      }
      ren.spawn('puff', s.x, s.y, { n: 5, color: '#fff', size: 0.1, speed: 0.6, life: 0.4 });
    } else if (s.kind === 'bus') {
      if (cfg.bays[s.id]) { delete cfg.bays[s.id]; placed = false; } else cfg.bays[s.id] = true;
      ren.spawn('puff', s.x, s.y, { n: 8, color: '#fff', size: 0.13, speed: 0.8, life: 0.5, spread: 0.4 });
    }
    A.play(placed ? 'place' : 'remove', { pan: pan });
    rebuild();
    if (popKey) ren.pop(popKey);
    designChanged();
  }

  /* a sensible first timing for new lights: opposite roads together, green shared by demand */
  function smartSignal(ni) {
    var nd = S.level.nodes[ni], flows = R.solver.approachFlows(S.level)[ni];
    function crit(dirs) { var m = 0.03; dirs.forEach(function (d) { if (flows[d] && flows[d].q > m) m = flows[d].q; }); return m; }
    var a = [0, 2].filter(function (d) { return nd.arms[d] >= 0; }), b = [1, 3].filter(function (d) { return nd.arms[d] >= 0; });
    var ca = crit(a), cb = crit(b), C = 24, ga = Math.max(5, Math.round((C - 2) * ca / (ca + cb))), gb = Math.max(5, C - 2 - ga);
    return R.solver.sigFromStages(S.level, nd, [{ dirs: a, tram: nd.tramAxis === 0, g: ga }, { dirs: b, tram: nd.tramAxis === 1, g: gb }], 1);
  }

  /* ---------------- canvas input ---------------- */
  function evWorld(e) {
    var r = ren.cv.getBoundingClientRect();
    return ren.toWorld(e.clientX - r.left, e.clientY - r.top);
  }
  function entryBadgePos(e) {
    var L = S.level, link = L.links[e.link], t = link.tiles[link.tiles.length - 1], d = link.b.dir;
    return { x: U.clamp(t[0] + 0.5 + U.DX[d] * 0.2 + U.DX[(d + 1) % 4] * 0.56, 0.3, L.N - 0.3), y: U.clamp(t[1] + 0.5 + U.DY[d] * 0.2 + U.DY[(d + 1) % 4] * 0.56, 0.3, L.N - 0.3) };
  }
  function onCanvasClick(e) {
    A.init();
    var w = evWorld(e), L = S.level;
    // road badges work in any mode
    var hit = null;
    L.entries.forEach(function (en) { var p = entryBadgePos(en); if (Math.hypot(p.x - w.x, p.y - w.y) < 0.45) hit = en; });
    if (hit) {
      S.forecast = true; S.forecastEntry = S.forecastEntry === hit.id ? null : hit.id;
      $('#btnForecast').classList.add('on');
      if (S.forecastEntry != null) toast(entryInfo(hit));
      A.play('click');
      return;
    }
    if (S.mode !== 'build') return;
    if (S.tool === 'select') {
      var best = -1, bd = 0.8;
      L.nodes.forEach(function (nd, i) { var d = Math.hypot(nd.c + 0.5 - w.x, nd.r + 0.5 - w.y); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) {
        var nc = S.config.nodes[best];
        if (nc.type === 'signal') { S.seqNode = best; renderSeq(); $('#seqCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); A.play('click'); }
        else toast(nc.type === 'plain' ? (S.net.nodes[best].uncontrolled ? 'An unmarked junction: drivers creep in and guess who goes first.' : S.net.nodes[best].allway ? 'All-way stop: first to arrive goes first.' : 'A priority junction: signed roads give way to the others.') : nc.type === 'rbt' ? 'A roundabout: entering traffic gives way to the circle.' : 'A mini-roundabout.');
      }
      return;
    }
    var s = slotAt(w);
    if (s) applyTool(s);
  }
  function onCanvasMove(e) {
    if (e.pointerType !== 'mouse' || S.mode !== 'build') return;
    var w = evWorld(e), s = slotAt(w), tip = $('#tip');
    S.hover = s;
    if (s) {
      var T = TOOLS.filter(function (x) { return x.id === S.tool; })[0];
      tip.textContent = !s.ok ? s.why : (S.tool === 'erase' ? 'Remove' : (s.active ? 'Remove ' : 'Place ') + T.name.toLowerCase());
      var r = ren.cv.getBoundingClientRect();
      tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px';
      tip.hidden = false;
    } else tip.hidden = true;
    ren.cv.style.cursor = s ? (s.ok ? 'pointer' : 'not-allowed') : 'default';
  }
  function entryInfo(en) {
    var L = S.level, n = Math.round(en.rate * profileArea());
    var parts = en.dests.slice().sort(function (a, b) { return b.p - a.p; }).map(function (d) { return '→ ' + L.entries[d.entry].label + ' ' + Math.round(d.p * 100) + '%'; });
    return 'Road ' + en.label + ': about ' + n + ' vehicles  ·  ' + parts.join('  ');
  }
  function profileArea() { var a = 0; for (var t = 0.5; t < S.level.T; t++) a += R.level.profile(S.level, t); return a; }
  function panOf(x) { var p = x / S.level.N * 2 - 1; return (S.mirror ? -p : p) * 0.7; }

  var toastTimer = null;
  function toast(msg, ms) {
    var el = $('#toast');
    el.textContent = msg; el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3200);
  }

  /* ---------------- traffic-light sequencer ---------------- */
  function rowsFor(ni) {
    var L = S.level, nd = L.nodes[ni], out = [];
    for (var d = 0; d < 4; d++) {
      if (nd.arms[d] < 0) continue;
      var link = L.links[nd.arms[d]], lbl, col = '#8a8fa3';
      var en = L.entries.filter(function (e) { return e.link === link.id; })[0];
      if (en) { lbl = en.label; col = ENTRY_COLORS[en.id % ENTRY_COLORS.length]; }
      else lbl = 'J' + ((link.a.node === ni ? link.b.node : link.a.node) + 1);
      var head = (d + 2) % 4; if (S.mirror && (head === 1 || head === 3)) head = 4 - head;
      out.push({ key: String(d), dir: d, label: lbl, color: col, arrow: ['↑', '→', '↓', '←'][head] });
    }
    if (nd.tramAxis >= 0) out.push({ key: 't', dir: -1, label: 'Tram', color: '#e8590c', arrow: '' });
    return out;
  }
  function renderSeq() {
    var card = $('#seqCard'), cfg = S.config;
    var sigNodes = [];
    cfg.nodes.forEach(function (n, i) { if (n.type === 'signal') sigNodes.push(i); });
    if (!sigNodes.length) { card.hidden = true; return; }
    if (sigNodes.indexOf(S.seqNode) < 0) S.seqNode = sigNodes[0];
    card.hidden = false;
    var ni = S.seqNode, sig = cfg.nodes[ni].sig, rows = rowsFor(ni), C = sig.C, h = '';
    h += '<div class="seq-head"><b>Traffic lights</b>';
    if (S.level.nodes.length > 1) {
      h += '<span class="tabs">' + sigNodes.map(function (i) { return '<button class="tab' + (i === ni ? ' on' : '') + '" data-node="' + i + '">Junction ' + (i + 1) + '</button>'; }).join('') + '</span>';
    }
    h += '</div>';
    h += '<div class="seq-ctrl"><button class="mini" data-act="c-">−</button><span class="cyc">' + C + ' ticks</span><button class="mini" data-act="c+">+</button>' +
      '<button class="mini" data-act="shl" title="Start the whole pattern earlier">◀</button><button class="mini" data-act="shr" title="Start the whole pattern later">▶</button>' +
      '<button class="mini" data-act="pair" title="Opposite roads go together">Pairs</button><button class="mini" data-act="split" title="One road at a time">One by one</button>' +
      '<button class="mini danger" data-act="del">Remove</button></div>';
    h += '<div class="seq-grid" style="--C:' + C + '">';
    rows.forEach(function (r, ri) {
      h += '<div class="seq-row"><div class="seq-lbl" style="background:' + r.color + '">' + (r.key === 't' ? '🚊' : r.label + r.arrow) + '</div><div class="seq-cells" data-row="' + r.key + '" data-ri="' + ri + '">';
      for (var t = 0; t < C; t++) h += '<div class="cell" data-t="' + t + '"></div>';
      h += '</div></div>';
    });
    h += '</div><div class="seq-ruler"><div></div><div><span>0</span><span>' + Math.round(C / 2) + '</span><span>' + C + '</span></div></div>';
    h += '<div class="seq-warn" id="seqWarn" hidden></div>';
    h += '<div class="seq-note">Drag across the cells to paint green. One cell is one tick; the pattern repeats all rush hour. The last green tick shows amber.</div>';
    card.innerHTML = h;
    paintSeq();
  }
  function paintSeq() {
    var ni = S.seqNode, nc = S.config.nodes[ni];
    if (!nc || nc.type !== 'signal') return;
    var sig = nc.sig, C = sig.C, rows = rowsFor(ni), clash = {}, warn = [];
    for (var i = 0; i < rows.length; i++) for (var j = i + 1; j < rows.length; j++) {
      var a = rows[i], b = rows[j];
      if (a.dir < 0 || b.dir < 0 || (a.dir + b.dir) % 2 === 0) continue;
      var n = 0;
      for (var t = 0; t < C; t++) if (sig.rows[a.key][t] && sig.rows[b.key][t]) { clash[a.key + ':' + t] = clash[b.key + ':' + t] = true; n++; }
      if (n) warn.push(a.label + ' and ' + b.label);
    }
    document.querySelectorAll('#seqCard .seq-cells').forEach(function (rowEl) {
      var key = rowEl.dataset.row, row = sig.rows[key], cells = rowEl.children;
      for (var t = 0; t < C; t++) {
        var g = row[t], amber = g && !row[(t + 1) % C];
        cells[t].className = 'cell' + (g ? (amber ? ' a' : ' g') : '') + (clash[key + ':' + t] ? ' x' : '');
      }
    });
    var w = $('#seqWarn');
    if (w) { w.hidden = !warn.length; w.textContent = warn.length ? '⚠ Crossing roads are green together: ' + warn.join(', ') + '. Expect crashes.' : ''; }
    S.lastSeqIdx = -1;
  }
  var paint = null;
  function seqPointer(e) {
    if (S.mode !== 'build') return;
    var el = e.target;
    if (e.type === 'pointerdown') {
      if (!el.classList.contains('cell')) return;
      A.init();
      var key = el.parentNode.dataset.row, t = +el.dataset.t, sig = S.config.nodes[S.seqNode].sig;
      paint = { val: !sig.rows[key][t], key: key, ri: +el.parentNode.dataset.ri, last: -1 };
      e.preventDefault();
    }
    if (!paint) return;
    if (e.type === 'pointerup' || e.type === 'pointercancel') { paint = null; rebuild(); designChanged(); return; }
    var at = document.elementFromPoint(e.clientX, e.clientY);
    if (!at || !at.classList.contains('cell') || at.parentNode.dataset.row !== paint.key) return;
    var tt = +at.dataset.t, row = S.config.nodes[S.seqNode].sig.rows[paint.key];
    if (tt === paint.last) return;
    // fill any cells skipped by a fast drag
    var from = paint.last < 0 ? tt : paint.last, lo = Math.min(from, tt), hi = Math.max(from, tt), changed = false;
    for (var k = lo; k <= hi; k++) if (row[k] !== paint.val) { row[k] = paint.val; changed = true; }
    paint.last = tt;
    if (changed) { A.play('tick', { row: paint.ri, on: paint.val }); paintSeq(); }
  }
  function seqClick(e) {
    if (S.mode !== 'build') return;
    var b = e.target.closest('button');
    if (!b) return;
    A.init(); A.play('click');
    if (b.dataset.node) { S.seqNode = +b.dataset.node; renderSeq(); return; }
    var act = b.dataset.act, ni = S.seqNode, nc = S.config.nodes[ni], sig = nc.sig, nd = S.level.nodes[ni];
    if (!act) return;
    function resize(C) {
      Object.keys(sig.rows).forEach(function (k) { var r = sig.rows[k].slice(0, C); while (r.length < C) r.push(false); sig.rows[k] = r; });
      sig.C = C;
    }
    if (act === 'c-') resize(Math.max(6, sig.C - 2));
    else if (act === 'c+') resize(Math.min(60, sig.C + 2));
    else if (act === 'shl' || act === 'shr') {
      var k = act === 'shl' ? 1 : -1;
      Object.keys(sig.rows).forEach(function (key) { var r = sig.rows[key], o = []; for (var t = 0; t < sig.C; t++) o.push(r[((t + k) % sig.C + sig.C) % sig.C]); sig.rows[key] = o; });
    } else if (act === 'pair') nc.sig = smartSignal(ni);
    else if (act === 'split') {
      var arms = [0, 1, 2, 3].filter(function (d) { return nd.arms[d] >= 0; }), g = Math.max(4, Math.round(sig.C / arms.length) - 1);
      nc.sig = R.solver.sigFromStages(S.level, nd, arms.map(function (d) { return { dirs: [d], tram: nd.tramAxis >= 0 && (d % 2 === 1) === (nd.tramAxis === 1), g: g }; }), 1);
    } else if (act === 'del') { nc.type = 'plain'; nc.sig = null; A.play('remove'); }
    rebuild(); designChanged();
  }
  function seqPlayhead() {
    if (!S.sim) return;
    var node = S.sim.net.nodes[S.seqNode];
    if (!node || !node.sig) return;
    var idx = node.sigIdx;
    if (idx === S.lastSeqIdx) return;
    document.querySelectorAll('#seqCard .seq-cells').forEach(function (rowEl) {
      if (S.lastSeqIdx >= 0 && rowEl.children[S.lastSeqIdx]) rowEl.children[S.lastSeqIdx].classList.remove('now');
      if (rowEl.children[idx]) rowEl.children[idx].classList.add('now');
    });
    S.lastSeqIdx = idx;
  }

  /* ---------------- timeline ---------------- */
  function drawTimeline() {
    var L = S.level, cv = tl, dpr = Math.min(2, window.devicePixelRatio || 1), w = cv.clientWidth, h = 56;
    if (!w) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    var c = tlCtx; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    var X = function (t) { return 6 + (w - 12) * t / L.TMAX; }, base = 40, top = 6;
    // rush-hour curve
    c.beginPath(); c.moveTo(X(0), base);
    for (var t = 0; t <= L.T; t += 2) c.lineTo(X(t), base - (base - top) * R.level.profile(L, t) * 0.95);
    c.lineTo(X(L.T), base); c.closePath();
    c.fillStyle = '#ffe3b3'; c.fill();
    c.fillStyle = '#f1e9dc'; c.fillRect(X(L.T), base - 3, X(L.TMAX) - X(L.T), 3);
    c.fillStyle = '#7a7f93'; c.font = '700 10px Nunito, system-ui, sans-serif'; c.textBaseline = 'alphabetic';
    c.textAlign = 'left'; c.fillText('rush hour', X(4), base - 4);
    c.textAlign = 'right'; c.fillText('clearing', X(L.TMAX) - 2, base - 6);
    // trains
    if (L.rail) L.rail.times.forEach(function (tt) {
      var T = R.sim.TRAIN;
      c.fillStyle = 'rgba(224,49,49,0.22)'; c.fillRect(X(tt - T.warn), top, X(tt + T.open) - X(tt - T.warn), base - top);
      c.fillStyle = '#e03131'; rrect(c, X(tt) - 7, top - 3, 14, 9, 3); c.fill();
      c.fillStyle = '#fff'; c.fillRect(X(tt) - 4, top, 3, 3); c.fillRect(X(tt) + 1, top, 3, 3);
    });
    // trams and buses
    R.level.tramTimes(L).forEach(function (tt) { if (tt < L.T) { c.fillStyle = '#e8590c'; rrect(c, X(tt) - 2, base - 12, 4, 12, 2); c.fill(); } });
    L.busLines.forEach(function (bl, li) {
      for (var t2 = bl.phase; t2 < L.T; t2 += bl.headway) { c.fillStyle = li ? '#20c997' : '#ff922b'; c.beginPath(); c.arc(X(t2), base - 4, 3, 0, 7); c.fill(); }
    });
    c.fillStyle = '#3d4050'; c.fillRect(6, base, w - 12, 2);
    // legend
    c.font = '700 10px Nunito, system-ui, sans-serif'; c.textAlign = 'left';
    var lx = 6, ly = 53;
    function leg(col, txt) { c.fillStyle = col; c.beginPath(); c.arc(lx + 4, ly - 3.500, 3.500, 0, 7); c.fill(); c.fillStyle = '#7a7f93'; c.fillText(txt, lx + 11, ly); lx += 18 + c.measureText(txt).width; }
    if (L.rail) leg('#e03131', 'train');
    if (L.tram) leg('#e8590c', 'tram');
    if (L.busLines.length) leg('#ff922b', 'bus');
    // playhead
    if (S.sim) {
      var px = X(Math.min(S.sim.t, L.TMAX));
      c.fillStyle = '#3d4050'; c.fillRect(px - 1, 2, 2, base);
      c.beginPath(); c.arc(px, 4, 4, 0, 7); c.fill();
      c.textAlign = 'right'; c.fillStyle = '#3d4050'; c.font = '800 11px Nunito, system-ui, sans-serif';
      c.fillText('tick ' + Math.floor(S.sim.t), w - 6, ly);
    }
  }
  function rrect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  /* ---------------- running traffic ---------------- */
  function startRun(kind, seedOverride) {
    A.init();
    var seed = seedOverride || (kind === 'official' ? 'official' : 'test-' + SAMPLES[S.sample]);
    S.sim = new R.sim.Sim(S.level, S.config, R.level.makeDemand(S.level, seed), { fx: true });
    S.mode = 'run'; S.runKind = kind; S.acc = 0; S.lastTick = -1; S.skipping = false; S.lastSeqIdx = -1;
    S.testResult = null; renderResultCard();
    S.slots = []; S.hover = null; $('#tip').hidden = true;
    S.forecast = false; S.forecastEntry = null; $('#btnForecast').classList.remove('on');
    document.body.classList.add('running');
    $('#toolsCard').classList.add('dis');
    $('#btnTest').classList.add('stop'); $('#btnTestLbl').textContent = kind === 'official' ? 'Official run…' : 'Stop';
    $('#btnTest').querySelector('.ico').textContent = kind === 'official' ? '●' : '■';
    $('#btnTest').disabled = kind === 'official';
    $('#btnSubmit').disabled = true; $('#btnSample').disabled = true;
    var rb = $('#runBadge'); rb.hidden = false; rb.textContent = kind === 'official' ? 'Official rush hour' : 'Test · traffic ' + SAMPLES[S.sample];
    rb.classList.toggle('official', kind === 'official');
    A.play('start');
  }
  function stopRun(silent) {
    if (S.mode !== 'run') return;
    S.sim = null; S.mode = 'build'; S.skipping = false;
    document.body.classList.remove('running');
    $('#toolsCard').classList.remove('dis');
    $('#btnTest').classList.remove('stop'); $('#btnTestLbl').textContent = 'Test'; $('#btnTest').querySelector('.ico').textContent = '▶';
    $('#btnTest').disabled = false; $('#btnSample').disabled = false;
    $('#runBadge').hidden = true;
    A.quiet(); A.setTrain(false);
    document.querySelectorAll('#seqCard .cell.now').forEach(function (c) { c.classList.remove('now'); });
    updateSubmitUI(); refreshSlots(); drawTimeline();
    if (!silent) A.play('stop');
  }
  function endRun() {
    var res = S.sim.result, kind = S.runKind;
    stopRun(true);
    showStats(res);
    if (kind === 'test') {
      S.testResult = { res: res, sample: SAMPLES[S.sample] };
      renderResultCard();
      A.play(res.crashes ? 'meh' : 'win');
      toast('Test score: ' + res.score + (res.crashes ? ' — ' + res.crashes + (res.crashes > 1 ? ' crashes' : ' crash') : '') + '. Details are in the panel.');
      confettiIf(res.score >= 700);
    } else {
      var rec = day();
      rec.submitted = { score: res.score, res: slim(res), stars: null, counts: S.net.cost.counts, config: S.config };
      if (!S.devOpts.date && !S.devOpts.seed && S.devOpts.weekday == null) {
        var st = store.stats;
        st.played++; st.streak = (st.lastNumber === S.level.number - 1) ? st.streak + 1 : 1;
        st.maxStreak = Math.max(st.maxStreak, st.streak); st.lastNumber = S.level.number; st.best = Math.max(st.best, res.score);
      }
      save();
      updateSubmitUI();
      showResults(true);
    }
  }
  function slim(res) { return { score: res.score, flow: res.flow, avgDelay: res.avgDelay, worstDelay: res.worstDelay, worstEntry: res.worstEntry, crashes: res.crashes, crashPen: res.crashPen, cost: res.cost, served: res.served, total: res.total, perEntry: res.perEntry, tramDelay: res.tramDelay }; }

  function showStats(res) {
    $('#stDelay').textContent = res.avgDelay.toFixed(1);
    $('#stCrash').textContent = res.crashes; $('#stCrash').classList.toggle('bad', res.crashes > 0);
    $('#stDone').textContent = res.served + '/' + res.total;
  }
  function liveStats() {
    var sim = S.sim, st = sim.stats, crashes = st.crashes + st.tramCrashes + st.trainCrashes;
    $('#stDelay').textContent = st.sumW ? st.liveDelay.toFixed(1) : '0.0';
    var ce = $('#stCrash');
    if (ce.textContent !== String(crashes)) { ce.textContent = crashes; ce.classList.toggle('bad', crashes > 0); ce.classList.remove('bump'); void ce.offsetWidth; ce.classList.add('bump'); }
    $('#stDone').textContent = st.done + '/' + st.total;
  }

  function handleEvents() {
    var sim = S.sim, ev = sim.events, i, e, p = {};
    for (i = 0; i < ev.length; i++) {
      e = ev[i];
      if (S.skipping) continue;
      switch (e.type) {
        case 'honk':
          R.sim.bodyPos(e.a, 0, p);
          ren.spawn('ring', p.x, p.y, { size: 0.22, life: 0.45, color: '#fff', speed: 0 });
          ren.spawn('ring', p.x, p.y, { size: 0.32, life: 0.6, color: '#ffd43b', speed: 0 });
          A.play(e.a.type === 'car' ? 'honk' : 'honkBig', { pan: panOf(p.x), id: e.a.id, angry: e.b === 1 });
          break;
        case 'crash':
          ren.spawn('star', e.a, e.b, { n: 9, size: 0.14, speed: 2.2, life: 0.8, color: '#ffd43b' });
          ren.spawn('puff', e.a, e.b, { n: 12, size: 0.2, speed: 1.1, life: 0.9, color: '#f1f3f5', spread: 0.2 });
          ren.spawn('puff', e.a, e.b, { n: 5, size: 0.16, speed: 0.6, life: 1.2, color: '#868e96', spread: 0.2 });
          if (!store.settings.calm) ren.shake = e.c ? 1 : 0.6;
          A.play('crash', { pan: panOf(e.a) });
          break;
        case 'towed':
          R.sim.bodyPos(e.a, e.a.len / 2, p);
          ren.spawn('puff', p.x, p.y, { n: 8, size: 0.16, speed: 0.8, life: 0.6, color: '#fff' });
          A.play('poof', { pan: panOf(p.x) });
          break;
        case 'done':
          R.sim.bodyPos(e.a, 0, p);
          A.play('pluck', { pan: panOf(p.x), note: (e.a.arr ? e.a.arr.dest * 2 : 5) + (e.a.id % 3) });
          break;
        case 'tramBell':
          R.sim.bodyPos(e.a, 0, p);
          ren.spawn('ring', p.x, p.y, { size: 0.3, life: 0.6, color: '#ffa94d', speed: 0 });
          A.play('tramBell', { pan: panOf(p.x) });
          break;
        case 'trainHorn': A.play('trainHorn', { pan: panOf(e.a) }); break;
        case 'barrierWarn': case 'barrierDown': A.startBell(); break;
        case 'barrierUp': A.stopBell(); break;
        case 'busStop':
          R.sim.bodyPos(e.a, e.a.len / 2, p);
          A.play('busDoor', { pan: panOf(p.x) });
          ren.spawn('note', p.x, p.y - 0.15, { size: 0.2, life: 1.0, color: '♪', speed: 0 });
          break;
        case 'sig': A.play('sig', { pan: panOf(e.a) }); break;
      }
    }
    ev.length = 0;
    // launches from standstill: a little engine note now and then
    if (!S.skipping) {
      var moving = 0, vs = 0, trainOn = false;
      for (i = 0; i < sim.veh.length; i++) {
        var V = sim.veh[i];
        if (V.v > 0.05) { moving++; vs += V.v; }
        if (V.a > 0.3 && V.v < 0.12 && !V._vr) { V._vr = true; R.sim.bodyPos(V, 0, p); A.play('vroom', { pan: panOf(p.x), id: V.id }); }
        else if (V.v > 0.4) V._vr = false;
      }
      A.setTraffic(moving, moving ? vs / moving : 0);
      sim.trains.forEach(function (tr) { var x = (sim.t - tr.t0) * R.sim.TRAIN.v; if (x > -9 && x < R.sim.TRAIN.len + 9) trainOn = true; });
      A.setTrain(trainOn);
    }
  }

  function confettiIf(yes) {
    if (!yes || store.settings.calm) return;
    var N = S.level.N, cols = ['#ff6b6b', '#ffd43b', '#69db7c', '#4dabf7', '#b197fc', '#f783ac'];
    for (var i = 0; i < 70; i++) ren.spawn('confetti', Math.random() * N, -0.5, { size: 0.2, life: 2.4, speed: 1.5, vy: 2.5, color: cols[i % cols.length] });
  }

  /* ---------------- results ---------------- */
  function renderResultCard() {
    var card = $('#resultCard'), tr = S.testResult;
    if (!tr) { card.hidden = true; return; }
    var r = tr.res;
    card.hidden = false;
    card.innerHTML = '<div class="card-h">Test result <small>traffic ' + tr.sample + ' · the official run will differ a little</small></div>' +
      '<div class="rs-top"><span class="rs-score">' + r.score + '</span><span class="rs-lbl">points</span></div>' +
      '<div class="rs-rows"><span>Flow (avg wait ' + r.avgDelay.toFixed(1) + ', worst road ' + r.worstDelay.toFixed(1) + ')</span><span>' + r.flow + '</span>' +
      '<span>Crashes × ' + r.crashes + '</span><span class="' + (r.crashPen ? 'neg' : '') + '">−' + r.crashPen + '</span>' +
      '<span>Build cost</span><span class="' + (r.cost ? 'neg' : '') + '">−' + r.cost + '</span></div>' + roadBars(r);
  }
  function roadBars(r) {
    var L = S.level, max = 12;
    r.perEntry.forEach(function (p) { if (p.delay > max) max = p.delay; });
    if (r.tramDelay != null && r.tramDelay > max) max = r.tramDelay;
    function bar(lbl, col, d) {
      return '<div class="roadbar"><span class="badge" style="background:' + col + '">' + lbl + '</span><span class="bar"><i class="' + (d > 25 ? 'bad' : d > 12 ? 'mid' : '') + '" style="width:' + Math.max(3, Math.round(100 * d / max)) + '%"></i></span><span>' + d.toFixed(1) + '</span></div>';
    }
    var h = '<div class="roadbars">';
    L.entries.forEach(function (e, i) { h += bar(e.label, ENTRY_COLORS[i % ENTRY_COLORS.length], r.perEntry[i].delay); });
    if (r.tramDelay != null) h += bar('🚊', '#e8590c', r.tramDelay);
    return h + '</div>';
  }

  function starsFor(score, par) {
    par = Math.max(1, par);
    return score >= par * 0.95 ? 3 : score >= par * 0.8 ? 2 : score >= par * 0.55 ? 1 : 0;
  }
  var STAR_SVG = '<svg class="star" viewBox="0 0 48 48"><path d="M24 3l6.300 13.400 14.700 1.800-10.800 10.100 2.800 14.500L24 35.700 11 42.800l2.800-14.500L3 18.200l14.700-1.800z" fill="#ffd43b" stroke="#f08c00" stroke-width="2.500" stroke-linejoin="round"/></svg>';

  function showResults(animate) {
    var rec = day(), sub = rec.submitted;
    if (!sub) return;
    var r = sub.res, L = S.level, par = rec.par;
    $('#resDay').textContent = 'Roadle #' + L.number + ' · ' + U.DAY_NAMES[L.weekday] + ' · ' + L.name;
    $('#resStars').innerHTML = STAR_SVG + STAR_SVG + STAR_SVG;
    $('#resBreak').innerHTML = '<span>Traffic flow</span><span class="v">' + r.flow + '</span><span class="sub">average wait ' + r.avgDelay.toFixed(1) + ' ticks · worst road ' + r.worstDelay.toFixed(1) + '</span>' +
      '<span>Crashes × ' + r.crashes + '</span><span class="v ' + (r.crashPen ? 'neg' : '') + '">−' + r.crashPen + '</span>' +
      '<span>Build cost</span><span class="v ' + (r.cost ? 'neg' : '') + '">−' + r.cost + '</span>';
    $('#resRoads').innerHTML = roadBars(r);
    openModal('#mResult');
    var el = $('#resScore');
    if (animate) {
      var t0 = performance.now(), k = 0;
      (function tick(now) {
        var f = Math.min(1, (now - t0) / 1100), v = Math.round(sub.score * U.ease.outCubic(f));
        el.textContent = v;
        if ((k++ % 4) === 0 && f < 1) A.play('count', { k: Math.round(f * 20) });
        if (f < 1) requestAnimationFrame(tick); else fillStars(true);
      })(t0);
    } else { el.textContent = sub.score; fillStars(false); }
    updateCountdown();
  }
  function fillStars(animate) {
    var rec = day(), sub = rec.submitted, par = rec.par, eng = $('#resEng');
    if (!sub) return;
    if (!par) { eng.className = 'engineer'; eng.textContent = 'The city engineer is still measuring up…'; S.pendingStars = animate ? 'anim' : 'static'; return; }
    S.pendingStars = null;
    var n = starsFor(sub.score, par.score);
    if (sub.stars == null) {
      sub.stars = n;
      if (!S.devOpts.date && !S.devOpts.seed && S.devOpts.weekday == null) store.stats.stars[n]++;
      save();
    }
    var stars = document.querySelectorAll('#resStars .star');
    stars.forEach(function (s, i) {
      if (i >= n) return;
      if (animate) setTimeout(function () { s.classList.add('on'); A.play('star', { n: i }); }, 250 + i * 380);
      else s.classList.add('on');
    });
    var diff = sub.score - par.score;
    eng.className = 'engineer' + (diff > 0 ? ' beat' : '');
    eng.innerHTML = (diff > 0 ? '🏆 <b>You beat the city engineer by ' + diff + '!</b>' : diff === 0 ? 'Dead level with the city engineer.' : 'The city engineer scored <b>' + par.score + '</b> — ' + (-diff) + ' ahead of you.') +
      '<br>Their design: ' + par.desc + '.';
    if (animate && n === 3) setTimeout(function () { confettiIf(true); A.play('win'); }, 1300);
  }
  function describeConfig(cfg) {
    var c = NET.cost(S.level, cfg), out = [];
    c.items.forEach(function (it) { out.push((it.n > 1 && it.key !== 'signal' ? it.n + ' × ' : '') + it.label.toLowerCase() + (it.key === 'signal' ? ' (' + it.n + ' roads)' : '')); });
    return (out.length ? out.join(', ') : 'nothing at all') + ' — cost ' + c.total;
  }

  var cdTimer = null;
  function updateCountdown() {
    clearInterval(cdTimer);
    function upd() {
      var now = new Date(), mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), s = Math.max(0, Math.floor((mid - now) / 1000));
      var names = U.DAY_NAMES, next = names[(S.level.weekday + 1) % 7];
      $('#resNext').textContent = 'Next junction (' + next + ') in ' + Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm ' + (s % 60) + 's';
    }
    upd(); cdTimer = setInterval(function () { if ($('#mResult').hidden) clearInterval(cdTimer); else upd(); }, 1000);
  }

  function shareText() {
    var rec = day(), sub = rec.submitted, L = S.level, r = sub.res, c = sub.counts || {};
    var stars = sub.stars == null ? '' : '⭐'.repeat(sub.stars) + '☆'.repeat(3 - sub.stars) + ' ';
    var tools = '';
    function add(n, em) { for (var i = 0; i < Math.min(n || 0, 4); i++) tools += em; }
    add(c.signals, '🚦'); add(c.rbt, '🔄'); add(c.mini, '⭕'); add(c.stop, '🛑'); add(c.yield, '🔻'); add(c.box, '🟨'); add(c.bay, '🚌'); add(c.bump, '〰️'); add(c.noturn, '⛔');
    var lines = ['Roadle #' + L.number + ' · ' + U.DAY_NAMES[L.weekday], stars + sub.score + ' pts',
      '🚗 flow ' + r.flow + ' · 💥 ' + r.crashes + ' · 💰 ' + r.cost, tools || '🤷 (built nothing)'];
    if (rec.par && sub.score > rec.par.score) lines.push('👷 Beat the city engineer by ' + (sub.score - rec.par.score));
    lines.push(root.ROADLE_URL || (location.protocol === 'file:' ? 'https://roadle.example' : location.origin + location.pathname));
    return lines.join('\n');
  }
  function doShare() {
    var txt = shareText(), btn = $('#btnShare');
    function ok() { btn.textContent = 'Copied!'; A.play('place'); setTimeout(function () { btn.textContent = 'Share'; }, 1800); }
    function fallback() {
      var ta = document.createElement('textarea'); ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); ok(); } catch (e) { prompt('Copy your result:', txt); }
      ta.remove();
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(ok, fallback); else fallback();
  }

  function updateSubmitUI() {
    var sub = day().submitted, b = $('#btnSubmit');
    b.disabled = false;
    b.classList.toggle('done', !!sub);
    b.textContent = sub ? 'Submitted · ' + sub.score + ' pts — view' : 'Submit design';
    $('#subNote').textContent = sub ? 'Today\'s score is locked in. Keep experimenting if you like.' : 'One official rush hour per day. Test as much as you like first.';
  }

  /* ---------------- the city engineer (par) ---------------- */
  function startPar() {
    var rec = day();
    S.parJob = null;
    if (rec.par && rec.par.v === 3) return;
    S.parJob = new R.solver.Job(S.level, { quick: true });
  }
  function stepPar(budget) {
    if (!S.parJob) return;
    if (S.parJob.step(budget)) {
      var res = S.parJob.result, rec = day();
      rec.par = { v: 3, score: res.official.score, desc: describeConfig(res.config), config: res.config };
      S.parJob = null; save();
      if (S.pendingStars) fillStars(S.pendingStars === 'anim');
      refreshDev();
    }
  }

  /* ---------------- modals ---------------- */
  function openModal(sel) { $(sel).hidden = false; }
  function closeModals() { document.querySelectorAll('.modal').forEach(function (m) { m.hidden = true; }); }
  function showStatsModal() {
    var st = store.stats, tot = st.stars[0] + st.stars[1] + st.stars[2] + st.stars[3];
    var avg = tot ? ((st.stars[1] + 2 * st.stars[2] + 3 * st.stars[3]) / tot).toFixed(1) : '–';
    $('#statGrid').innerHTML = '<div><b>' + st.played + '</b><span>played</span></div><div><b>' + st.streak + '</b><span>day streak</span></div><div><b>' + st.maxStreak + '</b><span>best streak</span></div><div><b>' + avg + '</b><span>avg stars</span></div>';
    var h = '', base = today(), wd = U.weekdayIndex(base);
    for (var i = 0; i < 7; i++) {
      var d = U.addDays(base, i - wd), rec = store.days['roadle:' + U.dateStr(d)], sub = rec && rec.submitted;
      h += '<div class="' + (i === wd ? 'today' : '') + '">' + U.DAY_NAMES[i].slice(0, 3) + '<b>' + (sub ? sub.score : '·') + '</b><i>' + (sub && sub.stars != null ? '★'.repeat(sub.stars) || '–' : '&nbsp;') + '</i></div>';
    }
    $('#statWeek').innerHTML = h;
    openModal('#mStats');
  }

  /* ---------------- settings ---------------- */
  function autoLeft() {
    try {
      var langs = navigator.languages || [navigator.language || ''];
      for (var i = 0; i < langs.length; i++) { var m = /-([A-Za-z]{2})\b/.exec(langs[i]); if (m) return LHT.indexOf(m[1].toUpperCase()) >= 0; }
      var tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return /^(Europe\/(London|Dublin)|Australia\/|Pacific\/Auckland|Asia\/(Tokyo|Kolkata|Hong_Kong|Singapore))/.test(tz);
    } catch (e) { return false; }
  }
  function applySettings() {
    var s = store.settings;
    S.mirror = s.hand === 'left' || (s.hand === 'auto' && autoLeft());
    ren.setMirror(S.mirror);
    A.setEnabled(!!s.sound);
    $('#btnSound').classList.toggle('off', !s.sound);
    $('#setSound').checked = !!s.sound; $('#setHand').value = s.hand; $('#setCalm').checked = !!s.calm;
    // turn-ban tools swap meaning when mirrored, so relabel nothing: screen-left stays "left"
    if (S.level) { refreshCounts(); refreshSlots(); renderSeq(); }
  }

  /* ---------------- developer panel ---------------- */
  function refreshDev() {
    var el = $('#dev');
    if (!S.dev) { el.hidden = true; return; }
    el.hidden = false;
    var L = S.level, rec = day(), h = '';
    h += '<button class="x" data-dev="close">×</button><b>Roadle dev</b> · ' + L.date + ' · ' + L.id;
    h += '<h4>Day</h4><button data-dev="prev">◀ day</button><button data-dev="next">day ▶</button><button data-dev="today">today</button><br>' +
      '<input type="date" id="devDate" value="' + L.date + '"> <select id="devWd"><option value="">weekday: auto</option>' + U.DAY_NAMES.map(function (n, i) { return '<option value="' + i + '"' + (S.devOpts.weekday === i ? ' selected' : '') + '>' + n + '</option>'; }).join('') + '</select><br>' +
      '<input type="text" id="devSeed" placeholder="custom seed" value="' + (S.devOpts.seed || '') + '"> <button data-dev="seed">load</button><button data-dev="rnd">random</button>';
    h += '<h4>Junction</h4>q=' + L.q.toFixed(2) + ' · ' + L.features.join(', ') + ' · nodes: ' + L.nodes.map(function (n) { return n.space + (n.blind ? '!' : ''); }).join('/') +
      '<br>' + L.entries.map(function (e) { return e.label + ':' + e.rate.toFixed(2); }).join(' ') + (L.rail ? '<br>trains @ ' + L.rail.times.join(', ') : '') + (L.tram ? '<br>tram every ' + L.tram.headway + ' from ' + L.tram.phase : '');
    h += '<h4>Run</h4><button data-dev="sp8">8×</button><button data-dev="sp16">16×</button><button data-dev="inst">instant ×5 seeds</button><button data-dev="official">official (no save)</button>';
    h += '<h4>Overlays</h4>' + ['paths', 'zones', 'ids'].map(function (k) { return '<label><input type="checkbox" data-ov="' + k + '"' + (ren.debug[k] ? ' checked' : '') + '> ' + k + '</label>'; }).join('');
    h += '<h4>Engineer</h4>par: ' + (rec.par ? rec.par.score + ' — ' + rec.par.desc : (S.parJob ? 'computing…' : 'n/a')) +
      '<br><button data-dev="solve">full solve</button><button data-dev="applypar">apply par design</button><button data-dev="repar">recompute par</button><div id="devOut"></div>';
    h += '<h4>Data</h4><button data-dev="resetday">reset this day</button><button data-dev="wipe">wipe all</button><button data-dev="copycfg">copy config</button><button data-dev="pastecfg">paste config</button>';
    el.innerHTML = h;
  }
  function devAction(e) {
    var t = e.target, act = t.dataset.dev;
    if (t.dataset.ov) { ren.debug[t.dataset.ov] = t.checked; return; }
    if (!act) return;
    var L = S.level, cur = U.parseDate(L.date), out = $('#devOut');
    function go(o) { loadDay(o); }
    if (act === 'close') { S.dev = false; try { localStorage.removeItem('roadle.dev'); } catch (x) { } refreshDev(); }
    else if (act === 'prev') go({ date: U.addDays(cur, -1), weekday: S.devOpts.weekday });
    else if (act === 'next') go({ date: U.addDays(cur, 1), weekday: S.devOpts.weekday });
    else if (act === 'today') go({});
    else if (act === 'seed') go({ date: cur, weekday: S.devOpts.weekday, seed: $('#devSeed').value || undefined });
    else if (act === 'rnd') go({ date: cur, weekday: S.devOpts.weekday, seed: 'dev-' + Math.random().toString(36).slice(2, 8) });
    else if (act === 'sp8') setSpeed(8);
    else if (act === 'sp16') setSpeed(16);
    else if (act === 'official') startRun('test', 'official');
    else if (act === 'inst') {
      var rows = SAMPLES.map(function (s) { var r = R.sim.evaluate(L, S.config, R.level.makeDemand(L, 'test-' + s)); return '<tr><td>' + s + '</td><td>' + r.score + '</td><td>' + r.avgDelay + '</td><td>' + r.worstDelay + '</td><td>' + r.crashes + '</td></tr>'; });
      var o = R.sim.evaluate(L, S.config, R.level.makeDemand(L, 'official'));
      out.innerHTML = '<table><tr><td>seed</td><td>score</td><td>avg</td><td>worst</td><td>crash</td></tr>' + rows.join('') + '<tr><td>official</td><td>' + o.score + '</td><td>' + o.avgDelay + '</td><td>' + o.worstDelay + '</td><td>' + o.crashes + '</td></tr></table>';
    } else if (act === 'solve') {
      out.textContent = 'solving…';
      setTimeout(function () {
        var t0 = Date.now(), sol = R.solver.solve(L, { seeds: ['test-A', 'test-B', 'test-C'] }), fam = {};
        sol.table.forEach(function (r) { var k = 'J' + (r.node + 1) + ' ' + r.family; if (!(k in fam) || r.score > fam[k]) fam[k] = r.score; });
        S.devSol = sol;
        out.innerHTML = '<b>best ' + sol.score + ' (official ' + sol.official.score + ')</b> ' + sol.names.join(' + ') + ' (' + sol.evals + ' runs, ' + (Date.now() - t0) + 'ms)<table>' +
          Object.keys(fam).sort(function (a, b) { return fam[b] - fam[a]; }).map(function (k) { return '<tr><td>' + k + '</td><td>' + fam[k] + '</td></tr>'; }).join('') + '</table><button data-dev="applysol">apply</button>';
      }, 30);
    } else if (act === 'applysol' && S.devSol) { S.config = S.devSol.config; rebuild(); designChanged(); }
    else if (act === 'applypar') { var rec = day(); if (rec.par) { S.config = JSON.parse(JSON.stringify(rec.par.config)); rebuild(); designChanged(); } }
    else if (act === 'repar') { delete day().par; startPar(); refreshDev(); }
    else if (act === 'resetday') { delete store.days[L.id]; save(); go(S.devOpts); }
    else if (act === 'wipe') { try { localStorage.removeItem(STORE_KEY); } catch (x) { } store = load(); go(S.devOpts); }
    else if (act === 'copycfg') { var txt = JSON.stringify(S.config); if (navigator.clipboard) navigator.clipboard.writeText(txt); out.innerHTML = '<pre>' + txt + '</pre>'; }
    else if (act === 'pastecfg') { var s = prompt('Config JSON'); if (s) { try { S.config = JSON.parse(s); rebuild(); designChanged(); } catch (x) { alert('bad JSON'); } } }
  }
  function enableDev(on) {
    S.dev = on;
    try { if (on) localStorage.setItem('roadle.dev', '1'); else localStorage.removeItem('roadle.dev'); } catch (e) { }
    refreshDev();
    if (on) toast('Developer mode on');
  }

  /* ---------------- main loop ---------------- */
  function setSpeed(v) {
    S.speed = v;
    if (v <= 4) { store.settings.speed = v; save(); }
    document.querySelectorAll('#speedRow [data-speed]').forEach(function (b) { b.classList.toggle('on', +b.dataset.speed === v); });
  }
  var lastTs = 0;
  function frame(ts) {
    var dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016);
    lastTs = ts;
    var alpha = 1;
    if (S.mode === 'run' && S.sim) {
      var sim = S.sim;
      if (S.skipping) {
        var t0 = performance.now();
        while (!sim.done && performance.now() - t0 < 14) { sim.advance(); }
        sim.events.length = 0;
      } else {
        S.acc += dt * S.speed * TPS * R.sim.SUB;
        var n = Math.floor(S.acc); S.acc -= n;
        if (n > 200) n = 200;
        for (var i = 0; i < n && !sim.done; i++) sim.advance();
        alpha = S.acc;
        handleEvents();
      }
      var tick = Math.floor(sim.t);
      if (tick !== S.lastTick) { S.lastTick = tick; liveStats(); drawTimeline(); seqPlayhead(); }
      if (sim.done) endRun();
    } else stepPar(S.pendingStars ? 12 : 4);
    var backlog = null;
    if (S.sim) { backlog = {}; S.sim.backlog.forEach(function (q, i) { backlog[i] = q.length; }); }
    ren.draw({ sim: S.sim, alpha: alpha, slots: S.mode === 'build' ? S.slots : null, hover: S.hover, forecast: S.forecast && S.mode === 'build',
      forecastEntry: S.forecastEntry, plainNet: S.plainNet, backlog: backlog, showNodeTags: S.mode === 'build' && S.level.nodes.length > 1 && !$('#seqCard').hidden }, dt);
    requestAnimationFrame(frame);
  }

  function layout() {
    var wrap = $('#canvasWrap'), stage = wrap.parentNode, w = stage.clientWidth;
    var wide = window.innerWidth > 860;
    var maxH = wide ? window.innerHeight - 190 : window.innerHeight * 0.62;
    var size = Math.max(260, Math.floor(Math.min(w, Math.max(300, maxH))));
    wrap.style.width = size + 'px'; wrap.style.height = size + 'px';
    if (wide) wrap.style.margin = '0'; else wrap.style.margin = '0 auto';
    ren.resize(size);
    document.querySelector('.timeline').style.maxWidth = size + 'px';
    document.querySelector('.timeline').style.margin = wide ? '10px 0 0' : '10px auto 0';
    drawTimeline();
  }

  /* ---------------- boot ---------------- */
  function boot() {
    ren = new R.render.Renderer($('#cv'));
    tl = $('#tl'); tlCtx = tl.getContext('2d');
    buildToolbox();
    var q = new URLSearchParams(location.search), devFlag = false;
    try { devFlag = localStorage.getItem('roadle.dev') === '1'; } catch (e) { }
    if (q.has('dev')) devFlag = q.get('dev') !== '0';
    S.dev = devFlag;
    try { if (devFlag) localStorage.setItem('roadle.dev', '1'); else localStorage.removeItem('roadle.dev'); } catch (e) { }
    applySettings();
    var opts = {};
    if (S.dev || q.has('shot')) {
      if (q.get('date')) opts.date = U.parseDate(q.get('date'));
      if (q.get('weekday')) opts.weekday = +q.get('weekday');
      if (q.get('seed')) opts.seed = q.get('seed');
    }
    loadDay(opts);
    layout();
    setSpeed(store.settings.speed || 1);
    setTool('select');

    // events
    window.addEventListener('resize', layout);
    if (window.ResizeObserver) {
      var stageEl = document.querySelector('.stage'), lastW = 0;
      new ResizeObserver(function () { var w = stageEl.clientWidth; if (w !== lastW) { lastW = w; layout(); } }).observe(stageEl);
    }
    ren.cv.addEventListener('click', onCanvasClick);
    ren.cv.addEventListener('pointermove', onCanvasMove);
    ren.cv.addEventListener('pointerleave', function () { S.hover = null; $('#tip').hidden = true; });
    $('#btnForecast').addEventListener('click', function () {
      S.forecast = !S.forecast; S.forecastEntry = null; this.classList.toggle('on', S.forecast); A.init(); A.play('click');
      if (S.forecast) toast('Ribbons show where each road\'s traffic is heading — thicker means busier. Tap a badge to single out one road.', 4200);
    });
    $('#btnTest').addEventListener('click', function () { if (S.mode === 'run') stopRun(); else startRun('test'); });
    $('#btnSample').addEventListener('click', function () {
      S.sample = (S.sample + 1) % SAMPLES.length; $('#sampleName').textContent = SAMPLES[S.sample]; A.init(); A.play('click');
      toast('Tests will use traffic sample ' + SAMPLES[S.sample] + ' — same amount of traffic, different timing.');
    });
    document.querySelectorAll('#speedRow [data-speed]').forEach(function (b) { b.addEventListener('click', function () { setSpeed(+b.dataset.speed); A.play('click'); }); });
    $('#btnSkip').addEventListener('click', function () { if (S.mode === 'run') { S.skipping = true; A.quiet(); } });
    $('#btnSubmit').addEventListener('click', function () {
      A.init(); A.play('click');
      if (day().submitted) { showResults(false); return; }
      if (S.mode === 'run') return;
      $('#cfText').textContent = 'The official rush hour uses fresh traffic and you get one go per day. This design costs ' + S.net.cost.total + '.';
      openModal('#mConfirm');
    });
    $('#cfYes').addEventListener('click', function () { closeModals(); startRun('official'); });
    $('#btnShare').addEventListener('click', doShare);
    $('#btnHelp').addEventListener('click', function () { A.init(); A.play('click'); openModal('#mHelp'); });
    $('#btnStats').addEventListener('click', function () { A.init(); A.play('click'); showStatsModal(); });
    $('#btnSettings').addEventListener('click', function () { A.init(); A.play('click'); openModal('#mSettings'); });
    $('#btnSound').addEventListener('click', function () { store.settings.sound = !store.settings.sound; save(); applySettings(); if (store.settings.sound) { A.init(); A.play('place'); } });
    $('#setSound').addEventListener('change', function () { store.settings.sound = this.checked; save(); applySettings(); });
    $('#setHand').addEventListener('change', function () { store.settings.hand = this.value; save(); applySettings(); });
    $('#setCalm').addEventListener('change', function () { store.settings.calm = this.checked; save(); });
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m || e.target.closest('[data-close]')) { m.hidden = true; if (m.id === 'mHelp') { store.seenHelp = true; save(); } } });
    });
    var seq = $('#seqCard');
    seq.addEventListener('pointerdown', seqPointer);
    window.addEventListener('pointermove', seqPointer);
    window.addEventListener('pointerup', seqPointer);
    window.addEventListener('pointercancel', seqPointer);
    seq.addEventListener('click', seqClick);
    $('#dev').addEventListener('click', devAction);
    $('#dev').addEventListener('change', function (e) {
      if (e.target.id === 'devDate' && e.target.value) loadDay({ date: U.parseDate(e.target.value), weekday: S.devOpts.weekday });
      else if (e.target.id === 'devWd') loadDay({ date: U.parseDate(S.level.date), weekday: e.target.value === '' ? undefined : +e.target.value, seed: S.devOpts.seed });
      else devAction(e);
    });
    // hidden developer mode: tap the logo seven times, or type "roadworks"
    var taps = 0, tapT = 0, typed = '';
    $('#brand').addEventListener('click', function () {
      var now = Date.now(); taps = now - tapT < 600 ? taps + 1 : 1; tapT = now;
      if (taps >= 7) { taps = 0; enableDev(!S.dev); }
    });
    window.addEventListener('keydown', function (e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key.length === 1) { typed = (typed + e.key.toLowerCase()).slice(-9); if (typed === 'roadworks') { enableDev(!S.dev); typed = ''; } }
      if (e.key === 'Escape') { closeModals(); setTool('select'); }
      else if (e.key === ' ') { e.preventDefault(); $('#btnTest').click(); }
      else if (e.key === '1') setSpeed(1); else if (e.key === '2') setSpeed(2); else if (e.key === '3' || e.key === '4') setSpeed(4);
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) A.quiet(); });
    // roll over to the new puzzle at midnight
    setInterval(function () {
      if (S.devOpts.date || S.devOpts.seed || S.devOpts.weekday != null) return;
      if (U.dateStr(today()) !== S.level.date && S.mode === 'build') { closeModals(); loadDay({}); toast('A new day, a new junction!'); }
    }, 30000);

    if (!store.seenHelp && !q.has('shot')) openModal('#mHelp');
    if (q.has('shot')) shotMode(q);
    requestAnimationFrame(frame);
  }

  /* Screenshot helper for automated visual checks (dev only): ?shot=run&t=60&cfg=par */
  function shotMode(q) {
    var mode = q.get('shot');
    if (q.get('hand')) { store.settings.hand = q.get('hand'); applySettings(); }
    if (q.get('cfg') === 'par') { var sol = R.solver.solve(S.level, { quick: true }); S.config = sol.config; rebuild(); }
    else if (q.get('cfg')) { try { S.config = JSON.parse(q.get('cfg')); rebuild(); } catch (e) { } }
    if (q.get('tool')) setTool(q.get('tool'));
    if (q.get('forecast')) { S.forecast = true; }
    if (mode === 'run') {
      startRun('test');
      var T = +(q.get('t') || 60);
      while (S.sim && !S.sim.done && S.sim.t < T) S.sim.advance();
      handleEvents(); liveStats(); drawTimeline(); seqPlayhead();
      S.speed = 0;
    } else if (mode === 'result') {
      startRun('official'); S.sim.runToEnd(); S.sim.events.length = 0;
      var j = new R.solver.Job(S.level, { quick: true }); while (!j.step(1000)) { }
      day().par = { v: 3, score: j.result.official.score, desc: describeConfig(j.result.config), config: j.result.config };
      endRun();
    } else if (mode === 'help') openModal('#mHelp');
    document.title = 'shot-ready';
  }

  // handles for the developer console and tools/e2e.js
  R.__S = S; R.__shareText = shareText; R.__loadDay = loadDay;
  root.addEventListener('DOMContentLoaded', boot);
})(typeof globalThis !== 'undefined' ? globalThis : window);
