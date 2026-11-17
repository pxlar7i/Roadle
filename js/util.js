/* Roadle — shared helpers: seeded RNG, dates, small math utils.
   Every file attaches to a single global namespace so the game works from
   plain <script> tags (no build step, works on file://) and from Node. */
(function (root) {
  'use strict';
  var R = root.Roadle = root.Roadle || {};

  /* ---------- seeded RNG (mulberry32) ---------- */
  function hashStr(str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 15; h = Math.imul(h, 2246822507);
    h ^= h >>> 13; h = Math.imul(h, 3266489909);
    return (h ^ (h >>> 16)) >>> 0;
  }

  function makeRng(seed) {
    var a = (typeof seed === 'string' ? hashStr(seed) : seed) >>> 0;
    function f() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    f.range = function (lo, hi) { return lo + (hi - lo) * f(); };
    f.int = function (lo, hi) { return lo + Math.floor(f() * (hi - lo + 1)); }; // inclusive
    f.chance = function (p) { return f() < p; };
    f.pick = function (arr) { return arr[Math.floor(f() * arr.length)]; };
    f.shuffle = function (arr) {
      for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(f() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    };
    // ~N(0,1) from four uniforms: arithmetic only, so identical on every JS engine
    f.normal = function () { return (f() + f() + f() + f() - 2) * 1.7320508075688772; };
    // exponential with mean 1 (rounded so engine differences in Math.log cannot matter)
    f.exp = function () { return Math.round(-Math.log(1 - f()) * 1e6) / 1e6; };
    f.weighted = function (weights) {
      var sum = 0, i;
      for (i = 0; i < weights.length; i++) sum += weights[i];
      var x = f() * sum;
      for (i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
      return weights.length - 1;
    };
    return f;
  }

  /* ---------- dates ---------- */
  var EPOCH = { y: 2026, m: 11, d: 16 }; // Roadle #1 (a Monday)
  var DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function parseDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
  }
  function dayNumber(d) { // 1-based puzzle number
    var a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
    var b = Date.UTC(EPOCH.y, EPOCH.m - 1, EPOCH.d);
    return Math.round((a - b) / 86400000) + 1;
  }
  function weekdayIndex(d) { return (d.getDay() + 6) % 7; } // 0 = Monday … 6 = Sunday
  function addDays(d, n) { var x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }

  /* ---------- math ---------- */
  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function round6(x) { return Math.round(x * 1e6) / 1e6; }
  function angLerp(a, b, t) {
    var d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return a + d * t;
  }
  var ease = {
    outBack: function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    inOut: function (t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; },
    outElastic: function (t) {
      if (t === 0 || t === 1) return t;
      return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (2 * Math.PI) / 3) + 1;
    }
  };

  // directions: 0 = N, 1 = E, 2 = S, 3 = W  (screen coords, y grows downward)
  var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
  var DIR_NAMES = ['N', 'E', 'S', 'W'];
  var DIR_LONG = ['north', 'east', 'south', 'west'];

  R.util = {
    hashStr: hashStr, makeRng: makeRng, EPOCH: EPOCH, DAY_NAMES: DAY_NAMES,
    dateStr: dateStr, parseDate: parseDate, dayNumber: dayNumber, weekdayIndex: weekdayIndex, addDays: addDays,
    clamp: clamp, lerp: lerp, round6: round6, angLerp: angLerp, ease: ease,
    DX: DX, DY: DY, DIR_NAMES: DIR_NAMES, DIR_LONG: DIR_LONG
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
