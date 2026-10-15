'use strict';
const { ipcRenderer, clipboard } = require('electron');
const $ = (id) => document.getElementById(id);
let cfg = null, status = null, local = null, diag = null, selectedSource = null;

// ---------- tabs ----------
function goto(tab) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.id === tab));
  if (tab === 'share') loadSources();
}
document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => goto(b.dataset.tab)));
ipcRenderer.on('goto', (_e, t) => goto(t));
function toast(t) { const el = $('toast'); el.textContent = t; el.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => (el.style.display = 'none'), 3500); }
ipcRenderer.on('toast', (_e, t) => toast(t));

// ---------- generic bound fields (data-k="a.b.c") ----------
const getK = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);
function patchFor(k, v) {
  const parts = k.split('.'); const top = parts[0];
  const obj = structuredClone(cfg[top]); let o = obj;
  for (let i = 1; i < parts.length - 1; i++) o = o[parts[i]];
  o[parts[parts.length - 1]] = v;
  return { [top]: obj };
}
function fillFields() {
  document.querySelectorAll('[data-k]').forEach((el) => {
    const v = getK(cfg, el.dataset.k);
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? '';
  });
  $('role').value = cfg.role; $('relayUrl').value = cfg.relayUrl;
  $('firstRun').style.display = cfg.firstRunDone ? 'none' : 'block';
  renderHotkeys(); relayWarn(); fillDisplays();
  $('relayRow').style.display = cfg.network.transport === 'relay' ? '' : 'none';
}
document.querySelectorAll('[data-k]').forEach((el) => el.addEventListener('change', async () => {
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' || el.dataset.num ? Number(el.value) : el.value;
  if (el.type === 'number') {
    if (!Number.isFinite(v)) return fillFields();
    v = Math.min(Number(el.max || Infinity), Math.max(Number(el.min || -Infinity), v));
  }
  cfg = await ipcRenderer.invoke('set-config', patchFor(el.dataset.k, v)); fillFields();
}));

async function fillDisplays() {
  const sel = $('hudDisplay'); const list = await ipcRenderer.invoke('list-displays');
  sel.innerHTML = '';
  for (const d of list) { const o = document.createElement('option'); o.value = d.id; o.textContent = d.label; sel.append(o); }
  sel.value = cfg.hud.displayId && list.some((d) => d.id === String(cfg.hud.displayId)) ? String(cfg.hud.displayId) : (list.find((d) => d.label.includes('primary')) || list[0]).id;
}
$('hudDisplay').onchange = async () => { cfg = await ipcRenderer.invoke('set-config', { hud: { ...cfg.hud, displayId: $('hudDisplay').value } }); };

// ---------- lobby ----------
function relayWarn() {
  const u = $('relayUrl').value.trim();
  const local = /^ws:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(u);
  $('relayWarn').textContent = /^ws:\/\//i.test(u) && !local ? 'Warning: ws:// over the internet is unencrypted. Use wss://.' : '';
}
$('relayUrl').oninput = relayWarn;
$('role').onchange = async () => {
  cfg = await ipcRenderer.invoke('set-config', { role: $('role').value });
  fillFields(); toast('Seat changed — calibration for this seat is loaded separately.');
};
$('create').onclick = () => ipcRenderer.send('session-create', $('relayUrl').value.trim());
$('join').onclick = () => ipcRenderer.send('session-join', $('relayUrl').value.trim(), $('joinCode').value);
$('leave').onclick = () => ipcRenderer.send('session-leave');
$('copy').onclick = () => { clipboard.writeText(status.session.code); toast('Lobby code copied'); };
$('frDone').onclick = () => { ipcRenderer.send('first-run-done'); $('firstRun').style.display = 'none'; };

// ---------- share ----------
async function loadSources() {
  const list = await ipcRenderer.invoke('list-sources');
  const box = $('sources'); box.innerHTML = '';
  for (const s of list) {
    const d = document.createElement('div'); d.className = 'src' + (selectedSource === s.id ? ' sel' : '');
    const img = document.createElement('img'); img.src = s.thumb;
    const t = document.createElement('div'); t.textContent = s.name; t.title = s.name;
    d.append(img, t);
    d.onclick = () => { selectedSource = s.id; ipcRenderer.send('select-source', { id: s.id, name: s.name }); loadSources(); };
    box.append(d);
  }
}
$('refreshSrc').onclick = loadSources;
$('stopShare').onclick = () => { selectedSource = null; ipcRenderer.send('select-source', null); loadSources(); };

// ---------- tracking ----------
$('observe').onchange = () => ipcRenderer.send('set-observe', $('observe').checked);
$('zero').onclick = () => ipcRenderer.send('zero');
$('calStart').onclick = () => {
  $('calResult').style.display = 'none';
  ipcRenderer.send('cal-start', { refX: Number($('refX').value), refY: Number($('refY').value), skipY: $('skipY').checked,
    freelookVk: parseInt($('vk').value, 16) || 0x12, recenterOnRelease: $('recenter').checked });
};
$('calMark').onclick = () => ipcRenderer.send('cal-mark');
$('restartAdmin').onclick = () => ipcRenderer.invoke('restart-admin');
ipcRenderer.on('cal-live', (_e, l) => {
  $('calLive').textContent = `Mouse input since last mark: ${l.moved} counts · reader: ${l.helper}${l.elevated ? ' · game is running as administrator' : ''}`;
  $('calLive').className = l.moved > 0 ? 'ok' : 'dim';
  $('calProblem').textContent = l.problem || '';
});
ipcRenderer.on('cal-problem', (_e, why) => { $('calProblem').textContent = why; });
$('calCancel').onclick = () => ipcRenderer.send('cal-cancel');
$('calReset').onclick = () => ipcRenderer.invoke('reset-calibration');
$('noseOnly').onclick = () => ipcRenderer.invoke('set-nose-only');
const STEP_TEXT = {
  'x-zero': 'In game, look straight along the helicopter nose. Press Mark.',
  'x-pos': () => `Turn RIGHT about ${$('refX').value}° (it doesn't matter if the gun tilts up or down). Press Mark.`,
  'x-return': 'Turn back to straight along the nose. Press Mark.',
  'x-neg': () => `Turn LEFT about ${$('refX').value}° from the nose (gun tilt doesn't matter). Press Mark.`,
  'y-zero': 'Aim as close to straight ahead as the gun allows. Press Mark.',
  'y-pos': () => `Look UP exactly ${$('refY').value}°. Press Mark.`,
  'y-return': 'Return to level along the nose. Press Mark.',
  'y-neg': () => `Look DOWN exactly ${$('refY').value}°. Press Mark.`,
};
ipcRenderer.on('cal-state', (_e, c) => {
  $('calRun').style.display = c ? 'block' : 'none'; $('calSetup').style.display = c ? 'none' : 'block';
  if (!c) $('calProblem').textContent = '';
  if (!c) return;
  const keys = Object.keys(STEP_TEXT).filter((k) => !(c.skipY && k.startsWith('y')));
  const pilot = cfg.role === 'pilot' ? ' (hold your free-look key while turning)' : '';
  $('calSteps').innerHTML = '';
  keys.forEach((k, i) => {
    const li = document.createElement('li');
    const t = STEP_TEXT[k]; li.textContent = (typeof t === 'function' ? t() : t) + (k.endsWith('zero') ? '' : pilot);
    li.className = i < c.index ? 'done' : i === c.index ? 'cur' : '';
    $('calSteps').append(li);
  });
});
ipcRenderer.on('cal-result', (_e, cal) => {
  const el = $('calResult'); el.style.display = 'block';
  el.textContent = (cal.valid ? (cal.approximate ? 'CALIBRATION APPLIED (APPROXIMATE — see ⚠ warnings; recalibrate later for better accuracy)\n' : 'CALIBRATION VALID\n') : 'CALIBRATION FAILED — not applied\n') +
    cal.checks.map((k) => `${!k.pass ? '✘' : k.warn ? '⚠' : '✔'}${k.axis || ''} ${k.name}: ${k.detail}`).join('\n') +
    (cal.valid ? `\n\n${cal.degPerCountX.toFixed(5)} °/count horizontal, ${cal.degPerCountY.toFixed(5)} °/count vertical` : '');
  el.className = cal.valid ? 'ok' : 'bad';
});

// gun limits
let limLive = null, limTrail = [];
$('limStart').onclick = () => { limTrail = []; $('limResult').style.display = 'none'; ipcRenderer.send('lim-start'); };
$('limMark').onclick = () => ipcRenderer.send('lim-mark');
$('limCancel').onclick = () => ipcRenderer.send('lim-cancel');
$('limExport').onclick = async () => { if (await ipcRenderer.invoke('lim-export')) toast('Gun limits exported'); };
$('limImport').onclick = async () => {
  const r = await ipcRenderer.invoke('lim-import');
  if (r) toast(r === 'ok' ? 'Gun limits imported' : r === 'invalid' ? 'Not a valid gun-limits file' : 'Could not read that file');
};
$('limClear').onclick = async () => { if (confirm('Delete the recorded gun limits?')) await ipcRenderer.invoke('lim-clear'); };
ipcRenderer.on('limrec', (_e, r) => {
  limLive = r;
  $('limStart').style.display = r ? 'none' : ''; $('limMark').style.display = r ? '' : 'none'; $('limCancel').style.display = r ? '' : 'none';
  if (!r) { $('limLive').textContent = ''; drawLimits(); return; }
  if (r.step === 'zero') $('limLive').textContent = 'Step 1: aim at the nose, then press Mark.';
  else {
    for (const p of r.last) limTrail.push(p);
    if (limTrail.length > 20000) limTrail.splice(0, limTrail.length - 20000);
    $('limLive').textContent = `Step 2: trace the edges, return to the nose, press Mark · az ${r.az.toFixed(1)}° el ${r.el.toFixed(1)}° · ` +
      (r.visual ? (r.blocking ? 'AT A STOP: extra mouse movement is being ignored' : 'stop detection active') : 'stop detection OFF (share your game window to enable it): don\'t push into the stops');
  }
  $('limLive').className = r.blocking ? 'warn' : 'dim';
  drawLimits();
});
ipcRenderer.on('limrec-result', (_e, x) => {
  const el = $('limResult'); el.style.display = 'block'; el.className = x.valid ? 'ok' : 'bad';
  el.textContent = (x.valid ? 'GUN LIMITS SAVED\n' : 'NOT SAVED\n') + x.checks.map((k) => `${!k.pass ? '✘' : k.warn ? '⚠' : '✔'} ${k.name}: ${k.detail}`).join('\n') +
    `\nmethod: ${x.method} · picture motion readable ${x.imageMotionKnownPct}% of the time` +
    `\nmouse movement ignored as 'at a stop': ` + ['right', 'left', 'up', 'down'].map((k) => `${k} ${x.perDirection[k].ignoredPct}%`).join(' · ') +
    (Object.values(x.perDirection).some((d) => d.ignoredPct > 60) ? `\n⚠ A lot of movement in one direction was ignored. If the gun really moved there, turn off 'Stop detection from my screen' and record again.` : '');
});
function drawLimits() {
  const c = $('limPlot'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const X = (az) => W / 2 + (az / 180) * (W / 2 - 10), Y = (el) => H / 2 - (el / 90) * (H / 2 - 10);
  g.strokeStyle = '#2a2f35'; g.lineWidth = 1;
  for (const a of [-180, -90, 0, 90, 180]) { g.beginPath(); g.moveTo(X(a), 0); g.lineTo(X(a), H); g.stroke(); }
  for (const e of [-90, -45, 0, 45, 90]) { g.beginPath(); g.moveTo(0, Y(e)); g.lineTo(W, Y(e)); g.stroke(); }
  g.fillStyle = '#8b949e'; g.font = '10px Segoe UI';
  g.fillText('NOSE', X(0) + 3, Y(0) - 3); g.fillText('left', 4, H / 2 - 3); g.fillText('right', W - 28, H / 2 - 3); g.fillText('up', X(0) + 3, 12); g.fillText('down', X(0) + 3, H - 4);
  const L = status && status.gunLimits;
  if (L && L.bins) {
    g.beginPath();
    L.bins.forEach((b, i) => (i ? g.lineTo(X(b.az), Y(b.elMax)) : g.moveTo(X(b.az), Y(b.elMax))));
    [...L.bins].reverse().forEach((b) => g.lineTo(X(b.az), Y(b.elMin)));
    g.closePath(); g.fillStyle = 'rgba(78,161,255,.18)'; g.fill(); g.strokeStyle = '#4ea1ff'; g.lineWidth = 1.5; g.stroke();
  }
  if (limTrail.length) {
    g.beginPath(); limTrail.forEach((p, i) => (i ? g.lineTo(X(p.az), Y(p.el)) : g.moveTo(X(p.az), Y(p.el))));
    g.strokeStyle = '#f2cc60'; g.lineWidth = 1.5; g.stroke();
  }
  if (limLive && limLive.step === 'trace') { g.beginPath(); g.arc(X(limLive.az), Y(limLive.el), 4, 0, 7); g.fillStyle = limLive.blocking ? '#ff7b72' : '#7ee787'; g.fill(); }
}

$('pingTest').onclick = () => ipcRenderer.send('ping-now');

// manual pad
const pad = $('pad');
function padSet(e) {
  const r = pad.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  $('padDot').style.left = x * 100 + '%'; $('padDot').style.top = y * 100 + '%';
  ipcRenderer.send('set-manual', { az: (x - 0.5) * 360, el: (0.5 - y) * 180 });
}
pad.onmousedown = (e) => { padSet(e); pad.onmousemove = padSet; };
window.addEventListener('mouseup', () => (pad.onmousemove = null));

// ---------- overlay ----------
$('showOv').onclick = () => ipcRenderer.send('set-overlay-visible', !status.overlayVisible);
$('ctOn').onclick = () => ipcRenderer.send('set-click-through', true);
$('ctOff').onclick = () => ipcRenderer.send('set-click-through', false);

// ---------- hotkeys ----------
const HK_LABELS = { toggleOverlay: 'Show / hide overlay', toggleClickThrough: 'Toggle click-through', openSettings: 'Open settings',
  recalibrate: 'Recalibrate', toggleTracking: 'Toggle mouse observation', zero: 'Re-zero to nose', calMark: 'Calibration mark', toggleHud: 'Crew dot on my screen', ping: 'Ping where I aim' };
function renderHotkeys() {
  const box = $('hkList'); box.innerHTML = '';
  for (const [k, label] of Object.entries(HK_LABELS)) {
    const l = document.createElement('label'); const s = document.createElement('span'); s.textContent = label;
    const i = document.createElement('input'); i.type = 'text'; i.value = cfg.hotkeys[k]; i.style.width = '160px';
    i.onchange = async () => { cfg = await ipcRenderer.invoke('set-config', { hotkeys: { ...cfg.hotkeys, [k]: i.value.trim() } }); };
    l.append(s, i); box.append(l);
  }
}
$('resetAll').onclick = async () => { if (confirm('Reset all settings and calibrations?')) { cfg = await ipcRenderer.invoke('reset-config'); fillFields(); } };

// ---------- status ----------
ipcRenderer.on('status', (_e, s) => {
  status = s;
  const ss = s.session;
  $('code').textContent = ss.code || '—'; $('copy').style.display = ss.code ? '' : 'none';
  const other = ss.role === 'pilot' ? 'gunner' : 'pilot';
  let txt = { idle: 'Not connected', connecting: 'Connecting…', reconnecting: 'Connection lost — reconnecting ' + (ss.detail || ''), connected: 'Connected to relay' }[ss.state] || ss.state;
  if (ss.state === 'connected') txt += ss.seats && ss.seats[other] ? ` · ${other} is here` : ` · waiting for ${other}`;
  if (ss.error) txt += ` · error: ${ss.error}`;
  $('sessState').textContent = txt;
  $('sessState').className = ss.error ? 'bad' : ss.state === 'connected' ? 'ok' : 'dim';
  $('observe').checked = s.trackingObserve;
  const c = s.calibration;
  $('calSummary').textContent = c.valid ? (c.noseOnly ? (s.role === 'pilot' ? 'Pilot default: your dot is locked to the centre of your screen (the nose) while you fly with the mouse. Calibrate only if you want free-look tracked.' : 'Seat declared nose-fixed: dot shows the nose (assumed), not measured.')
    : `Calibrated ${new Date(c.createdAt).toLocaleString()} for ${s.role}${c.verticalAssumed ? ' (vertical scale ASSUMED)' : ''}`) : `Not calibrated for ${s.role}.`;
  $('calSummary').className = c.valid ? 'ok' : 'warn';
  $('pilotOpts').style.display = s.role === 'pilot' ? 'block' : 'none';
  $('limCard').style.opacity = s.role === 'gunner' ? 1 : 0.5;
  const L = s.gunLimits;
  $('limSummary').textContent = L ? `Recorded ${new Date(L.recordedAt).toLocaleString()} · left/right ${L.azMin}° … ${L.azMax}° · up/down ${Math.min(...L.bins.map((b) => b.elMin))}° … ${Math.max(...L.bins.map((b) => b.elMax))}°${L.method ? ' · ' + L.method : ''}. Your aim is clamped to these limits.`
    : (s.role === 'gunner' ? 'No gun limits recorded.' : 'Gun limits are recorded from the Gunner seat.');
  $('limSummary').className = L ? 'ok' : 'dim';
  if (!limLive) drawLimits();
  $('hkFail').textContent = s.hotkeyFailures.length ? 'Could not register: ' + s.hotkeyFailures.map((f) => `${f.accelerator} (${HK_LABELS[f.name]})`).join(', ') : '';
  $('shareState').textContent = s.capture ? `${s.capture.status}${s.capture.source ? ' · ' + s.capture.source : ''}${s.capture.detail ? ' · ' + s.capture.detail : ''}` : '';
  $('statusbar').textContent = `${s.role.toUpperCase()} · lobby: ${ss.state} · overlay ${s.overlayVisible ? 'shown' : 'hidden'}${s.clickThrough ? ' · CLICK-THROUGH' : ''} · input: ${s.trackingObserve ? s.helperStatus : 'off'}${s.trackingObserve && !s.focusOk ? ' (game not focused)' : ''}`;
});
ipcRenderer.on('local', (_e, m) => {
  local = m;
  $('trackState').textContent = `My state: ${m.st}` + (m.why ? ` (${m.why})` : '') + (m.az !== null ? ` · az ${m.az.toFixed(1)}° el ${m.el.toFixed(1)}°` : '') + (m.src === 'visual' || m.learnedScale ? ` · source ${m.src}${m.learnedScale ? `, learned ${m.learnedScale.toFixed(4)}°/count` : ''}` : '') +
    (cfg && cfg.role === 'pilot' && m.src !== 'manual' ? ` · free-look ${m.freelook ? 'held' : 'released'}` : '');
});
ipcRenderer.on('diag', (_e, d) => { diag = d; });
setInterval(() => {
  if (!document.getElementById('diag').classList.contains('on')) return;
  $('diagOut').textContent = JSON.stringify({ local, remoteReceived: diag && diag.remote, remoteRateHz: diag && diag.remoteRateHz,
    remoteStale: diag && diag.stale, sinceLastRemoteMs: diag && diag.sinceLastMs, sequence: diag && diag.stats,
    peerRttMs: diag && diag.rttMs != null ? Math.round(diag.rttMs) : null, video: diag && { state: diag.pcState, size: diag.videoSize, fps: diag.peerFps },
    myShare: diag && diag.shareStatus, inputHelper: diag && diag.helperStatus, calibration: status && status.calibration }, null, 2);
}, 250);

(async () => { cfg = await ipcRenderer.invoke('get-config'); fillFields(); ipcRenderer.send('request-status'); })();
