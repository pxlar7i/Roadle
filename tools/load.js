// Loads the browser game modules into Node (they attach to globalThis.Roadle).
const path = require('path');
['util', 'level', 'net', 'sim', 'solver'].forEach(f => {
  try { require(path.join(__dirname, '..', 'js', f + '.js')); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
});
module.exports = globalThis.Roadle;
