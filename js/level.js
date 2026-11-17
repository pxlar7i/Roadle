/* Roadle — procedural junction generator + traffic demand generator.
   A level is fully determined by its seed string (normally the date), so every
   player gets the same junction each day. Difficulty follows the weekday. */
(function (root) {
  'use strict';
  var R = root.Roadle, U = R.util;
  var N = 13;                    // grid size (tiles)
  var T_ARRIVE = 180;            // ticks during which traffic arrives
  var T_MAX = 250;               // hard end of a run

  var STREET_A = ['Maple', 'Otter', 'Clover', 'Biscuit', 'Pebble', 'Willow', 'Marmalade', 'Puddle', 'Bramble',
    'Juniper', 'Teapot', 'Acorn', 'Dumpling', 'Honeybee', 'Figgy', 'Lark', 'Mossy', 'Pickle', 'Quince', 'Thimble',
    'Waffle', 'Nutmeg', 'Crumpet', 'Sorrel', 'Button', 'Poppy', 'Fennel', 'Gosling', 'Hazel', 'Tansy', 'Bobbin',
    'Custard', 'Mallow', 'Peapod', 'Snowdrop', 'Tumble'];
  var STREET_B = ['Street', 'Lane', 'Road', 'Avenue', 'Way', 'Row', 'Hill', 'Parade', 'Walk'];

  /* Weekday recipes. q = peak junction demand in vehicles per tick. */
  var RECIPES = [
    { name: 'Monday',    shape: 'single', arms3: 0.85, q: [0.30, 0.40], balance: [0.2, 0.5],  blind: 0.15, tight: 0.3, bus: 0,    tram: 0,   rail: 0,   heavyTurn: 0.1 },
    { name: 'Tuesday',   shape: 'single', arms3: 0.25, q: [0.38, 0.50], balance: [0.25, 0.9], blind: 0.35, tight: 0.3, bus: 0.2,  tram: 0,   rail: 0,   heavyTurn: 0.25 },
    { name: 'Wednesday', shape: 'single', arms3: 0.3,  q: [0.44, 0.55], balance: [0.3, 1.0],  blind: 0.25, tight: 0.35, bus: 1,   tram: 0,   rail: 0,   heavyTurn: 0.4 },
    { name: 'Thursday',  shape: 'single', arms3: 0.2,  q: [0.42, 0.53], balance: [0.3, 0.9],  blind: 0.2,  tight: 0.5, bus: 0.4,  tram: 1,   rail: 0,   heavyTurn: 0.3 },
    { name: 'Friday',    shape: 'single', arms3: 0.25, q: [0.48, 0.60], balance: [0.35, 1.0], blind: 0.2,  tight: 0.35, bus: 0.6, tram: 0,   rail: 1,   heavyTurn: 0.4 },
    { name: 'Saturday',  shape: 'double', arms3: 0,    q: [0.48, 0.58], balance: [0.3, 0.9],  blind: 0.2,  tight: 0.4, bus: 0.7,  tram: 0.5, rail: 0.5, heavyTurn: 0.4 },
    { name: 'Sunday',    shape: 'double', arms3: 0,    q: [0.52, 0.62], balance: [0.4, 1.0],  blind: 0.25, tight: 0.4, bus: 1,    tram: 1,   rail: 1,   heavyTurn: 0.5 }
  ];

  function key(c, r) { return c + ',' + r; }

  /* Tiles of an arm leaving a node tile in direction `dir`, optionally with a sideways jog. */
  function armTiles(c0, r0, dir, jog) {
    var tiles = [], c = c0 + U.DX[dir], r = r0 + U.DY[dir], n = 0;
    while (c >= 0 && c < N && r >= 0 && r < N) {
      tiles.push([c, r]); n++;
      if (jog && n === jog.k) {
        var side = (dir + (jog.j > 0 ? 1 : 3)) % 4;
        for (var i = 0; i < Math.abs(jog.j); i++) {
          c += U.DX[side]; r += U.DY[side];
          if (c < 0 || c >= N || r < 0 || r >= N) return null;
          tiles.push([c, r]);
        }
      }
      c += U.DX[dir]; r += U.DY[dir];
    }
    return tiles;
  }

  function generate(opts) {
    opts = opts || {};
    var date = opts.date ? (typeof opts.date === 'string' ? U.parseDate(opts.date) : opts.date) : new Date();
    var weekday = (opts.weekday != null) ? opts.weekday : U.weekdayIndex(date);
    var seedStr = opts.seed || ('roadle:' + U.dateStr(date));
    var rng = U.makeRng(seedStr + ':level:' + weekday);
    var rec = RECIPES[weekday];

    var level = {
      id: seedStr, date: U.dateStr(date), number: U.dayNumber(date), weekday: weekday, N: N,
      T: T_ARRIVE, TMAX: T_MAX, nodes: [], links: [], entries: [], busStops: [], busLines: [],
      tram: null, rail: null, scenery: [], features: [], theme: weekday
    };

    var used = {};           // road tiles
    function mark(tiles) { for (var i = 0; i < tiles.length; i++) used[key(tiles[i][0], tiles[i][1])] = true; }

    var hasTram = rng.chance(rec.tram), hasRail = rng.chance(rec.rail), hasBus = rng.chance(rec.bus);
    var double = rec.shape === 'double';
    if (double && weekday === 5) { // Saturday: exactly one rail-ish feature
      if (hasTram && hasRail) { if (rng.chance(0.5)) hasTram = false; else hasRail = false; }
      if (!hasTram && !hasRail) { if (rng.chance(0.5)) hasTram = true; else hasRail = true; }
    }

    /* ----- nodes and which arms exist (canonical orientation; rotated later) ----- */
    var nodeSpecs = [];
    if (!double) {
      var cx = rng.int(5, 7), cy = rng.int(5, 7);
      var arms = [true, true, true, true];
      if (rng.chance(rec.arms3)) {
        // remove one arm; with a tram keep the E–W axis intact
        var rem = hasTram ? rng.pick([0, 2]) : rng.int(0, 3);
        arms[rem] = false;
      }
      nodeSpecs.push({ c: cx, r: cy, arms: arms });
    } else {
      var gap = rng.pick([3, 3, 4]);
      var ca = rng.int(3, 4), cb = ca + gap, ry = rng.int(5, 7);
      var style = rng.int(0, 3);
      var aArms, bArms;
      if (style === 0) { aArms = [true, false, false, true]; bArms = [false, true, true, false]; }        // staggered crossroads
      else if (style === 1) { aArms = [true, false, true, true]; bArms = [false, true, true, false]; }    // cross + T
      else if (style === 2) { aArms = [true, false, false, true]; bArms = [true, true, true, false]; }    // T + cross
      else { aArms = [false, false, true, true]; bArms = [true, true, false, false]; }                    // mirrored stagger
      if (weekday === 6 && style !== 1 && style !== 2 && rng.chance(0.6)) {
        // Sunday likes an extra arm
        if (rng.chance(0.5)) aArms[aArms[0] ? 2 : 0] = true; else bArms[bArms[0] ? 2 : 0] = true;
      }
      aArms[1] = true; bArms[3] = true; // the connecting road
      nodeSpecs.push({ c: ca, r: ry, arms: aArms });
      nodeSpecs.push({ c: cb, r: ry, arms: bArms });
    }

    for (var ni = 0; ni < nodeSpecs.length; ni++) {
      var ns = nodeSpecs[ni];
      level.nodes.push({ id: ni, c: ns.c, r: ns.r, arms: [-1, -1, -1, -1], blind: false, space: 'open', tramAxis: -1 });
      used[key(ns.c, ns.r)] = true;
    }

    /* ----- rail placement (decided before arms so jogs can avoid it) ----- */
    var railPlan = null;
    if (hasRail) {
      var cand = [];
      for (ni = 0; ni < nodeSpecs.length; ni++) {
        for (var d = 0; d < 4; d++) {
          if (!nodeSpecs[ni].arms[d]) continue;
          if (double && ((ni === 0 && d === 1) || (ni === 1 && d === 3))) continue; // not the connector
          if (hasTram && (d === 1 || d === 3)) continue;                             // tram runs E–W
          if (double && (d === 0 || d === 2)) {
            // a horizontal rail must not cut another arm going the same way
            var other = nodeSpecs[1 - ni];
            if (other.arms[d]) continue;
          }
          cand.push({ node: ni, dir: d });
        }
      }
      if (cand.length) {
        var pk = rng.pick(cand), sp = nodeSpecs[pk.node];
        var armLen = (pk.dir === 0) ? sp.r : (pk.dir === 2) ? N - 1 - sp.r : (pk.dir === 1) ? N - 1 - sp.c : sp.c;
        var maxIdx = Math.min(3, armLen - 2);
        var tIdx = rng.int(1, Math.max(1, maxIdx));
        if (weekday <= 4 && tIdx < 2 && rng.chance(0.6)) tIdx = Math.min(2, Math.max(1, maxIdx));
        var vertical = (pk.dir === 1 || pk.dir === 3);
        var line = vertical ? sp.c + U.DX[pk.dir] * (1 + tIdx) : sp.r + U.DY[pk.dir] * (1 + tIdx);
        railPlan = { node: pk.node, dir: pk.dir, tile: tIdx, vertical: vertical, idx: line };
      } else hasRail = false;
    }
    function onRail(c, r) { return railPlan && (railPlan.vertical ? c === railPlan.idx : r === railPlan.idx); }

    /* ----- links ----- */
    function addLink(tiles, a, b, tram) {
      var id = level.links.length;
      level.links.push({ id: id, tiles: tiles, a: a, b: b, tram: !!tram, cls: 'minor' });
      mark(tiles);
      return id;
    }
    if (double) {
      var A = nodeSpecs[0], B = nodeSpecs[1], mid = [];
      for (var c = A.c + 1; c < B.c; c++) mid.push([c, A.r]);
      var lid = addLink(mid, { node: 0, dir: 1 }, { node: 1, dir: 3 }, hasTram);
      level.nodes[0].arms[1] = lid; level.nodes[1].arms[3] = lid;
    }
    for (ni = 0; ni < nodeSpecs.length; ni++) {
      ns = nodeSpecs[ni];
      for (d = 0; d < 4; d++) {
        if (!ns.arms[d] || level.nodes[ni].arms[d] >= 0) continue;
        var isTramArm = hasTram && (d === 1 || d === 3);
        var isRailArm = railPlan && railPlan.node === ni && railPlan.dir === d;
        var tiles = null;
        if (!isTramArm && !isRailArm && rng.chance(0.4)) {
          for (var attempt = 0; attempt < 4 && !tiles; attempt++) {
            var straight = armTiles(ns.c, ns.r, d, null);
            if (straight.length < 6) break;
            var jog = { k: rng.int(3, straight.length - 2), j: rng.pick([-2, -1, 1, 2]) };
            var t = armTiles(ns.c, ns.r, d, jog), ok = !!t;
            if (ok) {
              for (var i = jog.k; i < t.length && ok; i++) {
                var tc = t[i][0], tr = t[i][1];
                if (onRail(tc, tr)) ok = false;
                for (var oc = -1; oc <= 1 && ok; oc++) for (var orr = -1; orr <= 1 && ok; orr++) {
                  if (used[key(tc + oc, tr + orr)]) ok = false;
                }
                // keep clear of where other nodes' arms will run
                for (var nj = 0; nj < nodeSpecs.length && ok; nj++) {
                  if (nj !== ni && (Math.abs(tc - nodeSpecs[nj].c) <= 1 || Math.abs(tr - nodeSpecs[nj].r) <= 1)) ok = false;
                }
              }
              // the last tile must sit on the map edge
              var last = t[t.length - 1];
              if (ok && !(last[0] === 0 || last[0] === N - 1 || last[1] === 0 || last[1] === N - 1)) ok = false;
              // a jog must not wander into the row/column of a perpendicular arm of the same node
              if (ok) {
                for (i = jog.k; i < t.length && ok; i++) {
                  if ((d === 0 || d === 2) ? (t[i][1] === ns.r) : (t[i][0] === ns.c)) ok = false;
                }
              }
            }
            if (ok) tiles = t;
          }
        }
        if (!tiles) tiles = armTiles(ns.c, ns.r, d, null);
        var id2 = addLink(tiles, { node: ni, dir: d }, { edge: true, dir: d }, isTramArm);
        level.nodes[ni].arms[d] = id2;
      }
    }

    /* ----- rail ----- */
    if (railPlan) {
      var rl = level.nodes[railPlan.node].arms[railPlan.dir];
      var times = [], fwd = [];
      var nTrains = weekday === 6 ? 3 : 2;
      var slot = (T_ARRIVE - 30) / nTrains;
      for (i = 0; i < nTrains; i++) {
        times.push(Math.round(22 + slot * i + rng.range(0, slot - 22)));
        fwd.push(rng.chance(0.5));
      }
      level.rail = { vertical: railPlan.vertical, idx: railPlan.idx, link: rl, tile: railPlan.tile, times: times, fwd: fwd };
      level.features.push('rail');
    }

    /* ----- tram (one-way line along the E–W axis) ----- */
    if (hasTram) {
      var path = [], n0 = level.nodes[0];
      if (!double) path = [n0.arms[3], n0.arms[1]];
      else path = [level.nodes[0].arms[3], level.nodes[0].arms[1], level.nodes[1].arms[1]];
      var rev = rng.chance(0.5);
      if (rev) path.reverse();
      var hw = rng.int(34, 48);
      level.tram = { path: path, headway: hw, phase: rng.int(6, hw - 4), reverse: rev };
      for (ni = 0; ni < level.nodes.length; ni++) level.nodes[ni].tramAxis = 1;
      level.features.push('tram');
    }

    /* ----- node character: space for a roundabout, blind corners ----- */
    for (ni = 0; ni < level.nodes.length; ni++) {
      var nd = level.nodes[ni];
      if (rng.chance(rec.blind)) { nd.blind = true; nd.space = 'tight'; }
      else if (rng.chance(rec.tight)) nd.space = 'tight';
      if (nd.tramAxis >= 0) nd.space = (nd.space === 'open') ? 'tram' : nd.space;
      if (level.rail && level.links[level.rail.link].a.node === ni && level.rail.tile < 2 && nd.space === 'open') nd.space = 'tight';
    }
    if (double) {
      var midLen = level.links[level.nodes[0].arms[1]].tiles.length;
      if (midLen < 3) { // not enough room for two roundabouts
        if (level.nodes[0].space === 'open' && level.nodes[1].space === 'open') level.nodes[rng.int(0, 1)].space = 'tight';
      }
      level.features.push('double');
    }
    for (ni = 0; ni < level.nodes.length; ni++) if (level.nodes[ni].blind) { level.features.push('blind'); break; }

    /* ----- demand: road classes, entry rates, turning proportions ----- */
    var entries = level.entries;
    for (i = 0; i < level.links.length; i++) {
      var L = level.links[i];
      if (L.b.edge) entries.push({ id: entries.length, link: i, weight: 1, rate: 0, truck: 0.06, dests: [] });
    }
    // pick the "major" road
    var majorLinks = {};
    if (!double) {
      var nd0 = level.nodes[0], axes = [];
      if (nd0.arms[0] >= 0 && nd0.arms[2] >= 0) axes.push([0, 2]);
      if (nd0.arms[1] >= 0 && nd0.arms[3] >= 0) axes.push([1, 3]);
      var pair;
      if (hasTram) pair = [1, 3];
      else if (axes.length === 2 || rng.chance(0.75)) pair = rng.pick(axes);
      else { // priority road goes round the corner
        var present = [0, 1, 2, 3].filter(function (x) { return nd0.arms[x] >= 0; });
        var stem = present.filter(function (x) { return nd0.arms[(x + 2) % 4] < 0; })[0];
        pair = [stem, rng.pick(present.filter(function (x) { return x !== stem; }))];
      }
      majorLinks[nd0.arms[pair[0]]] = true; majorLinks[nd0.arms[pair[1]]] = true;
    } else {
      // main road is the E–W spine most of the time
      majorLinks[level.nodes[0].arms[1]] = true;
      if (hasTram || rng.chance(0.7)) { majorLinks[level.nodes[0].arms[3]] = true; majorLinks[level.nodes[1].arms[1]] = true; }
      else {
        var aSide = [0, 2].filter(function (x) { return level.nodes[0].arms[x] >= 0; });
        var bSide = [0, 2].filter(function (x) { return level.nodes[1].arms[x] >= 0; });
        majorLinks[level.nodes[0].arms[aSide.length ? rng.pick(aSide) : 3]] = true;
        majorLinks[level.nodes[1].arms[bSide.length ? rng.pick(bSide) : 1]] = true;
      }
    }
    for (i = 0; i < level.links.length; i++) if (majorLinks[i]) level.links[i].cls = 'major';

    var balance = rng.range(rec.balance[0], rec.balance[1]);
    var wsum = 0;
    for (i = 0; i < entries.length; i++) {
      var e = entries[i], maj = level.links[e.link].cls === 'major';
      e.weight = (maj ? 1 : balance) * rng.range(0.82, 1.18);
      e.truck = maj ? rng.range(0.07, 0.13) : rng.range(0.02, 0.07);
      wsum += e.weight;
    }
    var Q = rng.range(rec.q[0], rec.q[1]);
    level.q = U.round6(Q);
    for (i = 0; i < entries.length; i++) entries[i].rate = U.round6(Math.min(0.4, Q * entries[i].weight / wsum));

    level.transformPending = { rot: rng.int(0, 3), flip: rng.chance(0.5) };
    level._rngState = rng; // continue the same stream after the transform
    level._rec = rec; level._hasBus = hasBus;
    applyTransform(level);
    finishDemand(level);
    placeBus(level);
    decorate(level);
    nameIt(level);
    delete level._rngState; delete level._rec; delete level._hasBus; delete level.transformPending;
    level.difficulty = weekday + 1;
    return level;
  }

  /* Rotate / mirror the whole layout so the same recipe gives visually different junctions. */
  function applyTransform(level) {
    var tf = level.transformPending;
    function pt(p) {
      var c = p[0], r = p[1];
      if (tf.flip) c = N - 1 - c;
      for (var k = 0; k < tf.rot; k++) { var nc = N - 1 - r; r = c; c = nc; }
      return [c, r];
    }
    function dr(d) {
      if (tf.flip && (d === 1 || d === 3)) d = 4 - d;
      return (d + tf.rot) % 4;
    }
    level.nodes.forEach(function (nd) {
      var p = pt([nd.c, nd.r]); nd.c = p[0]; nd.r = p[1];
      var arms = [-1, -1, -1, -1];
      for (var d = 0; d < 4; d++) arms[dr(d)] = nd.arms[d];
      nd.arms = arms;
      if (nd.tramAxis >= 0) nd.tramAxis = (dr(1) % 2 === 1) ? 1 : 0;
    });
    level.links.forEach(function (L) {
      L.tiles = L.tiles.map(pt);
      L.a.dir = dr(L.a.dir); L.b.dir = dr(L.b.dir);
    });
    if (level.rail) {
      var a = level.rail.vertical ? pt([level.rail.idx, 0]) : pt([0, level.rail.idx]);
      var b = level.rail.vertical ? pt([level.rail.idx, N - 1]) : pt([N - 1, level.rail.idx]);
      level.rail.vertical = (a[0] === b[0]);
      level.rail.idx = level.rail.vertical ? a[0] : a[1];
    }
  }

  function turnOf(fromDir, toDir) { // arms are named by the side of the node they leave from
    var k = (toDir - fromDir + 4) % 4;
    return k === 2 ? 'S' : (k === 1 ? 'L' : 'R');
  }

  /* First arm (at the entry's node) on the way to another entry — tiny tree search. */
  function firstHop(level, fromEntry, toEntry) {
    var L = level.links[fromEntry.link], node = level.nodes[L.a.node], inDir = L.a.dir;
    var target = toEntry.link;
    for (var d = 0; d < 4; d++) {
      var lk = node.arms[d];
      if (lk < 0 || d === inDir) continue;
      if (lk === target) return { inDir: inDir, outDir: d };
      var LL = level.links[lk];
      if (!LL.b.edge) { // connector to the other node
        var other = level.nodes[LL.a.node === node.id ? LL.b.node : LL.a.node];
        if (other.arms.indexOf(target) >= 0) return { inDir: inDir, outDir: d };
      }
    }
    return null;
  }

  function finishDemand(level) {
    var rng = level._rngState, rec = level._rec, entries = level.entries;
    var heavy = rng.chance(rec.heavyTurn) ? { from: rng.int(0, entries.length - 1), turn: rng.pick(['L', 'L', 'R']) } : null;
    entries.forEach(function (e) {
      var ps = [], sum = 0;
      entries.forEach(function (o) {
        if (o.id === e.id) return;
        var hop = firstHop(level, e, o), turn = hop ? turnOf(hop.inDir, hop.outDir) : 'S';
        var w = o.weight * (turn === 'S' ? 1.7 : turn === 'L' ? 0.75 : 1.0) * rng.range(0.6, 1.4);
        if (level.links[e.link].cls === 'major' && level.links[o.link].cls === 'major') w *= 1.6;
        if (heavy && heavy.from === e.id && heavy.turn === turn) w *= 3.2;
        ps.push({ entry: o.id, p: w, turn: turn }); sum += w;
      });
      ps.forEach(function (p) { p.p = U.round6(p.p / sum); });
      e.dests = ps;
    });
    if (heavy) level.features.push('heavyturn');
    // rush-hour shape
    level.profile = { base: U.round6(rng.range(0.55, 0.7)), peakT: rng.int(80, 115), peakW: rng.int(38, 55) };
    // labels: clockwise from the top-left corner
    function edgePos(e) {
      var L = level.links[e.link], t = L.tiles[L.tiles.length - 1];
      if (t[1] === 0) return t[0];
      if (t[0] === N - 1) return N + t[1];
      if (t[1] === N - 1) return 2 * N + (N - 1 - t[0]);
      return 3 * N + (N - 1 - t[1]);
    }
    var order = entries.slice().sort(function (a, b) { return edgePos(a) - edgePos(b); });
    order.forEach(function (e, i) { e.label = String.fromCharCode(65 + i); });
    entries.forEach(function (e) { e.dir = level.links[e.link].b.dir; });
  }

  function placeBus(level) {
    var rng = level._rngState, entries = level.entries;
    if (!level._hasBus) return;
    var nLines = (level.weekday >= 5 && rng.chance(0.6)) ? 2 : 1;
    var usedTiles = {};
    for (var li = 0; li < nLines; li++) {
      // a bus line runs between two entries, preferring the main road
      var from = rng.pick(entries), tries = 0, to = null;
      while (tries++ < 12) {
        from = rng.pick(entries);
        var opts = from.dests.filter(function (dd) { return dd.turn === 'S' || tries > 6; });
        if (opts.length) { to = entries[rng.pick(opts).entry]; break; }
      }
      if (!to) continue;
      var stops = [];
      var where = rng.pick(['near', 'far', 'far', 'both']);
      if (level.weekday <= 2 && where === 'both') where = 'far';
      function tryStop(entry, fwd) {
        // fwd = lane running a→b (away from the node, i.e. the exit side of this arm)
        var L = level.links[entry.link], opts2 = [];
        for (var i = 1; i <= 2 && i < L.tiles.length - 2; i++) {
          var p = L.tiles[i - 1], q = L.tiles[i], n = L.tiles[i + 1];
          var straight = (p[0] === n[0]) || (p[1] === n[1]);
          var rail = level.rail && level.rail.link === L.id && Math.abs(level.rail.tile - i) <= 1;
          if (straight && !rail && !usedTiles[L.id + ':' + fwd + ':' + i]) opts2.push(i);
        }
        if (!opts2.length) return;
        var ti = rng.pick(opts2);
        usedTiles[L.id + ':' + fwd + ':' + ti] = true;
        var id = level.busStops.length;
        level.busStops.push({ id: id, link: L.id, fwd: fwd, tile: ti, dwell: rng.int(8, 12) });
        stops.push(id);
      }
      if (where === 'near' || where === 'both') tryStop(from, false);
      if (where === 'far' || where === 'both') tryStop(to, true);
      if (!stops.length) continue;
      var hw = rng.int(38, 58);
      level.busLines.push({ from: from.id, to: to.id, headway: hw, phase: rng.int(5, hw - 5), stops: stops });
    }
    if (level.busStops.length) level.features.push('bus');
  }

  /* Houses, trees, ponds. Purely cosmetic except the tall corner blocks that mark blind junctions. */
  function decorate(level) {
    var rng = U.makeRng(level.id + ':scenery');
    var occ = {};
    level.links.forEach(function (L) { L.tiles.forEach(function (t) { occ[key(t[0], t[1])] = 'road'; }); });
    level.nodes.forEach(function (nd) {
      occ[key(nd.c, nd.r)] = 'road';
      for (var dc = -1; dc <= 1; dc++) for (var dr = -1; dr <= 1; dr++) {
        var k = key(nd.c + dc, nd.r + dr);
        if (!occ[k]) occ[k] = 'apron';
      }
    });
    if (level.rail) for (var i = 0; i < N; i++) {
      var k = level.rail.vertical ? key(level.rail.idx, i) : key(i, level.rail.idx);
      if (!occ[k]) occ[k] = 'rail';
    }
    var sc = level.scenery;
    level.nodes.forEach(function (nd) {
      var corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      corners.forEach(function (cn, ci) {
        var c = nd.c + cn[0], r = nd.r + cn[1], k = key(c, r);
        if (occ[k] !== 'apron') return;
        if (nd.blind) { sc.push({ type: 'tower', c: c, r: r, hue: rng.int(0, 5), corner: ci, h: rng.range(0.7, 1) }); occ[k] = 'b'; }
        else if (nd.space === 'tight') {
          sc.push({ type: rng.chance(0.5) ? 'shop' : 'garden', c: c, r: r, hue: rng.int(0, 5), corner: ci }); occ[k] = 'b';
        } else if (nd.space === 'tram') {
          sc.push({ type: rng.chance(0.6) ? 'shop' : 'garden', c: c, r: r, hue: rng.int(0, 5), corner: ci }); occ[k] = 'b';
        }
      });
    });
    function nearRoad(c, r) {
      for (var d = 0; d < 4; d++) if (occ[key(c + U.DX[d], r + U.DY[d])] === 'road') return true;
      return false;
    }
    // a pond or two in open ground
    var ponds = rng.int(0, 2);
    for (var p = 0; p < ponds; p++) {
      for (var tries = 0; tries < 30; tries++) {
        var pc = rng.int(0, N - 2), pr = rng.int(0, N - 2), free = true;
        for (var a = 0; a < 2 && free; a++) for (var b = 0; b < 2 && free; b++) if (occ[key(pc + a, pr + b)]) free = false;
        if (!free) continue;
        for (a = 0; a < 2; a++) for (b = 0; b < 2; b++) occ[key(pc + a, pr + b)] = 'pond';
        sc.push({ type: 'pond', c: pc, r: pr, seed: rng.int(0, 9999), ducks: rng.int(0, 2) });
        break;
      }
    }
    for (var c = 0; c < N; c++) for (var r = 0; r < N; r++) {
      var kk = key(c, r);
      if (occ[kk]) continue;
      var nr = nearRoad(c, r), x = rng();
      if (nr && x < 0.5) {
        sc.push({ type: 'house', c: c, r: r, hue: rng.int(0, 5), w: rng.range(0.5, 0.72), h: rng.range(0.44, 0.62),
          ox: rng.range(-0.08, 0.08), oy: rng.range(-0.08, 0.08), rot: rng.int(0, 1), smoke: rng.chance(0.25) });
        occ[kk] = 'b';
      } else if (x < (nr ? 0.8 : 0.5)) {
        var n = rng.int(1, 3), trees = [];
        for (var t = 0; t < n; t++) trees.push({ x: rng.range(0.18, 0.82), y: rng.range(0.18, 0.82), s: rng.range(0.16, 0.27), k: rng.int(0, 2), ph: rng.range(0, 6.28) });
        sc.push({ type: 'trees', c: c, r: r, trees: trees });
        occ[kk] = 't';
      } else if (x > 0.93) {
        sc.push({ type: 'flowers', c: c, r: r, seed: rng.int(0, 9999) });
      }
    }
  }

  function nameIt(level) {
    var rng = U.makeRng(level.id + ':names');
    var a = rng.pick(STREET_A), b = rng.pick(STREET_A);
    while (b === a) b = rng.pick(STREET_A);
    var sa = a + ' ' + rng.pick(STREET_B), sb = b + ' ' + rng.pick(STREET_B);
    var nArms = level.entries.length;
    var kind = level.nodes.length > 1 ? 'staggered junction' : (nArms === 3 ? 'T-junction' : 'crossroads');
    level.name = sa + ' & ' + sb;
    level.kind = kind;
  }

  /* ---------- traffic demand ----------
     Arrivals on each approach follow a time-varying Cowan M3 headway model: a share of
     vehicles travel in bunches at a minimum headway, the rest arrive with shifted
     negative-exponential gaps. The rate follows a rush-hour bump. */
  function profile(level, t) {
    var p = level.profile, x = (t - p.peakT) / p.peakW;
    return p.base + (1 - p.base) * Math.exp(-x * x);
  }

  function makeDemand(level, seedStr) {
    var rng = U.makeRng(level.id + ':demand:' + seedStr);
    var arr = [], MINH = 1.25;
    // cumulative rush-hour profile, for inverse-transform sampling of arrival times
    var cum = [0], STEP = 0.5, k;
    for (k = 1; k * STEP <= level.T; k++) cum.push(cum[k - 1] + profile(level, (k - 0.5) * STEP) * STEP);
    var total = cum[cum.length - 1];
    function timeAt(u) {
      var target = u * total, lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { var mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid; else hi = mid; }
      var f = (target - cum[lo]) / Math.max(1e-9, cum[hi] - cum[lo]);
      return (lo + f) * STEP;
    }
    level.entries.forEach(function (e) {
      // the number of vehicles is fixed by the forecast (fair between traffic samples);
      // their timing is random: a Poisson process conditioned on that count, then bunched.
      var n = Math.round(e.rate * total), ts = [], i;
      for (i = 0; i < n; i++) ts.push(timeAt(rng()));
      ts.sort(function (x, y) { return x - y; });
      var psi = U.clamp(0.15 + e.rate * 1.1, 0.15, 0.55);
      for (i = 1; i < n; i++) {
        if (rng() < psi) ts[i] = Math.min(ts[i], ts[i - 1] + MINH + rng.range(0, 0.3));   // tailgater joins the platoon ahead
        if (ts[i] < ts[i - 1] + MINH) ts[i] = ts[i - 1] + MINH + rng.range(0, 0.15);
      }
      for (i = 0; i < n; i++) {
        var x = rng(), acc = 0, dest = e.dests[e.dests.length - 1].entry;
        for (var j = 0; j < e.dests.length; j++) { acc += e.dests[j].p; if (x < acc) { dest = e.dests[j].entry; break; } }
        var type = rng() < e.truck ? 'truck' : 'car';
        arr.push({ t: Math.round(Math.min(ts[i], level.T + 6) * 100) / 100, entry: e.id, dest: dest, type: type, hue: rng.int(0, 7) });
      }
    });
    level.busLines.forEach(function (bl, li) {
      for (var t = bl.phase; t < level.T; t += bl.headway) {
        arr.push({ t: Math.round((t + rng.range(-3, 3)) * 100) / 100, entry: bl.from, dest: bl.to, type: 'bus', hue: li, line: li });
      }
    });
    arr.sort(function (a, b) { return a.t - b.t || a.entry - b.entry; });
    arr.forEach(function (a, i) { a.id = i; });
    return { seed: seedStr, arrivals: arr };
  }

  function tramTimes(level) {
    var out = [];
    if (level.tram) for (var t = level.tram.phase; t < level.T + 10; t += level.tram.headway) out.push(t);
    return out;
  }

  R.level = {
    N: N, generate: generate, makeDemand: makeDemand, profile: profile, tramTimes: tramTimes,
    turnOf: turnOf, RECIPES: RECIPES
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
