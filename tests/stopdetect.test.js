'use strict';
// Reproduces the field report "gun-limit recording doesn't follow the gunner moving right":
// a fixed on-screen gun model plus low-texture scenery on one side made the old whole-image shift estimate
// read "not moving", so the stop detector threw away real movement. The robust estimator must never claim
// "confidently static" while the camera is actually turning.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../core/attitude');
const { estimateShift } = require('../core/stopDetector');
const { RotationEstimator } = require('../core/rotationEstimator');

const D = Math.PI / 180, W = 160, H = 90, F = (W / 2) / Math.tan(45 * D);
function tex(v) {
  const [x, y, z] = v;
  const az = Math.atan2(y, x);
  if (az > 0.2) return 150 + 4 * Math.sin(z * 3); // right side: almost featureless (sky / haze)
  let t = 128 + 40 * Math.sin(9 * x + 3 * z) * Math.cos(7 * y - 2 * z) + 30 * Math.sin(23 * y + 11 * x);
  const h = Math.sin(Math.floor(x * 20) * 12.9898 + Math.floor(y * 20) * 78.233 + Math.floor(z * 20) * 37.719) * 43758.5453;
  return Math.max(0, Math.min(255, t + 30 * (h - Math.floor(h) - 0.5)));
}
function render(q) {
  const g = new Uint8Array(W * H);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    if (px > W * 0.55 && py > H * 0.45) { g[py * W + px] = ((px * 7) ^ (py * 13)) & 0xff; continue; } // fixed gun model (textured)
    const r = [F, px - W / 2 + 0.5, -(py - H / 2 + 0.5)], n = Math.hypot(...r);
    g[py * W + px] = tex(A.qrot(q, r.map((v) => v / n)));
  }
  return g;
}

test('stop detection input: fixed gun + plain sky never reads as "confidently static" while turning right', () => {
  const est = new RotationEstimator({ w: W, h: H, fovH: 90 });
  let q = A.IDENTITY, prev = render(q); est.push(prev);
  let oldFalseStatic = 0, newFalseStatic = 0, frames = 0;
  // 1 s turning left over textured scenery (the estimator learns the gun is fixed), then 2 s turning right into the sky.
  const seq = [...Array(30).fill(-1.5), ...Array(60).fill(1.5)];
  for (const yawDeg of seq) {
    q = A.integrate(q, yawDeg * D, 0, 0);
    const cur = render(q);
    const old = estimateShift(prev, cur, W, H, 8);
    const r = est.push(cur);
    if (yawDeg > 0) {
      frames++;
      if (old.sx === 0 && old.sy === 0) oldFalseStatic++;
      // "confidently static" = what would make the detector block: no motion AND enough confidence to be trusted.
      if (r && r.conf >= 0.3 && Math.abs(r.yaw) < 0.2 * D) newFalseStatic++;
    }
    prev = cur;
  }
  assert.ok(oldFalseStatic > frames * 0.3, `old method should reproduce the bug (false static ${oldFalseStatic}/${frames})`);
  assert.equal(newFalseStatic, 0, `new method falsely static ${newFalseStatic}/${frames}`);
});
