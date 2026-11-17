/* Roadle — canvas renderer. Draws in world units (1 unit = 1 grid tile).
   A static layer (ground, roads, buildings) is cached and redrawn only when the
   junction design changes; vehicles, lights, trees and effects are drawn every frame. */
(function (root) {
  'use strict';
  var R = root.Roadle, U = R.util, NET = R.net;
  var TAU = Math.PI * 2;

  var THEMES = [
    { ground: '#cfe6b8', patch: '#c3dfa9', tree: ['#6fbf73', '#8fd18a', '#57a773'], water: '#8fd3f4', dot: 'rgba(60,90,50,0.10)' },
    { ground: '#c5ead9', patch: '#b6e2cd', tree: ['#4fb39a', '#7fd1b9', '#3d9c86'], water: '#8fd3f4', dot: 'rgba(40,90,80,0.10)' },
    { ground: '#f3e3b3', patch: '#ecd9a0', tree: ['#9bc46b', '#b8d98a', '#7fae58'], water: '#9ad8e8', dot: 'rgba(110,90,40,0.10)' },
    { ground: '#f8d9c0', patch: '#f3cdb0', tree: ['#f0a35e', '#f7c08a', '#8fbf6f'], water: '#9ad8e8', dot: 'rgba(120,70,40,0.10)' },
    { ground: '#f6d0d8', patch: '#f0c2cc', tree: ['#e88fa6', '#f4b6c5', '#8cc084'], water: '#a5d8f3', dot: 'rgba(120,50,70,0.10)' },
    { ground: '#ddd3f2', patch: '#d1c5ec', tree: ['#a48be0', '#c3b1ee', '#7fc8a9'], water: '#a5d8f3', dot: 'rgba(70,50,120,0.10)' },
    { ground: '#cfe3f7', patch: '#bfd8f2', tree: ['#6fb2e8', '#9bcdf2', '#7fc8a9'], water: '#7fc4ee', dot: 'rgba(40,70,120,0.10)' }
  ];
  var ROAD = '#666b82', ROAD_EDGE = '#51556a', MARK = '#fff4d8', SHADOW = 'rgba(40,35,60,0.20)';
  var CAR_COLORS = ['#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#4dabf7', '#9775fa', '#f783ac', '#f8f9fa'];
  var BUS_COLORS = ['#ff922b', '#20c997'];
  var HOUSE = [['#ff8787', '#fa5252'], ['#ffc078', '#ff922b'], ['#ffe066', '#fcc419'], ['#74c0fc', '#4dabf7'], ['#b197fc', '#9775fa'], ['#faa2c1', '#f06595']];
  var ENTRY_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#b197fc', '#ff922b'];
  var SIG = ['#ff5a5a', '#52e07a', '#ffc53d']; // red, green, amber (indexed by NET state)

  function Renderer(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d');
    this.staticCv = document.createElement('canvas');
    this.mirror = false; this.level = null; this.net = null;
    this.parts = []; this.pops = {}; this.shake = 0; this.time = 0;
    this.px = 600; this.dpr = 1;
    this.debug = { paths: false, zones: false, ids: false };
    this.barrier = 0; this.smokeT = 0;
  }

  Renderer.prototype.resize = function (cssPx) {
    var dpr = Math.min(2.5, window.devicePixelRatio || 1);
    this.dpr = dpr; this.css = cssPx; this.px = Math.round(cssPx * dpr);
    this.cv.width = this.px; this.cv.height = this.px;
    this.cv.style.width = cssPx + 'px'; this.cv.style.height = cssPx + 'px';
    this.staticCv.width = this.px; this.staticCv.height = this.px;
    this.dirty = true;
  };
  Renderer.prototype.setLevel = function (level) { this.level = level; this.theme = THEMES[level.theme % THEMES.length]; this.dirty = true; this.parts = []; };
  Renderer.prototype.setNet = function (net) { this.net = net; this.dirty = true; };
  Renderer.prototype.setMirror = function (m) { this.mirror = m; this.dirty = true; };

  Renderer.prototype.world = function (ctx) {
    var s = this.px / this.level.N;
    if (this.mirror) ctx.setTransform(-s, 0, 0, s, this.px, 0); else ctx.setTransform(s, 0, 0, s, 0, 0);
  };
  // screen px (css) → world coords
  Renderer.prototype.toWorld = function (cx, cy) {
    var s = this.css / this.level.N, x = cx / s, y = cy / s;
    if (this.mirror) x = this.level.N - x;
    return { x: x, y: y };
  };
  Renderer.prototype.text = function (ctx, str, x, y, size, color, weight) {
    ctx.save(); ctx.translate(x, y);
    if (this.mirror) ctx.scale(-1, 1);
    ctx.font = (weight || '800') + ' ' + size + 'px "Nunito", "Baloo 2", "Trebuchet MS", system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
    ctx.fillText(str, 0, 0.02 * size);
    ctx.restore();
  };

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }
  function strokePath(ctx, p, from, to) {
    var i0 = Math.max(0, Math.floor((from || 0) / p.ds)), i1 = to == null ? p.n - 1 : Math.min(p.n - 1, Math.ceil(to / p.ds));
    ctx.beginPath(); ctx.moveTo(p.x[i0], p.y[i0]);
    for (var i = i0 + 1; i <= i1; i++) ctx.lineTo(p.x[i], p.y[i]);
    ctx.stroke();
  }
  function shade(hex, f) { // f<1 darker, >1 lighter
    var n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    function c(v) { v = f <= 1 ? v * f : v + (255 - v) * (f - 1); return Math.max(0, Math.min(255, Math.round(v))); }
    return 'rgb(' + c(r) + ',' + c(g) + ',' + c(b) + ')';
  }

  /* ================= static layer ================= */
  Renderer.prototype.drawStatic = function () {
    var ctx = this.staticCv.getContext('2d'), L = this.level, net = this.net, th = this.theme, N = L.N, self = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = th.ground; ctx.fillRect(0, 0, this.px, this.px);
    this.world(ctx);
    var rng = U.makeRng(L.id + ':paint'), i, k;

    // soft ground patches and grid dots
    ctx.fillStyle = th.patch;
    for (i = 0; i < 16; i++) {
      var px = rng.range(0, N), py = rng.range(0, N), pr = rng.range(0.6, 1.8);
      ctx.beginPath(); ctx.ellipse(px, py, pr, pr * rng.range(0.5, 0.9), rng.range(0, 3), 0, TAU); ctx.fill();
    }
    ctx.fillStyle = th.dot;
    for (i = 0; i <= N; i++) for (k = 0; k <= N; k++) { ctx.beginPath(); ctx.arc(i, k, 0.035, 0, TAU); ctx.fill(); }

    // water, flowers
    L.scenery.forEach(function (s) {
      if (s.type === 'pond') {
        var r2 = U.makeRng(s.seed);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.beginPath(); ctx.ellipse(s.c + 1, s.r + 1, 0.93, 0.8, r2.range(-0.4, 0.4), 0, TAU); ctx.fill();
        ctx.fillStyle = th.water;
        ctx.beginPath(); ctx.ellipse(s.c + 1, s.r + 1, 0.84, 0.71, r2.range(-0.4, 0.4), 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.03; ctx.lineCap = 'round';
        for (var q = 0; q < 3; q++) { var wx = s.c + 1 + r2.range(-0.45, 0.45), wy = s.r + 1 + r2.range(-0.35, 0.35); ctx.beginPath(); ctx.moveTo(wx - 0.1, wy); ctx.lineTo(wx + 0.1, wy); ctx.stroke(); }
      } else if (s.type === 'flowers') {
        var r3 = U.makeRng(s.seed);
        for (var f = 0; f < 5; f++) {
          var fx = s.c + r3.range(0.15, 0.85), fy = s.r + r3.range(0.15, 0.85);
          ctx.fillStyle = r3.pick(['#ffffff', '#ffd43b', '#ff8fab', '#ffa94d']);
          ctx.beginPath(); ctx.arc(fx, fy, 0.045, 0, TAU); ctx.fill();
        }
      }
    });

    // railway
    if (L.rail) {
      var v = L.rail.vertical, c0 = L.rail.idx + 0.5;
      ctx.fillStyle = '#c9c1b2';
      if (v) ctx.fillRect(c0 - 0.24, -1, 0.48, N + 2); else ctx.fillRect(-1, c0 - 0.24, N + 2, 0.48);
      ctx.fillStyle = '#9a7b5f';
      for (var t = -0.9; t < N + 1; t += 0.22) { if (v) ctx.fillRect(c0 - 0.19, t, 0.38, 0.09); else ctx.fillRect(t, c0 - 0.19, 0.09, 0.38); }
      ctx.fillStyle = '#eef0f4';
      if (v) { ctx.fillRect(c0 - 0.125, -1, 0.04, N + 2); ctx.fillRect(c0 + 0.085, -1, 0.04, N + 2); }
      else { ctx.fillRect(-1, c0 - 0.125, N + 2, 0.04); ctx.fillRect(-1, c0 + 0.085, N + 2, 0.04); }
    }

    // roads: casing then surface
    ctx.lineCap = 'butt'; ctx.lineJoin = 'round';
    function roads(extra, color) {
      ctx.strokeStyle = color; ctx.fillStyle = color;
      net.links.forEach(function (li) { ctx.lineWidth = li.width + extra; strokePath(ctx, li.centre); });
      net.nodes.forEach(function (nd) {
        if (nd.type === 'rbt') {
          ctx.beginPath(); ctx.arc(nd.cx, nd.cy, 1.24 + extra / 2, 0, TAU); ctx.fill();
          for (var d = 0; d < 4; d++) {
            var lk = nd.level.arms[d]; if (lk < 0) continue;
            ctx.lineWidth = net.links[lk].width + extra + 0.12;
            ctx.beginPath(); ctx.moveTo(nd.cx + U.DX[d] * 1.1, nd.cy + U.DY[d] * 1.1); ctx.lineTo(nd.cx + U.DX[d] * 1.52, nd.cy + U.DY[d] * 1.52); ctx.stroke();
          }
          return;
        }
        var w = 0;
        for (var d2 = 0; d2 < 4; d2++) {
          var lk2 = nd.level.arms[d2]; if (lk2 < 0) continue;
          var ww = net.links[lk2].width + extra; if (ww > w) w = ww;
          ctx.lineWidth = ww;
          ctx.beginPath(); ctx.moveTo(nd.cx, nd.cy); ctx.lineTo(nd.cx + U.DX[d2] * 0.52, nd.cy + U.DY[d2] * 0.52); ctx.stroke();
        }
        ctx.fillRect(nd.cx - w / 2, nd.cy - w / 2, w, w);
        // rounded inner corners
        ctx.lineWidth = 0.36 + extra;
        nd.moves.forEach(function (m) { if (m.kind === 'move' && m.turn === 'R') strokePath(ctx, m.path); });
      });
    }
    roads(0.09, ROAD_EDGE); roads(0, ROAD);

    // lane markings
    ctx.strokeStyle = MARK; ctx.lineWidth = 0.035; ctx.setLineDash([0.17, 0.17]);
    net.links.forEach(function (li) { if (!li.level.tram) strokePath(ctx, li.centre, 0.12, li.centre.len - 0.12); });
    ctx.setLineDash([]);

    // level crossing surface over the road
    if (net.rail) {
      var rl = net.rail, li2 = net.links[L.rail.link];
      ctx.fillStyle = '#8f8a99';
      var hw = li2.width / 2 + 0.02;
      if (rl.vertical) ctx.fillRect(rl.x - 0.24, rl.y - hw, 0.48, hw * 2); else ctx.fillRect(rl.x - hw, rl.y - 0.24, hw * 2, 0.48);
      ctx.fillStyle = '#eef0f4';
      if (rl.vertical) { ctx.fillRect(rl.x - 0.125, rl.y - hw, 0.04, hw * 2); ctx.fillRect(rl.x + 0.085, rl.y - hw, 0.04, hw * 2); }
      else { ctx.fillRect(rl.x - hw, rl.y - 0.125, hw * 2, 0.04); ctx.fillRect(rl.x - hw, rl.y + 0.085, hw * 2, 0.04); }
    }

    // tram tracks
    if (net.tramRoute) {
      net.tramRoute.segs.forEach(function (sg) {
        ctx.strokeStyle = '#7b8098'; ctx.lineWidth = 0.22; strokePath(ctx, sg.path);
      });
      net.tramRoute.segs.forEach(function (sg) {
        ctx.strokeStyle = '#d9dce8'; ctx.lineWidth = 0.028;
        var pts = [], p = sg.path, j;
        [-0.065, 0.065].forEach(function (o) {
          ctx.beginPath();
          for (j = 0; j < p.n; j++) {
            var a = Math.max(0, j - 1), b = Math.min(p.n - 1, j + 1), tx = p.x[b] - p.x[a], ty = p.y[b] - p.y[a], l = Math.sqrt(tx * tx + ty * ty) || 1;
            var x = p.x[j] - ty / l * o, y = p.y[j] + tx / l * o;
            if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.stroke();
        });
      });
    }

    // junction furniture painted on the road
    net.nodes.forEach(function (nd) {
      if (nd.type === 'rbt') {
        ctx.strokeStyle = MARK; ctx.lineWidth = 0.03; ctx.setLineDash([0.12, 0.12]);
        ctx.beginPath(); ctx.arc(nd.cx, nd.cy, 1.17, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = '#f4f1e6'; ctx.beginPath(); ctx.arc(nd.cx, nd.cy, 0.56, 0, TAU); ctx.fill();
        ctx.fillStyle = th.tree[1]; ctx.beginPath(); ctx.arc(nd.cx, nd.cy, 0.48, 0, TAU); ctx.fill();
        var fr = U.makeRng(L.id + ':isl' + nd.id);
        for (var f = 0; f < 9; f++) {
          var an = fr.range(0, TAU), rad = fr.range(0.1, 0.4);
          ctx.fillStyle = fr.pick(['#fff', '#ffd43b', '#ff8fab']);
          ctx.beginPath(); ctx.arc(nd.cx + Math.cos(an) * rad, nd.cy + Math.sin(an) * rad, 0.04, 0, TAU); ctx.fill();
        }
      } else if (nd.type === 'mini') {
        ctx.fillStyle = '#f8f6ee'; ctx.beginPath(); ctx.arc(nd.cx, nd.cy, 0.105, 0, TAU); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 0.03; ctx.lineCap = 'round';
        for (var a3 = 0; a3 < 3; a3++) {
          var st = a3 * TAU / 3;
          ctx.beginPath(); ctx.arc(nd.cx, nd.cy, 0.2, st, st + 1.2, true); ctx.stroke();
        }
        ctx.lineCap = 'butt';
      }
      if (nd.box) {
        ctx.save();
        var bw = 0;
        for (var d = 0; d < 4; d++) { var lk = nd.level.arms[d]; if (lk >= 0 && net.links[lk].width > bw) bw = net.links[lk].width; }
        var h = bw / 2 - 0.03;
        ctx.beginPath(); ctx.rect(nd.cx - h, nd.cy - h, 2 * h, 2 * h); ctx.clip();
        ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 0.028;
        for (var o = -2; o <= 2; o += 0.13) {
          ctx.beginPath(); ctx.moveTo(nd.cx + o - 1, nd.cy - 1); ctx.lineTo(nd.cx + o + 1, nd.cy + 1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(nd.cx + o + 1, nd.cy - 1); ctx.lineTo(nd.cx + o - 1, nd.cy + 1); ctx.stroke();
        }
        ctx.restore();
        ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 0.04; ctx.strokeRect(nd.cx - h, nd.cy - h, 2 * h, 2 * h);
      }
    });

    // stop lines, speed bumps, bus stops
    var P = {};
    net.segs.forEach(function (sg) {
      if (sg.kind !== 'lane') return;
      if (sg.app && !(sg.app.node.type === 'signal')) {
        NET.posAt(sg.path, sg.len - 0.03, P);
        var nx = -Math.sin(P.a), ny = Math.cos(P.a);
        ctx.strokeStyle = MARK; ctx.lineWidth = 0.045;
        if (sg.app.sign === 'yield' || sg.app.node.type === 'rbt' || sg.app.node.type === 'mini') ctx.setLineDash([0.06, 0.05]);
        ctx.beginPath(); ctx.moveTo(P.x - nx * 0.13, P.y - ny * 0.13); ctx.lineTo(P.x + nx * 0.13, P.y + ny * 0.13); ctx.stroke();
        ctx.setLineDash([]);
      }
      sg.zones.forEach(function (z) {
        if (!z.bump) return;
        for (var q = 0; q < 3; q++) {
          NET.posAt(sg.path, z.s1 + 0.08 + q * 0.09, P);
          var bx = -Math.sin(P.a), by = Math.cos(P.a);
          ctx.strokeStyle = q % 2 ? '#3d4050' : '#ffd43b'; ctx.lineWidth = 0.085;
          ctx.beginPath(); ctx.moveTo(P.x - bx * 0.15, P.y - by * 0.15); ctx.lineTo(P.x + bx * 0.15, P.y + by * 0.15); ctx.stroke();
        }
      });
      sg.stops.forEach(function (bs) {
        NET.posAt(sg.path, bs.s - 0.38, P);
        ctx.save(); ctx.translate(P.x, P.y); ctx.rotate(P.a);
        if (bs.bay) {
          ctx.fillStyle = ROAD_EDGE; rr(ctx, -0.62, 0.1, 1.24, 0.37, 0.16); ctx.fill();
          ctx.fillStyle = ROAD; rr(ctx, -0.58, 0.08, 1.16, 0.35, 0.14); ctx.fill();
          ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 0.025; ctx.setLineDash([0.07, 0.05]);
          ctx.strokeRect(-0.45, 0.17, 0.9, 0.22); ctx.setLineDash([]);
        } else {
          ctx.strokeStyle = '#ffd43b'; ctx.lineWidth = 0.025; ctx.setLineDash([0.07, 0.05]);
          ctx.strokeRect(-0.45, -0.12, 0.9, 0.24); ctx.setLineDash([]);
        }
        // shelter beside the road
        var sy = bs.bay ? 0.56 : 0.34;
        ctx.fillStyle = SHADOW; rr(ctx, -0.26, sy + 0.03, 0.56, 0.2, 0.05); ctx.fill();
        ctx.fillStyle = '#e7f5ff'; rr(ctx, -0.28, sy, 0.56, 0.2, 0.05); ctx.fill();
        ctx.fillStyle = '#4dabf7'; rr(ctx, -0.28, sy, 0.56, 0.07, 0.03); ctx.fill();
        ctx.fillStyle = '#ffd43b'; ctx.beginPath(); ctx.arc(0.38, sy + 0.08, 0.07, 0, TAU); ctx.fill();
        ctx.fillStyle = '#3d4050'; ctx.beginPath(); ctx.arc(0.38, sy + 0.08, 0.03, 0, TAU); ctx.fill();
        ctx.restore();
      });
    });

    // buildings
    L.scenery.forEach(function (s) {
      if (s.type === 'house') {
        var col = HOUSE[s.hue], w = s.rot ? s.h : s.w, h = s.rot ? s.w : s.h;
        var x = s.c + 0.5 + s.ox - w / 2, y = s.r + 0.5 + s.oy - h / 2;
        ctx.fillStyle = SHADOW; rr(ctx, x + 0.05, y + 0.07, w, h, 0.07); ctx.fill();
        ctx.fillStyle = '#fff8ec'; rr(ctx, x - 0.02, y - 0.02, w + 0.04, h + 0.04, 0.08); ctx.fill();
        ctx.fillStyle = col[0]; rr(ctx, x, y, w, h, 0.06); ctx.fill();
        ctx.fillStyle = col[1];
        if (s.rot) { rr(ctx, x + w / 2, y, w / 2, h, 0.06); ctx.fill(); ctx.fillRect(x + w / 2, y + 0.03, 0.03, h - 0.06); }
        else { rr(ctx, x, y + h / 2, w, h / 2, 0.06); ctx.fill(); ctx.fillRect(x + 0.03, y + h / 2, w - 0.06, 0.03); }
        ctx.fillStyle = '#fff8ec'; ctx.fillRect(x + w * 0.68, y + h * 0.2, 0.08, 0.08);
        ctx.fillStyle = '#8a6f57'; ctx.fillRect(x + w * 0.68 + 0.015, y + h * 0.2 + 0.015, 0.05, 0.05);
      } else if (s.type === 'tower' || s.type === 'shop') {
        var tall = s.type === 'tower', cl = HOUSE[s.hue];
        var m = tall ? 0.06 : 0.14, bx = s.c + m, by = s.r + m, bs2 = 1 - 2 * m;
        ctx.fillStyle = tall ? 'rgba(40,35,60,0.28)' : SHADOW; rr(ctx, bx + (tall ? 0.1 : 0.05), by + (tall ? 0.14 : 0.07), bs2, bs2, 0.08); ctx.fill();
        ctx.fillStyle = tall ? shade(cl[1], 0.82) : '#fff8ec'; rr(ctx, bx, by, bs2, bs2, 0.08); ctx.fill();
        ctx.fillStyle = tall ? cl[0] : cl[0]; rr(ctx, bx + 0.05, by + 0.05, bs2 - 0.1, bs2 - 0.1, 0.06); ctx.fill();
        if (tall) {
          ctx.fillStyle = shade(cl[0], 1.35); rr(ctx, bx + 0.12, by + 0.12, bs2 - 0.24, bs2 - 0.24, 0.05); ctx.fill();
          ctx.fillStyle = '#dee2e6'; rr(ctx, bx + 0.2, by + 0.2, 0.16, 0.12, 0.02); ctx.fill(); rr(ctx, bx + bs2 - 0.38, by + bs2 - 0.36, 0.2, 0.14, 0.02); ctx.fill();
        } else {
          ctx.fillStyle = '#fff'; for (var a4 = 0; a4 < 4; a4++) ctx.fillRect(bx + 0.08 + a4 * (bs2 - 0.16) / 4, by + bs2 - 0.16, (bs2 - 0.16) / 8, 0.1);
          ctx.fillStyle = cl[1]; rr(ctx, bx + 0.16, by + 0.14, bs2 - 0.32, 0.18, 0.04); ctx.fill();
        }
      } else if (s.type === 'garden') {
        ctx.fillStyle = shade(th.tree[0], 0.85); rr(ctx, s.c + 0.12, s.r + 0.12, 0.76, 0.76, 0.12); ctx.fill();
        ctx.fillStyle = th.patch; rr(ctx, s.c + 0.2, s.r + 0.2, 0.6, 0.6, 0.08); ctx.fill();
        var gr = U.makeRng(L.id + ':g' + s.c + s.r);
        for (var g = 0; g < 7; g++) { ctx.fillStyle = gr.pick(['#fff', '#ffd43b', '#ff8fab', '#ffa94d']); ctx.beginPath(); ctx.arc(s.c + gr.range(0.28, 0.72), s.r + gr.range(0.28, 0.72), 0.04, 0, TAU); ctx.fill(); }
      }
    });
    this.dirty = false;
  };

  /* ================= vehicles ================= */
  var _f = {}, _r = {};
  function routePos(V, dist, out) { // position at absolute distance along the vehicle's route
    var rt = V.route, i = V.ri;
    while (i > 0 && rt.cum[i] > dist) i--;
    return NET.posAt(rt.segs[i].path, dist - rt.cum[i], out);
  }

  Renderer.prototype.drawVehicle = function (ctx, V, alpha, shadowPass) {
    var d = V.pd + (V.d - V.pd) * alpha, P = V.P, len = V.len, w = P.w;
    if (V.type === 'tram') return this.drawTram(ctx, V, d, shadowPass);
    routePos(V, d, _f); routePos(V, d - len, _r);
    var x = (_f.x + _r.x) / 2, y = (_f.y + _r.y) / 2, a = Math.atan2(_f.y - _r.y, _f.x - _r.x);
    if (V.lat > 0) { var e = U.ease.inOut(V.lat) * 0.3; x += -Math.sin(a) * e; y += Math.cos(a) * e; }
    var wob = 0;
    if (V.crashed) { wob = Math.sin(this.time * 30 + V.id) * 0.05 * Math.min(1, V.crashT / 4); a += 0.35 * ((V.id % 2) ? 1 : -1) + wob; }
    if (shadowPass) {
      ctx.save(); ctx.translate(x + 0.035 * (this.mirror ? -1 : 1), y + 0.055); ctx.rotate(a);
      ctx.fillStyle = SHADOW; rr(ctx, -len / 2, -w / 2, len, w, 0.07); ctx.fill(); ctx.restore();
      return;
    }
    ctx.save(); ctx.translate(x, y); ctx.rotate(a);
    // gentle squash when braking / stretch when pulling away
    var sq = U.clamp(V.a * 0.06, -0.05, 0.05);
    ctx.scale(1 + sq, 1 - sq);
    var body, roof;
    if (V.type === 'car') {
      body = CAR_COLORS[V.hue % 8]; roof = shade(body, 0.86);
      ctx.fillStyle = body; rr(ctx, -len / 2, -w / 2, len, w, 0.075); ctx.fill();
      ctx.fillStyle = roof; rr(ctx, -len * 0.26, -w * 0.36, len * 0.44, w * 0.72, 0.045); ctx.fill();
      ctx.fillStyle = '#3d4663'; rr(ctx, len * 0.1, -w * 0.33, len * 0.13, w * 0.66, 0.03); ctx.fill();   // windscreen
      ctx.fillStyle = 'rgba(61,70,99,0.75)'; rr(ctx, -len * 0.31, -w * 0.3, len * 0.07, w * 0.6, 0.02); ctx.fill();
    } else if (V.type === 'truck') {
      ctx.fillStyle = '#f1f3f5'; rr(ctx, -len / 2, -w / 2, len * 0.7, w, 0.04); ctx.fill();
      ctx.fillStyle = '#dee2e6'; rr(ctx, -len / 2 + 0.03, -w / 2 + 0.03, len * 0.7 - 0.06, w - 0.06, 0.03); ctx.fill();
      body = CAR_COLORS[V.hue % 7];
      ctx.fillStyle = body; rr(ctx, len * 0.22, -w * 0.46, len * 0.28, w * 0.92, 0.05); ctx.fill();
      ctx.fillStyle = '#3d4663'; rr(ctx, len * 0.36, -w * 0.36, len * 0.08, w * 0.72, 0.02); ctx.fill();
    } else { // bus
      body = BUS_COLORS[V.hue % 2];
      ctx.fillStyle = body; rr(ctx, -len / 2, -w / 2, len, w, 0.07); ctx.fill();
      ctx.fillStyle = shade(body, 1.35); rr(ctx, -len * 0.42, -w * 0.3, len * 0.78, w * 0.6, 0.04); ctx.fill();
      ctx.fillStyle = '#3d4663'; rr(ctx, len * 0.39, -w * 0.38, len * 0.07, w * 0.76, 0.02); ctx.fill();
      ctx.fillStyle = 'rgba(61,70,99,0.55)';
      for (var q = 0; q < 4; q++) { ctx.fillRect(-len * 0.36 + q * len * 0.17, -w * 0.5, len * 0.1, 0.025); ctx.fillRect(-len * 0.36 + q * len * 0.17, w * 0.5 - 0.025, len * 0.1, 0.025); }
    }
    // lights
    ctx.fillStyle = '#fffbe0';
    ctx.beginPath(); ctx.arc(len / 2 - 0.02, -w * 0.3, 0.022, 0, TAU); ctx.arc(len / 2 - 0.02, w * 0.3, 0.022, 0, TAU); ctx.fill();
    if (V.brake) {
      ctx.fillStyle = '#ff3b3b';
      ctx.fillRect(-len / 2 - 0.005, -w * 0.42, 0.035, 0.06); ctx.fillRect(-len / 2 - 0.005, w * 0.42 - 0.06, 0.035, 0.06);
    }
    var bl = this.blinker(V);
    if (bl && (Math.floor(this.time * 3.2 + V.id * 0.37) % 2 === 0)) {
      var side = bl === 'R' ? 1 : -1; // sim drives on the right; a mirrored canvas flips it for left-hand traffic
      ctx.fillStyle = '#ffa500';
      ctx.beginPath(); ctx.arc(len / 2 - 0.03, side * w * 0.46, 0.032, 0, TAU); ctx.arc(-len / 2 + 0.03, side * w * 0.46, 0.032, 0, TAU); ctx.fill();
    }
    ctx.restore();
    if (this.debug.ids) this.text(ctx, String(V.id), x, y - 0.2, 0.16, '#000', '700');
  };

  Renderer.prototype.blinker = function (V) {
    if (V.crashed) return (Math.floor(this.time * 4) % 2) ? 'L' : 'R';
    var segs = V.route.segs, sg = segs[V.ri];
    if (V.inBay || V.dwell > 0) return 'R';
    if (sg.kind === 'move') return sg.turn === 'S' ? null : sg.turn;
    if (sg.kind === 'exit') return 'R';
    if (sg.kind === 'ring' || sg.kind === 'entry') { var nx = segs[V.ri + 1]; return nx && nx.kind === 'exit' ? 'R' : (sg.kind === 'entry' ? null : 'L'); }
    if (sg.kind === 'lane' && sg.app && sg.len - V.s < 2.2) {
      var nxt = segs[V.ri + 1];
      if (nxt.kind === 'move' && nxt.turn !== 'S') return nxt.turn;
      if (nxt.kind === 'entry') { var ex = segs[V.ri + 3]; return ex && ex.kind === 'exit' ? 'R' : null; }
    }
    return null;
  };

  Renderer.prototype.drawTram = function (ctx, V, d, shadowPass) {
    var parts = [[0, 0.82], [0.88, 1.7]], w = V.P.w;
    for (var i = 0; i < 2; i++) {
      routePos(V, d - parts[i][0], _f); routePos(V, d - parts[i][1], _r);
      var x = (_f.x + _r.x) / 2, y = (_f.y + _r.y) / 2, a = Math.atan2(_f.y - _r.y, _f.x - _r.x), len = parts[i][1] - parts[i][0];
      if (V.crashed) a += Math.sin(this.time * 30) * 0.02;
      ctx.save();
      if (shadowPass) { ctx.translate(x + 0.035 * (this.mirror ? -1 : 1), y + 0.055); ctx.rotate(a); ctx.fillStyle = SHADOW; rr(ctx, -len / 2, -w / 2, len, w, 0.08); ctx.fill(); ctx.restore(); continue; }
      ctx.translate(x, y); ctx.rotate(a);
      ctx.fillStyle = '#fff3d6'; rr(ctx, -len / 2, -w / 2, len, w, 0.08); ctx.fill();
      ctx.fillStyle = '#e8590c'; rr(ctx, -len / 2 + 0.03, -w * 0.2, len - 0.06, w * 0.4, 0.04); ctx.fill();
      ctx.fillStyle = '#3d4663';
      if (i === 0) { rr(ctx, len / 2 - 0.1, -w * 0.38, 0.06, w * 0.76, 0.02); ctx.fill(); }
      else { rr(ctx, -len / 2 + 0.04, -w * 0.38, 0.06, w * 0.76, 0.02); ctx.fill(); }
      ctx.fillStyle = 'rgba(61,70,99,0.55)';
      for (var q = 0; q < 4; q++) { ctx.fillRect(-len * 0.38 + q * len * 0.2, -w * 0.5, len * 0.11, 0.025); ctx.fillRect(-len * 0.38 + q * len * 0.2, w * 0.5 - 0.025, len * 0.11, 0.025); }
      if (i === 0) { // pantograph
        ctx.strokeStyle = '#495057'; ctx.lineWidth = 0.022;
        ctx.beginPath(); ctx.moveTo(-0.12, 0); ctx.lineTo(0, -0.07); ctx.lineTo(0.12, 0); ctx.lineTo(0, 0.07); ctx.closePath(); ctx.stroke();
        ctx.fillStyle = '#fffbe0'; ctx.beginPath(); ctx.arc(len / 2 - 0.02, -w * 0.3, 0.022, 0, TAU); ctx.arc(len / 2 - 0.02, w * 0.3, 0.022, 0, TAU); ctx.fill();
      }
      ctx.restore();
    }
  };

  Renderer.prototype.drawTrains = function (ctx, sim) {
    var rail = this.net.rail, self = this;
    if (!rail || !sim) return;
    var T = R.sim.TRAIN;
    sim.trains.forEach(function (tr, ti) {
      var x = (sim.t - tr.t0) * T.v;
      if (x < -14 || x > T.len + 14) return;
      var sign = tr.fwd ? 1 : -1, cross = rail.vertical ? rail.y : rail.x, line = rail.vertical ? rail.x : rail.y;
      var cars = [{ l: 0.95, c: '#e03131', loco: true }, { l: 0.8, c: '#74c0fc' }, { l: 0.8, c: '#ffd43b' }, { l: 0.8, c: '#b197fc' }, { l: 0.8, c: '#8ce99a' }];
      var nose = cross + sign * x, off = 0;
      cars.forEach(function (c, ci) {
        var mid = nose - sign * (off + c.l / 2);
        off += c.l + 0.07;
        var px = rail.vertical ? line : mid, py = rail.vertical ? mid : line;
        var ang = rail.vertical ? (sign > 0 ? Math.PI / 2 : -Math.PI / 2) : (sign > 0 ? 0 : Math.PI);
        ctx.save(); ctx.translate(px + 0.05 * (self.mirror ? -1 : 1), py + 0.07); ctx.rotate(ang); ctx.fillStyle = 'rgba(40,35,60,0.25)'; rr(ctx, -c.l / 2, -0.17, c.l, 0.34, 0.07); ctx.fill(); ctx.restore();
        ctx.save(); ctx.translate(px, py); ctx.rotate(ang);
        ctx.fillStyle = c.c; rr(ctx, -c.l / 2, -0.17, c.l, 0.34, 0.07); ctx.fill();
        if (c.loco) {
          ctx.fillStyle = '#c92a2a'; rr(ctx, -c.l / 2 + 0.05, -0.13, c.l * 0.38, 0.26, 0.04); ctx.fill();
          ctx.fillStyle = '#343a40'; ctx.beginPath(); ctx.arc(c.l * 0.22, 0, 0.075, 0, TAU); ctx.fill();
          ctx.fillStyle = '#ffd43b'; ctx.beginPath(); ctx.arc(c.l * 0.22, 0, 0.04, 0, TAU); ctx.fill();
          ctx.fillStyle = '#fffbe0'; ctx.beginPath(); ctx.arc(c.l / 2 - 0.03, 0, 0.035, 0, TAU); ctx.fill();
          ctx.fillStyle = '#3d4663'; ctx.fillRect(-c.l / 2 + 0.1, -0.1, 0.05, 0.2);
        } else {
          ctx.fillStyle = shade(c.c, 0.85); rr(ctx, -c.l / 2 + 0.06, -0.11, c.l - 0.12, 0.22, 0.04); ctx.fill();
          ctx.fillStyle = shade(c.c, 1.3); ctx.fillRect(-c.l / 2 + 0.1, -0.02, c.l - 0.2, 0.04);
        }
        ctx.restore();
        if (c.loco && sim.running !== false) { tr._px = rail.vertical ? line : mid + sign * 0.2; tr._py = rail.vertical ? mid + sign * 0.2 : line; }
      });
    });
  };

  /* ================= signs, signals, crossing ================= */
  Renderer.prototype.pop = function (key) { this.pops[key] = this.time; };
  Renderer.prototype.popScale = function (key) {
    var t0 = this.pops[key];
    if (t0 == null) return 1;
    var t = (this.time - t0) / 0.45;
    if (t >= 1) { delete this.pops[key]; return 1; }
    return Math.max(0.01, U.ease.outBack(t));
  };

  Renderer.prototype.drawFurniture = function (ctx, sim) {
    var net = this.net, self = this, P = {};
    net.segs.forEach(function (sg) {
      if (!sg.app || (sg.kind !== 'lane' && sg.kind !== 'track')) return;
      var app = sg.app, node = app.node;
      NET.posAt(sg.path, sg.len - 0.03, P);
      var hx = Math.cos(P.a), hy = Math.sin(P.a), nx = -hy, ny = hx; // n = right of travel
      if (node.type === 'signal') {
        var st = app.state, col = SIG[st];
        if (!sim && node.sig) { // build mode: preview a slowly running cycle
          var key = app.isTram ? 't' : app.dir, idx = Math.floor(self.time * 2) % node.sig.C;
          col = SIG[node.sig.st[key][idx]];
        }
        var half = app.isTram ? 0.1 : 0.13;
        ctx.strokeStyle = col; ctx.lineWidth = 0.07; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(P.x - nx * half, P.y - ny * half); ctx.lineTo(P.x + nx * half, P.y + ny * half); ctx.stroke();
        ctx.lineCap = 'butt';
        if (!app.isTram) {
          var sc = self.popScale('sig' + node.id), lx = P.x + nx * 0.3 - hx * 0.06, ly = P.y + ny * 0.3 - hy * 0.06;
          ctx.save(); ctx.translate(lx, ly); ctx.scale(sc, sc);
          ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.arc(0.03, 0.045, 0.1, 0, TAU); ctx.fill();
          ctx.fillStyle = '#2f3242'; ctx.beginPath(); ctx.arc(0, 0, 0.1, 0, TAU); ctx.fill();
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, 0.062, 0, TAU); ctx.fill();
          ctx.globalAlpha = 0.25; ctx.beginPath(); ctx.arc(0, 0, 0.16, 0, TAU); ctx.fill(); ctx.globalAlpha = 1;
          ctx.restore();
        }
      }
      if (app.isTram) return;
      var sx = P.x + nx * 0.31 - hx * 0.08, sy = P.y + ny * 0.31 - hy * 0.08, s;
      if (app.sign && node.type === 'plain') {
        s = self.popScale('sign' + app.key);
        ctx.save(); ctx.translate(sx, sy); ctx.scale(s, s);
        ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.arc(0.03, 0.045, 0.11, 0, TAU); ctx.fill();
        if (app.sign === 'stop') {
          ctx.fillStyle = '#fff'; poly(ctx, 8, 0.125, Math.PI / 8); ctx.fill();
          ctx.fillStyle = '#e03131'; poly(ctx, 8, 0.1, Math.PI / 8); ctx.fill();
          ctx.fillStyle = '#fff'; ctx.fillRect(-0.06, -0.018, 0.12, 0.036);
        } else {
          ctx.fillStyle = '#e03131'; poly(ctx, 3, 0.14, Math.PI / 2); ctx.fill();
          ctx.fillStyle = '#fff'; poly(ctx, 3, 0.07, Math.PI / 2); ctx.fill();
        }
        ctx.restore();
      }
      var k = 0;
      ['noL', 'noR'].forEach(function (ban) {
        if (!app[ban]) return;
        k++;
        var bx = sx - hx * 0.27 * k, by = sy - hy * 0.27 * k;
        s = self.popScale(ban + app.key);
        ctx.save(); ctx.translate(bx, by); ctx.scale(s, s);
        ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.arc(0.03, 0.045, 0.11, 0, TAU); ctx.fill();
        ctx.fillStyle = '#e03131'; ctx.beginPath(); ctx.arc(0, 0, 0.115, 0, TAU); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(0, 0, 0.085, 0, TAU); ctx.fill();
        // arrow in the direction of travel, bending to the banned side
        ctx.rotate(P.a);
        var sd = ban === 'noL' ? -1 : 1;
        ctx.strokeStyle = '#2f3242'; ctx.lineWidth = 0.028; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(-0.05, -sd * 0.02); ctx.lineTo(0.01, -sd * 0.02); ctx.lineTo(0.01, sd * 0.045); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-0.02, sd * 0.025); ctx.lineTo(0.01, sd * 0.055); ctx.lineTo(0.04, sd * 0.025); ctx.stroke();
        ctx.strokeStyle = '#e03131'; ctx.lineWidth = 0.03;
        ctx.beginPath(); ctx.moveTo(-0.06, -0.06); ctx.lineTo(0.06, 0.06); ctx.stroke();
        ctx.restore();
      });
    });

    // level crossing barriers and lamps
    if (net.rail) {
      var rl = net.rail, state = sim ? rl.state : 0;
      var target = state === 2 ? 1 : (state === 1 ? 0.55 : 0);
      this.barrier += (target - this.barrier) * 0.12;
      var flash = state > 0 && (Math.floor(this.time * 4) % 2 === 0);
      rl.lanes.forEach(function (sg) {
        NET.posAt(sg.path, sg.rail.s1 - 0.02, P);
        var hx = Math.cos(P.a), hy = Math.sin(P.a), nx = -hy, ny = hx;
        var bx = P.x + nx * 0.27, by = P.y + ny * 0.27;
        // arm pivots at the kerb: open = along the road, closed = across the lane
        var ang = P.a + Math.PI / 2 + (1 - self.barrier) * (Math.PI / 2) + Math.PI / 2;
        ctx.save(); ctx.translate(bx, by);
        ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.arc(0.03, 0.04, 0.085, 0, TAU); ctx.fill();
        ctx.save(); ctx.rotate(ang);
        ctx.fillStyle = '#fff'; rr(ctx, 0, -0.03, 0.46, 0.06, 0.03); ctx.fill();
        ctx.fillStyle = '#e03131'; for (var q = 0; q < 3; q++) ctx.fillRect(0.06 + q * 0.14, -0.03, 0.07, 0.06);
        ctx.restore();
        ctx.fillStyle = '#2f3242'; ctx.beginPath(); ctx.arc(0, 0, 0.075, 0, TAU); ctx.fill();
        ctx.fillStyle = flash ? '#ff3b3b' : '#7a2a2a'; ctx.beginPath(); ctx.arc(0, 0, 0.045, 0, TAU); ctx.fill();
        if (flash) { ctx.globalAlpha = 0.3; ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.arc(0, 0, 0.16, 0, TAU); ctx.fill(); ctx.globalAlpha = 1; }
        ctx.restore();
      });
    }
  };
  function poly(ctx, n, r, rot) {
    ctx.beginPath();
    for (var i = 0; i < n; i++) { var a = rot + i * TAU / n; if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    ctx.closePath();
  }

  /* ================= scenery on top, effects ================= */
  Renderer.prototype.drawTrees = function (ctx) {
    var th = this.theme, t = this.time, mir = this.mirror ? -1 : 1;
    this.level.scenery.forEach(function (s) {
      if (s.type === 'trees') {
        s.trees.forEach(function (tr) {
          var sw = Math.sin(t * 1.3 + tr.ph) * 0.012, x = s.c + tr.x + sw, y = s.r + tr.y + Math.cos(t * 1.1 + tr.ph) * 0.006;
          ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.arc(x + 0.05 * mir, y + 0.07, tr.s, 0, TAU); ctx.fill();
          ctx.fillStyle = shade(th.tree[tr.k], 0.86); ctx.beginPath(); ctx.arc(x, y, tr.s, 0, TAU); ctx.fill();
          ctx.fillStyle = th.tree[tr.k]; ctx.beginPath(); ctx.arc(x - tr.s * 0.12, y - tr.s * 0.14, tr.s * 0.78, 0, TAU); ctx.fill();
          ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.beginPath(); ctx.arc(x - tr.s * 0.3, y - tr.s * 0.32, tr.s * 0.3, 0, TAU); ctx.fill();
        });
      } else if (s.type === 'pond' && s.ducks) {
        for (var d = 0; d < s.ducks; d++) {
          var a = t * 0.25 * (d ? -1 : 1) + d * 2.4, dx = s.c + 1 + Math.cos(a) * (0.3 + d * 0.15), dy = s.r + 1 + Math.sin(a) * (0.22 + d * 0.1);
          ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.ellipse(dx, dy, 0.07, 0.05, a + Math.PI / 2, 0, TAU); ctx.fill();
          ctx.fillStyle = '#ffa94d'; ctx.beginPath(); ctx.arc(dx - Math.sin(a) * 0.07, dy + Math.cos(a) * 0.07, 0.022, 0, TAU); ctx.fill();
        }
      }
    });
  };

  Renderer.prototype.spawn = function (type, x, y, opt) {
    opt = opt || {};
    var n = opt.n || 1;
    for (var i = 0; i < n; i++) {
      var a = Math.random() * TAU, sp = (opt.speed || 0.5) * (0.4 + Math.random() * 0.8);
      this.parts.push({ type: type, x: x + (Math.random() - 0.5) * (opt.spread || 0), y: y + (Math.random() - 0.5) * (opt.spread || 0),
        vx: Math.cos(a) * sp + (opt.vx || 0), vy: Math.sin(a) * sp + (opt.vy || 0), life: 0, max: (opt.life || 0.8) * (0.7 + Math.random() * 0.6),
        size: (opt.size || 0.12) * (0.7 + Math.random() * 0.6), color: opt.color || '#fff', rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 8 });
    }
    if (this.parts.length > 500) this.parts.splice(0, this.parts.length - 500);
  };

  Renderer.prototype.drawParts = function (ctx, dt) {
    var ps = this.parts, w = 0;
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      ps[w++] = p;
      var k = p.life / p.max;
      p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      if (p.type === 'puff') {
        p.vx *= 0.96; p.vy *= 0.96;
        ctx.globalAlpha = (1 - k) * 0.75; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.5 + k * 1.3), 0, TAU); ctx.fill();
      } else if (p.type === 'star') {
        p.vx *= 0.93; p.vy *= 0.93;
        ctx.globalAlpha = 1 - k * k; ctx.fillStyle = p.color;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
        ctx.beginPath();
        for (var q = 0; q < 10; q++) { var r = (q % 2 ? 0.45 : 1) * p.size * (1 - k * 0.5), a = q * TAU / 10; if (q === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
        ctx.closePath(); ctx.fill(); ctx.restore();
      } else if (p.type === 'ring') {
        ctx.globalAlpha = (1 - k) * 0.9; ctx.strokeStyle = p.color; ctx.lineWidth = 0.035 * (1 - k) + 0.01;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size * (0.3 + k * 1.6), 0, TAU); ctx.stroke();
      } else if (p.type === 'confetti') {
        p.vy += 2.2 * dt; p.vx *= 0.985;
        ctx.globalAlpha = Math.min(1, (1 - k) * 3); ctx.fillStyle = p.color;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); ctx.restore();
      } else if (p.type === 'note') {
        ctx.globalAlpha = 1 - k;
        this.text(ctx, p.color, p.x, p.y - k * 0.3, p.size, '#3d4050');
      }
    }
    ps.length = w;
    ctx.globalAlpha = 1;
  };

  /* ================= frame ================= */
  Renderer.prototype.draw = function (state, dt) {
    if (!this.level || !this.net) return;
    this.time += dt;
    if (this.dirty) this.drawStatic();
    var ctx = this.ctx, sim = state.sim, self = this, N = this.level.N;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var shx = 0, shy = 0;
    if (this.shake > 0.001) { shx = (Math.random() - 0.5) * this.shake * this.px * 0.02; shy = (Math.random() - 0.5) * this.shake * this.px * 0.02; this.shake *= 0.88; }
    ctx.drawImage(this.staticCv, shx, shy);
    this.world(ctx);
    if (shx || shy) ctx.translate(shx / (this.px / N) * (this.mirror ? -1 : 1), shy / (this.px / N));

    if (state.forecast) this.drawForecast(ctx, state);

    var alpha = state.alpha == null ? 1 : state.alpha, i;
    if (sim) {
      for (i = 0; i < sim.veh.length; i++) this.drawVehicle(ctx, sim.veh[i], alpha, true);
      for (i = 0; i < sim.veh.length; i++) this.drawVehicle(ctx, sim.veh[i], alpha, false);
    }
    this.drawFurniture(ctx, sim);
    this.drawTrains(ctx, sim);
    if (sim) this.trainSmoke(sim, dt);
    this.drawTrees(ctx);
    this.drawParts(ctx, dt);
    if (state.slots) this.drawSlots(ctx, state);
    this.drawLabels(ctx, state);
    if (this.debug.paths || this.debug.zones) this.drawDebug(ctx);
  };

  Renderer.prototype.trainSmoke = function (sim, dt) {
    var self = this;
    this.smokeT += dt;
    if (this.smokeT < 0.07) return;
    this.smokeT = 0;
    sim.trains.forEach(function (tr) {
      if (tr._px == null) return;
      var x = (sim.t - tr.t0) * R.sim.TRAIN.v;
      if (x < -14 || x > R.sim.TRAIN.len + 14) { tr._px = null; return; }
      self.spawn('puff', tr._px, tr._py, { color: '#ffffff', size: 0.13, life: 1.1, speed: 0.15 });
    });
  };

  Renderer.prototype.drawForecast = function (ctx, state) {
    var net = state.plainNet || this.net, L = this.level, maxq = 0.01;
    L.entries.forEach(function (e) { e.dests.forEach(function (d) { if (e.rate * d.p > maxq) maxq = e.rate * d.p; }); });
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    L.entries.forEach(function (e, ei) {
      if (state.forecastEntry != null && state.forecastEntry !== e.id) return;
      e.dests.forEach(function (d) {
        var rt = net.routes[e.id + '>' + d.entry], q = e.rate * d.p;
        ctx.strokeStyle = ENTRY_COLORS[ei % ENTRY_COLORS.length]; ctx.globalAlpha = 0.5;
        ctx.lineWidth = 0.03 + 0.22 * q / maxq;
        ctx.beginPath();
        var first = true;
        rt.segs.forEach(function (sg) {
          for (var j = 0; j < sg.path.n; j += 2) { if (first) { ctx.moveTo(sg.path.x[j], sg.path.y[j]); first = false; } else ctx.lineTo(sg.path.x[j], sg.path.y[j]); }
        });
        ctx.stroke();
      });
    });
    ctx.globalAlpha = 1; ctx.lineCap = 'butt';
  };

  Renderer.prototype.drawSlots = function (ctx, state) {
    var t = this.time, self = this;
    state.slots.forEach(function (s) {
      var hov = state.hover === s, pulse = 0.5 + 0.5 * Math.sin(t * 4 + s.x + s.y);
      var r = (s.kind === 'node' ? 0.36 : 0.24) * (hov ? 1.18 : 1) + pulse * 0.02;
      ctx.lineWidth = 0.04;
      if (!s.ok) {
        ctx.globalAlpha = 0.75; ctx.strokeStyle = '#868e96'; ctx.setLineDash([0.06, 0.06]);
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(s.x - r * 0.5, s.y - r * 0.5); ctx.lineTo(s.x + r * 0.5, s.y + r * 0.5); ctx.stroke();
        ctx.globalAlpha = 1;
        return;
      }
      ctx.fillStyle = s.active ? 'rgba(255,107,107,' + (0.25 + pulse * 0.15) + ')' : 'rgba(255,255,255,' + (0.3 + pulse * 0.25) + ')';
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = s.active ? '#ff6b6b' : '#ffffff'; ctx.setLineDash([0.09, 0.07]); ctx.lineDashOffset = -t * 0.25;
      ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = s.active ? '#e03131' : '#3d4050'; ctx.lineWidth = 0.045; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(s.x - 0.08, s.y); ctx.lineTo(s.x + 0.08, s.y);
      if (!s.active) { ctx.moveTo(s.x, s.y - 0.08); ctx.lineTo(s.x, s.y + 0.08); }
      ctx.stroke(); ctx.lineCap = 'butt';
    });
  };

  Renderer.prototype.drawLabels = function (ctx, state) {
    var L = this.level, self = this, N = L.N;
    L.entries.forEach(function (e, ei) {
      var link = L.links[e.link], t = link.tiles[link.tiles.length - 1], d = link.b.dir;
      var x = t[0] + 0.5 + U.DX[d] * 0.2 + U.DX[(d + 1) % 4] * 0.56, y = t[1] + 0.5 + U.DY[d] * 0.2 + U.DY[(d + 1) % 4] * 0.56;
      x = U.clamp(x, 0.3, N - 0.3); y = U.clamp(y, 0.3, N - 0.3);
      var hot = state.forecastEntry === e.id;
      ctx.fillStyle = SHADOW; ctx.beginPath(); ctx.arc(x + 0.02, y + 0.04, 0.21, 0, TAU); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, hot ? 0.24 : 0.21, 0, TAU); ctx.fill();
      ctx.fillStyle = ENTRY_COLORS[ei % ENTRY_COLORS.length]; ctx.beginPath(); ctx.arc(x, y, hot ? 0.2 : 0.17, 0, TAU); ctx.fill();
      self.text(ctx, e.label, x, y, 0.23, '#fff');
      var q = state.backlog ? state.backlog[e.id] : 0;
      if (q > 0) {
        var bx = x + U.DX[d] * -0.0 + 0.2, by = y - 0.2;
        ctx.fillStyle = '#e03131'; ctx.beginPath(); ctx.arc(bx, by, 0.13, 0, TAU); ctx.fill();
        self.text(ctx, q > 9 ? '9+' : String(q), bx, by, 0.15, '#fff');
      }
    });
    if (L.nodes.length > 1 && state.showNodeTags) {
      L.nodes.forEach(function (nd, i) {
        self.text(ctx, String(i + 1), nd.c + 0.5, nd.r + 0.5, 0.3, 'rgba(255,255,255,0.85)');
      });
    }
  };

  Renderer.prototype.drawDebug = function (ctx) {
    var net = this.net, self = this;
    if (this.debug.paths) {
      net.segs.forEach(function (sg) {
        ctx.strokeStyle = sg.kind === 'lane' ? 'rgba(0,200,255,0.8)' : sg.kind === 'ring' ? 'rgba(255,0,255,0.8)' : 'rgba(255,255,0,0.8)';
        ctx.lineWidth = 0.02; strokePath(ctx, sg.path);
      });
    }
    if (this.debug.zones) {
      net.segs.forEach(function (sg) {
        sg.conflicts.forEach(function (c) {
          ctx.strokeStyle = c.yield ? 'rgba(255,0,0,0.5)' : 'rgba(0,255,0,0.4)'; ctx.lineWidth = 0.06;
          strokePath(ctx, sg.path, c.in, c.out);
        });
      });
    }
  };

  R.render = { Renderer: Renderer, THEMES: THEMES, ENTRY_COLORS: ENTRY_COLORS, CAR_COLORS: CAR_COLORS, SIG: SIG };
})(typeof globalThis !== 'undefined' ? globalThis : window);
