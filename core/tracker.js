'use strict';
// Local viewpoint estimation from user-authorised raw mouse deltas + calibration.
// This is DEAD RECKONING: angle = sum(counts) * degPerCount, re-zeroed by the user.
// It is only as good as the assumption that the game maps raw counts linearly to view angle
// (no in-game acceleration/smoothing, no automatic recentering). Calibration checks this.

const { clampToEnvelope } = require('./gunLimits');

const CAL_VERSION = 1;

// Pilot default: the mouse flies the helicopter and the camera stays on the nose, so the pilot's
// viewpoint is the centre of their own screen. Needs no calibration and no mouse observation.
// Running calibration replaces this with free-look tracking (camera follows the mouse only while the key is held).
function emptyCalibration(role) {
  return { version: CAL_VERSION, role, valid: role === 'pilot', degPerCountX: null, degPerCountY: null,
    signX: 1, signY: -1, azLimit: 180, elLimit: 60,
    // pilot: camera follows the nose except while the free-look key is held
    pilotFreelookVk: role === 'pilot' ? 0x12 /* Alt */ : null, recenterOnRelease: true, noseOnly: role === 'pilot',
    createdAt: null, checks: [] };
}

/**
 * Calibration procedure (per axis): user zeroes on the nose, turns to a reference they can
 * identify at a known angle (default 90° = straight out the side), marks; returns to the
 * nose, marks (return check); turns the same angle the other way, marks.
 * Hard failures (data unusable): missing marks, too few counts, both swings in the same direction,
 * swings differing by more than 2.5x. Soft checks only WARN and mark the axis "approximate":
 * symmetry outside 0.85–1.18 (usually a misjudged reference angle) and return residual > 10 %
 * (usually the turret hit a stop while the mouse kept moving). Scale = reference / mean swing.
 */
function solveAxis({ refDeg, countsPos, countsReturn, countsNeg }) {
  const checks = [];
  const ok = (name, pass, detail) => { checks.push({ name, pass, detail }); return pass; };
  const warn = (name, good, detail) => { checks.push({ name, pass: true, warn: !good, detail }); return good; };
  const finite = [refDeg, countsPos, countsReturn, countsNeg].every(Number.isFinite);
  if (!ok('numeric', finite, 'all marks recorded')) return { valid: false, reliable: false, checks };
  ok('reference-angle', refDeg >= 5 && refDeg <= 180, `${refDeg}°`);
  ok('resolution', Math.abs(countsPos) >= 50 && Math.abs(countsNeg) >= 50,
    `${countsPos} / ${countsNeg} counts (need ≥50)`);
  ok('opposite-signs', Math.sign(countsPos) === -Math.sign(countsNeg) && countsPos !== 0,
    'positive and negative swings move in opposite directions');
  const ratio = Math.abs(countsPos) / Math.max(1, Math.abs(countsNeg));
  ok('swings-comparable', ratio >= 0.4 && ratio <= 2.5, `ratio ${ratio.toFixed(3)} (must be 0.4–2.5)`);
  const sym = warn('symmetry', ratio > 0.85 && ratio < 1.0 / 0.85,
    `ratio ${ratio.toFixed(3)} (ideal 0.85–1.18; outside = one turn over/undershot, scale averaged)`);
  const resid = Math.abs(countsReturn) / Math.max(1, Math.abs(countsPos));
  const ret = warn('return-to-centre', resid <= 0.10,
    `residual ${(resid * 100).toFixed(1)}% (ideal ≤10%; large = turret hit a stop, or acceleration/smoothing)`);
  const valid = checks.every((c) => c.pass);
  const avg = (Math.abs(countsPos) + Math.abs(countsNeg)) / 2;
  return { valid, reliable: valid && sym && ret, checks, degPerCount: valid ? refDeg / avg : null, sign: Math.sign(countsPos) || 1 };
}

/**
 * Combine axes. Games normally use one sensitivity for both axes, so when the vertical measurement is
 * unusable or unreliable (turrets often hit elevation stops) but horizontal is valid, vertical uses the
 * horizontal scale with the measured vertical sign (or mouse-up = look-up if the sign is unknown).
 */
function combineAxes(sx, sy) {
  const checks = [];
  let degY = sy.degPerCount, signY = sy.sign, verticalFromHorizontal = false;
  if (sx.valid && (!sy.valid || !sy.reliable)) {
    const signKnown = sy.checks.some((c) => c.name === 'opposite-signs' && c.pass);
    degY = sx.degPerCount; signY = signKnown ? sy.sign : -1; verticalFromHorizontal = true;
    checks.push({ name: 'vertical-scale', pass: true, warn: true,
      detail: `vertical measurement unreliable → using horizontal scale (${signKnown ? 'measured' : 'assumed'} direction)` });
  }
  const valid = sx.valid && (sy.valid || verticalFromHorizontal);
  return { valid, degPerCountY: valid ? degY : null, signY, verticalFromHorizontal,
    approximate: !sx.reliable || verticalFromHorizontal || !sy.reliable, checks };
}

class MouseTracker {
  constructor(calibration) {
    this.setCalibration(calibration);
    this.inputHealthy = false;   // raw-input helper alive
    this.focusOk = true;         // foreground filter satisfied
    this.freelookHeld = false;
    this.lastResetAt = null;
  }
  setCalibration(cal) { this.cal = cal; this.az = 0; this.el = 0; }
  /** Recorded gun limits (degrees). Clamping makes pushes into a stop cost nothing, exactly like the gun. */
  setLimits(env) { this.limits = env || null; }
  zero(now) { this.az = 0; this.el = 0; this.lastResetAt = now; }
  setFreelook(down) {
    this.freelookHeld = down;
    if (!down && this.cal.recenterOnRelease) { this.az = 0; this.el = 0; }
  }
  addDelta(dx, dy) {
    const c = this.cal;
    if (!c.valid || !this.focusOk) return;
    if (c.noseOnly || (c.role === 'pilot' && !this.freelookHeld)) return; // camera locked to nose
    this.az += dx * c.degPerCountX * c.signX;
    this.el += dy * c.degPerCountY * c.signY;
    this.az = Math.max(-c.azLimit, Math.min(c.azLimit, this.az));
    this.el = Math.max(-c.elLimit, Math.min(c.elLimit, this.el));
    if (this.limits && c.role === 'gunner') ({ az: this.az, el: this.el } = clampToEnvelope(this.limits, this.az, this.el));
  }
  /** Current estimate + honest state. */
  estimate() {
    const c = this.cal;
    if (!c.valid) return { az: null, el: null, src: 'none', st: 'UNCALIBRATED', cal: false };
    if (c.noseOnly) return { az: 0, el: 0, src: 'nose-assumed', st: 'NOSE_LOCKED', cal: true };
    if (!this.inputHealthy) return { az: null, el: null, src: 'none', st: 'UNAVAILABLE', cal: true };
    if (!this.focusOk) return { az: this.az, el: this.el, src: 'mouse', st: 'DEGRADED', cal: true };
    if (c.noseOnly || (c.role === 'pilot' && !this.freelookHeld))
      return { az: 0, el: 0, src: 'nose-assumed', st: 'NOSE_LOCKED', cal: true };
    return { az: this.az, el: this.el, src: 'mouse', st: 'LIVE_ESTIMATED', cal: true };
  }
}

module.exports = { CAL_VERSION, emptyCalibration, solveAxis, combineAxes, MouseTracker };
