'use strict';
// Estimates the helicopter's frame-to-frame rotation from the PILOT's own game image.
// The pilot camera is rigidly fixed to the nose, so global image motion of the scenery = body rotation.
//
// Method: block-match a grid of textured patches between consecutive small grayscale frames, then fit the
// exact small-rotation flow field of a pinhole camera (x right, y down, origin at the image centre, pixels,
// f = focal length from the horizontal FOV), plus a divergence term k that absorbs forward flight:
//   dx = -(f + x²/f)·yaw + (x·y/f)·pitch + y·roll + k·x
//   dy = -(x·y/f)·yaw + (f + y²/f)·pitch - x·roll + k·y
// by iteratively reweighted least squares. Patches that disagree (static cockpit, other vehicles, smoke) are
// down-weighted, and patches that stay still while the scene moves are learned as a static mask (cockpit frame).

class RotationEstimator {
  constructor({ w = 160, h = 90, fovH = 90, grid = [9, 5], patch = 14, search = 10, step = 2, minTexture = 40 } = {}) {
    Object.assign(this, { w, h, grid, patch, search, step, minTexture });
    this.setFov(fovH);
    this.prev = null; this.key = null; this.rel = [0, 0, 0];
    const [gx, gy] = grid, m = search + patch / 2 + 1;
    this.cells = [];
    for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
      this.cells.push({ cx: Math.round(m + (i + 0.5) * (w - 2 * m) / gx), cy: Math.round(m + (j + 0.5) * (h - 2 * m) / gy), still: 0 });
    }
  }
  setFov(fovH) { this.f = (this.w / 2) / Math.tan(((fovH / 2) * Math.PI) / 180); }
  reset() { this.prev = null; this.key = null; this.rel = [0, 0, 0]; }

  _match(prev, cur, cx, cy) {
    const { w, patch: p, search: s, step } = this, h2 = p >> 1;
    // Texture check on the previous patch.
    let sum = 0, sum2 = 0, n = 0;
    for (let y = cy - h2; y < cy + h2; y += step) for (let x = cx - h2; x < cx + h2; x += step) { const v = prev[y * w + x]; sum += v; sum2 += v * v; n++; }
    const variance = sum2 / n - (sum / n) ** 2;
    if (variance < this.minTexture) return null;
    const cost = new Float64Array((2 * s + 1) ** 2);
    let best = Infinity, bi = 0, total = 0;
    for (let dy = -s; dy <= s; dy++) for (let dx = -s; dx <= s; dx++) {
      let e = 0;
      for (let y = cy - h2; y < cy + h2; y += step) {
        const ry = y * w, qy = (y + dy) * w + dx;
        for (let x = cx - h2; x < cx + h2; x += step) e += Math.abs(prev[ry + x] - cur[qy + x]);
      }
      const idx = (dy + s) * (2 * s + 1) + (dx + s);
      cost[idx] = e; total += e;
      if (e < best) { best = e; bi = idx; }
    }
    const W = 2 * s + 1, bx = (bi % W) - s, by = Math.floor(bi / W) - s;
    // Distinctiveness: best must be clearly below the average cost.
    if (best > 0.6 * (total / cost.length)) return null;
    // Sub-pixel refinement (parabola through neighbours).
    const sub = (cm, c0, cp) => { const d = cm - 2 * c0 + cp; return d > 0 ? 0.5 * (cm - cp) / d : 0; };
    const at = (x, y) => cost[(y + s) * W + (x + s)];
    const fx = Math.abs(bx) < s ? sub(at(bx - 1, by), best, at(bx + 1, by)) : 0;
    const fy = Math.abs(by) < s ? sub(at(bx, by - 1), best, at(bx, by + 1)) : 0;
    return { dx: bx + fx, dy: by + fy };
  }

  /**
   * Feed a grayscale frame (Uint8Array w*h). Returns the rotation since the previous frame, or null.
   * Keyframes: each frame is measured against a reference frame and the increment is the change of that
   * measurement. Small per-frame motions (slow turns) are thus measured as larger, precise shifts, and matching
   * errors don't pile up every frame. The reference advances once the view has turned ~2.5° or matching weakens.
   */
  push(gray) {
    const first = !this.key;
    this.prev = gray;
    if (first) { this.key = gray; this.rel = [0, 0, 0]; return null; }
    const r = this._between(this.key, gray);
    const KEY_ADVANCE = 2.5 * Math.PI / 180;
    if (r.conf > 0) {
      const inc = { ...r, yaw: r.yaw - this.rel[0], pitch: r.pitch - this.rel[1], roll: r.roll - this.rel[2] };
      this.rel = [r.yaw, r.pitch, r.roll];
      if (Math.max(Math.abs(r.yaw), Math.abs(r.pitch), Math.abs(r.roll)) > KEY_ADVANCE || r.conf < 0.5) { this.key = gray; this.rel = [0, 0, 0]; }
      return inc;
    }
    // Lost the reference (big jump or no detail): restart from this frame; this frame's motion is unknown.
    this.key = gray; this.rel = [0, 0, 0];
    return r;
  }

  _between(prev, gray) {
    const obs = [];
    for (const c of this.cells) {
      if (c.still > 8) { c.still -= 0.002; continue; } // learned static region (cockpit / gun model): skip, re-test after ~1-2 min
      const m = this._match(prev, gray, c.cx, c.cy);
      if (m) obs.push({ x: c.cx - this.w / 2, y: c.cy - this.h / 2, dx: m.dx, dy: m.dy, cell: c });
    }
    if (obs.length < 6) return { yaw: 0, pitch: 0, roll: 0, conf: 0, used: obs.length, reason: 'too-little-texture' };
    const f = this.f;
    for (const o of obs) {
      o.rx = [-(f + (o.x * o.x) / f), (o.x * o.y) / f, o.y, o.x];
      o.ry = [-(o.x * o.y) / f, f + (o.y * o.y) / f, -o.x, o.y];
    }
    // RANSAC: hypotheses from random patch pairs (4 equations, 4 unknowns); keep the motion most patches agree
    // on, so a large static cockpit or a moving vehicle can't drag the answer. Then refine on the inliers.
    let rng = (this.seed = (this.seed || 12345) * 16807 % 2147483647);
    const rand = (n) => { rng = rng * 16807 % 2147483647; return rng % n; };
    const TH = 0.8;
    let best = null, bestCount = -1, bestErr = Infinity;
    const consider = (p) => {
      let count = 0, err = 0;
      for (const o of obs) { const r = resid(o, p); if (r < TH) { count++; err += r; } }
      if (count > bestCount || (count === bestCount && err < bestErr)) { best = p; bestCount = count; bestErr = err; }
    };
    consider([0, 0, 0, 0]);
    for (let it = 0; it < 80; it++) {
      const a = obs[rand(obs.length)], b = obs[rand(obs.length)];
      if (a === b || Math.hypot(a.x - b.x, a.y - b.y) < 15) continue;
      consider(solve([a, b], [1, 1]));
    }
    let p = best;
    for (let it = 0; it < 3; it++) {
      const inSet = obs.filter((o) => resid(o, p) < TH * 1.5);
      if (inSet.length < 6) break;
      p = solve(inSet, inSet.map(() => 1));
    }
    const inl = obs.filter((o) => resid(o, p) < 1.2);
    // Learn the static mask: patches that don't move while the fitted scene clearly does.
    const sceneMotion = Math.hypot(p[0], p[1]) * f + Math.abs(p[2]) * this.w / 2;
    for (const o of obs) {
      const still = Math.hypot(o.dx, o.dy) < 0.3;
      if (sceneMotion > 0.6 && still) o.cell.still = Math.min(40, o.cell.still + 1); else if (!still) o.cell.still = Math.max(0, o.cell.still - 1);
    }
    const conf = inl.length / Math.max(obs.length, 1) * Math.min(1, inl.length / 10);
    if (inl.length < 6) return { yaw: 0, pitch: 0, roll: 0, conf: 0, used: obs.length, reason: 'no-consistent-motion' };
    // Deadband against the reference frame: sub-pixel matching noise is ~0.01°; below 0.02° treat as no rotation
    // so a hovering helicopter doesn't drift. (Measured against the keyframe, so slow turns still accumulate.)
    const DB = 0.02 * Math.PI / 180;
    if (Math.abs(p[0]) < DB && Math.abs(p[1]) < DB && Math.abs(p[2]) < DB) return { yaw: 0, pitch: 0, roll: 0, div: p[3], conf, used: inl.length };
    return { yaw: p[0], pitch: p[1], roll: p[2], div: p[3], conf, used: inl.length };
  }
}

const dot4 = (r, p) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3] * p[3];
function resid(o, p) { return Math.hypot(o.dx - dot4(o.rx, p), o.dy - dot4(o.ry, p)); }
// Weighted least squares for [yaw, pitch, roll, k].
function solve(obs, wts) {
  const A = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], B = [0, 0, 0, 0];
  obs.forEach((o, i) => {
    const w = wts[i];
    for (const [row, rhs] of [[o.rx, o.dx], [o.ry, o.dy]]) {
      for (let r = 0; r < 4; r++) { B[r] += w * row[r] * rhs; for (let c = 0; c < 4; c++) A[r][c] += w * row[r] * row[c]; }
    }
  });
  for (let r = 0; r < 4; r++) A[r][r] += 1e-6;
  // Gaussian elimination.
  for (let i = 0; i < 4; i++) {
    let piv = i; for (let r = i + 1; r < 4; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
    [A[i], A[piv]] = [A[piv], A[i]]; [B[i], B[piv]] = [B[piv], B[i]];
    for (let r = i + 1; r < 4; r++) { const k = A[r][i] / A[i][i]; for (let c = i; c < 4; c++) A[r][c] -= k * A[i][c]; B[r] -= k * B[i]; }
  }
  const x = [0, 0, 0, 0];
  for (let i = 3; i >= 0; i--) { let s = B[i]; for (let c = i + 1; c < 4; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
  return x;
}

module.exports = { RotationEstimator };
