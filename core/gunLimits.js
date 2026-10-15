'use strict';
// Gun viewport limits: the region of nose-relative directions the gunner's camera can reach.
// Stored in DEGREES (independent of mouse sensitivity) as an envelope: for each azimuth bin, the lowest and
// highest reachable elevation. Built from a trace the gunner makes along the limits.

const LIMITS_VERSION = 1;

/** points: [{az, el}] along (and inside) the boundary. Returns an envelope or null. */
function buildEnvelope(points, { binDeg = 5 } = {}) {
  const pts = (points || []).filter((p) => Number.isFinite(p.az) && Number.isFinite(p.el));
  if (pts.length < 10) return null;
  const azMin = Math.min(...pts.map((p) => p.az)), azMax = Math.max(...pts.map((p) => p.az));
  const start = Math.floor(azMin / binDeg) * binDeg;
  const n = Math.max(1, Math.ceil((azMax - start) / binDeg));
  const bins = Array.from({ length: n }, (_, i) => ({ az: start + (i + 0.5) * binDeg, elMin: Infinity, elMax: -Infinity, count: 0 }));
  for (const p of pts) {
    const b = bins[Math.min(n - 1, Math.max(0, Math.floor((p.az - start) / binDeg)))];
    b.elMin = Math.min(b.elMin, p.el); b.elMax = Math.max(b.elMax, p.el); b.count++;
  }
  // Fill bins the trace skipped (fast swipes) by linear interpolation between neighbours with data.
  const filled = bins.filter((b) => b.count > 0);
  for (const b of bins) {
    if (b.count) continue;
    const lo = [...filled].reverse().find((f) => f.az < b.az), hi = filled.find((f) => f.az > b.az);
    const a = lo || hi, c = hi || lo, k = lo && hi ? (b.az - lo.az) / (hi.az - lo.az) : 0;
    b.elMin = a.elMin + (c.elMin - a.elMin) * k; b.elMax = a.elMax + (c.elMax - a.elMax) * k;
  }
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    version: LIMITS_VERSION, binDeg, azMin: r1(azMin), azMax: r1(azMax),
    bins: bins.map((b) => ({ az: r1(b.az), elMin: r1(b.elMin), elMax: r1(b.elMax), measured: b.count > 0 })),
    pointCount: pts.length, coverage: r1(filled.length / bins.length),
  };
}

/** Elevation range at a given azimuth (linear between bin centres). */
function elRangeAt(env, az) {
  const b = env.bins;
  if (az <= b[0].az) return [b[0].elMin, b[0].elMax];
  if (az >= b[b.length - 1].az) return [b[b.length - 1].elMin, b[b.length - 1].elMax];
  const i = Math.min(b.length - 2, Math.floor((az - b[0].az) / env.binDeg));
  const k = (az - b[i].az) / (b[i + 1].az - b[i].az);
  return [b[i].elMin + (b[i + 1].elMin - b[i].elMin) * k, b[i].elMax + (b[i + 1].elMax - b[i].elMax) * k];
}

/** Clamp a direction into the reachable envelope — mimics the gun stopping at its limits. */
function clampToEnvelope(env, az, el) {
  if (!env) return { az, el, clamped: false };
  const a = Math.max(env.azMin, Math.min(env.azMax, az));
  const [lo, hi] = elRangeAt(env, a);
  const e = Math.max(lo, Math.min(hi, el));
  return { az: a, el: e, clamped: a !== az || e !== el };
}

/** Sanity checks; returns { valid, checks }. */
function validateEnvelope(env, returnResidualDeg) {
  const checks = [];
  const add = (name, pass, detail, warn = false) => checks.push({ name, pass, warn, detail });
  if (!env) { add('enough-points', false, 'trace too short — move along the limits for longer'); return { valid: false, checks }; }
  add('traverse-range', env.azMax - env.azMin >= 10, `left/right ${env.azMin}° … ${env.azMax}°`);
  add('elevation-range', env.bins.every((b) => b.elMax - b.elMin >= 1), 'every slice has an up/down range');
  add('coverage', true, `${Math.round(env.coverage * 100)}% of slices traced directly (rest interpolated)`, env.coverage < 0.6);
  if (Number.isFinite(returnResidualDeg))
    add('return-to-nose', true, `ended ${returnResidualDeg.toFixed(1)}° from the nose (ideal < 5°; large = pushed into a stop)`, returnResidualDeg > 5);
  return { valid: checks.every((c) => c.pass), checks };
}

module.exports = { LIMITS_VERSION, buildEnvelope, clampToEnvelope, elRangeAt, validateEnvelope };
