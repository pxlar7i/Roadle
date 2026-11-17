// Sweep demand on one junction and compare control families (delay / crashes), to calibrate the model.
const R = require('./load.js');
const U = R.util;
const date = process.argv[2] || '2026-11-17';
const qs = (process.argv[3] || '0.3,0.45,0.6,0.75,0.9').split(',').map(Number);
const base = R.level.generate({ date });
console.log(base.date, base.kind, base.features.join(','), base.nodes.map(n => n.space).join('/'), 'rates', base.entries.map(e => e.rate.toFixed(2)).join(' '));
for (const q of qs) {
  const level = R.level.generate({ date });
  const k = q / level.q;
  level.entries.forEach(e => { e.rate = e.rate * k; });
  level.q = q; level.id = level.id + ':q' + q; delete level._ref;
  const flows = R.solver.approachFlows(level);
  const opts = R.solver.nodeOptions(level, 0, flows);
  const best = {};
  for (const opt of opts) {
    const cfg = R.net.defaultConfig(level);
    R.solver.applyOption(level, cfg, 0, opt);
    let d = 0, c = 0, u = 0, s = 0; const seeds = ['a', 'b', 'c'];
    for (const sd of seeds) { const r = R.sim.evaluate(level, cfg, R.level.makeDemand(level, sd)); d += r.avgDelay; c += r.crashes; u += r.unserved; s += r.score; }
    d /= seeds.length; c /= seeds.length; u /= seeds.length; s /= seeds.length;
    if (!best[opt.family] || s > best[opt.family].s) best[opt.family] = { s, d, c, u, name: opt.name };
  }
  console.log('q=' + q + '  ' + Object.keys(best).map(f => `${f}: ${Math.round(best[f].s)} (d${best[f].d.toFixed(1)} c${best[f].c.toFixed(1)} u${best[f].u.toFixed(0)})`).join(' | '));
}
