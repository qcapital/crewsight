'use strict';
// End-to-end check on ONE PC: starts a relay, launches two real CrewSight instances (pilot + gunner,
// separate profiles), lets them pair, share the primary screen to each other over WebRTC and exchange
// simulated viewpoints, then checks each received the other's video and viewpoint stream.
// Usage: node scripts/selftest.js
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createRelay } = require('../relay/server');
const electron = require('electron');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewsight-selftest-'));
  const relay = createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  await new Promise((r) => relay.wss.once('listening', r));
  const url = process.env.CREWSIGHT_TRANSPORT === 'p2p' ? 'p2p' : `ws://127.0.0.1:${relay.port}`;
  const run = (mode, profile) => new Promise((res) => {
    const exe = process.env.CREWSIGHT_EXE; const p = spawn(exe || electron, exe ? [] : ['.'], { cwd: path.join(__dirname, '..'), stdio: 'ignore',
      env: { ...process.env, CREWSIGHT_PROFILE: 'selftest-' + profile, CREWSIGHT_SELFTEST: `${mode},${dir},${url}` } });
    p.on('exit', res);
  });
  await Promise.all([run('create', 'a'), run('join', 'b')]);
  await relay.close();
  let ok = true;
  for (const m of ['create', 'join']) {
    const f = path.join(dir, `result-${m}.json`);
    if (!fs.existsSync(f)) { console.log(`${m}: NO RESULT`); ok = false; continue; }
    const r = JSON.parse(fs.readFileSync(f, 'utf8'));
    const d = r.diag || {};
    const checks = {
      sessionConnected: r.session.state === 'connected',
       
      viewpointRateHz: d.remoteRateHz, viewpointLive: d.stale === false && !!d.remote,
      outOfOrderRejected: d.stats && d.stats.rejectedOld, gaps: d.stats && d.stats.gaps,
      videoState: d.pcState, videoSize: d.videoSize, videoFps: d.peerFps, myShare: d.shareStatus,
      rttMs: d.rttMs != null ? Math.round(d.rttMs * 10) / 10 : null,
    };
    const pass = checks.sessionConnected && checks.viewpointLive && checks.viewpointRateHz >= 15 &&
      checks.videoState === 'connected' && d.videoSize && d.videoSize[0] > 0 && checks.videoFps > 0;
    ok = ok && pass;
    if (r.metrics && r.metrics.length) {
      const ms = r.metrics.slice(1); // skip startup sample
      const avg = (k) => (ms.reduce((a, x) => a + x[k], 0) / Math.max(1, ms.length)).toFixed(1);
      console.log(`   cpu avg ${avg('cpu')}% max ${Math.max(...ms.map((x) => x.cpu))}% · mem first ${ms[0] && ms[0].memMB}MB last ${ms.at(-1) && ms.at(-1).memMB}MB max ${Math.max(...ms.map((x) => x.memMB))}MB · stale samples ${r.staleSamples}/${r.diagSamples} · last video ${JSON.stringify(ms.at(-1) && ms.at(-1).vsize)}@${ms.at(-1) && ms.at(-1).vfps}fps`);
      fs.writeFileSync(path.join(dir, `metrics-${m}.json`), JSON.stringify(r.metrics));
    }
    console.log(`${m === 'create' ? 'pilot ' : 'gunner'} ${pass ? 'PASS' : 'FAIL'} ${JSON.stringify(checks)}`);
  }
  console.log("artifacts:", dir);
  process.exit(ok ? 0 : 1);
})();
