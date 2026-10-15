'use strict';
// Helicopter attitude (body -> world rotation) as a unit quaternion [w, x, y, z].
// Body axes: x forward (nose), y right, z up. Increments are body-frame small rotations:
//   yaw   + = nose right
//   pitch + = nose up
//   roll  + = right side down
// The world frame is arbitrary (the attitude when tracking started); only CHANGES of attitude are used.

const D = Math.PI / 180;

function qmul(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}
function qnorm(q) { const n = Math.hypot(...q) || 1; return q.map((v) => v / n); }
function qconj(q) { return [q[0], -q[1], -q[2], -q[3]]; }
function qaxis(ax, ay, az, angle) { const s = Math.sin(angle / 2); return [Math.cos(angle / 2), ax * s, ay * s, az * s]; }
function qrot(q, v) { const p = qmul(qmul(q, [0, v[0], v[1], v[2]]), qconj(q)); return [p[1], p[2], p[3]]; }

/**
 * Body-frame increment from yaw/pitch/roll (radians, conventions above) as a quaternion.
 * In these coordinates (x fwd, y right, z up): +yaw (forward -> right) is a positive rotation about z,
 * +pitch (nose up) is a negative rotation about y, +roll (right side down) is a negative rotation about x.
 */
function qFromYPR(yaw, pitch, roll) {
  return qnorm(qmul(qmul(qaxis(0, 0, 1, yaw), qaxis(0, 1, 0, -pitch)), qaxis(1, 0, 0, -roll)));
}
/** Apply a body-frame increment: R_new = R_old * dR. */
function integrate(q, yaw, pitch, roll) { return qnorm(qmul(q, qFromYPR(yaw, pitch, roll))); }

// Nose-relative angles (same convention as projection.js) <-> body vector.
function dirFromAzEl(az, el) { return [Math.cos(el * D) * Math.cos(az * D), Math.cos(el * D) * Math.sin(az * D), Math.sin(el * D)]; }
function azElFromDir(v) {
  const n = Math.hypot(...v) || 1;
  return { az: Math.atan2(v[1], v[0]) / D, el: Math.asin(Math.max(-1, Math.min(1, v[2] / n))) / D };
}

/**
 * World-anchor a direction seen at attitude qThen and express it in the body frame at attitude qNow.
 * This is how a ping stays on the same spot in the world while the helicopter turns.
 */
function reanchor(azEl, qThen, qNow) {
  const world = qrot(qThen, dirFromAzEl(azEl.az, azEl.el));
  return azElFromDir(qrot(qconj(qNow), world));
}

const isQuat = (q) => Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) && Math.abs(Math.hypot(...q) - 1) < 1e-3;

module.exports = { qmul, qnorm, qconj, qrot, qFromYPR, integrate, dirFromAzEl, azElFromDir, reanchor, isQuat, IDENTITY: [1, 0, 0, 0] };
