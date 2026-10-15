'use strict';
// Full-screen, always click-through HUD over MY game: draws where my crew member is looking, placed in MY view.
//   Pilot's HUD: my view = nose (or free-look estimate) -> gunner's aim point.
//   Gunner's HUD: my view = my tracked aim -> pilot's look (nose) point.
const { ipcRenderer } = require('electron');
const { projectIntoView } = require('../../core/projection');
const { RemoteViewpoint, Smoother } = require('../../core/remoteState');
const ATT = require('../../core/attitude');
let att = null; // latest helicopter attitude (own estimate if pilot, received if gunner)

const cv = document.getElementById('cv'), ctx = cv.getContext('2d');
let cfg = null, local = null;
const remote = new RemoteViewpoint();
const smoother = new Smoother();

ipcRenderer.on('config', (_e, c) => { cfg = c; remote.staleMs = c.network.staleMs; });
ipcRenderer.on('local', (_e, m) => { local = m; });
ipcRenderer.on('remote', (_e, m) => remote.accept(m, performance.now()));
ipcRenderer.on('reset-remote', () => { remote.reset(); smoother.reset(); });
ipcRenderer.on('att', (_e, a) => { att = { ...a, at: performance.now() }; });
const attFresh = () => att && att.ok && performance.now() - att.at < ((cfg && cfg.attitude && cfg.attitude.staleMs) || 1000);

// ---------- pings ----------
let marks = []; let cardTimer = null;
ipcRenderer.on('mark', (_e, mk) => {
  if (!cfg) return;
  const crew = cfg.role === 'pilot' ? 'GUNNER' : 'PILOT';
  const label = mk.mine ? 'YOU PINGED' : `${crew} PING`;
  if (mk.az !== null) marks.push({ az: mk.az, el: mk.el, q: mk.q || null, label, mine: !!mk.mine, at: performance.now() });
  marks = marks.slice(-6);
  if (!mk.mine && cfg.ping.showCard) showCard(label, mk.img, mk.az === null);
  ipcRenderer.send('hud-mark-diag', { mine: !!mk.mine, az: mk.az, el: mk.el, imgBytes: mk.img ? mk.img.length : 0, hasQ: !!mk.q, img: process.env.CREWSIGHT_SELFTEST ? mk.img : undefined });
});
function showCard(label, img, noDirection) {
  const card = document.getElementById('card');
  clearTimeout(cardTimer);
  card.className = cfg.ping.cardPos || 'top';
  card.innerHTML = '';
  const head = document.createElement('div'); head.className = 'head';
  head.textContent = label + (noDirection ? ' · direction unknown (crew not calibrated)' : '');
  card.append(head);
  if (img) {
    const shot = document.createElement('div'); shot.className = 'shot';
    const im = document.createElement('img'); im.src = img;
    const x = document.createElement('div'); x.className = 'x';
    shot.append(im, x); card.append(shot);
  }
  requestAnimationFrame(() => card.classList.add('show'));
  cardTimer = setTimeout(() => card.classList.remove('show'), (cfg.ping.cardSeconds || 5) * 1000);
}
function drawMarks(now, W, H, view) {
  marks = marks.filter((k) => now - k.at < (cfg.ping.markerSeconds || 6) * 1000);
  for (const k of marks) {
    // World-anchored when the ping carried an attitude and we have a fresh one; otherwise fixed to the airframe.
    const anchored = k.q && attFresh();
    const dir = anchored ? ATT.reanchor({ az: k.az, el: k.el }, k.q, att.q) : { az: k.az, el: k.el };
    const p = view && projectIntoView(dir, view, cfg.hud.fovH, W / H);
    if (!p) continue;
    const age = (now - k.at) / 1000, color = k.mine ? '#4ea1ff' : '#f2cc60';
    const m2 = 34, px = p.inView ? p.x * W : Math.min(W - m2, Math.max(m2, p.x * W)), py = p.inView ? p.y * H : Math.min(H - m2, Math.max(m2, p.y * H));
    ctx.save();
    ctx.globalAlpha = Math.max(0.25, 1 - age / (cfg.ping.markerSeconds || 6));
    // Expanding pulse + fixed diamond.
    const pr = 10 + ((age * 30) % 26);
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(px, py, pr, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(px, py - 9); ctx.lineTo(px + 9, py); ctx.lineTo(px, py + 9); ctx.lineTo(px - 9, py); ctx.closePath();
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke(); ctx.fillStyle = color; ctx.fill();
    if (!p.inView) {
      ctx.translate(px, py); ctx.rotate(Math.atan2(p.ay, p.ax));
      ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(14, -8); ctx.lineTo(14, 8); ctx.closePath(); ctx.fill();
      ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
    }
    label(k.label + (k.q ? (anchored ? '' : ' · tracking lost') : ' · not world-locked'), px + 14, py - 12, color);
    ctx.restore();
  }
}
const dpr = () => window.devicePixelRatio || 1;
ipcRenderer.send('request-status');

function label(text, x, y, color) {
  ctx.font = '600 12px "Segoe UI", sans-serif';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

let lastDraw = { drawn: false };
setInterval(() => ipcRenderer.send('hud-diag', { ...lastDraw, att: att ? { source: att.source, ok: att.ok, conf: att.conf, fresh: attFresh() } : null }), 500);

function draw() {
  requestAnimationFrame(draw);
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  lastDraw = { drawn: false };
  if (!cfg || !cfg.hud.enabled) return;
  const now = performance.now();
  {
    const v = local && local.az !== null ? { az: local.az, el: local.el } : cfg.role === 'pilot' ? { az: 0, el: 0 } : null;
    if (marks.length) drawMarks(now, W, H, v);
  }
  const crew = cfg.role === 'pilot' ? 'GUNNER' : 'PILOT';
  const m = remote.latest;
  if (!m) return;
  const stale = remote.isStale(now);
  const s = remote.sample(now, { interpolate: cfg.smoothing.interpolate, delayMs: cfg.smoothing.interpDelayMs });
  if (s.az === null) { label(`${crew}: ${s.st === 'UNCALIBRATED' ? 'not calibrated' : 'tracking unavailable'}`, W / 2 - 80, 28, '#f2cc60'); return; }
  if (stale && cfg.dot.hideWhenStale) return;
  // My own view direction. Pilot without tracking = nose. Gunner needs a live estimate to place anything.
  let view = null;
  if (local && local.az !== null) view = { az: local.az, el: local.el };
  else if (cfg.role === 'pilot') view = { az: 0, el: 0 };
  if (!view) { label(`${crew} dot needs YOUR tracking: calibrate or turn on mouse observation`, W / 2 - 200, 28, '#f2cc60'); return; }

  const p = projectIntoView({ az: s.az, el: s.el }, view, cfg.hud.fovH, W / H);
  if (!p) return;
  const sm = smoother.step(p.x, p.y, now, cfg.smoothing.visualTauMs);
  lastDraw = { drawn: true, inView: p.inView, x: +sm.x.toFixed(3), y: +sm.y.toFixed(3), stale, view, crew: { az: s.az, el: s.el } };
  const px = sm.x * W, py = sm.y * H;
  const d = cfg.dot, rad = d.size / 2;
  const color = stale ? '#8b949e' : d.color;
  ctx.save();
  ctx.globalAlpha = stale ? 0.5 : d.opacity;
  if (!p.inView) {
    const m2 = 28; // keep arrows inside the screen edge
    const ex = Math.min(W - m2, Math.max(m2, px)), ey = Math.min(H - m2, Math.max(m2, py));
    ctx.translate(ex, ey); ctx.rotate(Math.atan2(p.ay, p.ax));
    const a = rad * 1.4;
    ctx.beginPath(); ctx.moveTo(a, 0); ctx.lineTo(-a, -a); ctx.lineTo(-a * 0.3, 0); ctx.lineTo(-a, a); ctx.closePath();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.stroke(); ctx.fillStyle = color; ctx.fill();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.globalAlpha = stale ? 0.5 : d.opacity;
    if (cfg.hud.showLabel) label(crew, ex - 20, ey + (ey > H / 2 ? -a - 8 : a + 16), color);
  } else {
    if (d.halo) { ctx.beginPath(); ctx.arc(px, py, rad + 2.5, 0, 7); ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, rad + 1, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(); }
    ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.fillStyle = color; ctx.fill();
    if (stale) { ctx.setLineDash([4, 3]); ctx.lineWidth = 2; ctx.strokeStyle = '#000'; ctx.stroke(); }
    if (cfg.hud.showLabel) label(stale ? `${crew} (no update)` : crew, px + rad + 6, py + 4, color);
  }
  ctx.restore();
}
requestAnimationFrame(draw);
