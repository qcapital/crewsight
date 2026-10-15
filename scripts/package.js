'use strict';
// Produces dist/CrewSight-win32-x64/CrewSight.exe (portable, self-contained) and a .zip of it.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { packager } = require('@electron/packager');

(async () => {
  const root = path.join(__dirname, '..');
  const version = require('../package.json').version;
  // Versioned output folder, so a copy that is currently running doesn't block the build.
  const outDir = path.join(root, 'dist', `v${version}`);
  const native = path.join(root, 'app', 'native', 'RawMouse.exe');
  if (!fs.existsSync(native)) throw new Error('Run npm run build:native first');
  const [out] = await packager({
    dir: root, out: outDir, overwrite: true, platform: 'win32', arch: 'x64',
    name: 'CrewSight', executableName: 'CrewSight', asar: true,
    extraResource: [path.join(root, 'app', 'native')],
    ignore: [/^\/dist/, /^\/tests/, /^\/docs/, /^\/scripts/, /^\/relay/, /^\/\.git/, /\.cs$/, /^\/node_modules\/(electron|@electron)/],
  });
  for (const f of ['README.md', 'LICENSE']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(out, f));
  const zip = path.join(root, 'dist', `CrewSight-${version}-win32-x64.zip`);
  if (fs.existsSync(zip)) fs.rmSync(zip);
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${out}\\*' -DestinationPath '${zip}'`]);
  console.log('Packaged:', out, '\nZip:', zip, `(${(fs.statSync(zip).size / 1e6).toFixed(1)} MB)`);
})().catch((e) => { console.error(e); process.exit(1); });
