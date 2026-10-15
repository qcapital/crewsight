'use strict';
// Receiver-side bookkeeping for the peer's viewpoint stream:
// sequence ordering, staleness, update-rate and drop statistics.
// All times are LOCAL monotonic milliseconds (performance.now()); peer timestamps are
// never compared against local clocks.

class RemoteViewpoint {
  constructor({ staleMs = 750 } = {}) {
    this.staleMs = staleMs;
    this.reset();
  }
  reset() {
    this.epoch = null; this.lastSeq = -1; this.latest = null; this.prev = null;
    this.receivedAt = null; this.prevReceivedAt = null;
    this.stats = { accepted: 0, rejectedOld: 0, gaps: 0 };
    this._rateWindow = [];
  }
  /** Returns true if the message became the newest state. */
  accept(msg, now) {
    if (msg.epoch !== this.epoch) {
      // Peer restarted its tracker (new epoch): restart the sequence space.
      this.epoch = msg.epoch; this.lastSeq = -1; this.latest = null; this.prev = null;
    }
    if (msg.seq <= this.lastSeq) { this.stats.rejectedOld++; return false; }
    if (this.lastSeq >= 0 && msg.seq > this.lastSeq + 1) this.stats.gaps += msg.seq - this.lastSeq - 1;
    this.lastSeq = msg.seq;
    this.prev = this.latest; this.prevReceivedAt = this.receivedAt;
    this.latest = msg; this.receivedAt = now;
    this.stats.accepted++;
    this._rateWindow.push(now);
    while (this._rateWindow.length && now - this._rateWindow[0] > 1000) this._rateWindow.shift();
    return true;
  }
  isStale(now) { return this.receivedAt === null || now - this.receivedAt > this.staleMs; }
  updateRateHz(now) { return this._rateWindow.filter((t) => now - t <= 1000).length; }

  /**
   * Display sample. With interpolation on, renders `delayMs` in the past between the two
   * newest samples (smooth, adds ~one update period of latency). Off = newest sample.
   */
  sample(now, { interpolate = false, delayMs = 40 } = {}) {
    const cur = this.latest;
    if (!cur) return null;
    if (!interpolate || !this.prev || cur.az === null || this.prev.az === null) return cur;
    const t = now - delayMs;
    const t0 = this.prevReceivedAt, t1 = this.receivedAt;
    if (t1 <= t0 || t >= t1) return cur;
    const k = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
    let dAz = cur.az - this.prev.az;
    if (dAz > 180) dAz -= 360; else if (dAz < -180) dAz += 360;
    return { ...cur, az: this.prev.az + dAz * k, el: this.prev.el + (cur.el - this.prev.el) * k };
  }
}

/** Exponential visual smoothing with time constant tauMs (0 = disabled). */
class Smoother {
  constructor() { this.x = null; this.y = null; this.t = null; }
  step(x, y, now, tauMs) {
    if (!(tauMs > 0) || this.x === null) { this.x = x; this.y = y; this.t = now; return { x, y }; }
    const a = 1 - Math.exp(-(now - this.t) / tauMs);
    this.x += (x - this.x) * a; this.y += (y - this.y) * a; this.t = now;
    return { x: this.x, y: this.y };
  }
  reset() { this.x = this.y = this.t = null; }
}

module.exports = { RemoteViewpoint, Smoother };
