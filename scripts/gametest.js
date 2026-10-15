'use strict';
// Overlay-over-game check. Start the game first, then: node scripts/gametest.js <gamePid>
// Run once with the game in borderless and once in exclusive fullscreen.
const { spawnSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const electron = require('electron');
const pid = process.argv[2];
if (!/^\d+$/.test(pid || '')) { console.error('usage: node scripts/gametest.js <gamePid>'); process.exit(2); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewsight-game-'));
spawnSync(electron, ['.'], { cwd: path.join(__dirname, '..'), stdio: 'ignore', timeout: 60000,
  env: { ...process.env, CREWSIGHT_PROFILE: 'gametest', CREWSIGHT_NO_CONTENT_PROTECTION: '1', CREWSIGHT_SELFTEST: `game,${dir},${pid}` } });
const f = path.join(dir, 'game.json');
if (!fs.existsSync(f)) { console.log('NO RESULT'); process.exit(1); }
const r = JSON.parse(fs.readFileSync(f, 'utf8'));
console.log(JSON.stringify(r, null, 2));
console.log(r.overlay.visibleMagentaPixelsInScreenshot > 20 ? 'OVERLAY VISIBLE ABOVE GAME' : 'OVERLAY NOT VISIBLE ABOVE GAME');
console.log('screenshot:', path.join(dir, 'desktop.png'));
