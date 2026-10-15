'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { project, projectIntoView, wrapDeg, contentRect, toPixels } = require('../core/projection');
const P = require('../core/protocol');
const { RemoteViewpoint, Smoother } = require('../core/remoteState');
const { solveAxis, MouseTracker, emptyCalibration } = require('../core/tracker');
const config = require('../core/config');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('projection: centre, directions, edges', () => {
  const c = project({ az: 0, el: 0 }); near(c.x, 0.5); near(c.y, 0.5); assert.ok(c.inRange);
  assert.ok(project({ az: 30, el: 0 }).x > 0.5, 'right moves right');
  assert.ok(project({ az: -30, el: 0 }).x < 0.5, 'left moves left');
  assert.ok(project({ az: 0, el: 20 }).y < 0.5, 'up moves up');
  assert.ok(project({ az: 0, el: -20 }).y > 0.5, 'down moves down');
  near(project({ az: 90, el: 45 }).x, 1); near(project({ az: 90, el: 45 }).y, 0);
  near(project({ az: 45, el: 0 }, { azMax: 90 }).x, 0.75);
});
test('projection: axes independent', () => {
  near(project({ az: 40, el: 0 }).y, 0.5); near(project({ az: 0, el: 30 }).x, 0.5);
});
test('projection: out-of-range clamps and flags', () => {
  const p = project({ az: 150, el: 0 });
  assert.equal(p.inRange, false); assert.equal(p.edgeX, true); near(p.x, 1);
  const t = project({ az: 95, el: 0 }, { mode: 'tangent', azMax: 60 });
  assert.equal(t.inRange, false); near(t.x, 1);
});
test('projection: tangent mode matches edge and centre', () => {
  const cfg = { mode: 'tangent', azMax: 60, elMax: 40 };
  near(project({ az: 60, el: 0 }, cfg).x, 1, 1e-9);
  near(project({ az: 0, el: 0 }, cfg).x, 0.5);
  assert.ok(project({ az: 30, el: 0 }, cfg).x < 0.75, 'tangent compresses centre');
});
test('projection: invalid input rejected', () => {
  assert.equal(project({ az: NaN, el: 0 }), null);
  assert.equal(project({ az: Infinity, el: 0 }), null);
  assert.equal(project({ az: 0 }), null);
  assert.equal(project({ az: 0, el: 0 }, { azMax: 0 }), null);
});
test('wrapDeg', () => {
  near(wrapDeg(190), -170); near(wrapDeg(-190), 170); near(wrapDeg(180), 180); near(wrapDeg(-180), 180);
  near(wrapDeg(720), 0);
});
test('content rect letterbox/pillarbox and pixel mapping', () => {
  const r = contentRect(1920, 1080, 800, 800); near(r.w, 800); near(r.h, 450); near(r.y, 175);
  const q = contentRect(1080, 1920, 800, 800); near(q.h, 800); near(q.w, 450);
  const px = toPixels({ x: 0.5, y: 0.5 }, r); near(px.px, 400); near(px.py, 400);
  assert.equal(contentRect(0, 1, 1, 1), null);
});

const vp = (o = {}) => ({ v: 1, t: 'vp', seq: 1, ts: 5, epoch: 'abc', az: 10, el: -5, src: 'mouse',
  st: 'LIVE_ESTIMATED', cal: true, ...o });
test('protocol: valid viewpoint round trips', () => {
  const { msg } = P.parse(JSON.stringify(vp()));
  assert.equal(msg.az, 10); assert.equal(msg.st, 'LIVE_ESTIMATED');
});
test('protocol: rejects malformed', () => {
  for (const bad of [vp({ az: 'x' }), vp({ az: 200 }), vp({ el: -91 }), vp({ seq: -1 }), vp({ seq: 1.5 }),
    vp({ src: 'memory' }), vp({ st: 'LIVE' }), vp({ v: 2 }), vp({ t: 'nope' }), vp({ cal: 'yes' }),
    vp({ az: null, el: 3 })]) {
    assert.ok(P.parse(JSON.stringify(bad)).error, JSON.stringify(bad));
  }
  assert.equal(P.parse('{"v":1,"t":"vp","az":1e999}').error, 'invalid-fields');
  assert.equal(P.parse('not json').error, 'bad-json');
  assert.equal(P.parse('[1]').error, 'not-object');
  assert.equal(P.parse(JSON.stringify({ ...vp(), pad: 'x'.repeat(2000) })).error, 'too-large');
  assert.ok(P.parse(JSON.stringify({ v: 1, t: 'sig', kind: 'description', data: 'x'.repeat(8000) })).msg);
  assert.ok(P.parse(JSON.stringify({ v: 1, t: 'sig', kind: 'exec', data: 'x' })).error);
  assert.ok(P.parse(JSON.stringify({ v: 1, t: 'sig', kind: 'candidate', data: 'x'.repeat(20000) })).error);
});
test('protocol: null angles allowed together (tracking unavailable)', () => {
  assert.ok(P.parse(JSON.stringify(vp({ az: null, el: null, st: 'UNAVAILABLE' }))).msg);
});
test('protocol: session codes', () => {
  assert.equal(P.normaliseCode('abcd-efgh-jkmn'), 'ABCDEFGHJKMN');
  assert.equal(P.normaliseCode('ABCD-EFGH-JKM0'), null); // 0 not in alphabet
  assert.equal(P.normaliseCode('short'), null);
  assert.equal(P.formatCode('ABCDEFGHJKMN'), 'ABCD-EFGH-JKMN');
});

test('remote state: ordering, gaps, epoch restart, staleness', () => {
  const r = new RemoteViewpoint({ staleMs: 500 });
  assert.ok(r.isStale(0));
  assert.ok(r.accept({ ...vp(), seq: 1 }, 0));
  assert.ok(r.accept({ ...vp(), seq: 3 }, 10)); assert.equal(r.stats.gaps, 1);
  assert.equal(r.accept({ ...vp(), seq: 2, az: 99 }, 20), false, 'out-of-order rejected');
  assert.equal(r.latest.az, 10);
  assert.equal(r.accept({ ...vp(), seq: 3 }, 20), false, 'duplicate rejected');
  assert.ok(r.accept({ ...vp(), seq: 0, epoch: 'new' }, 30), 'new epoch resets');
  assert.ok(!r.isStale(400)); assert.ok(r.isStale(531));
});
test('remote state: interpolation is bounded between samples and handles wrap', () => {
  const r = new RemoteViewpoint();
  r.accept({ ...vp(), seq: 1, az: 170 }, 0); r.accept({ ...vp(), seq: 2, az: -170 }, 40);
  const s = r.sample(60, { interpolate: true, delayMs: 40 });
  assert.ok(Math.abs(s.az) > 170, `wrapped interpolation got ${s.az}`);
  assert.equal(r.sample(60, { interpolate: false }).az, -170);
});
test('smoother: tau 0 is passthrough, tau>0 lags', () => {
  const s = new Smoother(); s.step(0, 0, 0, 50);
  near(new Smoother().step(1, 1, 0, 0).x, 1);
  const o = s.step(1, 1, 16, 50); assert.ok(o.x > 0 && o.x < 1);
});

test('calibration: valid swing yields deg/count and sign', () => {
  const r = solveAxis({ refDeg: 90, countsPos: 1800, countsReturn: -40, countsNeg: -1750 });
  assert.ok(r.valid, JSON.stringify(r.checks)); near(r.degPerCount, 90 / 1775); assert.equal(r.sign, 1);
  const inv = solveAxis({ refDeg: 90, countsPos: -1800, countsReturn: 0, countsNeg: 1800 });
  assert.equal(inv.sign, -1);
});
test('calibration: invalid cases cannot be marked valid', () => {
  assert.equal(solveAxis({ refDeg: 90, countsPos: 1800, countsReturn: 0, countsNeg: 1800 }).valid, false, 'same sign');
  { const r = solveAxis({ refDeg: 90, countsPos: 1800, countsReturn: 0, countsNeg: -1000 }); assert.ok(r.valid && !r.reliable, 'asymmetric = approximate'); }
  { const r = solveAxis({ refDeg: 90, countsPos: 1800, countsReturn: 600, countsNeg: -1800 }); assert.ok(r.valid && !r.reliable, 'drift = approximate'); }
  assert.equal(solveAxis({ refDeg: 90, countsPos: 10, countsReturn: 0, countsNeg: -10 }).valid, false, 'resolution');
  assert.equal(solveAxis({ refDeg: 90, countsPos: NaN, countsReturn: 0, countsNeg: -10 }).valid, false);
});
test('tracker: states and integration', () => {
  const cal = { ...emptyCalibration('gunner'), valid: true, degPerCountX: 0.05, degPerCountY: 0.05, signX: 1, signY: -1 };
  const t = new MouseTracker(cal);
  assert.equal(t.estimate().st, 'UNAVAILABLE');
  t.inputHealthy = true; t.addDelta(200, 0); near(t.estimate().az, 10);
  t.addDelta(0, -100); near(t.estimate().el, 5, 1e-9); // mouse up (negative dy) => look up
  t.addDelta(100000, 0); near(t.estimate().az, 180);
  t.focusOk = false; assert.equal(t.estimate().st, 'DEGRADED');
  assert.equal(new MouseTracker(emptyCalibration('gunner')).estimate().st, 'UNCALIBRATED');
  const p = new MouseTracker({ ...cal, role: 'pilot', recenterOnRelease: true }); p.inputHealthy = true;
  p.addDelta(500, 0); assert.equal(p.estimate().st, 'NOSE_LOCKED'); near(p.estimate().az, 0);
  p.setFreelook(true); p.addDelta(200, 0); near(p.estimate().az, 10);
  p.setFreelook(false); near(p.estimate().az, 0);
});

test('pilot default: dot locked to screen centre without calibration or input', () => {
  const t = new MouseTracker(emptyCalibration('pilot'));
  t.addDelta(5000, -3000); // flying the helicopter with the mouse
  const e = t.estimate();
  assert.equal(e.st, 'NOSE_LOCKED'); assert.equal(e.az, 0); assert.equal(e.el, 0); assert.equal(e.cal, true);
  const p = project(e); near(p.x, 0.5); near(p.y, 0.5);
  assert.equal(new MouseTracker(emptyCalibration('gunner')).estimate().st, 'UNCALIBRATED');
});
test('config: defaults, corrupt recovery, type-safe merge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-')); const f = path.join(dir, 'config.json');
  assert.equal(config.load(f).config.role, 'gunner');
  fs.writeFileSync(f, '{broken');
  const r = config.load(f); assert.ok(r.recovered); assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('config.corrupt')));
  config.save(f, { ...r.config, role: 'pilot', dot: { size: 'big', color: '#fff' } });
  const l = config.load(f).config; assert.equal(l.role, 'pilot'); assert.equal(l.dot.size, 14); assert.equal(l.dot.color, '#fff');
  fs.writeFileSync(f, JSON.stringify({ schemaVersion: 99 })); assert.ok(config.load(f).recovered);
});

test('projectIntoView: pilot screen shows gunner aim', () => {
  const pilotView = { az: 0, el: 0 };
  const c = projectIntoView({ az: 0, el: 0 }, pilotView, 90, 16 / 9); near(c.x, 0.5); near(c.y, 0.5); assert.ok(c.inView);
  const r = projectIntoView({ az: 45, el: 0 }, pilotView, 90, 16 / 9); near(r.x, 1, 1e-9); near(r.y, 0.5); // 45° = edge at 90° HFOV
  const q = projectIntoView({ az: 20, el: 10 }, pilotView, 90, 16 / 9);
  assert.ok(q.x > 0.5 && q.y < 0.5 && q.inView, 'right+up lands right+up');
  const side = projectIntoView({ az: -90, el: 0 }, pilotView, 90, 16 / 9);
  assert.equal(side.inView, false); near(side.x, 0); assert.ok(side.ax < 0, 'arrow points left');
  const behind = projectIntoView({ az: 170, el: 0 }, pilotView, 90, 16 / 9);
  assert.equal(behind.inView, false); assert.ok(behind.ax > 0, 'behind-right arrow points right');
});
test('projectIntoView: gunner screen shows pilot nose relative to own aim', () => {
  // Gunner aiming 60° right: the nose (pilot's look) is to the gunner's LEFT.
  const p = projectIntoView({ az: 0, el: 0 }, { az: 60, el: 0 }, 100, 16 / 9);
  assert.ok(p.x < 0.5); assert.equal(p.inView, false); // 60° > 50° half-FOV -> edge arrow left
  const p2 = projectIntoView({ az: 0, el: 0 }, { az: 20, el: -15 }, 100, 16 / 9);
  assert.ok(p2.inView && p2.x < 0.5 && p2.y < 0.5, 'nose appears left and up when aiming right and down');
  // Same direction as own view -> centre, regardless of elevation.
  const s = projectIntoView({ az: 30, el: 40 }, { az: 30, el: 40 }, 100, 16 / 9); near(s.x, 0.5); near(s.y, 0.5);
  assert.equal(projectIntoView({ az: NaN, el: 0 }, { az: 0, el: 0 }, 90, 1.7), null);
});

// Ground-truth manoeuvre simulation: a world-fixed target, a helicopter at arbitrary roll/pitch/yaw,
// gunner aiming at the target. The pilot's TRUE screen position of the target (camera rigidly on the nose)
// must equal what CrewSight draws from the shared nose-relative angles, for every attitude.
test('manoeuvres: nose-relative sharing stays exact under any roll/pitch/yaw', () => {
  const r = Math.PI / 180;
  const mul = (A, B) => A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
  const app = (A, v) => A.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
  const T = (A) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => A[j][i]));
  // Body axes: x forward (nose), y right, z up. Attitude = yaw(z) * pitch(y) * roll(x).
  const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const Ry = (a) => [[Math.cos(a), 0, -Math.sin(a)], [0, 1, 0], [Math.sin(a), 0, Math.cos(a)]]; // +a = nose up
  const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), Math.sin(a)], [0, -Math.sin(a), Math.cos(a)]]; // +a = right roll
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 500; i++) {
    const R = mul(mul(Rz((rnd() * 360 - 180) * r), Ry((rnd() * 120 - 60) * r)), Rx((rnd() * 180 - 90) * r)); // body -> world
    const tgtWorld = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
    const n = Math.hypot(...tgtWorld); const w = tgtWorld.map((x) => x / n);
    // Gunner's aim in body frame (what the gunner's tracker reports):
    const b = app(T(R), w);
    const az = Math.atan2(b[1], b[0]) / r, el = Math.asin(Math.max(-1, Math.min(1, b[2]))) / r;
    // TRUTH: pilot camera = body frame; pinhole projection of the world target.
    const fov = 100, aspect = 16 / 9, th = Math.tan((fov / 2) * r);
    if (b[0] <= 0.05) continue; // behind the pilot: arrow case, covered elsewhere
    const tx = 0.5 + 0.5 * (b[1] / b[0]) / th, ty = 0.5 - 0.5 * (b[2] / b[0]) / (th / aspect);
    const got = projectIntoView({ az, el }, { az: 0, el: 0 }, fov, aspect);
    if (tx < 0 || tx > 1 || ty < 0 || ty > 1) { assert.equal(got.inView, false); continue; }
    near(got.x, tx, 1e-9); near(got.y, ty, 1e-9);
  }
});

test('calibration (lenient): real gunner data is accepted as approximate with vertical from horizontal', () => {
  const { combineAxes } = require('../core/tracker');
  // Reported in-game: uneven horizontal swings, vertical turret hit a stop (41 % residual).
  const sx = solveAxis({ refDeg: 90, countsPos: 4316, countsReturn: 69, countsNeg: -6797 });
  const sy = solveAxis({ refDeg: 45, countsPos: -1203, countsReturn: -494, countsNeg: 1404 });
  assert.ok(sx.valid && !sx.reliable, 'horizontal usable but approximate');
  assert.ok(sy.valid && !sy.reliable, 'vertical flagged unreliable');
  const c = combineAxes(sx, sy);
  assert.ok(c.valid && c.approximate && c.verticalFromHorizontal);
  near(c.degPerCountY, sx.degPerCount); assert.equal(c.signY, -1, 'measured sign kept: mouse up = look up');
  assert.equal(solveAxis({ refDeg: 90, countsPos: 4000, countsReturn: 0, countsNeg: -500 }).valid, false, '8x mismatch still rejected');
  assert.equal(combineAxes(solveAxis({ refDeg: 90, countsPos: 30, countsReturn: 0, countsNeg: -30 }), sy).valid, false);
});
