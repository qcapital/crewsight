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
  if (process.env.CREWSIGHT_PANTEST) spawn(electron, [path.join(__dirname, 'panwin.js')], { stdio: 'ignore', env: { ...process.env, PAN_MS: String(Number(process.env.CREWSIGHT_SELFTEST_MS || 15000) + 15000) } });
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
      marks: (r.marksSeen || []).map((k) => `${k.mine ? 'sent' : 'received'} az=${k.az} img=${Math.round(k.imgBytes / 1024)}KB worldLocked=${k.hasQ}`).join('; '),
      attDiag: d.attDiag,
      hudDrawn: r.hud ? `${r.hud.hudDrawn}/${r.hud.hudSamples}` : null, hudLast: r.hud && r.hud.hudLast, attitude: r.hud && r.hud.hudLast && r.hud.hudLast.att,
    };
    const pass = checks.sessionConnected && checks.viewpointLive && checks.viewpointRateHz >= 15 &&
      checks.videoState === 'connected' && d.videoSize && d.videoSize[0] > 0 && checks.videoFps > 0 &&
      r.hud && r.hud.hudDrawn >= 6 && // >= 3 s of drawing; connection setup time varies

      (m === 'create' ? (r.marksSeen || []).some((k) => k.mine) : (r.marksSeen || []).some((k) => !k.mine && k.az !== null && (process.env.CREWSIGHT_TRANSPORT !== 'p2p' || k.imgBytes > 1000) && k.hasQ)) &&
      !!(r.hud && r.hud.hudLast && r.hud.hudLast.att && r.hud.hudLast.att.fresh);
    let panOk = true;
    if (m === 'join' && r.panSnap && r.panSnap.zeroYaw !== null) {
      const turned = r.panSnap.trueYaw - r.panSnap.zeroYaw, err = r.panSnap.estAz - turned;
      panOk = Math.abs(err) <= Math.max(3, 0.08 * Math.abs(turned)) && Math.abs(r.panSnap.estEl) < 3;
      console.log(`   screen-centre tracking: scene turned ${turned.toFixed(1)}°, gunner measured ${r.panSnap.estAz.toFixed(1)}° (error ${err.toFixed(1)}°), vertical drift ${r.panSnap.estEl.toFixed(1)}° → ${panOk ? 'OK' : 'TOO FAR OFF'}`);
    }
    ok = ok && pass && panOk;
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
