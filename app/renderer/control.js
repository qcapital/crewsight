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
  let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
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
$('calCancel').onclick = () => ipcRenderer.send('cal-cancel');
$('calReset').onclick = () => ipcRenderer.invoke('reset-calibration');
$('noseOnly').onclick = () => ipcRenderer.invoke('set-nose-only');
const STEP_TEXT = {
  'x-zero': 'In game, look straight along the helicopter nose. Press Mark.',
  'x-pos': () => `Turn your view RIGHT exactly ${$('refX').value}° (e.g. straight out the right side). Press Mark.`,
  'x-return': 'Turn back to straight along the nose. Press Mark.',
  'x-neg': () => `Turn your view LEFT exactly ${$('refX').value}°. Press Mark.`,
  'y-zero': 'Look straight along the nose, level. Press Mark.',
  'y-pos': () => `Look UP exactly ${$('refY').value}°. Press Mark.`,
  'y-return': 'Return to level along the nose. Press Mark.',
  'y-neg': () => `Look DOWN exactly ${$('refY').value}°. Press Mark.`,
};
ipcRenderer.on('cal-state', (_e, c) => {
  $('calRun').style.display = c ? 'block' : 'none'; $('calSetup').style.display = c ? 'none' : 'block';
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
  el.textContent = (cal.valid ? 'CALIBRATION VALID\n' : 'CALIBRATION FAILED — not applied\n') +
    cal.checks.map((k) => `${k.pass ? '✔' : '✘'} ${k.axis || ''} ${k.name}: ${k.detail}`).join('\n') +
    (cal.valid ? `\n\n${cal.degPerCountX.toFixed(5)} °/count horizontal, ${cal.degPerCountY.toFixed(5)} °/count vertical` : '');
  el.className = cal.valid ? 'ok' : 'bad';
});

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
  recalibrate: 'Recalibrate', toggleTracking: 'Toggle mouse observation', zero: 'Re-zero to nose', calMark: 'Calibration mark', toggleHud: 'Crew dot on my screen' };
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
  $('hkFail').textContent = s.hotkeyFailures.length ? 'Could not register: ' + s.hotkeyFailures.map((f) => `${f.accelerator} (${HK_LABELS[f.name]})`).join(', ') : '';
  $('shareState').textContent = s.capture ? `${s.capture.status}${s.capture.source ? ' · ' + s.capture.source : ''}${s.capture.detail ? ' · ' + s.capture.detail : ''}` : '';
  $('statusbar').textContent = `${s.role.toUpperCase()} · lobby: ${ss.state} · overlay ${s.overlayVisible ? 'shown' : 'hidden'}${s.clickThrough ? ' · CLICK-THROUGH' : ''} · input: ${s.trackingObserve ? s.helperStatus : 'off'}${s.trackingObserve && !s.focusOk ? ' (game not focused)' : ''}`;
});
ipcRenderer.on('local', (_e, m) => {
  local = m;
  $('trackState').textContent = `My state: ${m.st}` + (m.az !== null ? ` · az ${m.az.toFixed(1)}° el ${m.el.toFixed(1)}°` : '') +
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
