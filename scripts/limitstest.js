'use strict';
// Gun-limit recording through the real app: synthetic trace with pushes into stops. Usage: node scripts/limitstest.js
const { spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const electron = require('electron');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewsight-limits-'));
spawnSync(process.env.CREWSIGHT_EXE || electron, process.env.CREWSIGHT_EXE ? [] : ['.'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', timeout: 60000,
  env: { ...process.env, CREWSIGHT_PROFILE: 'limitstest', CREWSIGHT_SELFTEST: `limits,${dir}` } });
const f = path.join(dir, 'limits.json');
if (!fs.existsSync(f)) { console.log('NO RESULT'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(f, 'utf8'));
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const pass = r.saved && near(r.azMax, 40, 3) && near(r.azMin, -60, 3) && near(r.elTop, 20, 3) && near(r.elBottom, -30, 3) &&
  near(r.atStop, r.azMax, 0.01) && near(r.back, r.azMax - 40, 0.5) && r.method === 'visual-stop-detection';
console.log(JSON.stringify(r));
console.log(pass ? 'PASS: true limits recorded despite pushing 15° up and 30° right into the stops; aim clamps with no drift'
  : 'FAIL');
process.exit(pass ? 0 : 1);
