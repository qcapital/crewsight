'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEnvelope, clampToEnvelope, elRangeAt, validateEnvelope } = require('../core/gunLimits');
const { StopDetector, estimateShift } = require('../core/stopDetector');
const { MouseTracker, emptyCalibration } = require('../core/tracker');

// A plausible door-gun envelope: traverse -100..+20, elevation -60..+15, with a lower floor near the skid.
const truth = (az) => [az > -40 ? -60 : -35, az < -80 ? 5 : 15];
function traceLoop() {
  const pts = [];
  for (let az = -100; az <= 20; az += 1) pts.push({ az, el: truth(az)[1] }); // along the top
  for (let el = 15; el >= -60; el -= 1) pts.push({ az: 20, el: Math.max(el, truth(20)[0]) }); // right edge
  for (let az = 20; az >= -100; az -= 1) pts.push({ az, el: truth(az)[0] }); // along the bottom
  for (let el = -35; el <= 5; el += 1) pts.push({ az: -100, el }); // left edge
  return pts;
}

test('envelope: built from a traced loop matches the true limits', () => {
  const env = buildEnvelope(traceLoop());
  assert.equal(env.azMin, -100); assert.equal(env.azMax, 20);
  for (const az of [-95, -60, -20, 10]) {
    const [lo, hi] = elRangeAt(env, az); const [tlo, thi] = truth(az);
    assert.ok(Math.abs(lo - tlo) <= 1 && Math.abs(hi - thi) <= 1, `az ${az}: ${lo}..${hi} vs ${tlo}..${thi}`);
  }
  assert.ok(validateEnvelope(env, 2).valid);
});
test('envelope: clamping mimics the gun stopping', () => {
  const env = buildEnvelope(traceLoop());
  assert.deepEqual(clampToEnvelope(env, 0, 0), { az: 0, el: 0, clamped: false });
  const c = clampToEnvelope(env, 60, 40); assert.equal(c.az, 20); assert.ok(Math.abs(c.el - 15) < 1); assert.ok(c.clamped);
  assert.ok(Math.abs(clampToEnvelope(env, -20, -90).el - -60) < 1);
});
test('envelope: too-short trace or skipped slices are handled', () => {
  assert.equal(buildEnvelope([{ az: 0, el: 0 }]), null);
  assert.equal(validateEnvelope(null).valid, false);
  const sparse = buildEnvelope(traceLoop().filter((p) => p.az < -60 || p.az > -30)); // a gap in the middle
  assert.ok(sparse.coverage < 1);
  const [lo, hi] = elRangeAt(sparse, -45); assert.ok(lo < -30 && hi > 10, 'gap interpolated');
});
test('tracker: limits clamp the estimate so pushing into a stop causes no drift', () => {
  const cal = { ...emptyCalibration('gunner'), valid: true, degPerCountX: 0.1, degPerCountY: 0.1, signX: 1, signY: -1 };
  const t = new MouseTracker(cal); t.inputHealthy = true;
  t.setLimits(buildEnvelope(traceLoop()));
  t.addDelta(2000, 0); // push 200° right, gun stops at +20
  assert.equal(t.estimate().az, 20);
  t.addDelta(-200, 0); // back off 20° -> straight at the nose, no leftover drift
  assert.equal(t.estimate().az, 0);
});

test('stop detector: blocks only the pushed axis and never the back-off', () => {
  const d = new StopDetector();
  let t = 0;
  // 300 ms of pushing right while the image does not move horizontally but moves vertically (sliding along a side stop).
  for (; t < 300; t += 10) { d.addMouse(5, -3, t); if (t % 50 === 0) d.addImage(0, 1.5, t); }
  const r = d.filter(5, -3, t);
  assert.equal(r.blockedX, true); assert.equal(r.blockedY, false); assert.equal(r.dx, 0); assert.equal(r.dy, -3);
  assert.equal(d.filter(-5, 0, t).blockedX, false, 'backing off is never blocked');
  // Free movement: image moves -> nothing blocked.
  const f = new StopDetector();
  for (t = 0; t < 300; t += 10) { f.addMouse(5, 0, t); if (t % 50 === 0) f.addImage(2, 0, t); }
  assert.equal(f.filter(5, 0, t).blockedX, false);
  // No image data -> detector unavailable, passes through.
  assert.equal(new StopDetector().filter(5, 5, 1000).visual, false);
});
test('image shift estimation finds a known translation', () => {
  const w = 96, h = 54, prev = new Uint8Array(w * h), cur = new Uint8Array(w * h);
  let s = 3; const rnd = () => ((s = (s * 16807) % 2147483647) % 256);
  for (let i = 0; i < prev.length; i++) prev[i] = rnd();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = Math.min(w - 1, Math.max(0, x - 3)), py = Math.min(h - 1, Math.max(0, y + 2));
    cur[y * w + x] = prev[py * w + px];
  }
  const r = estimateShift(prev, cur, w, h);
  assert.deepEqual([r.sx, r.sy], [3, -2]);
  assert.deepEqual([estimateShift(prev, prev, w, h).sx, estimateShift(prev, prev, w, h).sy], [0, 0]);
});
