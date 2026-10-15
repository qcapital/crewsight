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

module.exports = { wrapDeg, project, contentRect, toPixels, DEFAULT_PROJECTION, isFiniteNum };
