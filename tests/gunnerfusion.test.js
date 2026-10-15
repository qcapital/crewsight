'use strict';
// Ground truth: helicopter manoeuvring, turret driven by the mouse but speed-limited and stopped at its limits,
// gunner camera = airframe ⊗ turret. The fused estimate (gunner's image + pilot's helicopter attitude) must
// follow the TRUE turret direction; the old mouse dead-reckoning (with an approximate calibration) must not.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../core/attitude');
const { RotationEstimator } = require('../core/rotationEstimator');
const { GunnerFusion } = require('../core/gunnerFusion');

const D = Math.PI / 180, W = 160, H = 90, F = (W / 2) / Math.tan(45 * D);
function tex(v) {
  const [x, y, z] = v;
  let t = 128 + 40 * Math.sin(9 * x + 3 * z) * Math.cos(7 * y - 2 * z) + 30 * Math.sin(23 * y + 11 * x) + 25 * Math.cos(31 * z - 17 * y);
  const h = Math.sin(Math.floor(x * 20) * 12.9898 + Math.floor(y * 20) * 78.233 + Math.floor(z * 20) * 37.719) * 43758.5453;
  return Math.max(0, Math.min(255, t + 30 * (h - Math.floor(h) - 0.5)));
}
function render(q) {
  const g = new Uint8Array(W * H);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const r = [F, px - W / 2 + 0.5, -(py - H / 2 + 0.5)], n = Math.hypot(...r);
    g[py * W + px] = tex(A.qrot(q, r.map((v) => v / n)));
  }
  return g;
}
const turretQ = (az, el) => A.qmul(A.qFromYPR(az * D, 0, 0), A.qFromYPR(0, el * D, 0));

test('gunner fusion: follows a speed-limited turret through manoeuvres and stops; mouse-only does not', () => {
  const TRUE_DEG_PER_COUNT = 0.05, CAL_DEG_PER_COUNT = 0.065; // calibration 30 % too high (approximate)
  const AZ_MAX = 40, RATE = 2; // turret stops at +40°, max 2°/frame (60°/s at 30 fps)
  const est = new RotationEstimator({ w: W, h: H, fovH: 90 });
  const fus = new GunnerFusion({ degPerCountX: CAL_DEG_PER_COUNT, degPerCountY: CAL_DEG_PER_COUNT, signX: 1, signY: -1 });
  let qHeli = A.IDENTITY, az = 0, el = 0, mouseAz = 0, mouseEl = 0;
  est.push(render(A.qmul(qHeli, turretQ(az, el))));
  let worstFused = 0, worstMouse = 0;
  for (let i = 0; i < 120; i++) {
    // Helicopter manoeuvres (yaw + roll) the whole time.
    qHeli = A.integrate(qHeli, 1.0 * Math.sin(i / 20) * D, 0.3 * D * Math.cos(i / 13), 1.2 * Math.sin(i / 11) * D);
    // Gunner flicks the mouse fast right (far past the stop), then back left, plus some up/down.
    const dx = i < 40 ? 120 : i < 80 ? -90 : 0, dy = i % 30 < 10 ? -30 : 0;
    const wantAz = az + dx * TRUE_DEG_PER_COUNT, wantEl = el - dy * TRUE_DEG_PER_COUNT;
    az = Math.max(-80, Math.min(AZ_MAX, az + Math.max(-RATE, Math.min(RATE, wantAz - az))));
    el = Math.max(-30, Math.min(25, el + Math.max(-RATE, Math.min(RATE, wantEl - el))));
    mouseAz += dx * CAL_DEG_PER_COUNT; mouseEl -= dy * CAL_DEG_PER_COUNT; // old method
    fus.setHeli(qHeli, true);
    const out = fus.step(est.push(render(A.qmul(qHeli, turretQ(az, el)))), { dx, dy });
    worstFused = Math.max(worstFused, Math.hypot(out.az - az, out.el - el));
    worstMouse = Math.max(worstMouse, Math.hypot(mouseAz - az, mouseEl - el));
  }
  assert.ok(worstFused < 6, `fused worst error ${worstFused.toFixed(1)}°`);
  assert.ok(worstMouse > 30, `mouse-only should be badly off here (worst ${worstMouse.toFixed(1)}°)`);
});

test('gunner fusion: plain sky falls back to the mouse with the LEARNED scale', () => {
  const fus = new GunnerFusion({ degPerCountX: 0.1, signX: 1, signY: -1 }); // calibration 2x too high
  for (let i = 0; i < 80; i++) fus.step({ yaw: 1 * D, pitch: 0, roll: 0, conf: 0.9 }, { dx: 20, dy: 0 }); // truth 0.05°/count
  assert.ok(Math.abs(fus.scaleX - 0.05) < 0.005, `learned ${fus.scaleX}`);
  const before = fus.estimate().az;
  fus.step({ yaw: 0, pitch: 0, roll: 0, conf: 0 }, { dx: 200, dy: 0 }); // no picture detail: mouse only
  assert.ok(Math.abs(fus.estimate().az - before - 10) < 1, 'mouse fallback uses learned 0.05°/count');
});

test('gunner fusion: helicopter turning alone does not move the turret estimate', () => {
  const fus = new GunnerFusion({}); let qHeli = A.IDENTITY; let qGunTruth = A.IDENTITY;
  for (let i = 0; i < 60; i++) {
    const inc = [1.5 * D, 0.5 * D, 1 * D];
    qHeli = A.integrate(qHeli, ...inc); qGunTruth = A.integrate(qGunTruth, ...inc); // turret fixed to airframe
    fus.setHeli(qHeli, true);
    fus.step({ yaw: inc[0], pitch: inc[1], roll: inc[2], conf: 0.9 });
  }
  const e = fus.estimate(); assert.ok(Math.hypot(e.az, e.el) < 1e-6);
});
