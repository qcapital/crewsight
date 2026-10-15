'use strict';
// Overlay renderer: (1) shares the LOCAL game window to the peer over WebRTC,
// (2) shows the PEER's shared window, (3) draws the peer's viewpoint dot on top.
// Video is end-to-end between the two apps (DTLS-SRTP); the relay only carries signalling.
const { ipcRenderer } = require('electron');
const { project, contentRect, toPixels } = require('../../core/projection');
const { RemoteViewpoint, Smoother } = require('../../core/remoteState');
const { P2PSession } = require('./p2p');

const $ = (id) => document.getElementById(id);
const video = $('video'), cv = $('cv'), ctx = cv.getContext('2d');
let cfg = null;
const remote = new RemoteViewpoint();
const smoother = new Smoother();
const stats = { peerFrames: 0, lastPeerFrameAt: 0, peerFps: 0, _fc: 0, _ft: performance.now() };

// ---------------- local share ----------------
let localStream = null, localSource = null, reattachTimer = null;
let shareStatus = 'none';
function setShareStatus(s, detail) {
  shareStatus = s;
  const el = $('share');
  el.textContent = { none: 'NOT SHARING', live: 'SHARING', lost: 'SHARE LOST — RETRYING', error: 'SHARE ERROR' }[s] || s;
  el.className = 'pill ' + (s === 'live' ? 'ok' : s === 'none' ? 'dim' : 'warn');
  ipcRenderer.send('capture-status', { status: s, source: localSource && localSource.name, detail: detail || null });
}
async function startShare(src) {
  stopShare(false);
  localSource = src;
  if (!src) { setShareStatus('none'); return; }
  try {
    const s = cfg.share;
    localStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
      chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: s.maxWidth, maxHeight: Math.round(s.maxWidth * 9 / 16) * 2,
      maxFrameRate: s.maxFps } } });
  } catch (e) { setShareStatus('error', e.name); scheduleReattach(); return; }
  const track = localStream.getVideoTracks()[0];
  track.contentHint = 'motion';
  track.onended = () => { setShareStatus('lost', 'window closed or capture ended'); scheduleReattach(); };
  setShareStatus('live');
  attachLocalTrack();
  if (p2p) p2p.setLocalStream(localStream, cfg.share);
}
function stopShare(clearSource = true) {
  clearTimeout(reattachTimer);
  if (localStream) localStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  localStream = null;
  if (clearSource) { localSource = null; setShareStatus('none'); }
  attachLocalTrack();
  if (p2p) p2p.setLocalStream(null, cfg.share);
}
function scheduleReattach() {
  clearTimeout(reattachTimer);
  if (!localSource || !cfg.share.autoReattach) return;
  reattachTimer = setTimeout(async () => {
    const found = await ipcRenderer.invoke('source-alive', localSource.id, localSource.name);
    if (found) startShare({ id: found.id, name: found.name }); else scheduleReattach();
  }, 2000);
}

// ---------------- WebRTC ----------------
// Fixed roles avoid offer glare: the PILOT always offers; the GUNNER always answers.
// Transceiver 0 carries pilot->gunner video, transceiver 1 carries gunner->pilot video.
let pc = null, gen = null, peer = { inSession: false, present: false, polite: true };
let pendingCandidates = [];
const myTxIndex = () => (peer.polite ? 1 : 0);

function closePc() { if (pc) { pc.ontrack = pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); } pc = null; video.srcObject = null; }
function newPc() {
  closePc();
  pc = new RTCPeerConnection({ iceServers: cfg.network.iceServers });
  pc.onicecandidate = (e) => { if (e.candidate) signal('candidate', { gen, c: e.candidate.toJSON() }); };
  pc.ontrack = (e) => {
    const stream = new MediaStream([e.track]);
    e.track.onunmute = () => { video.srcObject = stream; video.play().catch(() => {}); };
  };
  pc.onconnectionstatechange = () => {
    renderLink();
    if (pc && pc.connectionState === 'failed' && !peer.polite) setTimeout(offer, 1000);
  };
  return pc;
}
function signal(kind, obj) { ipcRenderer.send('signal-out', kind, JSON.stringify(obj)); }
async function offer() {
  if (!peer.inSession || !peer.present || peer.polite) return;
  gen = Math.random().toString(36).slice(2, 10);
  pendingCandidates = [];
  newPc();
  pc.addTransceiver('video', { direction: 'sendonly' });
  pc.addTransceiver('video', { direction: 'recvonly' });
  attachLocalTrack();
  await pc.setLocalDescription(await pc.createOffer());
  signal('description', { gen, d: pc.localDescription.toJSON() });
}
async function onSignal({ kind, data }) {
  let m; try { m = JSON.parse(data); } catch { return; }
  if (!m || typeof m.gen !== 'string') return;
  try {
    if (kind === 'description' && m.d && typeof m.d.sdp === 'string') {
      if (m.d.type === 'offer' && peer.polite) {
        if (m.gen !== gen || !pc) { gen = m.gen; pendingCandidates = []; newPc(); }
        await pc.setRemoteDescription(m.d);
        const tx = pc.getTransceivers();
        if (tx[1]) tx[1].direction = 'sendonly';
        if (tx[0]) tx[0].direction = 'recvonly';
        attachLocalTrack();
        await pc.setLocalDescription(await pc.createAnswer());
        signal('description', { gen, d: pc.localDescription.toJSON() });
      } else if (m.d.type === 'answer' && !peer.polite && m.gen === gen && pc) {
        await pc.setRemoteDescription(m.d);
      } else return;
      for (const c of pendingCandidates) await pc.addIceCandidate(c).catch(() => {});
      pendingCandidates = [];
    } else if (kind === 'candidate' && m.c && m.gen === gen && pc) {
      if (pc.remoteDescription) await pc.addIceCandidate(m.c).catch(() => {});
      else if (pendingCandidates.length < 50) pendingCandidates.push(m.c);
    }
  } catch (e) { console.warn('signal error', e); }
}
async function attachLocalTrack() {
  if (!pc) return;
  const tx = pc.getTransceivers()[myTxIndex()];
  if (!tx) return;
  const track = localStream ? localStream.getVideoTracks()[0] : null;
  try {
    await tx.sender.replaceTrack(track);
    const p = tx.sender.getParameters();
    if (p.encodings && p.encodings.length) {
      p.encodings[0].maxBitrate = cfg.share.maxBitrateKbps * 1000;
      p.encodings[0].maxFramerate = cfg.share.maxFps;
      await tx.sender.setParameters(p);
    }
  } catch (e) { /* parameters can only be set after negotiation; retried on next attach */ }
}
setInterval(() => { if (pc && pc.connectionState === 'connected') attachLocalTrack(); }, 5000);

// ---------------- P2P transport (default) ----------------
let p2p = null, p2pStatus = null;
const isP2P = () => cfg && cfg.network.transport === 'p2p';
function ensureP2P() {
  if (p2p) return p2p;
  p2p = new P2PSession({ iceServers: cfg.network.iceServers, broker: cfg.network.broker });
  p2p.on('status', (s) => { p2pStatus = s; ipcRenderer.send('p2p-status', s); if (!s.seats || !s.seats[s.role === 'pilot' ? 'gunner' : 'pilot']) remote.reset(); renderLink(); });
  p2p.on('viewpoint', (m) => remote.accept(m, performance.now()));
  p2p.on('stream', (s) => { video.srcObject = s; if (s) video.play().catch(() => {}); renderLink(); });
  if (localStream) p2p.setLocalStream(localStream, cfg.share);
  return p2p;
}
ipcRenderer.on('p2p-cmd', (_e, c) => {
  const s = ensureP2P();
  if (c.op === 'create') s.create(c.role); else if (c.op === 'join') s.join(c.code, c.role); else s.leave();
});
ipcRenderer.on('local', (_e, m) => { if (p2p && isP2P()) p2p.sendViewpoint(m); });

// ---------------- IPC ----------------
ipcRenderer.on('config', (_e, c) => {
  cfg = c; remote.staleMs = c.network.staleMs;
  const peerRole = c.role === 'pilot' ? 'GUNNER' : 'PILOT';
  $('title').textContent = `${peerRole} VIEW`;
});
ipcRenderer.on('mode', (_e, m) => { document.body.classList.toggle('ct', m.clickThrough); });
ipcRenderer.on('source', (_e, src) => startShare(src));
ipcRenderer.on('signal', (_e, s) => onSignal(s));
ipcRenderer.on('peer', (_e, p) => {
  if (isP2P()) { peer = { inSession: !!(p2pStatus && ['connected', 'waiting', 'reconnecting'].includes(p2pStatus.state)), present: p.present, polite: true }; return; }
  const was = peer; peer = p;
  if (!p.inSession || !p.present) { if (pc) { closePc(); gen = null; } remote.reset(); }
  else if (!p.polite && (!was.present || !was.inSession || !pc)) offer();
  renderLink();
});
ipcRenderer.on('remote', (_e, m) => remote.accept(m, performance.now()));
$('btnCT').onclick = () => ipcRenderer.send('set-click-through', true);
$('btnSettings').onclick = () => ipcRenderer.send('open-settings');
ipcRenderer.send('request-status');

function renderLink() {
  const el = $('link');
  let t = 'NO SESSION', c = 'dim';
  if (peer.inSession && !peer.present) { t = 'WAITING FOR CREW'; c = 'warn'; }
  else if (isP2P() && peer.inSession) {
    const s = p2p ? p2p.videoState() : 'none';
    t = s === 'connected' ? 'VIDEO LINKED' : s === 'none' ? (video.srcObject ? 'VIDEO LINKED' : 'CREW CONNECTED · NO VIDEO') : 'VIDEO ' + s.toUpperCase();
    c = s === 'failed' ? 'bad' : 'ok';
  } else if (peer.inSession && pc) {
    const s = pc.connectionState;
    t = s === 'connected' ? 'VIDEO LINKED' : s === 'failed' ? 'VIDEO FAILED (NAT?)' : 'VIDEO ' + s.toUpperCase();
    c = s === 'connected' ? 'ok' : s === 'failed' ? 'bad' : 'warn';
  } else if (peer.inSession) { t = 'CREW CONNECTED'; c = 'ok'; }
  el.textContent = t; el.className = 'pill ' + c;
}

// ---------------- render loop ----------------
function onFrame(now) {
  stats.lastPeerFrameAt = performance.now(); stats._fc++;
  if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
}
if ('requestVideoFrameCallback' in video) video.requestVideoFrameCallback(onFrame);
video.addEventListener('loadeddata', () => video.requestVideoFrameCallback && video.requestVideoFrameCallback(onFrame));

function draw() {
  requestAnimationFrame(draw);
  if (!cfg) return;
  const now = performance.now();
  if (now - stats._ft >= 1000) { stats.peerFps = stats._fc; stats._fc = 0; stats._ft = now; }
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const top = document.body.classList.contains('ct') ? 0 : 24;
  const crop = cfg.overlay.crop;
  const vw = video.videoWidth, vh = video.videoHeight;
  const hasVideo = vw > 0 && video.srcObject && now - stats.lastPeerFrameAt < 3000;
  // Content rect = where the (cropped) peer video is drawn, letterboxed in the area below the bar.
  const srcW = hasVideo ? vw * crop.w : 16, srcH = hasVideo ? vh * crop.h : 9;
  const r = contentRect(srcW, srcH, W, H - top);
  if (!r) return;
  r.y += top;
  ctx.globalAlpha = cfg.overlay.streamOpacity;
  if (hasVideo) ctx.drawImage(video, vw * crop.x, vh * crop.y, vw * crop.w, vh * crop.h, r.x, r.y, r.w, r.h);
  else { ctx.fillStyle = '#0d0f12'; ctx.fillRect(r.x, r.y, r.w, r.h); }
  ctx.globalAlpha = 1;
  $('msg').style.display = hasVideo ? 'none' : 'block';
  $('msg').textContent = !peer.inSession ? 'Not in a session — open Settings to create or join a lobby'
    : !peer.present ? 'Waiting for your crew member to join…'
    : video.srcObject ? 'No video frames (crew member\'s shared window minimised or not sharing)'
    : 'Waiting for crew member\'s screen share…';

  drawDot(now, r);
}

function drawDot(now, r) {
  const st = $('state');
  const m = remote.latest;
  const stale = remote.isStale(now);
  if (!m) { st.textContent = peer.present ? 'NO VIEWPOINT DATA' : '—'; st.className = 'dim'; return; }
  const s = remote.sample(now, { interpolate: cfg.smoothing.interpolate, delayMs: cfg.smoothing.interpDelayMs });
  const labels = { LIVE_ESTIMATED: 'LIVE · MOUSE ESTIMATE', LIVE_MANUAL: 'LIVE · MANUAL', LIVE_SIMULATED: 'SIMULATED (TEST)',
    NOSE_LOCKED: 'PILOT · NOSE / SCREEN CENTRE', DEGRADED: 'DEGRADED · GAME NOT FOCUSED', UNCALIBRATED: 'CREW UNCALIBRATED',
    CALIBRATING: 'CREW CALIBRATING', UNAVAILABLE: 'TRACKING UNAVAILABLE' };
  st.textContent = stale ? 'STALE · NO UPDATES' : labels[s.st] || s.st;
  st.className = stale ? 'bad' : s.st.startsWith('LIVE') && s.st !== 'LIVE_SIMULATED' ? 'ok' : 'warn';
  if (s.az === null) { smoother.reset(); return; }
  if (stale && cfg.dot.hideWhenStale) return;
  const p = project({ az: s.az, el: s.el }, cfg.projection);
  if (!p) return;
  const sm = smoother.step(p.x, p.y, now, cfg.smoothing.visualTauMs);
  const { px, py } = toPixels(sm, r);
  const d = cfg.dot, rad = d.size / 2;
  ctx.save();
  ctx.globalAlpha = stale ? 0.45 : d.opacity;
  const color = stale ? '#8b949e' : d.color;
  if (!p.inRange) {
    // Edge chevron pointing outward: direction exceeds the configured angular range.
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const ang = Math.atan2(py - cy, px - cx);
    ctx.translate(Math.min(r.x + r.w - rad, Math.max(r.x + rad, px)), Math.min(r.y + r.h - rad, Math.max(r.y + rad, py)));
    ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(rad, 0); ctx.lineTo(-rad, -rad); ctx.lineTo(-rad * 0.3, 0); ctx.lineTo(-rad, rad); ctx.closePath();
    if (d.halo) { ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.stroke(); }
    ctx.fillStyle = color; ctx.fill();
  } else if (stale) {
    ctx.setLineDash(stale ? [4, 3] : []);
    if (d.halo) { ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.stroke(); }
    ctx.lineWidth = 2.5; ctx.strokeStyle = color; ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.stroke();
  } else {
    if (d.halo) { ctx.beginPath(); ctx.arc(px, py, rad + 2.5, 0, 7); ctx.fillStyle = 'rgba(0,0,0,.75)'; ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, rad + 1, 0, 7); ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fill(); }
    ctx.beginPath(); ctx.arc(px, py, rad, 0, 7); ctx.fillStyle = color; ctx.fill();
    if (s.st === 'DEGRADED') { ctx.lineWidth = 2; ctx.strokeStyle = '#f2cc60'; ctx.stroke(); }
  }
  ctx.restore();
}
requestAnimationFrame(draw);

// Diagnostics for the control window.
setInterval(() => {
  const now = performance.now();
  ipcRenderer.send('overlay-diag', {
    peerFps: stats.peerFps, videoSize: [video.videoWidth, video.videoHeight], pcState: isP2P() ? (p2p ? p2p.videoState() : 'none') : pc ? pc.connectionState : 'none', transport: cfg && cfg.network.transport, p2pRttMs: p2p ? p2p.rttMs : null,
    remote: remote.latest ? { az: remote.latest.az, el: remote.latest.el, st: remote.latest.st, src: remote.latest.src, cal: remote.latest.cal } : null,
    remoteRateHz: remote.updateRateHz(now), stale: remote.isStale(now), stats: remote.stats,
    sinceLastMs: remote.receivedAt === null ? null : Math.round(now - remote.receivedAt), shareStatus,
  });
}, 500);
