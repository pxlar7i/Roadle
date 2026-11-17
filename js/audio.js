/* Roadle — all sound is synthesised with WebAudio (no audio files to host). */
(function (root) {
  'use strict';
  var R = root.Roadle;
  var ctx = null, master = null, enabled = true, engine = null, rumble = null, bellTimer = null;
  var last = {}; // rate limiting per sound name
  var PENTA = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25, 783.99, 880.0];

  function init() {
    if (ctx || !enabled) { if (ctx && ctx.state === 'suspended') ctx.resume(); return; }
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.55;
      var comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16; comp.ratio.value = 5;
      master.connect(comp); comp.connect(ctx.destination);
      startEngine();
    } catch (e) { ctx = null; }
  }

  function out(pan) {
    if (pan == null || !ctx.createStereoPanner) return master;
    var p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan)); p.connect(master);
    return p;
  }

  function tone(o) {
    if (!ctx) return;
    var t = ctx.currentTime + (o.at || 0), osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t);
    if (o.f2) osc.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    var vol = o.vol == null ? 0.2 : o.vol, att = o.attack || 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + att);
    if (o.hold) g.gain.setValueAtTime(vol, t + o.dur - (o.release || 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    var dest = out(o.pan);
    if (o.lp) { var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.lp; osc.connect(f); f.connect(g); } else osc.connect(g);
    g.connect(dest);
    osc.start(t); osc.stop(t + o.dur + 0.03);
  }

  var noiseBuf = null;
  function getNoise() {
    if (noiseBuf) return noiseBuf;
    var n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0), lastV = 0;
    for (var i = 0; i < n; i++) { var w = Math.random() * 2 - 1; lastV = (lastV + 0.02 * w) / 1.02; d[i] = w * 0.5 + lastV * 3; }
    noiseBuf = b; return b;
  }
  function noise(o) {
    if (!ctx) return;
    var t = ctx.currentTime + (o.at || 0), src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    src.buffer = getNoise(); src.loop = true;
    f.type = o.type || 'lowpass'; f.frequency.setValueAtTime(o.f || 800, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + o.dur);
    f.Q.value = o.q || 0.7;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(o.vol || 0.2, t + (o.attack || 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f); f.connect(g); g.connect(out(o.pan));
    src.start(t, Math.random()); src.stop(t + o.dur + 0.05);
  }

  function startEngine() {
    // a soft bed of road noise whose level follows how much traffic is moving
    var src = ctx.createBufferSource(); src.buffer = getNoise(); src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180;
    var g = ctx.createGain(); g.gain.value = 0;
    src.connect(f); f.connect(g); g.connect(master); src.start();
    var o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), og = ctx.createGain(), of = ctx.createBiquadFilter();
    o1.type = 'sawtooth'; o2.type = 'sawtooth'; o1.frequency.value = 46; o2.frequency.value = 69.5;
    of.type = 'lowpass'; of.frequency.value = 140; og.gain.value = 0;
    o1.connect(of); o2.connect(of); of.connect(og); og.connect(master); o1.start(); o2.start();
    engine = { g: g, f: f, og: og, o1: o1, o2: o2 };
    // train rumble
    var rs = ctx.createBufferSource(); rs.buffer = getNoise(); rs.loop = true;
    var rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 130;
    var rg = ctx.createGain(); rg.gain.value = 0;
    rs.connect(rf); rf.connect(rg); rg.connect(master); rs.start();
    rumble = { g: rg };
  }

  function setTraffic(moving, avgSpeed) { // moving = number of moving vehicles
    if (!ctx || !engine) return;
    var lvl = enabled ? Math.min(1, moving / 28) : 0, t = ctx.currentTime;
    engine.g.gain.setTargetAtTime(0.05 + lvl * 0.2 * (moving > 0 ? 1 : 0), t, 0.3);
    engine.f.frequency.setTargetAtTime(150 + avgSpeed * 260, t, 0.3);
    engine.og.gain.setTargetAtTime(lvl * 0.05, t, 0.3);
    engine.o1.frequency.setTargetAtTime(40 + avgSpeed * 22, t, 0.4);
    engine.o2.frequency.setTargetAtTime(60 + avgSpeed * 33, t, 0.4);
  }
  function quiet() {
    if (!ctx || !engine) return;
    var t = ctx.currentTime;
    engine.g.gain.setTargetAtTime(0, t, 0.2); engine.og.gain.setTargetAtTime(0, t, 0.2); rumble.g.gain.setTargetAtTime(0, t, 0.2);
    stopBell();
  }
  function setTrain(on) {
    if (!ctx || !rumble) return;
    rumble.g.gain.setTargetAtTime(on && enabled ? 0.5 : 0, ctx.currentTime, 0.35);
  }
  function startBell() {
    if (bellTimer || !ctx) return;
    var k = 0;
    bellTimer = setInterval(function () {
      if (!enabled) return;
      tone({ type: 'triangle', f: (k++ % 2) ? 932 : 784, dur: 0.22, vol: 0.09, attack: 0.002 });
    }, 260);
  }
  function stopBell() { if (bellTimer) { clearInterval(bellTimer); bellTimer = null; } }

  var SOUNDS = {
    click: function () { tone({ type: 'triangle', f: 660, f2: 880, dur: 0.06, vol: 0.12 }); },
    place: function (o) { tone({ type: 'triangle', f: 440, f2: 660, dur: 0.09, vol: 0.2, pan: o.pan }); tone({ type: 'sine', f: 880, f2: 1320, dur: 0.14, vol: 0.14, at: 0.07, pan: o.pan }); },
    remove: function (o) { tone({ type: 'triangle', f: 520, f2: 260, dur: 0.14, vol: 0.18, pan: o.pan }); },
    error: function () { tone({ type: 'square', f: 180, f2: 140, dur: 0.16, vol: 0.09, lp: 900 }); },
    tick: function (o) { tone({ type: 'sine', f: PENTA[(o.row || 0) % PENTA.length] * (o.on ? 2 : 1), dur: 0.07, vol: 0.1 }); },
    sig: function (o) { tone({ type: 'sine', f: 1200, f2: 900, dur: 0.035, vol: 0.05, pan: o.pan }); },
    start: function () { [0, 2, 4, 7].forEach(function (n, i) { tone({ type: 'triangle', f: PENTA[n], dur: 0.16, vol: 0.16, at: i * 0.07 }); }); },
    stop: function () { [4, 2, 0].forEach(function (n, i) { tone({ type: 'triangle', f: PENTA[n], dur: 0.14, vol: 0.13, at: i * 0.07 }); }); },
    honk: function (o) {
      var base = 380 + ((o.id || 0) % 7) * 22;
      tone({ type: 'square', f: base, dur: 0.13, vol: 0.085, pan: o.pan, lp: 1700, hold: true });
      tone({ type: 'square', f: base * 1.26, dur: 0.13, vol: 0.07, pan: o.pan, lp: 1700, hold: true });
      if (o.angry) {
        tone({ type: 'square', f: base, dur: 0.2, vol: 0.085, pan: o.pan, lp: 1700, hold: true, at: 0.18 });
        tone({ type: 'square', f: base * 1.26, dur: 0.2, vol: 0.07, pan: o.pan, lp: 1700, hold: true, at: 0.18 });
      }
    },
    honkBig: function (o) {
      tone({ type: 'sawtooth', f: 196, dur: 0.38, vol: 0.12, pan: o.pan, lp: 900, hold: true });
      tone({ type: 'sawtooth', f: 247, dur: 0.38, vol: 0.1, pan: o.pan, lp: 900, hold: true });
    },
    crash: function (o) {
      noise({ f: 2600, f2: 180, dur: 0.38, vol: 0.5, pan: o.pan });
      tone({ type: 'sine', f: 130, f2: 42, dur: 0.3, vol: 0.5, pan: o.pan });
      [0.05, 0.13, 0.2, 0.3].forEach(function (at, i) { tone({ type: 'triangle', f: 1500 + i * 420 + Math.random() * 300, dur: 0.09, vol: 0.07, at: at, pan: o.pan }); });
      tone({ type: 'triangle', f: 620, f2: 210, dur: 0.42, vol: 0.1, at: 0.22, pan: o.pan }); // sad little slide
    },
    poof: function (o) { noise({ type: 'bandpass', f: 500, f2: 1800, dur: 0.22, vol: 0.16, pan: o.pan }); tone({ type: 'sine', f: 500, f2: 900, dur: 0.14, vol: 0.08, pan: o.pan }); },
    tramBell: function (o) {
      [0, 0.17].forEach(function (at) {
        tone({ type: 'sine', f: 1568, dur: 0.34, vol: 0.14, at: at, pan: o.pan, attack: 0.002 });
        tone({ type: 'sine', f: 2637, dur: 0.2, vol: 0.05, at: at, pan: o.pan, attack: 0.002 });
      });
    },
    trainHorn: function (o) {
      [[0, 0.75], [0.9, 0.42]].forEach(function (seg) {
        [311, 370, 466].forEach(function (f) { tone({ type: 'sawtooth', f: f, f2: f * 0.985, dur: seg[1], vol: 0.085, at: seg[0], lp: 1300, hold: true, attack: 0.04, release: 0.12, pan: o.pan }); });
      });
    },
    busDoor: function (o) { noise({ type: 'highpass', f: 2500, f2: 5200, dur: 0.3, vol: 0.07, pan: o.pan, attack: 0.03 }); },
    vroom: function (o) { tone({ type: 'sawtooth', f: 62 + (o.id % 5) * 4, f2: 118, dur: 0.5, vol: 0.05, lp: 420, pan: o.pan, attack: 0.05 }); },
    pluck: function (o) { tone({ type: 'triangle', f: PENTA[(o.note || 0) % PENTA.length], dur: 0.32, vol: 0.055, pan: o.pan, attack: 0.003 }); },
    star: function (o) { var n = o.n || 0; tone({ type: 'triangle', f: PENTA[4 + n * 2], dur: 0.4, vol: 0.2 }); tone({ type: 'sine', f: PENTA[4 + n * 2] * 2, dur: 0.5, vol: 0.1, at: 0.03 }); },
    win: function () { [0, 2, 4, 5, 7, 9].forEach(function (n, i) { tone({ type: 'triangle', f: PENTA[n], dur: 0.3, vol: 0.16, at: i * 0.09 }); }); },
    meh: function () { [4, 3, 1].forEach(function (n, i) { tone({ type: 'triangle', f: PENTA[n], dur: 0.3, vol: 0.14, at: i * 0.14 }); }); },
    count: function (o) { tone({ type: 'sine', f: 500 + (o.k || 0) * 30, dur: 0.04, vol: 0.05 }); }
  };
  var LIMIT = { honk: 0.22, honkBig: 0.6, pluck: 0.09, vroom: 0.35, sig: 0.1, crash: 0.15, tramBell: 1.2, busDoor: 0.4, tick: 0.02, count: 0.03, poof: 0.1 };

  function play(name, o) {
    if (!enabled) return;
    if (!ctx) init();
    if (!ctx || !SOUNDS[name]) return;
    if (ctx.state !== 'running') { if (ctx.resume) ctx.resume(); return; } // no gesture yet: stay silent rather than queue sounds
    var now = ctx.currentTime, lim = LIMIT[name];
    if (lim && last[name] && now - last[name] < lim) return;
    last[name] = now;
    try { SOUNDS[name](o || {}); } catch (e) { /* audio is never essential */ }
  }

  function setEnabled(v) {
    enabled = v;
    if (!v) { quiet(); }
    else init();
  }

  R.audio = { init: init, play: play, setEnabled: setEnabled, setTraffic: setTraffic, setTrain: setTrain, startBell: startBell, stopBell: stopBell, quiet: quiet,
    isEnabled: function () { return enabled; } };
})(typeof globalThis !== 'undefined' ? globalThis : window);
