'use strict';
// Gunner viewpoint from the gunner's OWN screen, fused with the helicopter attitude from the pilot.
//
//   q_gun   : gunner camera -> world   (integrated from image rotation of the gunner's capture)
//   q_heli  : airframe      -> world   (streamed from the pilot's view)
//   turret  = q_heli⁻¹ · q_gun          -> direction relative to the nose (what the crew dot needs)
//
// The image shows what the optic really did, so turret speed limits, stops and smoothing are measured instead
// of assumed. When the picture lacks detail (plain sky) the mouse fills in, with a degrees-per-count scale
// that is learned from the image while both are available. Recorded gun limits clamp the result.
const A = require('./attitude');
const { clampToEnvelope } = require('./gunLimits');

const D = Math.PI / 180;

class GunnerFusion {
  constructor({ degPerCountX = null, degPerCountY = null, signX = 1, signY = -1, limits = null, minConf = 0.4 } = {}) {
    this.minConf = minConf;
    this.qGun = A.IDENTITY; this.qHeli = A.IDENTITY; this.heliOk = false;
    this.scaleX = degPerCountX; this.scaleY = degPerCountY; this.signX = signX; this.signY = signY;
    this.limits = limits; this.learnN = 0;
    this.lastSource = 'none'; this.visualConf = 0;
  }
  setLimits(env) { this.limits = env || null; }
  /** Latest helicopter attitude from the pilot (same arbitrary world frame for both players). */
  setHeli(q, ok) {
    // Keep the turret estimate continuous: the airframe turning must not move the turret relative to the nose.
    const d = A.qmul(A.qconj(this.qHeli), q);
    this.heliTurnDeg = 2 * Math.acos(Math.min(1, Math.abs(d[0]))) / D; // since the previous update
    this.qHeli = q; this.heliOk = !!ok;
  }
  /** Gun pointing along the nose now. */
  zero() { this.qGun = this.qHeli; }

  /**
   * One camera frame: inc = rotation estimated from the gunner's image ({yaw,pitch,roll,conf} radians, camera
   * frame) or null; mouse = raw counts since the previous frame.
   */
  step(inc, mouse = { dx: 0, dy: 0 }) {
    const visual = inc && inc.conf >= this.minConf;
    this.visualConf = inc ? inc.conf : 0;
    if (visual) {
      this.qGun = A.integrate(this.qGun, inc.yaw, inc.pitch, inc.roll);
      this._learnScale(inc, mouse);
      this.lastSource = 'visual';
    } else if ((mouse.dx || mouse.dy) && this.scaleX) {
      // Mouse fallback: counts -> camera yaw/pitch with the learned/calibrated scale.
      const yaw = mouse.dx * this.scaleX * this.signX * D, pitch = mouse.dy * (this.scaleY || this.scaleX) * this.signY * D;
      this.qGun = A.integrate(this.qGun, yaw, pitch, 0);
      this.lastSource = 'mouse';
    } else if (!visual) this.lastSource = this.scaleX ? this.lastSource : 'none';
    this._gimbal();
    return this.estimate();
  }

  // A gun mount turns left/right and up/down only: it can't roll relative to the airframe. Re-imposing that each
  // frame stops small roll-estimation errors from slowly turning horizontal movement into fake vertical movement.
  _gimbal() {
    const qT = A.qmul(A.qconj(this.qHeli), this.qGun);
    const { az, el } = A.azElFromDir(A.qrot(qT, [1, 0, 0]));
    this.qGun = A.qmul(this.qHeli, A.qmul(A.qFromYPR(az * D, 0, 0), A.qFromYPR(0, el * D, 0)));
  }

  // While the image is reliable and the mouse moved clearly, image rotation / counts = degrees per count.
  // Only learned from frames without a fast helicopter turn mixed in (that motion isn't from the mouse).
  _learnScale(inc, mouse) {
    if ((this.heliTurnDeg || 0) > 0.3 || this.atLimit) return; // helicopter turning or gun held at a stop
    const yawDeg = Math.abs(inc.yaw) / D, pitchDeg = Math.abs(inc.pitch) / D;
    if (Math.abs(mouse.dx) >= 8 && yawDeg > 0.2 && Math.abs(inc.roll) < 0.3 * D) {
      const s = yawDeg / Math.abs(mouse.dx);
      this.scaleX = this.scaleX ? this.scaleX + (s - this.scaleX) * 0.05 : s;
      this.learnN++;
    }
    if (Math.abs(mouse.dy) >= 8 && pitchDeg > 0.2 && Math.abs(inc.roll) < 0.3 * D) {
      const s = pitchDeg / Math.abs(mouse.dy);
      this.scaleY = this.scaleY ? this.scaleY + (s - this.scaleY) * 0.05 : s;
    }
  }

  /** Turret direction relative to the nose, clamped to the recorded gun limits. */
  estimate() {
    const qT = A.qmul(A.qconj(this.qHeli), this.qGun);
    let { az, el } = A.azElFromDir(A.qrot(qT, [1, 0, 0]));
    if (this.limits) {
      const c = clampToEnvelope(this.limits, az, el);
      this.atLimit = c.clamped;
      if (c.clamped) {
        // The real gun can't be there: pull the estimate back onto the limit (removes drift past a stop).
        az = c.az; el = c.el;
        this.qGun = A.qmul(this.qHeli, A.qmul(A.qFromYPR(az * D, 0, 0), A.qFromYPR(0, el * D, 0)));
      }
    }
    return { az, el, source: this.lastSource, heliOk: this.heliOk, visualConf: this.visualConf, learnedScaleX: this.scaleX };
  }
}

module.exports = { GunnerFusion };
