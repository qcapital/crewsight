'use strict';
// Separate Electron process showing the synthetic turning scene (scripts/pantest.html), so a CrewSight instance
// can capture it (Electron doesn't list its own windows as capture sources). Used by scripts/selftest.js.
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(() => {
  // Frameless and exactly 16:9 like a borderless game, so the captured picture is a clean 90° view.
  // Placed on a secondary monitor when there is one, so the pilot instance (sharing the primary screen) doesn't see it.
  const { screen } = require('electron');
  const other = screen.getAllDisplays().find((d) => d.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay();
  const w = new BrowserWindow({ width: 640, height: 360, x: other.workArea.x + 60, y: other.workArea.y + 60, frame: false, useContentSize: true, title: 'PanTest', webPreferences: { backgroundThrottling: false } });
  w.loadFile(path.join(__dirname, 'pantest.html'), { query: { rate: process.env.PAN_RATE || '15' } });
  // A still scene for the pilot instance, so its helicopter-rotation estimate isn't disturbed by desktop activity.
  const still = new BrowserWindow({ width: 640, height: 360, x: other.workArea.x + 60, y: other.workArea.y + 460, frame: false, useContentSize: true, title: 'StillTest', webPreferences: { backgroundThrottling: false } });
  still.loadFile(path.join(__dirname, 'pantest.html'), { query: { rate: '0', title: 'StillTest' } });
  setTimeout(() => app.quit(), Number(process.env.PAN_MS || 30000));
});
