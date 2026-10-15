'use strict';
// Versioned local configuration. Missing/corrupt files fall back to defaults; corrupt files
// are preserved as config.corrupt-<time>.json. Session codes/tokens are never persisted.
const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  firstRunDone: false,
  role: 'gunner',
  relayUrl: 'ws://localhost:8787',
  overlay: { x: null, y: null, width: 640, height: 400, streamOpacity: 1,
    crop: { x: 0, y: 0, w: 1, h: 1 } },
  // In-app screen share of the LOCAL player's game window, sent peer-to-peer (WebRTC).
  share: { lastSourceName: null, autoReattach: true, maxWidth: 1280, maxFps: 30, maxBitrateKbps: 2500 },
  // Crew member's dot drawn on MY game screen. fovH must match the game's horizontal field of view.
  hud: { enabled: true, displayId: null, fovH: 90, showLabel: true },
  dot: { color: '#ff3b30', size: 14, opacity: 0.95, halo: true, hideWhenStale: false },
  projection: { mode: 'linear', azMax: 90, elMax: 45, centerX: 0.5, centerY: 0.5 },
  smoothing: { interpolate: true, interpDelayMs: 40, visualTauMs: 30 },
  network: { sendHz: 30, staleMs: 750,
    // 'p2p' = PeerJS broker introduces the PCs, then everything is direct. 'relay' = self-hosted relay/server.js.
    transport: 'p2p', broker: null, // broker: {host, port, path, secure} for a self-hosted peerjs-server
    // STUN finds a direct path; add a TURN server (user-supplied credentials) for strict NATs.
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] },
  tracking: { mode: 'mouse', observeInput: false, foregroundFilter: 'WarDogs' },
  hotkeys: { toggleOverlay: 'Ctrl+Alt+O', toggleClickThrough: 'Ctrl+Alt+C',
    openSettings: 'Ctrl+Alt+S', recalibrate: 'Ctrl+Alt+R', toggleTracking: 'Ctrl+Alt+T',
    zero: 'Ctrl+Alt+Z', calMark: 'Ctrl+Alt+M', toggleHud: 'Ctrl+Alt+H', ping: 'Ctrl+Shift+Space' },
  // Pings: marker where I aim + snapshot of my screen around the crosshair. zoom = share of my screen width.
  ping: { showCard: true, zoom: 0.3, cardPos: 'top', cardSeconds: 5, markerSeconds: 15 },
  // Track the helicopter's rotation from the pilot's own shared view, so pings stay on their spot in the world.
  attitude: { enabled: true, staleMs: 1000 },
  calibrations: { pilot: null, gunner: null },
  // Recorded gun viewport limits (degrees, nose-relative). Kept across app versions; export/import as JSON.
  gunLimits: null,
});

function isPlainObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/** Deep-merge `src` onto defaults, keeping only keys whose type matches the default. */
function mergeTyped(def, src) {
  if (!isPlainObj(src)) return structuredClone(def);
  const out = {};
  for (const k of Object.keys(def)) {
    const d = def[k], s = src[k];
    if (isPlainObj(d)) out[k] = mergeTyped(d, s);
    else if (d === null) out[k] = s === undefined ? null : s; // free-form (calibrations, positions)
    else if (typeof s === typeof d && !(typeof s === 'number' && !Number.isFinite(s))) out[k] = s;
    else out[k] = structuredClone(d);
  }
  return out;
}

function migrate(raw) {
  // v1 is the first schema; future versions transform `raw` step by step here.
  return raw;
}

function load(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      try { fs.copyFileSync(file, path.join(path.dirname(file), `config.corrupt-${Date.now()}.json`)); } catch {}
    }
    return { config: structuredClone(DEFAULTS), recovered: e.code !== 'ENOENT' };
  }
  if (!isPlainObj(raw) || typeof raw.schemaVersion !== 'number' || raw.schemaVersion > SCHEMA_VERSION)
    return { config: structuredClone(DEFAULTS), recovered: true };
  const cfg = mergeTyped(DEFAULTS, migrate(raw));
  cfg.schemaVersion = SCHEMA_VERSION;
  return { config: cfg, recovered: false };
}

function save(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { SCHEMA_VERSION, DEFAULTS, load, save, mergeTyped };
