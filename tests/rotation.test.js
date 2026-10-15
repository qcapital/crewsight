'use strict';
// Ground-truth tests: a synthetic textured 3D world rendered through a pinhole camera fixed to the nose,
// with a known attitude sequence. The estimator must recover the attitude change from the images alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../core/attitude');
const { RotationEstimator } = require('../core/rotationEstimator');
const { reanchor, qconj, qmul, qFromYPR, integrate, IDENTITY } = A;

const D = Math.PI / 180;
const W = 160, H = 90, FOV = 90, F = (W / 2) / Math.tan((FOV / 2) * D);

// Textured world: value depends only on the world direction (distant scenery), so pure rotation is exact.
function tex(v) {
  const [x, y, z] = v;
  let t = 128 + 40 * Math.sin(9 * x + 3 * z) * Math.cos(7 * y - 2 * z) + 30 * Math.sin(23 * y + 11 * x) + 25 * Math.cos(31 * z - 17 * y);
  const hsh = Math.sin(Math.floor(x * 20) * 12.9898 + Math.floor(y * 20) * 78.233 + Math.floor(z * 20) * 37.719) * 43758.5453;
  t += 30 * (hsh - Math.floor(hsh) - 0.5);
  return Math.max(0, Math.min(255, t));
}
function render(q, { cockpit = 0 } = {}) {
  const g = new Uint8Array(W * H);
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    if (py >= H * (1 - cockpit)) { g[py * W + px] = ((px >> 3) + (py >> 3)) % 2 ? 60 : 200; continue; } // static cockpit
    const x = px - W / 2 + 0.5, y = py - H / 2 + 0.5;
    const ray = [F, x, -y]; const n = Math.hypot(...ray);
    g[py * W + px] = tex(A.qrot(q, ray.map((v) => v / n)));
  }
  return g;
}
const angleBetween = (q1, q2) => { const d = qmul(qconj(q1), q2); return 2 * Math.acos(Math.min(1, Math.abs(d[0]))) / D; };

function runSequence(frames, perFrame, opts) {
  const est = new RotationEstimator({ w: W, h: H, fovH: FOV });
  let truth = IDENTITY, estQ = IDENTITY, confSum = 0;
  est.push(render(truth, opts));
  for (let i = 0; i < frames; i++) {
    const [y, p, r] = perFrame(i);
    truth = integrate(truth, y * D, p * D, r * D);
    const out = est.push(render(truth, opts));
    estQ = integrate(estQ, out.yaw, out.pitch, out.roll); confSum += out.conf;
  }
  return { err: angleBetween(truth, estQ), total: angleBetween(IDENTITY, truth), conf: confSum / frames };
}

test('rotation: pure yaw / pitch / roll each recovered', () => {
  for (const [name, f] of [['yaw', () => [1.5, 0, 0]], ['pitch', () => [0, 1.2, 0]], ['roll', () => [0, 0, 2]]]) {
    const r = runSequence(30, f);
    assert.ok(r.err < 0.1 * r.total + 1, `${name}: error ${r.err.toFixed(2)}° of ${r.total.toFixed(1)}°`);
  }
});
test('rotation: combined manoeuvre (3 s at 30 fps) tracked within 10 %', () => {
  const r = runSequence(90, (i) => [1.2 * Math.sin(i / 15), 0.8 * Math.cos(i / 11), 1.5 * Math.sin(i / 9)]);
  assert.ok(r.err < 0.1 * r.total + 1.5, `error ${r.err.toFixed(2)}° after ${r.total.toFixed(1)}° of rotation`);
  assert.ok(r.conf > 0.5);
});
test('rotation: static cockpit covering the bottom 35 % is ignored', () => {
  const r = runSequence(60, (i) => [1.5, 0.5 * Math.sin(i / 7), 1.0], { cockpit: 0.35 });
  assert.ok(r.err < 0.1 * r.total + 1.5, `error ${r.err.toFixed(2)}° after ${r.total.toFixed(1)}°`);
});
test('rotation: hovering still -> no drift', () => {
  const r = runSequence(60, () => [0, 0, 0]);
  assert.ok(r.err < 0.3, `drift ${r.err.toFixed(3)}°`);
});
test('reanchor: a world-fixed ping moves the right way as the helicopter turns', () => {
  const q0 = IDENTITY;
  const qRight = integrate(q0, 30 * D, 0, 0); // helicopter yaws 30° right
  const p = reanchor({ az: 0, el: 0 }, q0, qRight); // ping was dead ahead
  assert.ok(Math.abs(p.az - -30) < 1e-6, 'ping is now 30° to the LEFT of the nose');
  const qUp = integrate(q0, 0, 20 * D, 0);
  assert.ok(Math.abs(reanchor({ az: 0, el: 0 }, q0, qUp).el - -20) < 1e-6, 'nose up -> ping lower');
  const qRoll = integrate(q0, 0, 0, 90 * D); // right side down 90°
  const r = reanchor({ az: 90, el: 0 }, q0, qRoll); // ping was out the right side, level
  assert.ok(Math.abs(r.el - 90) < 1e-6 || Math.abs(r.el + 90) < 1e-6, 'after rolling 90°, right side is up/down');
  assert.ok(A.isQuat(qFromYPR(0.1, 0.2, 0.3)));
});
