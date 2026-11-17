/* Roadle — builds the drivable network (lanes, junction movements, conflict zones,
   priority rules, routes) from a level plus the player's configuration. */
(function (root) {
  'use strict';
  var R = root.Roadle, U = R.util;
  var EXT = 1.0;                 // how far lanes extend beyond the map edge
  var LANE_OFF = 0.16, LANE_OFF_TRAM = 0.27;
  var RING_R = 0.86, RING_D = 0.56; // roundabout ring radius, entry/exit angular offset (rad)
  var DETOUR = 35;               // ticks added to a vehicle forced onto another route by a banned turn
  var GREEN = 1, RED = 0, AMBER = 2;

  var COST = { yield: 5, stop: 5, bump: 10, noturn: 20, box: 15, bay: 35, mini: 35, rbt: 100, signalHead: 20 };

  /* ---------------- paths ---------------- */
  function resample(pts, ds) {
    var cum = [0], i, L = 0;
    for (i = 1; i < pts.length; i++) {
      var dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      L += Math.sqrt(dx * dx + dy * dy); cum.push(L);
    }
    var n = Math.max(2, Math.round(L / ds) + 1), step = L / (n - 1);
    var x = new Array(n), y = new Array(n), j = 0;
    for (i = 0; i < n; i++) {
      var s = Math.min(L, i * step);
      while (j < pts.length - 2 && cum[j + 1] < s) j++;
      var seg = cum[j + 1] - cum[j], t = seg > 1e-9 ? (s - cum[j]) / seg : 0;
      x[i] = pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t;
      y[i] = pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t;
    }
    var len = Math.round(L * 1e4) / 1e4;
    return { x: x, y: y, n: n, len: len, ds: len / (n - 1) };
  }
  function posAt(p, s, out) {
    out = out || {};
    var f = s / p.ds, i = Math.floor(f);
    if (i < 0) i = 0; if (i > p.n - 2) i = p.n - 2;
    var t = f - i; // may be <0 or >1: straight extrapolation beyond the ends
    var dx = p.x[i + 1] - p.x[i], dy = p.y[i + 1] - p.y[i];
    out.x = p.x[i] + dx * t; out.y = p.y[i] + dy * t; out.a = Math.atan2(dy, dx);
    return out;
  }
  function offsetRight(pts, off) {
    var out = [];
    for (var i = 0; i < pts.length; i++) {
      var a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      var tx = b[0] - a[0], ty = b[1] - a[1], l = Math.sqrt(tx * tx + ty * ty) || 1;
      out.push([pts[i][0] - ty / l * off, pts[i][1] + tx / l * off]);
    }
    return out;
  }
  function bezier(p0, c0, c1, p1, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t;
      out.push([u * u * u * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t * t * t * p1[0],
                u * u * u * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t * t * t * p1[1]]);
    }
    return out;
  }
  function chaikin(pts, iters) {
    for (var k = 0; k < iters; k++) {
      var out = [pts[0]];
      for (var i = 0; i < pts.length - 1; i++) {
        var a = pts[i], b = pts[i + 1];
        out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
        out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
      }
      out.push(pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }
  /* Dense centre line through tile centres with rounded corners. */
  function centreLine(verts) {
    var out = [verts[0]], i, k;
    function lineTo(p) {
      var a = out[out.length - 1], dx = p[0] - a[0], dy = p[1] - a[1], l = Math.sqrt(dx * dx + dy * dy);
      var n = Math.max(1, Math.round(l / 0.1));
      for (var q = 1; q <= n; q++) out.push([a[0] + dx * q / n, a[1] + dy * q / n]);
    }
    for (i = 1; i < verts.length - 1; i++) {
      var p = verts[i - 1], v = verts[i], nx = verts[i + 1];
      var ux = v[0] - p[0], uy = v[1] - p[1], ul = Math.sqrt(ux * ux + uy * uy); ux /= ul; uy /= ul;
      var wx = nx[0] - v[0], wy = nx[1] - v[1], wl = Math.sqrt(wx * wx + wy * wy); wx /= wl; wy /= wl;
      if (Math.abs(ux * wx + uy * wy) > 0.99) { lineTo(v); continue; }
      var r = Math.min(0.5, ul, wl);
      lineTo([v[0] - ux * r, v[1] - uy * r]);
      var ox = v[0] - ux * r + wx * r, oy = v[1] - uy * r + wy * r;
      for (k = 1; k <= 8; k++) {
        var ph = (Math.PI / 2) * k / 8;
        out.push([ox - wx * r * Math.cos(ph) + ux * r * Math.sin(ph), oy - wy * r * Math.cos(ph) + uy * r * Math.sin(ph)]);
      }
    }
    lineTo(verts[verts.length - 1]);
    return out;
  }

  /* ---------------- config ---------------- */
  function appKey(linkId, end) { return linkId + ':' + end; }

  function approachList(level) { // every place a road lane arrives at a node
    var out = [];
    level.links.forEach(function (L) {
      if (!L.a.edge) out.push({ key: appKey(L.id, 'a'), link: L.id, end: 'a', node: L.a.node, dir: L.a.dir });
      if (!L.b.edge) out.push({ key: appKey(L.id, 'b'), link: L.id, end: 'b', node: L.b.node, dir: L.b.dir });
    });
    return out;
  }

  function defaultSignal(level, nd) {
    var C = 24, rows = {};
    function row(a, b) { var r = []; for (var i = 0; i < C; i++) r.push(i >= a && i < b); return r; }
    for (var d = 0; d < 4; d++) if (nd.arms[d] >= 0) rows[d] = (d % 2 === 0) ? row(0, 10) : row(12, 22);
    if (nd.tramAxis >= 0) rows.t = nd.tramAxis === 0 ? row(0, 10) : row(12, 22);
    return { C: C, rows: rows };
  }

  function defaultConfig(level) {
    var cfg = { nodes: [], app: {}, bays: {} };
    level.nodes.forEach(function () { cfg.nodes.push({ type: 'plain', box: false, sig: null }); });
    return cfg;
  }

  function canPlace(level, nodeId, type) {
    var nd = level.nodes[nodeId];
    if (type === 'rbt') return nd.space === 'open';
    if (type === 'mini') return nd.tramAxis < 0;
    return true;
  }

  /* Make any config safe to simulate (used for saved games and solver output). */
  function normConfig(level, cfg) {
    var out = defaultConfig(level);
    if (!cfg) return out;
    level.nodes.forEach(function (nd, i) {
      var src = (cfg.nodes && cfg.nodes[i]) || {}, n = out.nodes[i];
      var type = src.type;
      if (['plain', 'mini', 'rbt', 'signal'].indexOf(type) < 0) type = 'plain';
      if (!canPlace(level, i, type)) type = 'plain';
      n.type = type;
      n.box = !!src.box && type !== 'rbt' && type !== 'mini';
      if (type === 'signal') {
        var def = defaultSignal(level, nd), s = src.sig || def;
        var C = U.clamp(Math.round(s.C || 24), 4, 60), rows = {};
        Object.keys(def.rows).forEach(function (k) {
          var r = (s.rows && s.rows[k]) || [], o = [];
          for (var t = 0; t < C; t++) o.push(!!r[t]);
          rows[k] = o;
        });
        n.sig = { C: C, rows: rows };
      }
    });
    approachList(level).forEach(function (a) {
      var src = cfg.app && cfg.app[a.key];
      if (!src) return;
      var type = out.nodes[a.node].type;
      var o = { sign: null, bump: !!src.bump, noL: !!src.noL, noR: !!src.noR };
      if (type === 'plain' && (src.sign === 'yield' || src.sign === 'stop')) o.sign = src.sign;
      // never ban every movement of an approach
      var nd = level.nodes[a.node], hasS = nd.arms[(a.dir + 2) % 4] >= 0, hasL = nd.arms[(a.dir + 1) % 4] >= 0, hasR = nd.arms[(a.dir + 3) % 4] >= 0;
      if (!hasL) o.noL = false;
      if (!hasR) o.noR = false;
      if (!hasS && (o.noL || !hasL) && (o.noR || !hasR)) { o.noR = false; if (!hasR) o.noL = false; }
      if (o.sign || o.bump || o.noL || o.noR) out.app[a.key] = o;
    });
    level.busStops.forEach(function (b) { if (cfg.bays && cfg.bays[b.id]) out.bays[b.id] = true; });
    return out;
  }

  function cost(level, cfg) {
    var items = [], total = 0;
    function add(key, label, n, each) { if (n > 0) { items.push({ key: key, label: label, n: n, cost: n * each }); total += n * each; } }
    var cnt = { yield: 0, stop: 0, bump: 0, noturn: 0, box: 0, bay: 0, mini: 0, rbt: 0, heads: 0, signals: 0 };
    cfg.nodes.forEach(function (n, i) {
      if (n.type === 'mini') cnt.mini++;
      if (n.type === 'rbt') cnt.rbt++;
      if (n.type === 'signal') { cnt.signals++; cnt.heads += Object.keys(n.sig.rows).length; }
      if (n.box) cnt.box++;
    });
    Object.keys(cfg.app).forEach(function (k) {
      var a = cfg.app[k];
      if (a.sign === 'yield') cnt.yield++;
      if (a.sign === 'stop') cnt.stop++;
      if (a.bump) cnt.bump++;
      if (a.noL) cnt.noturn++;
      if (a.noR) cnt.noturn++;
    });
    cnt.bay = Object.keys(cfg.bays).length;
    add('signal', 'Traffic lights', cnt.heads, COST.signalHead);
    add('rbt', 'Roundabout', cnt.rbt, COST.rbt);
    add('mini', 'Mini-roundabout', cnt.mini, COST.mini);
    add('bay', 'Bus bay', cnt.bay, COST.bay);
    add('box', 'Box junction', cnt.box, COST.box);
    add('stop', 'Stop sign', cnt.stop, COST.stop);
    add('yield', 'Give-way sign', cnt.yield, COST.yield);
    add('bump', 'Speed bump', cnt.bump, COST.bump);
    add('noturn', 'Turn ban', cnt.noturn, COST.noturn);
    return { total: total, items: items, counts: cnt };
  }

  /* ---------------- network ---------------- */
  function build(level, cfgIn) {
    var cfg = normConfig(level, cfgIn);
    var net = { level: level, config: cfg, segs: [], nodes: [], lanes: {}, tracks: [], routes: {}, tramRoute: null, rail: null, links: [] };
    function newSeg(kind, pts, props) {
      var path = resample(pts, 0.05);
      var s = { id: net.segs.length, kind: kind, path: path, len: path.len, vmax: 9, veh: [], tails: [], conflicts: [], zones: [], stops: [], upstream: [] };
      for (var k in props) s[k] = props[k];
      net.segs.push(s);
      return s;
    }

    level.nodes.forEach(function (nd, i) {
      var nc = cfg.nodes[i];
      net.nodes.push({
        id: i, level: nd, cx: nd.c + 0.5, cy: nd.r + 0.5, type: nc.type, box: nc.box, blind: nd.blind,
        R: nc.type === 'rbt' ? 1.5 : 0.5, apps: [null, null, null, null], outLanes: [null, null, null, null],
        tramApp: null, moves: [], internal: [], moveMap: {}, sig: null, allway: false, uncontrolled: false
      });
    });

    /* --- links: centre line, two lanes, optional tram track --- */
    level.links.forEach(function (L) {
      var verts = [], first = 0, last = L.tiles.length - 1, S, E;
      if (L.a.edge) { var t0 = L.tiles[0]; S = [t0[0] + 0.5 + U.DX[L.a.dir] * (0.5 + EXT), t0[1] + 0.5 + U.DY[L.a.dir] * (0.5 + EXT)]; }
      else { var na = net.nodes[L.a.node]; S = [na.cx + U.DX[L.a.dir] * na.R, na.cy + U.DY[L.a.dir] * na.R]; if (na.R > 1) first = 1; }
      if (L.b.edge) { var tk = L.tiles[last]; E = [tk[0] + 0.5 + U.DX[L.b.dir] * (0.5 + EXT), tk[1] + 0.5 + U.DY[L.b.dir] * (0.5 + EXT)]; }
      else { var nb = net.nodes[L.b.node]; E = [nb.cx + U.DX[L.b.dir] * nb.R, nb.cy + U.DY[L.b.dir] * nb.R]; if (nb.R > 1) last -= 1; }
      verts.push(S);
      for (var i = first; i <= last; i++) verts.push([L.tiles[i][0] + 0.5, L.tiles[i][1] + 0.5]);
      verts.push(E);
      var centre = centreLine(verts), off = L.tram ? LANE_OFF_TRAM : LANE_OFF;
      var rev = centre.slice().reverse();
      var info = { id: L.id, level: L, centre: resample(centre, 0.05), off: off, width: off * 2 + 0.32 };
      net.links.push(info);
      var fwd = newSeg('lane', offsetRight(centre, off), { link: L.id, fwd: true, vmax: 0.9 });
      var back = newSeg('lane', offsetRight(rev, off), { link: L.id, fwd: false, vmax: 0.9 });
      net.lanes[L.id + ':1'] = fwd; net.lanes[L.id + ':0'] = back;
      info.fwd = fwd; info.back = back;
      function hook(seg, startEnd, endEnd, endName) {
        seg.startNode = startEnd.edge ? null : net.nodes[startEnd.node];
        seg.endNode = endEnd.edge ? null : net.nodes[endEnd.node];
        if (seg.endNode) {
          var key = appKey(L.id, endName), ac = cfg.app[key] || {};
          var app = { key: key, link: L.id, end: endName, dir: endEnd.dir, node: seg.endNode, lane: seg, sign: ac.sign || null,
            bump: !!ac.bump, noL: !!ac.noL, noR: !!ac.noR, rank: 0, state: GREEN, isTram: false, cls: L.cls };
          seg.app = app; seg.endNode.apps[endEnd.dir] = app;
        }
        if (seg.startNode) seg.startNode.outLanes[startEnd.dir] = seg;
      }
      hook(fwd, L.a, L.b, 'b'); hook(back, L.b, L.a, 'a');
    });
    level.entries.forEach(function (e) {
      net.lanes[e.link + ':0'].entry = e.id;     // inbound from the map edge
      net.lanes[e.link + ':1'].exitEntry = e.id; // outbound to the map edge
    });

    /* --- tram tracks --- */
    if (level.tram) {
      var tp = level.tram.path, tsegs = [];
      for (var ti = 0; ti < tp.length; ti++) {
        var TL = level.links[tp[ti]], info = net.links[tp[ti]];
        var towardA; // travelling b→a?
        if (ti < tp.length - 1) { // leaves this link at the node shared with the next link
          var nxt = level.links[tp[ti + 1]];
          var shared = (!TL.a.edge && ((!nxt.a.edge && nxt.a.node === TL.a.node) || (!nxt.b.edge && nxt.b.node === TL.a.node))) ? 'a' : 'b';
          towardA = shared === 'a';
        } else {
          var prv = level.links[tp[ti - 1]];
          var sharedP = (!TL.a.edge && ((!prv.a.edge && prv.a.node === TL.a.node) || (!prv.b.edge && prv.b.node === TL.a.node))) ? 'a' : 'b';
          towardA = sharedP !== 'a';
        }
        var pts = [];
        for (var q = 0; q < info.centre.n; q++) pts.push([info.centre.x[q], info.centre.y[q]]);
        if (towardA) pts.reverse();
        var tr = newSeg('track', pts, { link: TL.id, vmax: 0.7, tram: true });
        var endEnd = towardA ? TL.a : TL.b, startEnd = towardA ? TL.b : TL.a;
        tr.endNode = endEnd.edge ? null : net.nodes[endEnd.node];
        tr.startNode = startEnd.edge ? null : net.nodes[startEnd.node];
        if (tr.endNode) {
          var tapp = { key: 't' + tr.endNode.id, dir: endEnd.dir, node: tr.endNode, lane: tr, sign: null, rank: -1, state: GREEN, isTram: true };
          tr.app = tapp; tr.endNode.tramApp = tapp;
        }
        tr.startDir = startEnd.dir; tr.endDir = endEnd.dir;
        tsegs.push(tr); net.tracks.push(tr);
      }
      var troute = [];
      for (ti = 0; ti < tsegs.length; ti++) {
        troute.push(tsegs[ti]);
        if (ti < tsegs.length - 1) {
          var a = tsegs[ti], b = tsegs[ti + 1], pa = a.path, pb = b.path;
          var mv = newSeg('tmove', [[pa.x[pa.n - 1], pa.y[pa.n - 1]], [pb.x[0], pb.y[0]]],
            { node: a.endNode, app: a.app, fromDir: a.endDir, toDir: b.startDir, turn: 'S', tram: true, vmax: 0.7, exitLane: b });
          mv.upstream.push({ seg: a, dist: 0 });
          a.endNode.moves.push(mv); a.endNode.internal.push(mv);
          troute.push(mv);
        }
      }
      net.tramRoute = makeRoute(troute, 0);
    }

    /* --- junction internals --- */
    net.nodes.forEach(function (node) {
      var d, a, b;
      if (node.type === 'rbt') { buildRoundabout(node); return; }
      for (a = 0; a < 4; a++) {
        if (!node.apps[a]) continue;
        for (b = 0; b < 4; b++) {
          if (b === a || !node.outLanes[b]) continue;
          var inL = node.apps[a].lane, outL = node.outLanes[b];
          var p0 = [inL.path.x[inL.path.n - 1], inL.path.y[inL.path.n - 1]], p1 = [outL.path.x[0], outL.path.y[0]];
          var hi = [-U.DX[a], -U.DY[a]], ho = [U.DX[b], U.DY[b]];
          var turn = R.level.turnOf(a, b), pts;
          if (node.type === 'mini') pts = miniPath(node, a, b, p0, p1, hi, ho, turn);
          else if (turn === 'S') pts = [p0, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2], p1];
          else {
            var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
            var legIn = Math.abs(dx * hi[0] + dy * hi[1]), legOut = Math.abs(dx * ho[0] + dy * ho[1]);
            // left turns cut the corner (so opposing left-turners pass without crossing paths); right turns hug the kerb
            var kf = turn === 'L' ? 0.3 : 0.56;
            pts = bezier(p0, [p0[0] + hi[0] * legIn * kf, p0[1] + hi[1] * legIn * kf],
              [p1[0] - ho[0] * legOut * kf, p1[1] - ho[1] * legOut * kf], p1, 14);
          }
          var vmax = node.type === 'mini' ? 0.46 : (turn === 'S' ? 0.9 : turn === 'L' ? 0.56 : 0.45);
          var mv = newSeg('move', pts, { node: node, app: node.apps[a], fromDir: a, toDir: b, turn: turn, vmax: vmax, exitLane: outL });
          mv.upstream.push({ seg: inL, dist: 0 });
          node.moves.push(mv); node.internal.push(mv);
          node.moveMap[a * 4 + b] = [mv];
        }
      }
    });

    function miniPath(node, a, b, p0, p1, hi, ho, turn) {
      if (turn === 'R') {
        var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
        var legIn = Math.abs(dx * hi[0] + dy * hi[1]), legOut = Math.abs(dx * ho[0] + dy * ho[1]);
        return bezier(p0, [p0[0] + hi[0] * legIn * 0.56, p0[1] + hi[1] * legIn * 0.56],
          [p1[0] - ho[0] * legOut * 0.56, p1[1] - ho[1] * legOut * 0.56], p1, 12);
      }
      var rho = 0.21, pts = [p0, [p0[0] + hi[0] * 0.12, p0[1] + hi[1] * 0.12]];
      var phiA = Math.atan2(-U.DY[a], U.DX[a]), phiB = Math.atan2(-U.DY[b], U.DX[b]);
      var th0 = phiA + 0.9, th1 = phiB - 0.9;
      while (th1 < th0) th1 += Math.PI * 2;
      var n = Math.max(2, Math.round((th1 - th0) / 0.35));
      for (var i = 0; i <= n; i++) {
        var th = th0 + (th1 - th0) * i / n;
        pts.push([node.cx + rho * Math.cos(th), node.cy - rho * Math.sin(th)]);
      }
      pts.push([p1[0] - ho[0] * 0.12, p1[1] - ho[1] * 0.12]); pts.push(p1);
      return chaikin(pts, 3);
    }

    function buildRoundabout(node) {
      var arms = [];
      for (var d = 0; d < 4; d++) if (node.apps[d] || node.outLanes[d]) arms.push({ dir: d, phi: Math.atan2(-U.DY[d], U.DX[d]) });
      arms.forEach(function (a) { if (a.phi < 0) a.phi += Math.PI * 2; });
      arms.sort(function (x, y) { return x.phi - y.phi; });
      function ring(th) { return [node.cx + RING_R * Math.cos(th), node.cy - RING_R * Math.sin(th)]; }
      function tang(th) { return [-Math.sin(th), -Math.cos(th)]; }
      function arc(t0, t1) {
        while (t1 <= t0) t1 += Math.PI * 2;
        var n = Math.max(3, Math.round((t1 - t0) / 0.12)), pts = [];
        for (var i = 0; i <= n; i++) pts.push(ring(t0 + (t1 - t0) * i / n));
        return pts;
      }
      var n = arms.length;
      arms.forEach(function (a, i) {
        var nxt = arms[(i + 1) % n];
        a.arcA = newSeg('ring', arc(a.phi - RING_D, a.phi + RING_D), { node: node, vmax: 0.5, ringArm: a.dir });
        a.arcB = newSeg('ring', arc(a.phi + RING_D, nxt.phi - RING_D), { node: node, vmax: 0.5 });
        node.internal.push(a.arcA, a.arcB);
        var app = node.apps[a.dir], out = node.outLanes[a.dir];
        if (app) {
          var inL = app.lane, p0 = [inL.path.x[inL.path.n - 1], inL.path.y[inL.path.n - 1]];
          var q = ring(a.phi + RING_D), tq = tang(a.phi + RING_D), hi = [-U.DX[a.dir], -U.DY[a.dir]];
          var dist = Math.sqrt((q[0] - p0[0]) * (q[0] - p0[0]) + (q[1] - p0[1]) * (q[1] - p0[1]));
          a.entry = newSeg('entry', bezier(p0, [p0[0] + hi[0] * dist * 0.45, p0[1] + hi[1] * dist * 0.45],
            [q[0] - tq[0] * dist * 0.4, q[1] - tq[1] * dist * 0.4], q, 14),
            { node: node, app: app, fromDir: a.dir, vmax: 0.5, turn: 'R' });
          a.entry.upstream.push({ seg: inL, dist: 0 });
          node.internal.push(a.entry); node.moves.push(a.entry);
        }
        if (out) {
          var p1 = [out.path.x[0], out.path.y[0]], e = ring(a.phi - RING_D), te = tang(a.phi - RING_D), ho = [U.DX[a.dir], U.DY[a.dir]];
          var dist2 = Math.sqrt((e[0] - p1[0]) * (e[0] - p1[0]) + (e[1] - p1[1]) * (e[1] - p1[1]));
          a.exit = newSeg('exit', bezier(e, [e[0] + te[0] * dist2 * 0.4, e[1] + te[1] * dist2 * 0.4],
            [p1[0] - ho[0] * dist2 * 0.45, p1[1] - ho[1] * dist2 * 0.45], p1, 14),
            { node: node, toDir: a.dir, vmax: 0.55, exitLane: out });
          node.internal.push(a.exit);
        }
      });
      // entry merges: entering traffic gives way to the ring
      arms.forEach(function (a, i) {
        if (!a.entry) return;
        var prev = arms[(i + n - 1) % n];
        var zE = Math.min(a.entry.len, 0.5), zA = Math.min(a.arcA.len, 0.5);
        a.entry.conflicts.push({ foe: a.arcA, in: U.round6(a.entry.len - zE), out: a.entry.len, fin: U.round6(a.arcA.len - zA), fout: a.arcA.len,
          merge: true, yield: true, mutual: false, inside: false, ctx: CTX.rbt });
        a.arcA.conflicts.push({ foe: a.entry, in: U.round6(a.arcA.len - zA), out: a.arcA.len, fin: U.round6(a.entry.len - zE), fout: a.entry.len,
          merge: true, yield: false, mutual: false, inside: false, ctx: CTX.rbt });
        a.arcA.upstream.push({ seg: prev.arcB, dist: 0 });
        a.arcA.upstream.push({ seg: prev.arcA, dist: prev.arcB.len });
        if (prev.entry) a.arcA.upstream.push({ seg: prev.entry, dist: prev.arcB.len });
      });
      // routes through the ring
      arms.forEach(function (a, i) {
        if (!a.entry) return;
        arms.forEach(function (b) {
          if (b === a || !b.exit) return;
          var list = [a.entry, a.arcB], k = (i + 1) % n;
          while (arms[k] !== b) { list.push(arms[k].arcA, arms[k].arcB); k = (k + 1) % n; }
          list.push(b.exit);
          node.moveMap[a.dir * 4 + b.dir] = list;
        });
      });
    }

    /* --- conflict zones for ordinary junctions --- */
    function zonePair(A, B, thr) {
      var pa = A.path, pb = B.path, thr2 = thr * thr, aLo = -1, aHi = -1, bLo = -1, bHi = -1, i, j;
      for (i = 0; i < pa.n; i++) {
        for (j = 0; j < pb.n; j++) {
          var dx = pa.x[i] - pb.x[j], dy = pa.y[i] - pb.y[j];
          if (dx * dx + dy * dy < thr2) {
            if (aLo < 0) aLo = i; aHi = i;
            if (bLo < 0 || j < bLo) bLo = j; if (j > bHi) bHi = j;
          }
        }
      }
      if (aLo < 0) return null;
      return { aIn: U.round6(aLo * pa.ds), aOut: U.round6(aHi * pa.ds), bIn: U.round6(bLo * pb.ds), bOut: U.round6(bHi * pb.ds) };
    }

    net.nodes.forEach(function (node) {
      if (node.type === 'rbt') return;
      var apps = node.apps.filter(function (a) { return a; });
      var signed = apps.filter(function (a) { return a.sign; }).length;
      node.allway = node.type === 'plain' && apps.length > 0 && apps.every(function (a) { return a.sign === 'stop'; });
      node.uncontrolled = node.type === 'plain' && signed === 0;
      apps.forEach(function (a) { a.rank = (node.type === 'plain' && a.sign) ? 1 : 0; });
      var mv = node.moves;
      for (var i = 0; i < mv.length; i++) for (var j = i + 1; j < mv.length; j++) {
        var A = mv[i], B = mv[j];
        if (A.app === B.app) continue; // same approach: plain car-following
        // opposing left-turners pass nearside to nearside without interfering
        if (node.type !== 'mini' && A.turn === 'L' && B.turn === 'L' && !A.tram && !B.tram && (A.fromDir + 2) % 4 === B.fromDir) continue;
        var z = zonePair(A, B, (A.tram || B.tram) ? 0.31 : 0.26);
        if (!z) continue;
        var merge = A.exitLane === B.exitLane;
        if (merge) { z.aOut = A.len; z.bOut = B.len; }
        A.conflicts.push(rule(node, A, B, { foe: B, in: z.aIn, out: z.aOut, fin: z.bIn, fout: z.bOut, merge: merge }));
        B.conflicts.push(rule(node, B, A, { foe: A, in: z.bIn, out: z.bOut, fin: z.aIn, fout: z.aOut, merge: merge }));
      }
      mv.forEach(function (m) { m.conflicts.sort(function (x, y) { return x.in - y.in; }); });
      // signal programme
      if (node.type === 'signal') {
        var sc = cfg.nodes[node.id].sig, st = {};
        Object.keys(sc.rows).forEach(function (k) {
          var row = sc.rows[k], arr = [];
          for (var t = 0; t < sc.C; t++) arr.push(row[t] ? (row[(t + 1) % sc.C] ? GREEN : AMBER) : RED);
          st[k] = arr;
        });
        node.sig = { C: sc.C, st: st };
      }
    });

    /* Who gives way to whom. M is "me", F the conflicting movement. */
    function rule(node, M, F, c) {
      var rel, ctx = CTX.none;
      var a = M.fromDir, b = F.fromDir, opposite = ((a + 2) % 4) === b, fromRight = ((a + 3) % 4) === b;
      if (M.tram) rel = 'prio';
      else if (F.tram) { rel = 'yield'; ctx = CTX.tram; }
      else if (node.type === 'mini') {
        ctx = CTX.mini;
        if (opposite) rel = (M.turn === 'L' && F.turn !== 'L') ? 'yield' : (F.turn === 'L' && M.turn !== 'L') ? 'prio' : 'mutual';
        else rel = fromRight ? 'prio' : 'yield'; // give way to traffic already circulating (from the left)
      } else if (node.allway) { rel = 'mutual'; ctx = CTX.allway; }
      else {
        var rm = M.app.rank, rf = F.app.rank;
        if (node.type !== 'signal' && rm !== rf) {
          rel = rm > rf ? 'yield' : 'prio';
          if (rel === 'yield') ctx = M.app.sign === 'stop' ? CTX.stop : (node.blind ? CTX.yieldBlind : CTX.yield);
        } else if (opposite) {
          rel = (M.turn === 'L' && F.turn !== 'L') ? 'yield' : (F.turn === 'L' && M.turn !== 'L') ? 'prio' : 'mutual';
          ctx = M.app.sign === 'stop' ? CTX.stop : CTX.left;
        } else if (node.type === 'signal') rel = 'none'; // conflicting greens: nobody expects the other
        else {
          rel = fromRight ? 'yield' : 'prio';
          if (rel === 'yield') ctx = M.app.sign === 'stop' ? CTX.stop : M.app.sign === 'yield' ? (node.blind ? CTX.yieldBlind : CTX.yield)
            : (node.blind ? CTX.freeBlind : CTX.free);
        }
      }
      c.yield = rel === 'yield' || rel === 'mutual';
      c.mutual = rel === 'mutual';
      c.inside = c.yield && opposite && M.turn === 'L' && !F.tram && M.app.rank === 0 && node.type !== 'mini' && !node.allway;
      c.ctx = ctx;
      return c;
    }

    /* --- lane furniture: speed zones, bus stops, level crossing --- */
    function sAtTile(seg, tile) {
      var p = seg.path, cx = tile[0] + 0.5, cy = tile[1] + 0.5, best = 0, bd = 1e9;
      for (var i = 0; i < p.n; i++) { var dx = p.x[i] - cx, dy = p.y[i] - cy, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
      return U.round6(best * p.ds);
    }
    net.segs.forEach(function (seg) {
      if (seg.kind !== 'lane' || !seg.app) return;
      var app = seg.app, node = app.node;
      if (app.bump) seg.zones.push({ s1: U.round6(seg.len - 1.75), s2: U.round6(seg.len - 1.4), v: 0.3, bump: true });
      if (node.type === 'plain' && !node.allway) {
        if (app.sign === 'yield') seg.zones.push({ s1: U.round6(seg.len - 0.8), s2: seg.len, v: 0.45 });
        else if (node.uncontrolled) seg.zones.push({ s1: U.round6(seg.len - 0.8), s2: seg.len, v: node.blind ? 0.26 : 0.3 });
      }
    });
    level.busStops.forEach(function (b) {
      var seg = net.lanes[b.link + ':' + (b.fwd ? 1 : 0)];
      var s = sAtTile(seg, level.links[b.link].tiles[b.tile]) + 0.3;
      s = U.clamp(s, 0.9, seg.len - 0.5);
      seg.stops.push({ id: b.id, s: U.round6(s), dwell: b.dwell, bay: !!cfg.bays[b.id], seg: seg });
    });
    if (level.rail) {
      var RL = level.rail, tile = level.links[RL.link].tiles[RL.tile];
      net.rail = { level: RL, vertical: RL.vertical, idx: RL.idx, x: tile[0] + 0.5, y: tile[1] + 0.5, state: 0, lanes: [] };
      ['1', '0'].forEach(function (k) {
        var seg = net.lanes[RL.link + ':' + k], s = sAtTile(seg, tile);
        seg.rail = { s1: U.round6(s - 0.36), s2: U.round6(s + 0.36) };
        net.rail.lanes.push(seg);
      });
    }

    /* --- routes --- */
    function makeRoute(segs, detour) {
      var cum = [], idx = {}, d = 0;
      for (var i = 0; i < segs.length; i++) { cum.push(d); idx[segs[i].id] = i; d += segs[i].len; }
      return { segs: segs, cum: cum, idx: idx, len: d, detour: detour || 0 };
    }
    function hops(from, to) { // sequence of {node, inDir, outDir}
      var out = [], L = level.links[from.link], node = level.nodes[L.a.node], inDir = L.a.dir, guard = 0;
      while (guard++ < 4) {
        var found = false;
        for (var d = 0; d < 4 && !found; d++) {
          var lk = node.arms[d];
          if (lk < 0 || d === inDir) continue;
          if (lk === to.link) { out.push({ node: node.id, inDir: inDir, outDir: d }); return out; }
          var LL = level.links[lk];
          if (!LL.b.edge) {
            var viaA = LL.a.node === node.id, other = level.nodes[viaA ? LL.b.node : LL.a.node];
            if (other.arms.indexOf(to.link) >= 0) {
              out.push({ node: node.id, inDir: inDir, outDir: d });
              inDir = viaA ? LL.b.dir : LL.a.dir; node = other; found = true;
            }
          }
        }
        if (!found) return null;
      }
      return null;
    }
    function banned(h) {
      for (var i = 0; i < h.length; i++) {
        var app = net.nodes[h[i].node].apps[h[i].inDir], t = R.level.turnOf(h[i].inDir, h[i].outDir);
        if ((t === 'L' && app.noL) || (t === 'R' && app.noR)) return i;
      }
      return -1;
    }
    function segsFor(from, h) {
      var segs = [net.lanes[from.link + ':0']];
      for (var i = 0; i < h.length; i++) {
        var node = net.nodes[h[i].node];
        var inner = node.moveMap[h[i].inDir * 4 + h[i].outDir];
        for (var k = 0; k < inner.length; k++) segs.push(inner[k]);
        segs.push(node.outLanes[h[i].outDir]);
      }
      return segs;
    }
    level.entries.forEach(function (from) {
      level.entries.forEach(function (to) {
        if (from.id === to.id) return;
        var h = hops(from, to), bi = banned(h), detour = 0;
        if (bi >= 0) {
          var best = null, bestScore = -1;
          level.entries.forEach(function (alt) {
            if (alt.id === from.id || alt.id === to.id) return;
            var ha = hops(from, alt);
            if (!ha || banned(ha) >= 0) return;
            var same = true;
            for (var i = 0; i < bi; i++) if (!ha[i] || ha[i].outDir !== h[i].outDir) same = false;
            var t = ha[bi] ? R.level.turnOf(ha[bi].inDir, ha[bi].outDir) : 'X';
            var sc = (same ? 10 : 0) + (t === 'S' ? 3 : 1);
            if (sc > bestScore) { bestScore = sc; best = ha; }
          });
          if (best) { h = best; detour = DETOUR; }
        }
        net.routes[from.id + '>' + to.id] = makeRoute(segsFor(from, h), detour);
      });
    });

    net.cost = cost(level, cfg);
    return net;
  }

  /* Driver perception by situation: sigma = error judging a gap, pm = chance of overlooking
     a vehicle entirely, gl = safety margin (ticks) wanted before the other vehicle arrives. */
  var CTX = {
    none:       { sigma: 0,    pm: 0,     gl: 0.8 },
    yield:      { sigma: 0.22, pm: 0.07,  gl: 0.9 },
    yieldBlind: { sigma: 0.32, pm: 0.16,  gl: 0.9 },
    stop:       { sigma: 0.1,  pm: 0.008, gl: 1.0 },
    free:       { sigma: 0.3,  pm: 0.3,   gl: 0.7 },
    freeBlind:  { sigma: 0.38, pm: 0.45,  gl: 0.7 },
    left:       { sigma: 0.12, pm: 0.006, gl: 0.9 },
    rbt:        { sigma: 0.08, pm: 0.003, gl: 0.9 },
    mini:       { sigma: 0.1,  pm: 0.006, gl: 0.6 },
    tram:       { sigma: 0.07, pm: 0.004, gl: 1.3 },
    allway:     { sigma: 0,    pm: 0,     gl: 1.0 }
  };

  R.net = {
    build: build, posAt: posAt, defaultConfig: defaultConfig, normConfig: normConfig, defaultSignal: defaultSignal,
    cost: cost, canPlace: canPlace, approachList: approachList, appKey: appKey, COST: COST, CTX: CTX,
    GREEN: GREEN, RED: RED, AMBER: AMBER, EXT: EXT, RING_R: RING_R, DETOUR: DETOUR
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
