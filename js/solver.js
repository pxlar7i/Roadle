/* Roadle — the "city engineer": a heuristic solver that tries the standard families of
   junction control and keeps the best. Used for the daily par score, for the
   developer tools, and by tools/playtest.js to check that different junctions reward
   different kinds of control. */
(function (root) {
  'use strict';
  var R = root.Roadle, U = R.util, NET = R.net;

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* expected peak flow (veh/tick) arriving on each approach of each node, split by turn */
  function approachFlows(level) {
    var net = NET.build(level, NET.defaultConfig(level));
    var flows = level.nodes.map(function () { return [null, null, null, null]; });
    level.entries.forEach(function (from) {
      from.dests.forEach(function (dd) {
        var route = net.routes[from.id + '>' + dd.entry], q = from.rate * dd.p;
        route.segs.forEach(function (sg) {
          if (sg.kind !== 'move') return;
          var f = flows[sg.node.id][sg.fromDir] || (flows[sg.node.id][sg.fromDir] = { q: 0, L: 0, S: 0, R: 0 });
          f.q += q; f[sg.turn] += q;
        });
      });
    });
    return flows;
  }

  function sigFromStages(level, nd, stages, allRed) {
    // stages: [{dirs:[...], tram:bool, g: ticks}]
    var C = 0, rows = {}, d;
    stages.forEach(function (s) { C += s.g + allRed; });
    for (d = 0; d < 4; d++) if (nd.arms[d] >= 0) rows[d] = [];
    if (nd.tramAxis >= 0) rows.t = [];
    stages.forEach(function (s) {
      for (var k = 0; k < s.g + allRed; k++) {
        var on = k < s.g;
        Object.keys(rows).forEach(function (key) {
          var member = key === 't' ? !!s.tram : s.dirs.indexOf(+key) >= 0;
          rows[key].push(on && member);
        });
      }
    });
    return { C: C, rows: rows };
  }

  /* Base control options for one node. */
  function nodeOptions(level, ni, flows) {
    var nd = level.nodes[ni], fl = flows[ni], arms = [], opts = [], d;
    for (d = 0; d < 4; d++) if (nd.arms[d] >= 0) arms.push(d);
    function q(d) { return fl[d] ? fl[d].q : 0; }
    function appKeyFor(d) {
      var L = level.links[nd.arms[d]];
      return NET.appKey(L.id, (!L.a.edge && L.a.node === ni && L.a.dir === d) ? 'a' : 'b');
    }
    function signs(minor, kind) {
      var app = {};
      minor.forEach(function (d) { app[appKeyFor(d)] = { sign: kind }; });
      return app;
    }
    opts.push({ name: 'nothing', family: 'none', node: { type: 'plain' }, app: {} });

    // priority road candidates: the through axes plus the two busiest approaches
    var pairs = [];
    if (nd.arms[0] >= 0 && nd.arms[2] >= 0) pairs.push([0, 2]);
    if (nd.arms[1] >= 0 && nd.arms[3] >= 0) pairs.push([1, 3]);
    var byFlow = arms.slice().sort(function (a, b) { return q(b) - q(a); });
    var top = [byFlow[0], byFlow[1]].sort();
    if (!pairs.some(function (p) { return p[0] === top[0] && p[1] === top[1]; })) pairs.push(top);
    pairs.forEach(function (p) {
      var minor = arms.filter(function (d) { return p.indexOf(d) < 0; });
      if (!minor.length) return;
      var nm = U.DIR_NAMES[p[0]] + U.DIR_NAMES[p[1]];
      opts.push({ name: 'give-way (' + nm + ' priority)', family: 'giveway', node: { type: 'plain' }, app: signs(minor, 'yield') });
      opts.push({ name: 'stop signs (' + nm + ' priority)', family: 'stop', node: { type: 'plain' }, app: signs(minor, 'stop') });
    });
    // single give-way on the quietest approach (cheap)
    opts.push({ name: 'all-way stop', family: 'allway', node: { type: 'plain' }, app: signs(arms, 'stop') });
    if (NET.canPlace(level, ni, 'mini')) opts.push({ name: 'mini-roundabout', family: 'mini', node: { type: 'mini' }, app: {} });
    if (NET.canPlace(level, ni, 'rbt')) opts.push({ name: 'roundabout', family: 'roundabout', node: { type: 'rbt' }, app: {} });

    // signals
    var axisA = arms.filter(function (d) { return d % 2 === 0; }), axisB = arms.filter(function (d) { return d % 2 === 1; });
    function crit(dirs) { var m = 0.02; dirs.forEach(function (d) { if (q(d) > m) m = q(d); }); return m; }
    function split(groups, C, allRed) {
      var tot = 0, lost = groups.length * allRed;
      groups.forEach(function (g) { tot += g.crit; });
      return groups.map(function (g) {
        return { dirs: g.dirs, tram: g.tram, g: Math.max(4, Math.round((C - lost) * g.crit / tot)) };
      });
    }
    var tramAxis = nd.tramAxis;
    if (axisA.length && axisB.length) {
      [16, 22, 30, 40].forEach(function (C) {
        var st = split([{ dirs: axisA, crit: crit(axisA), tram: tramAxis === 0 }, { dirs: axisB, crit: crit(axisB), tram: tramAxis === 1 }], C, 1);
        opts.push({ name: 'lights, 2-stage, cycle ' + C, family: 'lights', node: { type: 'signal', sig: sigFromStages(level, nd, st, 1) }, app: {} });
      });
    }
    if (arms.length >= 3) {
      [24, 36, 48].forEach(function (C) {
        var groups = arms.map(function (d) { return { dirs: [d], crit: crit([d]), tram: tramAxis >= 0 && (d % 2 === 1) === (tramAxis === 1) }; });
        var st = split(groups, C, 1);
        opts.push({ name: 'lights, split phases, cycle ' + C, family: 'lights-split', node: { type: 'signal', sig: sigFromStages(level, nd, st, 1) }, app: {} });
      });
    }
    if (tramAxis >= 0 && axisA.length && axisB.length) {
      // dedicated tram stage
      [30, 42].forEach(function (C) {
        var st = split([{ dirs: axisA, crit: crit(axisA) }, { dirs: axisB, crit: crit(axisB) }, { dirs: [], crit: 0.09, tram: true }], C, 1);
        opts.push({ name: 'lights + tram stage, cycle ' + C, family: 'lights', node: { type: 'signal', sig: sigFromStages(level, nd, st, 1) }, app: {} });
      });
    }
    return opts;
  }

  function applyOption(level, cfg, ni, opt) {
    var nd = cfg.nodes[ni];
    nd.type = opt.node.type; nd.sig = opt.node.sig ? clone(opt.node.sig) : null;
    if (nd.type === 'rbt' || nd.type === 'mini') nd.box = false;
    // wipe signs on this node's approaches, keep bumps / bans
    NET.approachList(level).forEach(function (a) {
      if (a.node !== ni) return;
      var cur = cfg.app[a.key] || {};
      var o = { sign: (opt.app[a.key] && opt.app[a.key].sign) || null, bump: !!cur.bump, noL: !!cur.noL, noR: !!cur.noR };
      if (o.sign || o.bump || o.noL || o.noR) cfg.app[a.key] = o; else delete cfg.app[a.key];
    });
  }

  function modifiers(level, cfg) {
    var mods = [];
    level.nodes.forEach(function (nd, i) {
      var t = cfg.nodes[i].type;
      if (t !== 'rbt' && t !== 'mini') mods.push({ name: 'box ' + i, apply: function (c) { c.nodes[i].box = !c.nodes[i].box; } });
    });
    level.busStops.forEach(function (b) {
      mods.push({ name: 'bay ' + b.id, apply: function (c) { if (c.bays[b.id]) delete c.bays[b.id]; else c.bays[b.id] = true; } });
    });
    NET.approachList(level).forEach(function (a) {
      function tog(field) {
        return function (c) { var o = c.app[a.key] || (c.app[a.key] = { sign: null }); o[field] = !o[field]; };
      }
      var nd = level.nodes[a.node];
      mods.push({ name: 'bump ' + a.key, apply: tog('bump') });
      if (nd.arms[(a.dir + 1) % 4] >= 0) mods.push({ name: 'noL ' + a.key, apply: tog('noL') });
    });
    return mods;
  }

  function signalTweaks(level, cfg) {
    var tw = [];
    cfg.nodes.forEach(function (n, i) {
      if (n.type !== 'signal') return;
      [2, 4, 8, -2, -4].forEach(function (k) {
        tw.push({ name: 'offset ' + i + ' by ' + k, apply: function (c) {
          var s = c.nodes[i].sig;
          Object.keys(s.rows).forEach(function (key) {
            var r = s.rows[key], o = [];
            for (var t = 0; t < s.C; t++) o.push(r[((t - k) % s.C + s.C) % s.C]);
            s.rows[key] = o;
          });
        } });
      });
    });
    return tw;
  }

  /* The search, written as a generator so the browser can run it in small slices. */
  function* solveGen(level, opts) {
    opts = opts || {};
    // Like a player, the engineer designs against the practice traffic samples and only
    // then faces the official rush hour (so the par is fair, not tuned to the official run).
    var seeds = opts.seeds || ['test-A', 'test-B'];
    var demands = seeds.map(function (s) { return R.level.makeDemand(level, s); });
    var flows = approachFlows(level), evals = 0, table = [];
    var quick = !!opts.quick;

    function* score(cfg) {
      var sum = 0, first = null;
      for (var i = 0; i < demands.length; i++) {
        var r = R.sim.evaluate(level, cfg, demands[i]);
        if (!first) first = r;
        sum += r.score; evals++;
        yield null;
      }
      return { score: sum / demands.length, res: first };
    }

    var cfg = NET.defaultConfig(level), nN = level.nodes.length, ni, best, r, k;
    var options = level.nodes.map(function (nd, i) { return nodeOptions(level, i, flows); });
    var choice = [];
    // sensible starting point for multi-node levels: give-way on the first option of each node
    for (ni = 0; ni < nN; ni++) { choice.push(options[ni][Math.min(1, options[ni].length - 1)]); applyOption(level, cfg, ni, choice[ni]); }

    var rounds = nN > 1 ? 2 : 1, bestScore = -1;
    for (var round = 0; round < rounds; round++) {
      for (ni = 0; ni < nN; ni++) {
        var localBest = null;
        for (k = 0; k < options[ni].length; k++) {
          var opt = options[ni][k];
          if (quick && round > 0 && opt.family !== choice[ni].family && k > 6) continue;
          var c = clone(cfg);
          applyOption(level, c, ni, opt);
          r = yield* score(c);
          if (round === rounds - 1 || nN === 1) table.push({ node: ni, name: opt.name, family: opt.family, score: Math.round(r.score), res: r.res });
          if (!localBest || r.score > localBest.score) localBest = { score: r.score, opt: opt, cfg: c, res: r.res };
        }
        choice[ni] = localBest.opt; cfg = localBest.cfg; bestScore = localBest.score; best = localBest;
      }
    }

    // two junctions close together: also try coordinated lights at both, with a range of offsets
    if (nN === 2) {
      var cycles = quick ? [28] : [20, 28, 36];
      for (var ci = 0; ci < cycles.length; ci++) {
        var C = cycles[ci], pair = [];
        for (ni = 0; ni < nN; ni++) {
          pair.push(options[ni].filter(function (o) { return o.family === 'lights' && o.node.sig.C >= C - 5 && o.node.sig.C <= C + 5; })[0]);
        }
        if (!pair[0] || !pair[1]) continue;
        var offs = quick ? [0, 4, 8] : [0, 3, 6, 9, 12, 16];
        for (var oi = 0; oi < offs.length; oi++) {
          var cj = clone(cfg);
          applyOption(level, cj, 0, pair[0]); applyOption(level, cj, 1, pair[1]);
          var s1 = cj.nodes[1].sig, s0 = cj.nodes[0].sig, off = offs[oi];
          // same cycle length at both so the offset holds
          if (s1.C !== s0.C) continue;
          Object.keys(s1.rows).forEach(function (key) {
            var rr = s1.rows[key], o = [];
            for (var t = 0; t < s1.C; t++) o.push(rr[((t - off) % s1.C + s1.C) % s1.C]);
            s1.rows[key] = o;
          });
          r = yield* score(cj);
          table.push({ node: 0, name: 'coordinated lights C' + s0.C + ' offset ' + off, family: 'lights-both', score: Math.round(r.score), res: r.res });
          if (r.score > bestScore) { bestScore = r.score; cfg = cj; best = { score: r.score, cfg: cj, res: r.res }; choice[0] = pair[0]; choice[1] = pair[1]; }
        }
      }
    }

    // refinements: paint, bays, bumps, turn bans, signal offsets — keep whatever helps
    var improved = true, passes = 0;
    while (improved && passes++ < (quick ? 1 : 2)) {
      improved = false;
      var mods = modifiers(level, cfg).concat(signalTweaks(level, cfg));
      for (k = 0; k < mods.length; k++) {
        var c2 = clone(cfg);
        mods[k].apply(c2);
        c2 = NET.normConfig(level, c2);
        r = yield* score(c2);
        if (r.score > bestScore + 1) { bestScore = r.score; cfg = c2; best = { score: r.score, cfg: c2, res: r.res }; improved = true; }
      }
    }
    cfg = NET.normConfig(level, cfg);
    var fam = choice.map(function (o) { return o.family; });
    var official = R.sim.evaluate(level, cfg, R.level.makeDemand(level, 'official'));
    return { config: cfg, score: Math.round(bestScore), res: best.res, official: official, families: fam, names: choice.map(function (o) { return o.name; }), table: table, evals: evals };
  }

  function solve(level, opts) {
    var g = solveGen(level, opts), s = g.next();
    while (!s.done) s = g.next();
    return s.value;
  }

  /* Run the solver a few milliseconds at a time (browser). */
  function Job(level, opts) { this.gen = solveGen(level, opts); this.result = null; this.done = false; }
  Job.prototype.step = function (budgetMs) {
    var t0 = Date.now();
    while (!this.done && Date.now() - t0 < budgetMs) {
      var s = this.gen.next();
      if (s.done) { this.done = true; this.result = s.value; }
    }
    return this.done;
  };

  R.solver = { solve: solve, Job: Job, nodeOptions: nodeOptions, approachFlows: approachFlows, sigFromStages: sigFromStages, applyOption: applyOption };
})(typeof globalThis !== 'undefined' ? globalThis : window);
