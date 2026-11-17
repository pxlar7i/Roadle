// End-to-end check: drives the real page in headless Edge/Chrome over the DevTools protocol.
// Usage: node tools/e2e.js      (no npm packages needed; set EDGE=path\to\browser.exe to override)
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const EDGE = process.env.EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9337;
const outDir = process.env.SHOTS || path.join(os.tmpdir(), 'roadle-e2e');
fs.mkdirSync(outDir, { recursive: true });
const profile = path.join(outDir, 'profile-' + Date.now());
const pageUrl = 'file:///' + path.join(__dirname, '..', 'index.html').replace(/\\/g, '/');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const edge = spawn(EDGE, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1280,900', '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let ws, id = 0;
  const pending = {}, errors = [], logs = [];
  try {
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      await sleep(250);
      try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json')).json(); target = list.find(t => t.type === 'page'); } catch (e) { /* not up yet */ }
    }
    if (!target) throw new Error('could not reach the browser');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
      else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        errors.push(d.exception ? d.exception.description : d.text);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') logs.push(m.params.args.map(a => a.value || a.description).join(' '));
    };
    const send = (method, params) => new Promise(res => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
    const ev = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.result.exceptionDetails) throw new Error('eval failed: ' + expr.slice(0, 80) + ' :: ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description));
      return r.result.result.value;
    };
    const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(outDir, name + '.png'), Buffer.from(r.result.data, 'base64')); };
    const click = async (x, y) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      await sleep(80);
    };
    const clickSel = async sel => {
      const p = await ev('(()=>{const e=document.querySelector(' + JSON.stringify(sel) + '); if(!e) return null; e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];})()');
      if (!p) throw new Error('no element ' + sel);
      await click(p[0], p[1]);
    };
    const worldClick = async (wx, wy) => {
      const p = await ev('(()=>{const c=document.querySelector("#cv"); c.scrollIntoView({block:"center"}); const r=c.getBoundingClientRect(); const N=13; const x=(Roadle.__S.mirror?N-(' + wx + '):(' + wx + '))/N*r.width; return [r.left+x, r.top+(' + wy + ')/N*r.height];})()');
      await click(p[0], p[1]);
    };
    const costNow = async () => +(await ev('document.querySelector("#stCost").textContent'));
    const check = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) process.exitCode = 1; };

    await send('Runtime.enable'); await send('Page.enable');
    async function open(query, w, h, mobile) {
      await send('Emulation.setDeviceMetricsOverride', { width: w || 1280, height: h || 900, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile });
      await send('Page.navigate', { url: pageUrl + (query || '') });
      await sleep(1000);
    }

    console.log('1. first visit (desktop)');
    await open('?dev=1&date=2026-11-18');
    check(await ev('!document.querySelector("#mHelp").hidden'), 'help opens on first visit');
    await clickSel('#mHelp .btn.go');
    check(await ev('document.querySelector("#mHelp").hidden'), 'help closes');
    check(await ev('!document.querySelector("#dev").hidden'), 'dev panel visible with ?dev=1');
    const info = await ev('(()=>{const L=Roadle.__S.level; return {c:L.nodes[0].c, r:L.nodes[0].r, stops:L.busStops.length, arms:L.entries.length};})()');

    console.log('2. build: sign, lights, sequencer, bus bay');
    await clickSel('.tool[data-tool="give"]');
    let sp = await ev('(()=>{const s=Roadle.__S.slots.filter(s=>s.ok)[0]; return [s.x,s.y];})()');
    await worldClick(sp[0], sp[1]);
    check(await costNow() === 5, 'give-way placed, cost 5');
    await clickSel('.tool[data-tool="signal"]');
    await worldClick(info.c + 0.5, info.r + 0.5);
    check(await ev('!document.querySelector("#seqCard").hidden'), 'sequencer appears');
    check(await costNow() === 20 * info.arms, 'lights cost 20 per road and the sign came down (cost=' + await costNow() + ')');
    const cells = await ev('(()=>{const row=document.querySelector("#seqCard .seq-cells"); row.scrollIntoView({block:"center"}); const kids=[...row.children]; const i0=kids.findIndex(c=>!c.classList.contains("g")&&!c.classList.contains("a")); window.__g0=kids.length-kids.filter(c=>!c.classList.contains("g")&&!c.classList.contains("a")).length; return [i0,i0+7].map(i=>{const r=row.children[i].getBoundingClientRect(); return [r.left+r.width/2, r.top+r.height/2];});})()');
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cells[0][0], y: cells[0][1] });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cells[0][0], y: cells[0][1], button: 'left', clickCount: 1 });
    for (let k = 1; k <= 8; k++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cells[0][0] + (cells[1][0] - cells[0][0]) * k / 8, y: cells[0][1], buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cells[1][0], y: cells[1][1], button: 'left', clickCount: 1 });
    await sleep(150);
    const greens = await ev('[...document.querySelector("#seqCard .seq-cells").children].filter(c=>c.classList.contains("g")||c.classList.contains("a")).length');
    const g0 = await ev('window.__g0');
    check(greens >= g0 + 7, 'drag-painting adds green ticks (' + g0 + ' → ' + greens + ' green cells in row 1)');
    check(await ev('!document.querySelector("#seqWarn").hidden'), 'conflicting-green warning shown');
    await shot('e2e-sequencer');
    await clickSel('#seqCard [data-act="pair"]');
    check(await ev('document.querySelector("#seqWarn").hidden'), 'preset "Pairs" clears the conflict');
    if (info.stops) {
      await clickSel('.tool[data-tool="bay"]');
      sp = await ev('(()=>{const s=Roadle.__S.slots[0]; return s?[s.x,s.y]:null;})()');
      const before = await costNow();
      await worldClick(sp[0], sp[1]);
      check(await costNow() === before + 35, 'bus bay placed (+35)');
    }

    console.log('3. test run');
    await clickSel('#btnTest');
    await sleep(1800);
    check(await ev('document.body.classList.contains("running")'), 'run started');
    check(await ev('Roadle.__S.sim.veh.length > 0'), 'vehicles on the map');
    await shot('e2e-running');
    await clickSel('#speedRow [data-speed="4"]');
    // the lamps drawn on the board must follow the signal plan: sample the canvas pixel at one lamp over time
    const lampProbe = '(()=>{const S=Roadle.__S, sim=S.sim; if(!sim) return null; const node=sim.net.nodes[0]; const app=node.apps.filter(a=>a)[0];' +
      'const p=Roadle.net.posAt(app.lane.path, app.lane.len-0.03, {}); const hx=Math.cos(p.a), hy=Math.sin(p.a);' +
      'const wx=p.x-hy*0.3-hx*0.06, wy=p.y+hx*0.3-hy*0.06; const cv=document.querySelector("#cv"); const N=S.level.N;' +
      'const px=Math.round((S.mirror?N-wx:wx)/N*cv.width), py=Math.round(wy/N*cv.height);' +
      'const d=cv.getContext("2d").getImageData(px,py,1,1).data; return {state:app.state, r:d[0], g:d[1], b:d[2]};})()';
    const seen = {};
    for (let k = 0; k < 40; k++) { const s = await ev(lampProbe); if (s) seen[s.state] = s; await sleep(120); }
    const red = seen[0], green = seen[1];
    check(!!red && !!green, 'signal goes through red and green during the run');
    check(!!red && red.r > 200 && red.g < 140, 'lamp on the board is red when the signal is red ' + JSON.stringify(red || {}));
    check(!!green && green.g > 180 && green.r < 140, 'lamp on the board is green when the signal is green ' + JSON.stringify(green || {}));
    if (seen[2]) check(seen[2].r > 200 && seen[2].g > 150 && seen[2].b < 120, 'lamp on the board is amber on the last green tick ' + JSON.stringify(seen[2]));
    await shot('e2e-running-later');
    await sleep(300);
    await clickSel('#btnSkip');
    await sleep(2500);
    check(await ev('!document.querySelector("#resultCard").hidden'), 'test result card shown');
    console.log('       ' + await ev('document.querySelector("#resultCard").innerText.replace(/\\n+/g," | ").slice(0,220)'));
    await shot('e2e-test-result');

    console.log('4. submit');
    await clickSel('#btnSubmit');
    check(await ev('!document.querySelector("#mConfirm").hidden'), 'confirm dialog');
    await clickSel('#cfYes');
    await sleep(700);
    await clickSel('#btnSkip');
    await sleep(7000);
    check(await ev('!document.querySelector("#mResult").hidden'), 'results modal shown');
    const eng = await ev('document.querySelector("#resEng").innerText');
    console.log('       score ' + await ev('document.querySelector("#resScore").textContent') + ' | ' + eng.replace(/\n/g, ' '));
    check(/engineer/i.test(eng) && !/still measuring/.test(eng), 'engineer comparison filled in');
    await shot('e2e-results');
    const share = await ev('Roadle.__shareText()');
    console.log('       --- share text ---\n       ' + share.replace(/\n/g, '\n       '));
    check(/Roadle #\d+/.test(share) && /pts/.test(share), 'share text looks right');
    await clickSel('#btnShare'); await sleep(300);
    await clickSel('#mResult .row [data-close]');
    check(/Submitted/.test(await ev('document.querySelector("#btnSubmit").textContent')), 'submit button locked after submission');

    console.log('5. reload keeps state');
    await open('?dev=1&date=2026-11-18');
    check(/Submitted/.test(await ev('document.querySelector("#btnSubmit").textContent')), 'submission persisted');
    check(await costNow() > 0, 'design persisted');

    console.log('6. the other tools, on a junction with open ground');
    await open('?dev=1&date=2026-11-27');
    const n2 = await ev('(()=>{const L=Roadle.__S.level; return {c:L.nodes[0].c, r:L.nodes[0].r};})()');
    await clickSel('.tool[data-tool="rbt"]'); await worldClick(n2.c + 0.5, n2.r + 0.5);
    check(await costNow() === 100, 'roundabout placed (100)');
    await clickSel('.tool[data-tool="mini"]'); await worldClick(n2.c + 0.5, n2.r + 0.5);
    check(await costNow() === 35, 'mini-roundabout replaces it (35)');
    await clickSel('.tool[data-tool="box"]'); await worldClick(n2.c + 0.5, n2.r + 0.5);
    check(await costNow() === 35, 'box junction refused on a roundabout');
    await clickSel('.tool[data-tool="erase"]'); await worldClick(n2.c + 0.5, n2.r + 0.5);
    check(await costNow() === 0, 'erase clears the junction');
    for (const tool of ['box', 'stop', 'bump', 'banL', 'banR']) {
      await clickSel('.tool[data-tool="' + tool + '"]');
      sp = await ev('(()=>{const s=Roadle.__S.slots.filter(s=>s.ok && !s.active)[0]; return s?[s.x,s.y]:null;})()');
      if (!sp) { check(false, tool + ': no slot offered'); continue; }
      const before = await costNow();
      await worldClick(sp[0], sp[1]);
      check(await costNow() > before, tool + ' placed (' + before + ' → ' + await costNow() + ')');
    }
    await clickSel('#btnForecast'); await sleep(400); await shot('e2e-forecast');
    await clickSel('#btnTest'); await sleep(600); await clickSel('#btnSkip'); await sleep(2500);
    check(await ev('!document.querySelector("#resultCard").hidden'), 'mixed design runs to a result');

    console.log('7. phone layout with left-hand traffic');
    await open('?dev=0&date=2026-11-22', 390, 780, true);
    await ev('(()=>{const s=document.querySelector("#setHand"); s.value="left"; s.dispatchEvent(new Event("change"));})()');
    check(await ev('Roadle.__S.mirror === true'), 'map mirrored for left-hand traffic');
    const over = await ev('document.documentElement.scrollWidth - document.documentElement.clientWidth');
    check(over <= 1, 'no sideways overflow on a 390px phone (overflow ' + over + 'px)');
    if (over > 1) console.log('       widest: ' + await ev('[...document.querySelectorAll("body *")].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,6).map(e=>e.tagName+"."+e.className+"#"+e.id+"="+Math.round(e.getBoundingClientRect().right)).join(", ")'));
    await shot('e2e-phone');
    await ev('window.scrollTo(0, 0); document.querySelector("#btnTest").click()');
    await sleep(3000);
    await shot('e2e-phone-run');
    check(await ev('!!Roadle.__S.sim && Roadle.__S.sim.veh.length > 0'), 'traffic runs on the phone layout');
    check(await ev('document.querySelector("#dev").hidden'), 'dev panel hidden without the flag');

    console.log('\nJS exceptions: ' + (errors.length ? '\n' + errors.join('\n') : 'none'));
    if (logs.length) console.log('console errors:', [...new Set(logs)].slice(0, 8));
    if (errors.length) process.exitCode = 1;
    console.log('screenshots in ' + outDir);
  } catch (e) { console.error('E2E ERROR', e); process.exitCode = 1; }
  finally {
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    edge.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
})();
