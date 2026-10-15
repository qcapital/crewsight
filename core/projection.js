'use strict';
// Angle -> normalised stream coordinate projection.
// Conventions (see docs/ARCHITECTURE.md):
//   az (azimuth)   degrees, 0 = helicopter nose, +right / -left, range (-180, 180]
//   el (elevation) degrees, 0 = nose-level,      +up / -down,      range [-90, 90]
//   x, y normalised to the stream CONTENT rectangle: (0,0) top-left, (1,1) bottom-right.
// Only normalised coordinates ever leave this module's callers; pixels are a local concern.

function isFiniteNum(v) { return typeof v === 'number' && Number.isFinite(v); }

function wrapDeg(a) {
  if (!isFiniteNum(a)) return NaN;
  let r = ((a + 180) % 360 + 360) % 360 - 180;
  if (r === -180) r = 180;
  return r;
}

const DEFAULT_PROJECTION = Object.freeze({
  mode: 'linear',      // 'linear' | 'tangent'
  azMax: 90,           // degrees mapped to the left/right content edge
  elMax: 45,           // degrees mapped to the top/bottom content edge
  centerX: 0.5,        // where (0,0) lands inside the content rect
  centerY: 0.5,
});

// Maps one axis to a signed fraction in [-1,1] (or beyond when out of range).
function axisFraction(angleDeg, maxDeg, mode) {
  if (mode === 'tangent') {
    // Perspective-like: only valid for |angle| < 90. Beyond that it is out of range by definition.
    const rad = (d) => (d * Math.PI) / 180;
    if (Math.abs(angleDeg) >= 89.9) return Math.sign(angleDeg) * Infinity;
    return Math.tan(rad(angleDeg)) / Math.tan(rad(Math.min(maxDeg, 89)));
  }
  return angleDeg / maxDeg;
}

/**
 * project({az, el}, cfg) -> { x, y, inRange, edgeX, edgeY } or null when input invalid.
 * Out-of-range policy: the point is clamped to the content edge and inRange=false
 * so the renderer draws an edge chevron instead of a dot.
 */
function project(angles, cfg = DEFAULT_PROJECTION) {
  const c = { ...DEFAULT_PROJECTION, ...cfg };
  if (!angles || !isFiniteNum(angles.az) || !isFiniteNum(angles.el)) return null;
  if (!(c.azMax > 0 && c.azMax <= 180) || !(c.elMax > 0 && c.elMax <= 90)) return null;
  const az = wrapDeg(angles.az);
  const el = Math.max(-90, Math.min(90, angles.el));
  const fx = axisFraction(az, c.azMax, c.mode);
  const fy = axisFraction(el, c.elMax, c.mode);
  // Half-widths from the (possibly off-centre) centre point to each edge.
  const halfX = fx >= 0 ? 1 - c.centerX : c.centerX;
  const halfY = fy >= 0 ? c.centerY : 1 - c.centerY; // +el goes up (smaller y)
  let x = c.centerX + fx * halfX;
  let y = c.centerY - fy * halfY;
  const inRange = Math.abs(fx) <= 1 && Math.abs(fy) <= 1;
  const clamp = (v) => Math.max(0, Math.min(1, v));
  return { x: clamp(x), y: clamp(y), inRange, edgeX: Math.abs(fx) > 1, edgeY: Math.abs(fy) > 1 };
}

/** Letterbox: largest rect of aspect srcW/srcH centred inside a boxW x boxH area. */
function contentRect(srcW, srcH, boxW, boxH) {
  if (!(srcW > 0 && srcH > 0 && boxW > 0 && boxH > 0)) return null;
  const s = Math.min(boxW / srcW, boxH / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

/** Normalised content coordinate -> overlay pixel. */
function toPixels(pt, rect) {
  return { px: rect.x + pt.x * rect.w, py: rect.y + pt.y * rect.h };
}

/**
 * Where does a crew member's look direction appear on MY screen?
 * target, view: { az, el } in degrees relative to the helicopter nose (same convention as above).
 * view is where MY camera points (pilot: 0,0 = nose; gunner: own tracked aim). fovH = game's horizontal FOV,
 * aspect = my screen width/height. Perspective (pinhole) projection; camera roll relative to the airframe is
 * assumed zero. Ignores parallax between seats (fine for targets more than ~50 m away).
 * Returns { x, y, inView, ax, ay } with x,y normalised to my screen; when not in view, x,y are clamped to the
 * edge and (ax, ay) is the unit direction to point an edge arrow.
 */
function projectIntoView(target, view, fovH, aspect) {
  if (!target || !view || ![target.az, target.el, view.az, view.el, fovH, aspect].every(isFiniteNum)) return null;
  if (!(fovH > 1 && fovH < 179 && aspect > 0)) return null;
  const r = Math.PI / 180;
  const dir = (a, e) => [Math.cos(e * r) * Math.cos(a * r), Math.cos(e * r) * Math.sin(a * r), Math.sin(e * r)];
  const d = dir(target.az, target.el);
  const va = view.az * r, ve = view.el * r;
  const f = dir(view.az, view.el);
  const right = [-Math.sin(va), Math.cos(va), 0];
  const up = [-Math.sin(ve) * Math.cos(va), -Math.sin(ve) * Math.sin(va), Math.cos(ve)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cf = dot(d, f), cr = dot(d, right), cu = dot(d, up);
  const th = Math.tan((fovH / 2) * r), tv = th / aspect;
  const n = Math.hypot(cr, cu) || 1;
  if (cf <= 1e-3) {
    // Behind the camera: arrow toward the shortest way round, pinned to the screen edge.
    const ax = cr / n, ay = -cu / n;
    const k = 0.5 / Math.max(Math.abs(ax), Math.abs(ay), 1e-9);
    return { x: 0.5 + ax * k, y: 0.5 + ay * k, inView: false, ax, ay };
  }
  const x = 0.5 + 0.5 * (cr / cf) / th;
  const y = 0.5 - 0.5 * (cu / cf) / tv;
  const inView = x >= 0 && x <= 1 && y >= 0 && y <= 1;
  if (inView) return { x, y, inView, ax: 0, ay: 0 };
  const dx = x - 0.5, dy = y - 0.5, m = Math.hypot(dx, dy);
  const k = 0.5 / Math.max(Math.abs(dx), Math.abs(dy));
  return { x: 0.5 + dx * k, y: 0.5 + dy * k, inView: false, ax: dx / m, ay: dy / m };
}

module.exports = { projectIntoView, wrapDeg, project, contentRect, toPixels, DEFAULT_PROJECTION, isFiniteNum };
