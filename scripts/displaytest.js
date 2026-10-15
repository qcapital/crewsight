'use strict';
// Dot alignment on every monitor / overlay size / aspect ratio, at 100% and emulated 150% and 200% scale,
// plus click-through and topmost checks via Win32. Usage: node scripts/displaytest.js
const { spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const electron = require('electron');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewsight-display-'));
let ok = true;
for (const scale of [1, 1.5, 2]) {
  const args = ['.', ...(scale !== 1 ? [`--force-device-scale-factor=${scale}`] : [])];
  spawnSync(electron, args, { cwd: path.join(__dirname, '..'), stdio: 'ignore', timeout: 120000,
    env: { ...process.env, CREWSIGHT_PROFILE: 'displaytest', CREWSIGHT_SELFTEST: `display,${dir}` } });
  const f = path.join(dir, `display-${scale}.json`);
  if (!fs.existsSync(f)) { console.log(`scale ${scale}: NO RESULT`); ok = false; continue; }
  const { results, clickThrough } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const missing = results.filter((r) => !r.pixels);
  const errs = results.filter((r) => r.pixels).map((r) => r.errDip);
  const maxErr = Math.max(...errs);
  // Out-of-range (az 120) draws an edge arrow; its centroid is offset from the clamp point by design.
  const inRangeMax = Math.max(...results.filter((r) => r.pixels && r.inRange).map((r) => r.errDip));
  const ctOk = clickThrough.hitBefore === 'overlay' && clickThrough.hitAfter === 'other' && clickThrough.topmost;
  const pass = !missing.length && inRangeMax <= 2 && ctOk;
  ok = ok && pass;
  console.log(`scale ${scale}: ${pass ? 'PASS' : 'FAIL'} · ${results.length} placements on displays ${[...new Set(results.map((r) => r.display))].join(',')} · ` +
    `in-range max error ${inRangeMax.toFixed(2)} DIP · edge-arrow max offset ${maxErr.toFixed(1)} DIP · missing ${missing.length} · click-through ${JSON.stringify(clickThrough)}`);
}
console.log('artifacts:', dir);
process.exit(ok ? 0 : 1);
