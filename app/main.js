'use strict';
// CrewSight main process: windows, hotkeys, tray, config, raw-input helper, tracking loop, session.
const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../core/config');
const P = require('../core/protocol');
const { MouseTracker, emptyCalibration, solveAxis } = require('../core/tracker');
const { SessionClient } = require('../core/netClient');

// Allows a second instance on one PC for testing: CREWSIGHT_PROFILE=b npm start
if (process.env.CREWSIGHT_PROFILE) app.setPath('userData', app.getPath('userData') + '-' + process.env.CREWSIGHT_PROFILE);
if (!app.requestSingleInstanceLock()) { app.quit(); }

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const LOG_FILE = () => path.join(app.getPath('userData'), 'crewsight.log');
let cfg, overlayWin, controlWin, hudWin, tray, helper = null;
const state = {
  overlayVisible: true, clickThrough: false, trackingObserve: false,
  hotkeyFailures: [], helperStatus: 'stopped', helperLastBeat: 0,
  session: { state: 'idle', code: null, role: null, seats: null, rttMs: null, error: null },
  manual: { az: 0, el: 0 }, seq: 0, epoch: newEpoch(), cal: null, capture: { status: 'none' },
};
const tracker = new MouseTracker(emptyCalibration('gunner'));
const net = new SessionClient();

function newEpoch() { return crypto.randomBytes(6).toString('hex'); }
function log(level, msg, data) {
  // Structured log; never contains raw mouse streams, session tokens or video.
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...data }) + '\n';
  try { fs.appendFileSync(LOG_FILE(), line); } catch {}
}
function saveCfg() { try { config.save(CONFIG_FILE(), cfg); } catch (e) { log('error', 'config-save', { e: e.message }); } }
const toControl = (ch, d) => controlWin && !controlWin.isDestroyed() && controlWin.webContents.send(ch, d);
const toOverlay = (ch, d) => overlayWin && !overlayWin.isDestroyed() && overlayWin.webContents.send(ch, d);
const toHud = (ch, d) => hudWin && !hudWin.isDestroyed() && hudWin.webContents.send(ch, d);
const broadcast = (ch, d) => { toControl(ch, d); toOverlay(ch, d); };

function activeCalibration() {
  const c = cfg.calibrations[cfg.role];
  return c && c.role === cfg.role ? c : emptyCalibration(cfg.role);
}
function applyCalibration() {
  tracker.setCalibration(activeCalibration());
  state.epoch = newEpoch(); state.seq = 0; // receivers restart their sequence space
  restartHelper();
}

// ---------- windows ----------
function createOverlay() {
  const o = cfg.overlay;
  const wa = screen.getPrimaryDisplay().workArea;
  overlayWin = new BrowserWindow({
    x: o.x ?? wa.x + wa.width - o.width - 24, y: o.y ?? wa.y + 24, width: o.width, height: o.height,
    minWidth: 200, minHeight: 130, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    resizable: true, hasShadow: false, show: false, title: 'CrewSight Overlay',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.once('ready-to-show', () => { if (state.overlayVisible) overlayWin.showInactive();
    if (!process.env.CREWSIGHT_NO_CONTENT_PROTECTION) overlayWin.setContentProtection(true); // WDA_EXCLUDEFROMCAPTURE: keep the overlay out of screen shares (test switch only)
    pushOverlayConfig(); });
  const persist = () => { const b = overlayWin.getBounds(); Object.assign(cfg.overlay, { x: b.x, y: b.y, width: b.width, height: b.height }); saveCfg(); };
  overlayWin.on('moved', persist); overlayWin.on('resized', persist);
  overlayWin.on('closed', () => { overlayWin = null; });
}
// Full-screen, permanently click-through HUD on the game's monitor: crew member's dot in MY view.
function hudDisplay() {
  const all = screen.getAllDisplays();
  return all.find((d) => String(d.id) === String(cfg.hud.displayId)) || screen.getPrimaryDisplay();
}
function createHud() {
  if (hudWin && !hudWin.isDestroyed()) hudWin.destroy();
  const b = hudDisplay().bounds;
  hudWin = new BrowserWindow({ x: b.x, y: b.y, width: b.width, height: b.height, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, movable: false, hasShadow: false, show: false,
    title: 'CrewSight HUD', webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  hudWin.setAlwaysOnTop(true, 'screen-saver');
  hudWin.setIgnoreMouseEvents(true);
  hudWin.loadFile(path.join(__dirname, 'renderer', 'hud.html'));
  hudWin.once('ready-to-show', () => {
    hudWin.setBounds(b); // exact fit even when the display scale differs from the primary
    if (cfg.hud.enabled) hudWin.showInactive();
    if (!process.env.CREWSIGHT_NO_CONTENT_PROTECTION) hudWin.setContentProtection(true);
    pushOverlayConfig();
  });
  hudWin.on('closed', () => { hudWin = null; });
}
function setHudEnabled(on) {
  cfg.hud.enabled = on; saveCfg(); pushOverlayConfig();
  if (hudWin) on ? hudWin.showInactive() : hudWin.hide();
  pushStatus(); refreshTray();
}

function createControl() {
  if (controlWin && !controlWin.isDestroyed()) { controlWin.show(); controlWin.focus(); return; }
  controlWin = new BrowserWindow({
    width: 900, height: 720, minWidth: 720, minHeight: 560, title: 'CrewSight', backgroundColor: '#111316',
    autoHideMenuBar: true, webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  controlWin.once('ready-to-show', () => controlWin.setContentProtection(true));
  controlWin.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  controlWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); controlWin.hide(); } });
}
function pushOverlayConfig() {
  toHud('config', { hud: cfg.hud, dot: cfg.dot, smoothing: cfg.smoothing, network: cfg.network, role: cfg.role });
  toOverlay('config', { overlay: cfg.overlay, dot: cfg.dot, projection: cfg.projection, smoothing: cfg.smoothing,
    network: cfg.network, role: cfg.role, share: cfg.share });
  toOverlay('mode', { clickThrough: state.clickThrough });
}

function setClickThrough(on) {
  state.clickThrough = on;
  if (overlayWin) {
    overlayWin.setIgnoreMouseEvents(on);
    overlayWin.setFocusable(!on);
  }
  toOverlay('mode', { clickThrough: on }); pushStatus(); refreshTray();
}
function setOverlayVisible(v) {
  state.overlayVisible = v;
  if (overlayWin) v ? overlayWin.showInactive() : overlayWin.hide();
  pushStatus(); refreshTray();
}
function setObserve(on) {
  state.trackingObserve = on; cfg.tracking.observeInput = on; saveCfg();
  restartHelper(); pushStatus(); refreshTray();
}

// ---------- hotkeys ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  state.hotkeyFailures = [];
  const actions = {
    toggleOverlay: () => setOverlayVisible(!state.overlayVisible),
    toggleClickThrough: () => setClickThrough(!state.clickThrough),
    openSettings: () => createControl(),
    recalibrate: () => { createControl(); toControl('goto', 'tracking'); },
    toggleTracking: () => setObserve(!state.trackingObserve),
    zero: () => { tracker.zero(performance.now()); toControl('toast', 'Tracking re-zeroed to the nose'); },
    calMark: () => calMark(),
    toggleHud: () => setHudEnabled(!cfg.hud.enabled),
  };
  for (const [name, fn] of Object.entries(actions)) {
    const acc = cfg.hotkeys[name];
    if (!acc) continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, fn); } catch { ok = false; }
    if (!ok) state.hotkeyFailures.push({ name, accelerator: acc });
  }
  if (state.hotkeyFailures.length) log('warn', 'hotkey-conflicts', { failures: state.hotkeyFailures });
  pushStatus();
}

// ---------- tray ----------
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open CrewSight', click: createControl },
    { label: state.overlayVisible ? 'Hide overlay' : 'Show overlay', click: () => setOverlayVisible(!state.overlayVisible) },
    { label: 'Crew dot on my screen (HUD)', type: 'checkbox', checked: !!(cfg && cfg.hud.enabled), click: (i) => setHudEnabled(i.checked) },
    { label: 'Click-through', type: 'checkbox', checked: state.clickThrough, click: (i) => setClickThrough(i.checked) },
    { label: 'Observe my mouse for tracking', type: 'checkbox', checked: state.trackingObserve, click: (i) => setObserve(i.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]));
}
function createTray() {
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPklEQVR4nGNgGAWjYBSMglEwCkbBKBgFgwUw/v//n4GBgYGBiYGBgZGBgeE/AwPDfwYGBgYmBgaG/wwjEgAAa/kEEbm4TacAAAAASUVORK5CYII=');
  tray = new Tray(icon); tray.setToolTip('CrewSight'); tray.on('click', createControl); refreshTray();
}

// ---------- raw-input helper (user-authorised, read-only) ----------
function helperPath() {
  const packed = path.join(process.resourcesPath || '', 'native', 'RawMouse.exe');
  return fs.existsSync(packed) ? packed : path.join(__dirname, 'native', 'RawMouse.exe');
}
function stopHelper() {
  if (helper) { try { helper.stdin.end(); helper.kill(); } catch {} helper = null; }
  tracker.inputHealthy = false; state.helperStatus = 'stopped';
}
function restartHelper() {
  stopHelper();
  const needed = state.trackingObserve && (cfg.tracking.mode === 'mouse' || state.cal);
  if (!needed) { pushStatus(); return; }
  const exe = helperPath();
  if (!fs.existsSync(exe)) { state.helperStatus = 'missing'; log('error', 'helper-missing', { exe }); pushStatus(); return; }
  const c = activeCalibration();
  const args = [];
  if (cfg.role === 'pilot' && c.pilotFreelookVk) args.push('--vk', c.pilotFreelookVk.toString(16));
  if (cfg.tracking.foregroundFilter) args.push('--fg', cfg.tracking.foregroundFilter);
  const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  helper = child; state.helperStatus = 'starting';
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { onHelperLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
    if (buf.length > 4096) buf = '';
  });
  child.on('exit', (code) => {
    if (helper !== child) return;
    helper = null; tracker.inputHealthy = false; state.helperStatus = `exited (${code})`;
    log('warn', 'helper-exit', { code }); pushStatus();
  });
}
function onHelperLine(line) {
  state.helperLastBeat = performance.now();
  if (state.helperStatus !== 'running') { state.helperStatus = 'running'; tracker.inputHealthy = true; pushStatus(); }
  const [k, a, b] = line.split(' ');
  if (k === 'M') {
    const dx = Number(a), dy = Number(b);
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    tracker.addDelta(dx, dy);
    if (state.cal) { state.cal.cx += dx; state.cal.cy += dy; }
  } else if (k === 'K') tracker.setFreelook(a === '1');
  else if (k === 'F') { tracker.focusOk = cfg.tracking.foregroundFilter ? a === '1' : true; pushStatus(); }
  else if (k === 'E') { state.helperStatus = 'error ' + a; pushStatus(); }
}

// ---------- calibration ----------
// Steps per axis: zero -> pos -> return -> neg. Marks come from the UI button or the calMark hotkey.
const CAL_STEPS = ['x-zero', 'x-pos', 'x-return', 'x-neg', 'y-zero', 'y-pos', 'y-return', 'y-neg'];
function calStart(opts) {
  state.cal = { step: 0, cx: 0, cy: 0, base: 0, marks: {}, refX: Number(opts.refX) || 90, refY: Number(opts.refY) || 45,
    skipY: !!opts.skipY, freelookVk: opts.freelookVk, recenterOnRelease: opts.recenterOnRelease !== false };
  if (!state.trackingObserve) setObserve(true); else restartHelper();
  pushCal();
}
function calMark() {
  const c = state.cal; if (!c) return;
  const name = CAL_STEPS[c.step];
  const axis = name[0];
  const cur = axis === 'x' ? c.cx : c.cy;
  if (name.endsWith('zero')) c.base = cur; else c.marks[name] = cur - c.base;
  c.step++;
  if (c.skipY && c.step === 4) c.step = CAL_STEPS.length;
  if (c.step >= CAL_STEPS.length) calFinish(); else pushCal();
}
function calFinish() {
  const c = state.cal;
  const sx = solveAxis({ refDeg: c.refX, countsPos: c.marks['x-pos'], countsReturn: c.marks['x-return'], countsNeg: c.marks['x-neg'] });
  let sy;
  if (c.skipY) sy = { valid: sx.valid, degPerCount: sx.degPerCount, sign: -1,
    checks: [{ name: 'vertical-assumed', pass: true, detail: 'ASSUMED equal to horizontal scale, mouse-up = look-up (not measured)' }] };
  else {
    sy = solveAxis({ refDeg: c.refY, countsPos: c.marks['y-pos'], countsReturn: c.marks['y-return'], countsNeg: c.marks['y-neg'] });
    // Mouse "up" yields negative raw dy; the user was asked to look UP for the positive swing.
  }
  const cal = { ...emptyCalibration(cfg.role), valid: sx.valid && sy.valid,
    degPerCountX: sx.degPerCount, degPerCountY: sy.degPerCount, signX: sx.sign, signY: sy.sign,
    pilotFreelookVk: cfg.role === 'pilot' ? (c.freelookVk || 0x12) : null, recenterOnRelease: c.recenterOnRelease,
    createdAt: new Date().toISOString(), refX: c.refX, refY: c.skipY ? null : c.refY, verticalAssumed: c.skipY,
    checks: [...sx.checks.map((k) => ({ axis: 'horizontal', ...k })), ...sy.checks.map((k) => ({ axis: 'vertical', ...k }))] };
  state.cal = null;
  if (cal.valid) { cfg.calibrations[cfg.role] = cal; saveCfg(); applyCalibration(); }
  log('info', 'calibration-finished', { role: cfg.role, valid: cal.valid });
  toControl('cal-result', cal); pushCal(); pushStatus();
}
function pushCal() { toControl('cal-state', state.cal ? { step: CAL_STEPS[state.cal.step], index: state.cal.step, skipY: state.cal.skipY } : null); }

// ---------- local estimate + send loop ----------
function localEstimate(now) {
  const mode = cfg.tracking.mode;
  if (mode === 'simulated') {
    const t = now / 1000;
    return { az: 70 * Math.sin(t * 0.6), el: 25 * Math.sin(t * 0.9), src: 'simulated', st: 'LIVE_SIMULATED', cal: false };
  }
  if (mode === 'manual') return { az: state.manual.az, el: state.manual.el, src: 'manual', st: 'LIVE_MANUAL', cal: false };
  if (!state.trackingObserve && !activeCalibration().noseOnly) {
    const c = activeCalibration();
    return { az: null, el: null, src: 'none', st: c.valid ? 'UNAVAILABLE' : 'UNCALIBRATED', cal: c.valid };
  }
  if (state.cal) return { az: null, el: null, src: 'none', st: 'CALIBRATING', cal: false };
  // Helper heartbeat lost -> unavailable rather than frozen.
  if (helper && state.helperStatus === 'running' && now - state.helperLastBeat > 2500) tracker.inputHealthy = false;
  return tracker.estimate();
}
let loopTimer = null;
function startLoop() {
  clearInterval(loopTimer);
  const hz = Math.max(5, Math.min(60, cfg.network.sendHz));
  loopTimer = setInterval(() => {
    const now = performance.now();
    const est = localEstimate(now);
    const msg = { seq: state.seq++, ts: Math.round(now), epoch: state.epoch, ...est };
    if (msg.az !== null) { msg.az = Math.round(msg.az * 100) / 100; msg.el = Math.round(msg.el * 100) / 100; }
    if (net.state === 'connected') net.sendViewpoint(msg);
    toControl('local', { ...msg, freelook: tracker.freelookHeld, focusOk: tracker.focusOk });
    toOverlay('local', msg);
    toHud('local', msg);
  }, 1000 / hz);
}

// ---------- session ----------
net.on('status', (s) => { state.session.state = s.state; state.session.detail = s.detail; pushStatus(); });
net.on('joined', (j) => { state.session.code = P.formatCode(j.code); state.session.role = j.role; state.session.error = null; pushStatus(); });
net.on('presence', (seats) => { state.session.seats = seats; pushStatus(); });
net.on('rtt', (ms) => { state.session.rttMs = ms; });
net.on('error', (code) => { state.session.error = code; log('warn', 'net-error', { code }); pushStatus(); });
net.on('viewpoint', (m) => { toOverlay('remote', m); toHud('remote', m); });
ipcMain.on('remote-vp', (_e, m) => toHud('remote', m)); // P2P: overlay renderer owns the data channel
net.on('signal', (s) => toOverlay('signal', s));
function pushPeer() {
  const s = state.session; const other = s.role === 'pilot' ? 'gunner' : 'pilot';
  if (!(s.seats && s.seats[other])) toHud('reset-remote');
  toOverlay('peer', { inSession: s.state === 'connected', present: !!(s.seats && s.seats[other]), polite: s.role === 'gunner' });
}

function pushStatus() {
  pushPeer();
  const c = activeCalibration();
  broadcast('status', {
    role: cfg.role, overlayVisible: state.overlayVisible, clickThrough: state.clickThrough,
    trackingObserve: state.trackingObserve, trackingMode: cfg.tracking.mode, helperStatus: state.helperStatus,
    focusOk: tracker.focusOk, hotkeyFailures: state.hotkeyFailures, session: { ...state.session },
    calibration: { valid: c.valid, noseOnly: !!c.noseOnly, createdAt: c.createdAt, verticalAssumed: !!c.verticalAssumed },
    capture: state.capture,
  });
}

// ---------- IPC ----------
ipcMain.handle('get-config', () => cfg);
ipcMain.handle('get-defaults', () => config.DEFAULTS);
ipcMain.handle('list-displays', () => screen.getAllDisplays().map((d, i) => ({ id: String(d.id), label: `Display ${i + 1}: ${d.size.width}×${d.size.height}${d.id === screen.getPrimaryDisplay().id ? ' (primary)' : ''}` })));
ipcMain.handle('set-config', (_e, patch) => {
  const roleChanged = patch.role && patch.role !== cfg.role;
  cfg = config.mergeTyped(config.DEFAULTS, { ...cfg, ...patch });
  saveCfg(); pushOverlayConfig();
  if (patch.hotkeys) registerHotkeys();
  if (patch.hud) { createHud(); }
  if (patch.network) startLoop();
  if (roleChanged || patch.tracking) applyCalibration();
  if (roleChanged && state.session.state !== 'idle') { sessionLeave(); toControl('toast', 'Role changed: left the session. Re-join with the new role.'); }
  pushStatus();
  return cfg;
});
ipcMain.handle('reset-config', () => { cfg = structuredClone(config.DEFAULTS); saveCfg(); registerHotkeys(); applyCalibration(); pushOverlayConfig(); pushStatus(); return cfg; });
ipcMain.handle('reset-calibration', () => { cfg.calibrations[cfg.role] = null; saveCfg(); applyCalibration(); pushStatus(); });
ipcMain.handle('set-nose-only', () => {
  cfg.calibrations[cfg.role] = { ...emptyCalibration(cfg.role), valid: true, noseOnly: true, createdAt: new Date().toISOString(),
    checks: [{ name: 'nose-only', pass: true, detail: 'User declared the camera is fixed to the nose; direction is ASSUMED 0,0' }] };
  saveCfg(); applyCalibration(); pushStatus();
});
ipcMain.handle('list-sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 240, height: 135 } });
  return sources.filter((s) => !/^CrewSight/.test(s.name))
    .map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
ipcMain.handle('source-alive', async (_e, id, name) => {
  // Used for recovery: is the same window still present, or a window with the same title?
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } });
  return sources.find((s) => s.id === id) || (name && sources.find((s) => s.name === name)) || null;
});
ipcMain.on('select-source', (_e, src) => { cfg.share.lastSourceName = src ? src.name : null; saveCfg(); toOverlay('source', src); });
ipcMain.on('signal-out', (_e, kind, data) => { if (net.state === 'connected') net.sendSignal(kind, data); });
ipcMain.on('overlay-diag', (_e, d) => toControl('diag', { ...d, rttMs: net.rttMs, helperStatus: state.helperStatus }));
ipcMain.on('capture-status', (_e, s) => { state.capture = s; pushStatus(); });
function sessionCreate(url) {
  state.session.error = null;
  if (cfg.network.transport === 'p2p') toOverlay('p2p-cmd', { op: 'create', role: cfg.role });
  else { cfg.relayUrl = url || cfg.relayUrl; saveCfg(); net.create(cfg.relayUrl, cfg.role); }
}
function sessionJoin(url, code) {
  state.session.error = null;
  if (cfg.network.transport === 'p2p') toOverlay('p2p-cmd', { op: 'join', code, role: cfg.role });
  else { cfg.relayUrl = url || cfg.relayUrl; saveCfg(); net.join(cfg.relayUrl, code, cfg.role); }
}
function sessionLeave() {
  net.leave(); toOverlay('p2p-cmd', { op: 'leave' });
  state.session = { state: 'idle', code: null, role: null, seats: null, rttMs: null, error: null }; pushStatus();
}
ipcMain.on('session-create', (_e, url) => sessionCreate(url));
ipcMain.on('session-join', (_e, url, code) => sessionJoin(url, code));
ipcMain.on('session-leave', () => sessionLeave());
ipcMain.on('p2p-status', (_e, s) => {
  if (cfg.network.transport !== 'p2p') return;
  // p2p 'waiting' (host, nobody yet) is shown like a connected lobby without the crew member.
  state.session = { state: ['waiting', 'connected'].includes(s.state) ? 'connected' : s.state, code: s.code, role: s.role,
    seats: s.seats, rttMs: s.rttMs, error: s.error, detail: s.state === 'waiting' ? 'waiting' : null };
  pushStatus();
});
ipcMain.on('set-manual', (_e, m) => { if (Number.isFinite(m.az) && Number.isFinite(m.el)) state.manual = { az: Math.max(-180, Math.min(180, m.az)), el: Math.max(-90, Math.min(90, m.el)) }; });
ipcMain.on('set-overlay-visible', (_e, v) => setOverlayVisible(!!v));
ipcMain.on('set-click-through', (_e, v) => setClickThrough(!!v));
ipcMain.on('set-observe', (_e, v) => setObserve(!!v));
ipcMain.on('zero', () => tracker.zero(performance.now()));
ipcMain.on('cal-start', (_e, o) => calStart(o || {}));
ipcMain.on('cal-mark', () => calMark());
ipcMain.on('cal-cancel', () => { state.cal = null; pushCal(); });
ipcMain.on('first-run-done', () => { cfg.firstRunDone = true; saveCfg(); });
ipcMain.on('request-status', () => { pushStatus(); pushOverlayConfig(); pushCal(); });
ipcMain.on('open-settings', () => createControl());
ipcMain.handle('session-rtt', () => net.rttMs);

// ---------- lifecycle ----------
app.whenReady().then(() => {
  const loaded = config.load(CONFIG_FILE());
  cfg = loaded.config;
  if (loaded.recovered) log('warn', 'config-recovered-defaults', {});
  state.trackingObserve = !!cfg.tracking.observeInput;
  tracker.setCalibration(activeCalibration());
  createOverlay(); createHud(); createControl();
  screen.on('display-metrics-changed', () => createHud()); screen.on('display-removed', () => createHud()); screen.on('display-added', () => createHud()); createTray(); registerHotkeys(); restartHelper(); startLoop();
  if (loaded.recovered) setTimeout(() => toControl('toast', 'Settings file was unreadable; defaults restored (old file backed up).'), 1500);
  log('info', 'started', { version: app.getVersion() });
  const st = process.env.CREWSIGHT_SELFTEST;
  if (st && st.startsWith('display,')) overlayWin.webContents.once('did-finish-load', () => runDisplayTest(st.split(',')[1]));
  else if (st && st.startsWith('game,')) overlayWin.webContents.once('did-finish-load', () => runGameTest(st.split(',')[1], st.split(',')[2]));
  else if (st) runSelfTest(st);
});

// Automated display check (scripts/displaytest.js): dot pixel alignment on every monitor and several
// overlay sizes, plus Win32 hit-testing of click-through and topmost. CREWSIGHT_SELFTEST=display,<dir>
async function runDisplayTest(dir) {
  const { project, contentRect } = require('../core/projection');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  Object.assign(cfg.dot, { color: '#ff00ff', halo: false, size: 16, opacity: 1, hideWhenStale: false });
  Object.assign(cfg.smoothing, { interpolate: false, visualTauMs: 0 });
  cfg.network.staleMs = 100000; cfg.overlay.crop = { x: 0, y: 0, w: 1, h: 1 }; cfg.projection = { ...config.DEFAULTS.projection };
  setClickThrough(false); pushOverlayConfig();
  await wait(1500);
  let seq = 0; const results = [];
  const send = (az, el) => toOverlay('remote', { t: 'vp', seq: seq++, ts: 0, epoch: 'disp', az, el, src: 'manual', st: 'LIVE_MANUAL', cal: false, from: 'x' });
  for (const d of screen.getAllDisplays()) {
    for (const [w, h] of [[640, 400], [420, 640], [960, 300]]) {
      overlayWin.setBounds({ x: d.workArea.x + 40, y: d.workArea.y + 40, width: w, height: h });
      for (const [az, el] of [[0, 0], [45, 20], [-60, -30], [120, 0]]) {
        send(az, el); await wait(350); send(az, el); await wait(150);
        const img = await overlayWin.webContents.capturePage();
        const { width: iw, height: ih } = img.getSize(); const bmp = img.toBitmap(); // BGRA
        let sx = 0, sy = 0, n = 0;
        for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
          const i = (y * iw + x) * 4;
          if (bmp[i] > 200 && bmp[i + 1] < 60 && bmp[i + 2] > 200) { sx += x; sy += y; n++; }
        }
        const [cw, ch] = overlayWin.getContentSize();
        const r = contentRect(16, 9, cw, ch - 24); r.y += 24;
        const p = project({ az, el }, cfg.projection);
        const ex = r.x + p.x * r.w, ey = r.y + p.y * r.h;
        const k = iw / cw; // physical px per DIP
        const gx = n ? sx / n / k : null, gy = n ? sy / n / k : null;
        const err = n ? Math.hypot(gx - ex, gy - ey) : null;
        results.push({ display: d.id, scale: d.scaleFactor, size: [w, h], az, el, inRange: p.inRange, pixels: n,
          expected: [+ex.toFixed(1), +ey.toFixed(1)], got: n ? [+gx.toFixed(1), +gy.toFixed(1)] : null, errDip: err && +err.toFixed(2) });
      }
    }
  }
  // Click-through + topmost via Win32 (independent of Electron's own view of itself).
  const hwnd = overlayWin.getNativeWindowHandle().readBigUInt64LE(0).toString();
  const b = overlayWin.getBounds(); const disp = screen.getDisplayMatching(b);
  const phys = screen.dipToScreenPoint({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  const ps = (hitOnly) => new Promise((res) => {
    const script = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class W{[StructLayout(LayoutKind.Sequential)]public struct P{public int X,Y;}[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(P p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);}';$p=New-Object W+P;$p.X=${Math.round(phys.x)};$p.Y=${Math.round(phys.y)};$h=[W]::GetAncestor([W]::WindowFromPoint($p),2);$ex=[W]::GetWindowLong([IntPtr]${hwnd},-20);"$h $ex"`;
    const c = spawn('powershell', ['-NoProfile', '-Command', script]); let out = '';
    c.stdout.on('data', (x) => (out += x)); c.on('exit', () => res(out.trim()));
  });
  const before = (await ps()).split(' ');
  setClickThrough(true); await wait(500);
  const after = (await ps()).split(' ');
  const exAfter = Number(after[1]);
  const clickThrough = {
    hitBefore: before[0] === hwnd ? 'overlay' : 'other', hitAfter: after[0] === hwnd ? 'overlay' : 'other',
    topmost: !!(exAfter & 0x8), transparentStyle: !!(exAfter & 0x20), noActivate: !overlayWin.isFocusable(), display: disp.id,
  };
  fs.writeFileSync(path.join(dir, `display-${screen.getPrimaryDisplay().scaleFactor}.json`), JSON.stringify({ results, clickThrough }, null, 2));
  app.isQuitting = true; app.quit();
}

// Over-the-game check (scripts/gametest.js): overlay with a magenta test dot placed on the game's monitor in
// click-through mode, then a real desktop screenshot (GDI) and Windows' fullscreen state. CREWSIGHT_SELFTEST=game,<dir>,<pid>
async function runGameTest(dir, pid) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  Object.assign(cfg.dot, { color: '#ff00ff', halo: false, size: 24, opacity: 1 });
  cfg.network.staleMs = 100000; pushOverlayConfig();
  const ps = (script) => new Promise((res) => {
    const c = spawn('powershell', ['-NoProfile', '-Command', script]); let out = '';
    c.stdout.on('data', (x) => (out += x)); c.stderr.on('data', (x) => (out += x)); c.on('exit', () => res(out.trim()));
  });
  const info = JSON.parse(await ps(`Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class G{[StructLayout(LayoutKind.Sequential)]public struct R{public int L,T,Ri,B;}[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);[DllImport("user32.dll")]public static extern int GetWindowLong(IntPtr h,int i);[DllImport("shell32.dll")]public static extern int SHQueryUserNotificationState(out int s);}';$h=(Get-Process -Id ${pid}).MainWindowHandle;$r=New-Object G+R;[void][G]::GetWindowRect($h,[ref]$r);$s=0;[void][G]::SHQueryUserNotificationState([ref]$s);@{rect=@($r.L,$r.T,$r.Ri,$r.B);style=[G]::GetWindowLong($h,-16);exStyle=[G]::GetWindowLong($h,-20);quns=$s}|ConvertTo-Json -Compress`));
  const [L, T, R, B] = info.rect;
  const gameDisplay = screen.getDisplayNearestPoint(screen.screenToDipPoint({ x: (L + R) / 2, y: (T + B) / 2 }));
  overlayWin.setBounds({ x: gameDisplay.bounds.x + 60, y: gameDisplay.bounds.y + 60, width: 640, height: 400 });
  setOverlayVisible(true); setClickThrough(true);
  let seq = 0;
  const tick = setInterval(() => toOverlay('remote', { t: 'vp', seq: seq++, ts: 0, epoch: 'game', az: 0, el: 0, src: 'manual', st: 'LIVE_MANUAL', cal: false, from: 'x' }), 100);
  await wait(2500);
  const shot = path.join(dir, 'desktop.png');
  const b = gameDisplay.bounds;
  const cap = await ps(`Add-Type -AssemblyName System.Drawing;$bmp=New-Object System.Drawing.Bitmap ${b.width},${b.height};$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen(${b.x},${b.y},0,0,$bmp.Size);$n=0;for($y=60;$y -lt 470;$y+=2){for($x=60;$x -lt 710;$x+=2){$c=$bmp.GetPixel($x,$y);if($c.R -gt 200 -and $c.G -lt 60 -and $c.B -gt 200){$n++}}};$bmp.Save('${shot.replace(/\\/g, '\\\\')}');$n`);
  clearInterval(tick);
  const quns = { 1: 'not present', 2: 'busy', 3: 'D3D exclusive fullscreen', 4: 'presentation mode', 5: 'accepts notifications', 6: 'quiet time', 7: 'app (UWP)' }[info.quns] || info.quns;
  const WS_CAPTION = 0xC00000, WS_EX_TOPMOST = 0x8;
  const coversMonitor = L <= b.x && T <= b.y && R >= b.x + b.width && B >= b.y + b.height; // assumes 100% scaling
  fs.writeFileSync(path.join(dir, 'game.json'), JSON.stringify({
    game: { rect: info.rect, captioned: !!(info.style & WS_CAPTION), gameTopmost: !!(info.exStyle & WS_EX_TOPMOST), coversMonitor,
      windowsFullscreenState: quns },
    overlay: { visibleMagentaPixelsInScreenshot: Number(cap), clickThrough: state.clickThrough, display: gameDisplay.id },
  }, null, 2));
  app.isQuitting = true; app.quit();
}

// Automated two-instance check (used by scripts/selftest.js): CREWSIGHT_SELFTEST=create|join,<dir>,<relayUrl>
function runSelfTest(spec) {
  const [mode, dir, url] = spec.split(',');
  cfg.tracking.mode = 'simulated';
  const codeFile = path.join(dir, 'code.txt');
  const outFile = path.join(dir, `result-${mode}.json`);
  let lastDiag = null, staleSamples = 0, diagSamples = 0;
  const metrics = [];
  ipcMain.on('overlay-diag', (_e, d) => { lastDiag = d; diagSamples++; if (d.stale) staleSamples++; });
  let hudSamples = 0, hudDrawn = 0, hudLast = null;
  ipcMain.on('hud-diag', (_e, d) => { hudSamples++; if (d.drawn) hudDrawn++; hudLast = d; });
  // Whole-app CPU (% of one core, summed over processes) and memory, every 10 s.
  const t0 = Date.now();
  setInterval(() => {
    const pm = app.getAppMetrics();
    metrics.push({ s: Math.round((Date.now() - t0) / 1000), cpu: +pm.reduce((a, p) => a + p.cpu.percentCPUUsage, 0).toFixed(1),
      memMB: Math.round(pm.reduce((a, p) => a + p.memory.workingSetSize, 0) / 1024),
      helper: helper ? 'on' : 'off', vfps: lastDiag && lastDiag.peerFps, vsize: lastDiag && lastDiag.videoSize });
  }, 10000);
  overlayWin.webContents.once('did-finish-load', async () => {
    const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    if (screens[0]) toOverlay('source', { id: screens[0].id, name: screens[0].name });
  });
  cfg.network.transport = url === 'p2p' ? 'p2p' : 'relay';
  cfg.role = mode === 'create' ? 'pilot' : 'gunner';
  pushOverlayConfig();
  overlayWin.webContents.once('did-finish-load', () => setTimeout(() => {
    if (mode === 'create') {
      sessionCreate(url);
      const t = setInterval(() => { if (state.session.code) { clearInterval(t); fs.writeFileSync(codeFile, state.session.code); } }, 200);
    } else {
      const t = setInterval(() => { if (fs.existsSync(codeFile)) { clearInterval(t); sessionJoin(url, fs.readFileSync(codeFile, 'utf8')); } }, 200);
    }
  }, 500));
  setTimeout(async () => {
    try { fs.writeFileSync(path.join(dir, `overlay-${mode}.png`), (await overlayWin.webContents.capturePage()).toPNG()); } catch {}
    fs.writeFileSync(outFile, JSON.stringify({ hud: { hudSamples, hudDrawn, hudLast }, metrics, staleSamples, diagSamples, session: state.session, diag: { ...lastDiag, rttMs: lastDiag && lastDiag.transport === 'p2p' ? lastDiag.p2pRttMs : net.rttMs } }, null, 2));
    app.isQuitting = true; app.quit();
  }, Number(process.env.CREWSIGHT_SELFTEST_MS || 15000));
}
app.on('second-instance', () => createControl());
app.on('window-all-closed', (e) => e.preventDefault?.());
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); stopHelper(); net.leave(true); clearInterval(loopTimer); });
