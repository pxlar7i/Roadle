// Automated playtest: for a range of days, run the solver and report which family of
// traffic control scores best on each junction. Usage: node tools/playtest.js [weeks] [startDate] [-v]
const R = require('./load.js');
const U = R.util;
const args = process.argv.slice(2);
const verbose = args.includes('-v');
const nums = args.filter(a => !a.startsWith('-'));
const weeks = +(nums[0] || 2);
const start = U.parseDate(nums[1] || '2026-11-16');
const wins = {}, byDay = [[], [], [], [], [], [], []];
const t0 = Date.now();
for (let i = 0; i < weeks * 7; i++) {
  const date = U.addDays(start, i);
  const level = R.level.generate({ date });
  const sol = R.solver.solve(level, { seeds: ['test-A', 'test-B', 'test-C'] });
  // best score per family, per node
  const fam = {};
  sol.table.forEach(r => { const k = r.node + ':' + r.family; if (!(k in fam) || r.score > fam[k]) fam[k] = r.score; });
  const famStr = Object.keys(fam).sort((a, b) => fam[b] - fam[a]).map(k => k + '=' + fam[k]).join(' ');
  const cost = R.net.cost(level, sol.config);
  const extras = cost.items.filter(it => ['box', 'bay', 'bump', 'noturn'].includes(it.key)).map(it => it.key + 'x' + it.n).join(',');
  const key = sol.families.join('+');
  sol.families.forEach(f => { wins[f] = (wins[f] || 0) + 1; });
  byDay[level.weekday].push(sol.official.score);
  console.log(`${level.date} ${R.level.RECIPES[level.weekday].name.slice(0, 3)} ${level.kind.padEnd(18)} arms=${level.entries.length} q=${level.q.toFixed(2)} [${level.features.join(',')}] ${level.nodes.map(n => n.space + (n.blind ? '!' : '')).join('/')}`);
  console.log(`   BEST ${sol.score} official ${sol.official.score} (${key}${extras ? ' +' + extras : ''}) delay=${sol.res.avgDelay} crashes=${sol.res.crashes} cost=${sol.res.cost} evals=${sol.evals}`);
  if (verbose) console.log('   ' + famStr);
}
console.log('\nWinning families:', wins);
console.log('Avg best score by weekday:', byDay.map((a, i) => R.level.RECIPES[i].name.slice(0, 3) + '=' + Math.round(a.reduce((x, y) => x + y, 0) / a.length)).join(' '));
console.log('time', ((Date.now() - t0) / 1000).toFixed(1) + 's');
