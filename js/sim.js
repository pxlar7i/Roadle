/* Roadle — microscopic traffic simulation.
   Vehicles follow lane paths with an IDM car-following model (acceleration, braking,
   queues), give way using gap acceptance with imperfect perception (which is where
   near-misses and crashes come from), obey signals/signs, and are scored on delay. */
(function (root) {
  'use strict';
  var R = root.Roadle, U = R.util, NET = R.net;
  var SUB = 5, DT = 1 / SUB;
  var GREEN = NET.GREEN, RED = NET.RED, AMBER = NET.AMBER, EXT = NET.EXT;

  var TYPES = {
    car:   { len: 0.42, w: 0.22, v0: 0.9, a: 0.38, b: 0.5,  T: 1.0, s0: 0.12, bmax: 1.0,  weight: 1 },
    truck: { len: 0.62, w: 0.24, v0: 0.8, a: 0.24, b: 0.42, T: 1.2, s0: 0.15, bmax: 0.9,  weight: 1 },
    bus:   { len: 0.78, w: 0.25, v0: 0.8, a: 0.26, b: 0.42, T: 1.2, s0: 0.15, bmax: 0.9,  weight: 8 },
    tram:  { len: 1.7,  w: 0.26, v0: 0.7, a: 0.15, b: 0.3,  T: 1.4, s0: 0.2,  bmax: 0.75, weight: 15 }
  };
  Object.keys(TYPES).forEach(function (k) { var P = TYPES[k]; P.sq = 2 * Math.sqrt(P.a * P.b); P.name = k; });

  var TRAIN = { v: 1.1, len: 4.4, warn: 8, close: 5, open: 5.5 };
  var SCORE = { tau: 38, crash: 60, tramCrash: 200, trainCrash: 300, stuck: 25, crashDelay: 10, worstShare: 0.4 };
  var CRASH_TIME = 10;      // ticks a wreck blocks the junction before it is towed
  var TAIL_PAD = 0.2;
  var REACT = 0.6;          // ticks before a driver reacts to something unexpected in their path

  /* time to cover distance d from speed v, accelerating at a up to vmax (optimistic if v>vmax) */
  function tt(d, v, a, vmax) {
    if (d <= 0) return 0;
    if (v >= vmax) return d / v;
    var d1 = (vmax * vmax - v * v) / (2 * a);
    if (d <= d1) return (Math.sqrt(v * v + 2 * a * d) - v) / a;
    return (vmax - v) / a + (d - d1) / vmax;
  }
  /* same, but if already faster than vmax assume slowing to vmax (pessimistic) */
  function ttSlow(d, v, a, vmax) {
    if (d <= 0) return 0;
    if (v >= vmax) return d / vmax;
    return tt(d, v, a, vmax);
  }

  /* free-flow reference times on the untouched junction, per origin>destination and vehicle type */
  function refTimes(level) {
    if (level._ref) return level._ref;
    var net = NET.build(level, NET.defaultConfig(level)), ref = {};
    function time(route, P) {
      var t = 0, segs = route.segs;
      for (var i = 0; i < segs.length; i++) {
        var sg = segs[i], len = sg.len;
        if (i === segs.length - 1) len = len - EXT + P.len + 0.15;
        var v = P.v0;
        if (sg.kind === 'move' && sg.turn !== 'S') { v = Math.min(v, sg.vmax); t += 0.7; }
        t += len / v;
      }
      return Math.round(t * 100) / 100;
    }
    Object.keys(net.routes).forEach(function (k) {
      ref[k] = { car: time(net.routes[k], TYPES.car), truck: time(net.routes[k], TYPES.truck), bus: time(net.routes[k], TYPES.bus) };
    });
    if (net.tramRoute) ref.tram = time(net.tramRoute, TYPES.tram);
    level._ref = ref;
    return ref;
  }

  function Sim(level, config, demand, opts) {
    opts = opts || {};
    this.level = level; this.demand = demand; this.fx = !!opts.fx;
    this.net = NET.build(level, config);
    this.ref = refTimes(level);
    this.rng = U.makeRng(level.id + ':drivers:' + demand.seed);
    this.step = 0; this.t = 0; this.done = false; this.result = null;
    this.veh = []; this.events = []; this.nextId = 1;
    this.nextArr = 0;
    this.backlog = level.entries.map(function () { return []; });
    this.tramTimes = R.level.tramTimes(level); this.nextTram = 0; this.tramQueue = [];
    this.trains = [];
    if (level.rail) for (var i = 0; i < level.rail.times.length; i++) this.trains.push({ t0: level.rail.times[i], fwd: level.rail.fwd[i], hit: false, honked: false });
    this.stats = {
      spawned: 0, done: 0, sumW: 0, sumWD: 0, crashes: 0, tramCrashes: 0, trainCrashes: 0, honks: 0, nearMiss: 0,
      total: demand.arrivals.length + this.tramTimes.length,
      perEntry: level.entries.map(function () { return { n: 0, delay: 0, out: 0 }; }),
      tram: { delay: 0, out: 0 },
      liveDelay: 0
    };
    this._p = {};
    this.tickUpdate();
  }

  /* ---------- helpers ---------- */
  Sim.prototype.emit = function (type, a, b, c) {
    if (this.fx) this.events.push({ type: type, a: a, b: b, c: c, t: this.t });
  };

  // distance from the end of segment `sg` to u's front, when u's front is already beyond sg
  function beyond(u, sg) {
    var segs = u.route.segs, k = u.tailFrom, d = u.s;
    while (k < u.ri && segs[k] !== sg) k++;
    for (var i = k + 1; i < u.ri; i++) d += segs[i].len;
    return d;
  }

  function bodyPos(V, back, out) {
    var segs = V.route.segs, i = V.ri, s = V.s - back;
    while (s < 0 && i > 0) { i--; s += segs[i].len; }
    return NET.posAt(segs[i].path, s, out);
  }

  Sim.prototype.pair = function (V, W, ctx) {
    var p = V.pairs[W.id];
    if (!p) {
      var wait = V.waitT0 >= 0 ? this.t - V.waitT0 : 0;
      p = V.pairs[W.id] = { miss: this.rng() < ctx.pm * (1 + wait / 10), eps: this.rng.normal() * ctx.sigma };
    }
    return p;
  };

  /* Is a conflict zone physically occupied by a vehicle on the other movement? */
  Sim.prototype.blockedBy = function (V, c) {
    var F = c.foe, i, W, f;
    for (i = 0; i < F.veh.length; i++) {
      W = F.veh[i]; f = W.s;
      if (W !== V && f > c.fin - 0.02 && f - W.len < c.fout) {
        if (V.squeeze > 0 && W.v < 0.05 && !W.crashed) continue;
        return W;
      }
    }
    for (i = 0; i < F.tails.length; i++) {
      W = F.tails[i];
      if (W === V) continue;
      f = F.len + beyond(W, F);
      if (f - W.len < c.fout) {
        if (V.squeeze > 0 && W.v < 0.05 && !W.crashed) continue;
        return W;
      }
    }
    return null;
  };

  /* Gap acceptance: may V pass conflict c (zone starts dIn ahead) given approaching foes? */
  Sim.prototype.gapOK = function (V, c, dIn, M) {
    var F = c.foe, ctx = c.ctx, P = V.P, self = this;
    var vcap = Math.min(V.v0, M.vmax);
    var tArr = ttSlow(dIn, V.v, P.a * 0.85, vcap);
    var zl = c.out - c.in;
    var tClr = ttSlow(dIn + zl + V.len + 0.05, V.v, P.a * 0.85, vcap);
    var tMer = ttSlow(dIn + zl, V.v, P.a * 0.85, vcap);
    var wait = V.waitT0 >= 0 ? this.t - V.waitT0 : 0;
    var gl = ctx.gl * (1 - Math.min(0.6, wait / 50));
    var fzl = c.fout - c.fin, i, W, f;

    function test(W, dW, seen) {
      // W is dW short of its zone start. `seen` = in the junction, no perception error.
      var wv = W.v;
      if (W.crashed) return true;
      if (wv < 0.05 && (W.held || !W.head || W.stuck)) {
        if (c.mutual) {
          if (V.waitT0 >= 0 && (W.waitT0 < 0 || V.waitT0 < W.waitT0 || (V.waitT0 === W.waitT0 && V.id < W.id))) return true;
          return false;
        }
        // waiting at its own stop line or stuck in a queue: it will look before it moves.
        // A vehicle paused inside the junction, though, may set off again any moment.
        if (!seen || W.stuck || W.boxHeld) return true;
      }
      var wcap = Math.max(wv, Math.min(W.v0, F.vmax));
      var est = 1;
      if (!seen && ctx.pm > 0) {
        var pr = self.pair(V, W, ctx);
        if (pr.miss) return true;
        est = 1 + pr.eps * Math.min(1.3, 0.35 + wv);
        if (est < 0.5) est = 0.5;
      }
      var tWc = (dW + fzl + W.len) / (wv > 0.3 ? wv : 0.3);
      if (c.merge) {
        var tWm = tt(dW + fzl, wv, W.P.a, wcap) * est;
        if (tMer + gl < tWm) return true;          // I slot in ahead with a decent gap
        return tWc + 0.1 < tArr;                   // or W is through before I get there
      }
      var tWa = tt(dW, wv, W.P.a, wcap) * est;
      if (tClr + gl < tWa) return true;            // I am clear before W arrives
      return tWc + 0.25 < tArr;                    // W is clear before I arrive
    }

    // vehicles on the conflicting movement itself
    for (i = 0; i < F.veh.length; i++) {
      W = F.veh[i]; f = W.s;
      if (W === V || f - W.len >= c.fout) continue;
      if (f > c.fin - 0.02) return false;
      if (!test(W, c.fin - f, true)) return false;
    }
    for (i = 0; i < F.tails.length; i++) {
      W = F.tails[i];
      if (W !== V && F.len + beyond(W, F) - W.len < c.fout) return false;
    }
    // vehicles still approaching it
    var red = F.app && F.app.node.sig && F.app.state === RED, amber = F.app && F.app.node.sig && F.app.state === AMBER;
    for (var u = 0; u < F.upstream.length; u++) {
      var up = F.upstream[u], S = up.seg;
      for (i = 0; i < S.veh.length; i++) {
        W = S.veh[i];
        if (W === V) continue;
        var ri = W.route.idx[F.id];
        if (ri === undefined || ri <= W.ri) continue;       // not heading for this movement
        var dW = S.len - W.s + up.dist + c.fin;
        if (dW > 6) continue;
        if (up.dist === 0 && F.app) {
          if (F.app.sign === 'stop' && !W.stopDone && (c.mutual || V.waitT0 >= 0)) continue; // it still has to stop first
          if (red && !W.runRed) continue;
          if (amber && W.held) continue;
        }
        if (!test(W, dW, false)) return false;
      }
    }
    return true;
  };

  /* Before pulling away: wait for vehicles already crossing my path to clear. */
  Sim.prototype.junctionClear = function (V, M, dLine) {
    var P = V.P, vcap = Math.min(V.v0, M.vmax);
    for (var k = 0; k < M.conflicts.length; k++) {
      var c = M.conflicts[k], F = c.foe, i, W, f, tWc;
      var tArr = tt(dLine + c.in, V.v, P.a, vcap);
      for (i = 0; i < F.veh.length; i++) {
        W = F.veh[i]; f = W.s;
        if (W === V || f - W.len >= c.fout) continue;
        if (f < c.fin - 0.02 && W.v < 0.05 && (W.held || W.stuck)) continue;
        if (V.squeeze > 0 && W.v < 0.05) continue;
        tWc = (c.fout - f + W.len) / (W.v > 0.3 ? W.v : 0.3);
        if (tWc + 0.2 > tArr) return false;
      }
      for (i = 0; i < F.tails.length; i++) {
        W = F.tails[i];
        if (W === V) continue;
        f = F.len + beyond(W, F) - W.len; // rear position
        if (f >= c.fout) continue;
        if (V.squeeze > 0 && W.v < 0.05) continue;
        tWc = (c.fout - f) / (W.v > 0.3 ? W.v : 0.3);
        if (tWc + 0.2 > tArr) return false;
      }
    }
    return true;
  };

  /* Box junction rule: is there room for me on the far side? */
  Sim.prototype.exitRoom = function (V, M) {
    var out = M.exitLane;
    if (!out) return true;
    var need = V.len + 0.2, node = M.node, i, k;
    for (k = 0; k < node.moves.length; k++) {
      var m = node.moves[k];
      if (m.exitLane !== out) continue;
      for (i = 0; i < m.veh.length; i++) need += m.veh[i].len + 0.16;
    }
    var rear = 1e9, lv = 0;
    for (i = 0; i < out.veh.length; i++) {
      var u = out.veh[i], r = u.s - u.len;
      if (r < rear) { rear = r; lv = u.v; }
    }
    return rear + lv * 2.2 >= need;
  };

  /* ---------- per-tick housekeeping: signals, level crossing, arrivals ---------- */
  Sim.prototype.tickUpdate = function () {
    var net = this.net, tick = Math.round(this.t), self = this, i;
    net.nodes.forEach(function (node) {
      if (!node.sig) return;
      var idx = tick % node.sig.C, changed = false;
      for (var d = 0; d < 4; d++) {
        var app = node.apps[d];
        if (!app) continue;
        var st = node.sig.st[d][idx];
        if (st !== app.state) changed = true;
        app.state = st;
      }
      if (node.tramApp && node.sig.st.t) node.tramApp.state = node.sig.st.t[idx];
      node.sigIdx = idx;
      if (changed && tick > 0) self.emit('sig', node.cx, node.cy);
    });
    if (net.rail) {
      var s = 0;
      for (i = 0; i < this.trains.length; i++) {
        var tr = this.trains[i], dt = this.t - tr.t0;
        if (dt >= -TRAIN.warn && dt < -TRAIN.close) s = Math.max(s, 1);
        if (dt >= -TRAIN.close && dt < TRAIN.open) s = 2;
        if (dt >= -TRAIN.warn && !tr.honked) { tr.honked = true; this.emit('trainHorn', net.rail.x, net.rail.y); }
      }
      if (s !== net.rail.state) { this.emit(s === 0 ? 'barrierUp' : (s === 1 ? 'barrierWarn' : 'barrierDown'), net.rail.x, net.rail.y); net.rail.state = s; }
    }
    var arr = this.demand.arrivals;
    while (this.nextArr < arr.length && arr[this.nextArr].t <= this.t) {
      var a = arr[this.nextArr++];
      this.backlog[a.entry].push(a);
    }
    while (this.nextTram < this.tramTimes.length && this.tramTimes[this.nextTram] <= this.t) {
      this.tramQueue.push(this.tramTimes[this.nextTram++]);
    }
  };

  Sim.prototype.trySpawn = function () {
    var net = this.net, i, j, u;
    for (i = 0; i < this.backlog.length; i++) {
      var q = this.backlog[i];
      if (!q.length) continue;
      var lane = net.lanes[this.level.entries[i].link + ':0'], rear = 1e9, lv = 0;
      for (j = 0; j < lane.veh.length; j++) { u = lane.veh[j]; if (u.s - u.len < rear) { rear = u.s - u.len; lv = u.v; } }
      var a = q[0], P = TYPES[a.type];
      // enter at a speed and spacing close to car-following equilibrium
      var vs = Math.min(P.v0 * 0.97, lv * 1.05 + 0.12);
      if (rear < P.s0 + 0.1 + vs * P.T * 0.8) continue;
      q.shift();
      var route = net.routes[a.entry + '>' + a.dest];
      var V = this.makeVehicle(P, route, a.t);
      V.entry = a.entry; V.hue = a.hue; V.arr = a;
      V.free = this.ref[a.entry + '>' + a.dest][a.type];
      V.detour = route.detour;
      V.v = Math.min(V.v0, vs);
      if (a.type === 'bus') {
        var line = this.level.busLines[a.line];
        for (j = 0; j < route.segs.length; j++) {
          var sg = route.segs[j];
          for (var k = 0; k < sg.stops.length; k++) if (line.stops.indexOf(sg.stops[k].id) >= 0) { V.busStops.push(sg.stops[k]); V.free += sg.stops[k].dwell; }
        }
      }
      // which way will it turn at the next junction (for indicators)
      this.stats.perEntry[a.entry].n++;
    }
    if (this.tramQueue.length && net.tramRoute) {
      var first = net.tramRoute.segs[0], clear = true;
      for (j = 0; j < first.veh.length; j++) if (first.veh[j].s - first.veh[j].len < 0.6) clear = false;
      if (clear) {
        var T = this.makeVehicle(TYPES.tram, net.tramRoute, this.tramQueue.shift());
        T.free = this.ref.tram; T.v = T.v0 * 0.9; T.entry = -1;
      }
    }
  };

  Sim.prototype.makeVehicle = function (P, route, sched) {
    var V = {
      id: this.nextId++, P: P, type: P.name, len: P.len, route: route, ri: 0, s: 0, v: 0, a: 0,
      v0: P.name === 'tram' ? P.v0 : P.v0 * (0.93 + 0.14 * this.rng()),
      sched: sched, born: this.t, free: 0, detour: 0, tailFrom: 0,
      held: false, head: true, stuck: false, waitT0: -1, stopDone: false, stopT: 0, amberGo: false, runRed: false,
      pairs: {}, touch: null, boxHeld: false, react: 0, crashed: false, crashT: 0, squeeze: 0, jamT: 0, honkCd: 0, lineWait: 0,
      busStops: [], dwell: 0, inBay: false, lat: 0, bayStop: null, gone: false, belled: false,
      pd: 0, d: 0, brake: false, hue: 0, entry: -1
    };
    route.segs[0].veh.push(V);
    this.veh.push(V);
    this.stats.spawned++;
    this.emit('spawn', V);
    return V;
  };

  /* ---------- the driver model: returns the acceleration for this step ---------- */
  Sim.prototype.plan = function (V) {
    var P = V.P, segs = V.route.segs, seg = segs[V.ri], v = V.v, net = this.net;
    var i, j, u, g, z, d, c, sg;
    var bc = P.b * 0.8;

    /* desired speed, anticipating slower stretches ahead */
    var v0 = V.v0 < seg.vmax ? V.v0 : seg.vmax;
    if (V.squeeze > 0 && v0 > 0.18) v0 = 0.18;
    for (i = 0; i < seg.zones.length; i++) {
      z = seg.zones[i];
      if (V.s < z.s2) {
        if (V.s >= z.s1) { if (z.v < v0) v0 = z.v; }
        else { var vz = Math.sqrt(z.v * z.v + 2 * bc * (z.s1 - V.s)); if (vz < v0) v0 = vz; }
      }
    }
    var dist = seg.len - V.s;
    for (j = V.ri + 1; j < segs.length && dist < 3; j++) {
      sg = segs[j];
      var lim = V.v0 < sg.vmax ? V.v0 : sg.vmax;
      if (lim < v0) { var va = Math.sqrt(lim * lim + 2 * bc * dist); if (va < v0) v0 = va; }
      for (i = 0; i < sg.zones.length; i++) {
        z = sg.zones[i];
        var vz2 = Math.sqrt(z.v * z.v + 2 * bc * (dist + z.s1)); if (vz2 < v0) v0 = vz2;
      }
      dist += sg.len;
    }

    /* leader */
    var gap = 1e9, lv = 0, head = true;
    for (i = 0; i < seg.veh.length; i++) {
      u = seg.veh[i];
      if (u !== V && u.s > V.s) { g = u.s - u.len - V.s; if (g < gap) { gap = g; lv = u.v; } head = false; }
    }
    for (i = 0; i < seg.tails.length; i++) {
      u = seg.tails[i];
      if (u === V) continue;
      g = seg.len + beyond(u, seg) - u.len - V.s; if (g < gap) { gap = g; lv = u.v; }
    }
    dist = seg.len - V.s;
    for (j = V.ri + 1; j < segs.length && dist < 4; j++) {
      sg = segs[j];
      for (i = 0; i < sg.veh.length; i++) { u = sg.veh[i]; g = dist + u.s - u.len; if (g < gap) { gap = g; lv = u.v; } }
      for (i = 0; i < sg.tails.length; i++) {
        u = sg.tails[i];
        if (u === V) continue;
        g = dist + sg.len + beyond(u, sg) - u.len; if (g < gap) { gap = g; lv = u.v; }
      }
      dist += sg.len;
    }
    V.head = head;
    V.stuck = v < 0.05 && gap < P.s0 + 0.2;

    /* things I may have to stop for */
    var stopD = 1e9, held = false, emergency = false, sawBlock = false;

    if (V.busStops.length && V.busStops[0].seg === seg) {
      d = V.busStops[0].s - V.s;
      if (d > -0.2) { if (d < stopD) stopD = d < 0 ? 0 : d; }
      else V.busStops.shift();
    }

    if (seg.rail && V.s < seg.rail.s1) {
      d = seg.rail.s1 - V.s - 0.06;
      if (net.rail.state >= 1) {
        if (v * v <= 2 * P.bmax * (d > 0.001 ? d : 0.001)) { if (d < stopD) stopD = d < 0 ? 0 : d; }
      } else if (d < 1.5 && (V.s + gap) - seg.rail.s2 < V.len + 0.12) { // never stop on the tracks
        if (d < stopD) stopD = d < 0 ? 0 : d;
      }
    }

    if (seg.endNode && seg.app && V.ri + 1 < segs.length) {
      var app = seg.app, node = app.node, dLine = seg.len - V.s, M = segs[V.ri + 1];
      var hold = false;
      if (dLine < 3.2) {
        if (node.sig) {
          var st = app.state;
          if (st === RED) {
            if (!V.runRed) { if (v * v <= 2 * P.bmax * (dLine > 0.02 ? dLine : 0.02) || v < 0.1) hold = true; else V.runRed = true; }
          } else if (st === AMBER) {
            if (!V.amberGo) { if (v * v <= 2 * P.b * 1.15 * (dLine > 0.02 ? dLine : 0.02) || v < 0.1) hold = true; else V.amberGo = true; }
          } else { V.amberGo = false; V.runRed = false; }
        }
        if (!hold && app.sign === 'stop' && !V.stopDone) {
          hold = true;
          if (v < 0.03 && dLine < 0.25 && head) { V.stopT += DT; if (V.stopT >= (node.allway ? 1.6 : 0.8)) { V.stopDone = true; hold = false; } }
        }
        if (!hold && head && dLine < 1.7) {
          var ok = true;
          V.boxHeld = false;
          if (node.box && !this.exitRoom(V, M)) { ok = false; V.boxHeld = true; }
          if (ok) {
            for (i = 0; i < M.conflicts.length; i++) {
              c = M.conflicts[i];
              if (c.yield && !c.inside && !this.gapOK(V, c, dLine + c.in, M)) { ok = false; break; }
            }
          }
          if (ok && v < 0.35) ok = this.junctionClear(V, M, dLine);
          if (!ok && (v * v <= 2 * P.bmax * (dLine > 0.03 ? dLine - 0.03 : 0.001) || v < 0.1)) hold = true;
        }
        if (hold) { d = dLine - 0.05; if (d < stopD) stopD = d < 0 ? 0 : d; }
        else if (dLine < 1.3) {
          for (i = 0; i < M.conflicts.length; i++) {
            c = M.conflicts[i];
            if (this.blockedBy(V, c)) { sawBlock = true; if (c.merge || V.react >= REACT || v < 0.35) { d = dLine + c.in - 0.06; if (d < stopD) { stopD = d < 0 ? 0 : d; emergency = true; } } }
          }
        }
        if (app.isTram && !V.belled && dLine < 2.6) { V.belled = true; this.emit('tramBell', V); }
      }
      held = hold;
      if (hold && v < 0.05 && dLine < 0.6) {
        if (V.waitT0 < 0) V.waitT0 = this.t;
        V.lineWait += DT;
      }
    } else if (seg.node) {
      /* inside a junction: stop short of any occupied conflict zone; left-turners wait for a gap */
      dist = -V.s;
      for (j = V.ri; j < segs.length && dist < 1.4; j++) {
        sg = segs[j];
        if (!sg.node) break;
        for (i = 0; i < sg.conflicts.length; i++) {
          c = sg.conflicts[i];
          d = dist + c.in;
          if (d < 0.02) continue; // already committed to this zone
          var blocked = false;
          if (this.blockedBy(V, c)) { sawBlock = true; if (c.merge || V.react >= REACT || v < 0.35) { blocked = true; emergency = !c.merge; } }
          else if (c.yield && c.inside && V.squeeze <= 0 && !this.gapOK(V, c, d, sg)) {
            if (v * v <= 2 * P.bmax * d || v < 0.1) blocked = true;
          }
          if (blocked) { d -= 0.06; if (d < stopD) stopD = d < 0 ? 0 : d; held = true; }
        }
        dist += sg.len;
      }
      if (held && v < 0.05) {
        if (V.waitT0 < 0) V.waitT0 = this.t;
        V.jamT += DT;
        if (V.jamT > 10) { V.squeeze = 1; V.jamT = 0; }
      } else if (v > 0.1) V.jamT = 0;
    }
    if (sawBlock) V.react += DT; else V.react = 0;
    if (stopD < 0.3 || V.dwell > 0) held = true;
    V.held = held;

    /* IDM */
    var r = v / v0, free = 1 - r * r * r * r, acc;
    if (free < -2) free = -2;
    acc = P.a * free;
    if (gap < 1e8) {
      if (gap < 0.01) gap = 0.01;
      var ss = P.s0 + v * P.T + v * (v - lv) / P.sq;
      if (ss < P.s0) ss = P.s0;
      var a1 = P.a * (free - (ss / gap) * (ss / gap));
      if (a1 < acc) acc = a1;
    }
    if (stopD < 1e8) {
      var gs = stopD < 0.01 ? 0.01 : stopD;
      var s2 = 0.04 + v * 0.5 + v * v / P.sq;
      var a2 = P.a * (free - (s2 / gs) * (s2 / gs));
      // never brake later than physics allows
      if (stopD > 0.02) { var need = -v * v / (2 * stopD); if (need < -P.b && need < a2) a2 = need * 1.05; }
      if (a2 < acc) acc = a2;
    }
    if (acc < -P.bmax) acc = -P.bmax;
    if (emergency && acc < -0.8 && v > 0.3 && V.honkCd <= 0) {
      V.honkCd = 8; this.stats.honks++; this.stats.nearMiss++; this.emit('honk', V, 1);
    }
    if (V.lineWait > 22 && V.honkCd <= 0 && head) {
      V.honkCd = 14 + (V.id % 9); this.stats.honks++; this.emit('honk', V, 0);
    }
    if (V.honkCd > 0) V.honkCd -= DT;
    return acc;
  };

  /* ---------- one simulation sub-step ---------- */
  Sim.prototype.advance = function () {
    if (this.done) return;
    if (this.step % SUB === 0) this.tickUpdate();
    this.trySpawn();
    var veh = this.veh, n = veh.length, i, V;

    for (i = 0; i < n; i++) {
      V = veh[i];
      V.pd = V.d;
      if (V.crashed || V.inBay) V.a = 0; else V.a = this.plan(V);
    }
    for (i = 0; i < n; i++) {
      V = veh[i];
      if (V.crashed) {
        V.crashT -= DT;
        if (V.crashT <= 0) {
          if (V.type === 'tram') { V.crashed = false; this.emit('resume', V); }
          else this.remove(V, 'towed');
        }
        continue;
      }
      if (V.inBay) { this.bayStep(V); continue; }
      var nv = V.v + V.a * DT;
      if (nv < 0) nv = 0;
      V.brake = V.a < -0.12 || (nv < 0.02 && V.v < 0.02);
      V.v = nv;
      V.s += nv * DT;
      if (V.dwell > 0) { this.dwellStep(V); }
      else if (V.busStops.length && nv < 0.03) {
        var bs = V.busStops[0], seg0 = V.route.segs[V.ri];
        if (bs.seg === seg0 && Math.abs(bs.s - V.s) < 0.16) {
          V.dwell = bs.dwell; V.v = 0;
          this.emit('busStop', V, bs);
          if (bs.bay) { V.inBay = true; V.bayStop = bs; var ix = seg0.veh.indexOf(V); if (ix >= 0) seg0.veh.splice(ix, 1); }
        }
      }
      this.move(V);
    }
    this.collide();
    this.trainStep();

    // drop finished vehicles
    var w = 0;
    for (i = 0; i < veh.length; i++) if (!veh[i].gone) veh[w++] = veh[i];
    veh.length = w;

    this.step++;
    this.t = this.step / SUB;
    if (this.t >= this.level.TMAX) this.finish();
    else if (this.t > this.level.T + 2 && !veh.length && this.nextArr >= this.demand.arrivals.length && !this.tramQueue.length &&
      this.nextTram >= this.tramTimes.length && this.backlogEmpty() && this.trainsDone()) this.finish();
  };

  Sim.prototype.backlogEmpty = function () {
    for (var i = 0; i < this.backlog.length; i++) if (this.backlog[i].length) return false;
    return true;
  };
  Sim.prototype.trainsDone = function () {
    for (var i = 0; i < this.trains.length; i++) if (this.t < this.trains[i].t0 + TRAIN.open + 1) return false;
    return true;
  };

  Sim.prototype.dwellStep = function (V) {
    V.dwell -= DT; V.v = 0;
    if (V.dwell <= 0) { V.dwell = 0; V.busStops.shift(); this.emit('busGo', V); }
  };

  Sim.prototype.bayStep = function (V) {
    if (V.lat < 1) V.lat = Math.min(1, V.lat + DT * 0.9);
    if (V.dwell > 0) { V.dwell -= DT; return; }
    // pull out when the lane is clear behind and beside the bus
    var seg = V.route.segs[V.ri], ok = true;
    for (var i = 0; i < seg.veh.length; i++) {
      var u = seg.veh[i];
      if (u.s > V.s - V.len - 0.4 - u.v * 2.2 && u.s - u.len < V.s + 0.25) { ok = false; break; }
    }
    if (ok) {
      V.inBay = false; V.busStops.shift(); V.bayStop = null;
      seg.veh.push(V);
      this.emit('busGo', V);
    }
  };

  Sim.prototype.move = function (V) {
    var segs = V.route.segs, seg = segs[V.ri];
    if (!V.inBay && V.lat > 0) V.lat = Math.max(0, V.lat - DT * 0.7);
    while (V.s >= seg.len && V.ri < segs.length - 1) {
      var ix = seg.veh.indexOf(V);
      if (ix >= 0) seg.veh.splice(ix, 1);
      seg.tails.push(V);
      V.s -= seg.len; V.ri++;
      if (seg.app) { V.stopDone = false; V.stopT = 0; V.waitT0 = -1; V.lineWait = 0; V.amberGo = false; V.runRed = false; V.belled = false; }
      seg = segs[V.ri];
      seg.veh.push(V);
      if (!seg.node) V.squeeze = 0;
    }
    // release segments my tail has fully left
    while (V.tailFrom < V.ri) {
      var rear = V.s - V.len;
      for (var k = V.tailFrom + 1; k < V.ri; k++) rear += segs[k].len;
      if (rear < TAIL_PAD) break;
      var tl = segs[V.tailFrom].tails, it = tl.indexOf(V);
      if (it >= 0) tl.splice(it, 1);
      V.tailFrom++;
    }
    V.d = V.route.cum[V.ri] + V.s;
    if (V.ri === segs.length - 1 && V.s >= seg.len - EXT + V.len + 0.15) this.remove(V, 'done');
  };

  Sim.prototype.remove = function (V, why) {
    if (V.gone) return;
    var segs = V.route.segs, k, ix;
    ix = segs[V.ri].veh.indexOf(V); if (ix >= 0) segs[V.ri].veh.splice(ix, 1);
    for (k = V.tailFrom; k < V.ri; k++) { ix = segs[k].tails.indexOf(V); if (ix >= 0) segs[k].tails.splice(ix, 1); }
    V.gone = true;
    var delay;
    if (why === 'done') delay = Math.max(0, this.t - V.sched - V.free) + V.detour;
    else delay = Math.max(0, this.t - V.sched - V.free * (V.d / V.route.len)) + SCORE.crashDelay + V.detour;
    this.account(V, delay);
    this.emit(why, V);
  };

  Sim.prototype.account = function (V, delay) {
    var st = this.stats, w = V.P.weight;
    st.done++; st.sumW += w; st.sumWD += w * delay;
    if (V.entry >= 0) { st.perEntry[V.entry].delay += delay; st.perEntry[V.entry].out++; }
    else { st.tram.delay += delay; st.tram.out++; }
    st.liveDelay = st.sumWD / st.sumW;
  };

  /* ---------- collisions ---------- */
  var _a = {}, _b = {};
  function overlap(A, B) {
    var na = A.len > 1 ? 6 : 3, nb = B.len > 1 ? 6 : 3, ra = A.P.w * 0.5, rb = B.P.w * 0.5, rr = (ra + rb) * 0.92;
    rr *= rr;
    for (var i = 0; i < na; i++) {
      bodyPos(A, ra + (A.len - 2 * ra) * i / (na - 1), _a);
      for (var j = 0; j < nb; j++) {
        bodyPos(B, rb + (B.len - 2 * rb) * j / (nb - 1), _b);
        var dx = _a.x - _b.x, dy = _a.y - _b.y;
        if (dx * dx + dy * dy < rr) return true;
      }
    }
    return false;
  }

  Sim.prototype.collide = function () {
    var nodes = this.net.nodes;
    for (var ni = 0; ni < nodes.length; ni++) {
      var segs = nodes[ni].internal;
      for (var si = 0; si < segs.length; si++) {
        var S = segs[si];
        if (!S.veh.length && !S.tails.length) continue;
        for (var ci = 0; ci < S.conflicts.length; ci++) {
          var F = S.conflicts[ci].foe;
          if (F.id < S.id || (!F.veh.length && !F.tails.length)) continue;
          for (var x = 0; x < S.veh.length + S.tails.length; x++) {
            var A = x < S.veh.length ? S.veh[x] : S.tails[x - S.veh.length];
            for (var y = 0; y < F.veh.length + F.tails.length; y++) {
              var B = y < F.veh.length ? F.veh[y] : F.tails[y - F.veh.length];
              if (A === B || (A.crashed && B.crashed) || A.gone || B.gone) continue;
              if (A.touch && A.touch[B.id]) continue;
              if (!overlap(A, B)) continue;
              if ((A.v < 0.2 && B.v < 0.2) || A.squeeze > 0 || B.squeeze > 0) {
                (A.touch || (A.touch = {}))[B.id] = true; (B.touch || (B.touch = {}))[A.id] = true;
                continue;
              }
              this.crash(A, B);
            }
          }
        }
      }
    }
  };

  Sim.prototype.crash = function (A, B) {
    var st = this.stats, tram = A.type === 'tram' || B.type === 'tram';
    if (tram) st.tramCrashes++; else st.crashes++;
    bodyPos(A, 0, _a); bodyPos(B, 0, _b);
    this.emit('crash', (_a.x + _b.x) / 2, (_a.y + _b.y) / 2, tram);
    [A, B].forEach(function (V) {
      if (!V.crashed) { V.crashed = true; V.crashT = CRASH_TIME; }
      V.v = 0; V.a = 0;
    });
  };

  /* ---------- trains ---------- */
  Sim.prototype.trainStep = function () {
    var rail = this.net.rail;
    if (!rail) return;
    for (var i = 0; i < this.trains.length; i++) {
      var tr = this.trains[i], x = (this.t - tr.t0) * TRAIN.v;
      tr.x = x; // distance of the loco's nose past the crossing centre
      tr.active = x > -16 && x < TRAIN.len + 16;
      if (x > -0.45 && x < TRAIN.len + 0.45) {
        for (var k = 0; k < rail.lanes.length; k++) {
          var seg = rail.lanes[k], z = seg.rail;
          for (var j = seg.veh.length - 1; j >= 0; j--) {
            var V = seg.veh[j];
            if (V.s > z.s1 + 0.12 && V.s - V.len < z.s2 - 0.12) {
              this.stats.trainCrashes++;
              bodyPos(V, V.len / 2, _a);
              this.emit('crash', _a.x, _a.y, true);
              this.remove(V, 'towed');
            }
          }
        }
      }
    }
  };

  /* ---------- end of run ---------- */
  Sim.prototype.finish = function () {
    if (this.done) return;
    var self = this, i;
    this.unserved = 0;
    this.veh.forEach(function (V) {
      if (V.gone) return;
      self.unserved++;
      var delay = Math.max(0, self.t - V.sched - V.free * (V.d / V.route.len)) + SCORE.stuck + V.detour;
      self.account(V, delay);
    });
    for (i = 0; i < this.backlog.length; i++) {
      this.backlog[i].forEach(function (a) {
        self.unserved++;
        var w = TYPES[a.type].weight, delay = Math.max(0, self.t - a.t) + SCORE.stuck;
        self.stats.done++; self.stats.sumW += w; self.stats.sumWD += w * delay;
        self.stats.perEntry[a.entry].delay += delay; self.stats.perEntry[a.entry].out++;
      });
    }
    this.tramQueue.forEach(function (t0) {
      self.unserved++;
      var td = Math.max(0, self.t - t0) + SCORE.stuck;
      self.stats.done++; self.stats.sumW += TYPES.tram.weight; self.stats.sumWD += TYPES.tram.weight * td;
      self.stats.tram.delay += td; self.stats.tram.out++;
    });
    this.done = true;
    this.result = this.score();
  };

  Sim.prototype.score = function () {
    var st = this.stats, cost = this.net.cost.total;
    var avg = st.sumW > 0 ? st.sumWD / st.sumW : 0;
    // the worst-served road counts too: a junction that starves one approach is not a good junction
    var worst = avg, worstEntry = -1;
    st.perEntry.forEach(function (p, i) { if (p.out >= 3 && p.delay / p.out > worst) { worst = p.delay / p.out; worstEntry = i; } });
    if (st.tram.out >= 1 && st.tram.delay / st.tram.out > worst) { worst = st.tram.delay / st.tram.out; worstEntry = 'tram'; }
    var eff = avg * (1 - SCORE.worstShare) + worst * SCORE.worstShare;
    var flow = Math.round(1000 * Math.exp(-eff / SCORE.tau));
    var crashPen = SCORE.crash * st.crashes + SCORE.tramCrash * st.tramCrashes + SCORE.trainCrash * st.trainCrashes;
    return {
      score: Math.max(0, flow - crashPen - cost), flow: flow, avgDelay: Math.round(avg * 10) / 10,
      worstDelay: Math.round(worst * 10) / 10, worstEntry: worstEntry, tramDelay: st.tram.out ? Math.round(st.tram.delay / st.tram.out * 10) / 10 : null,
      crashes: st.crashes + st.tramCrashes + st.trainCrashes, crashPen: crashPen, cost: cost,
      served: st.done - (this.unserved || 0), unserved: this.unserved || 0, total: st.done, honks: st.honks,
      perEntry: st.perEntry.map(function (p) { return { n: p.out, delay: p.out ? Math.round(p.delay / p.out * 10) / 10 : 0 }; })
    };
  };

  Sim.prototype.runToEnd = function () {
    var guard = (this.level.TMAX + 5) * SUB;
    while (!this.done && guard-- > 0) this.advance();
    if (!this.done) this.finish();
    return this.result;
  };

  /* one-call evaluation used by the solver, the playtest script and "skip to result" */
  function evaluate(level, config, demand) {
    return new Sim(level, config, demand, { fx: false }).runToEnd();
  }

  R.sim = { Sim: Sim, evaluate: evaluate, TYPES: TYPES, TRAIN: TRAIN, SCORE: SCORE, SUB: SUB, DT: DT, bodyPos: bodyPos, refTimes: refTimes, CRASH_TIME: CRASH_TIME };
})(typeof globalThis !== 'undefined' ? globalThis : window);
