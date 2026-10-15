'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { project, wrapDeg, contentRect, toPixels } = require('../core/projection');
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
  assert.equal(solveAxis({ refDeg: 90, countsPos: 1800, countsReturn: 0, countsNeg: -1000 }).valid, false, 'asymmetric');
  assert.equal(solveAxis({ refDeg: 90, countsPos: 1800, countsReturn: 600, countsNeg: -1800 }).valid, false, 'drift');
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
