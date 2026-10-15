'use strict';
// Detects that the gun is pressed against a stop: the mouse keeps moving along an axis but the gunner's own
// game image does not move along that axis. Used while recording gun limits (helicopter parked, so image
// motion comes from the camera). Per axis, so sliding ALONG a limit still records the free axis.
// Capture lags the mouse, so mouse motion is taken from an older window than image motion.

class StopDetector {
  constructor({ mouseFrom = 220, mouseTo = 70, imageWindow = 150, mouseThr = 6, imageThr = 0.6, staleMs = 250 } = {}) {
    Object.assign(this, { mouseFrom, mouseTo, imageWindow, mouseThr, imageThr, staleMs });
    this.mouse = []; this.image = []; this.applied = []; this.wasX = false; this.wasY = false;
  }
  addMouse(dx, dy, t) { this.mouse.push({ dx, dy, t }); this._trim(t); }
  /** sx, sy: estimated image shift (px of the analysis frame) since the previous analysed frame. */
  addImage(sx, sy, t) { this.image.push({ sx, sy, t }); this._trim(t); }
  _trim(t) {
    while (this.mouse.length && t - this.mouse[0].t > this.mouseFrom + 50) this.mouse.shift();
    while (this.image.length && t - this.image[0].t > 1000) this.image.shift();
    while (this.applied.length && t - this.applied[0].t > 1000) this.applied.shift();
  }
  available(t) { return this.image.length > 0 && t - this.image[this.image.length - 1].t < this.staleMs; }
  /**
   * Should a new delta (dx, dy) be ignored because the gun is at a stop in that direction?
   * Only deltas in the SAME direction as the recent push are blocked, so backing off a stop is never lost.
   */
  filter(dx, dy, t) {
    if (!this.available(t)) return { dx, dy, blockedX: false, blockedY: false, visual: false };
    const m = this.mouse.filter((s) => t - s.t <= this.mouseFrom && t - s.t >= this.mouseTo);
    const img = this.image.filter((s) => t - s.t <= this.imageWindow);
    if (img.length < 2) return { dx, dy, blockedX: false, blockedY: false, visual: true };
    const netX = m.reduce((a, s) => a + s.dx, 0), netY = m.reduce((a, s) => a + s.dy, 0);
    const imgX = img.reduce((a, s) => a + Math.abs(s.sx), 0), imgY = img.reduce((a, s) => a + Math.abs(s.sy), 0);
    const blockedX = Math.abs(netX) >= this.mouseThr && imgX < this.imageThr && Math.sign(dx) === Math.sign(netX) && dx !== 0;
    const blockedY = Math.abs(netY) >= this.mouseThr && imgY < this.imageThr && Math.sign(dy) === Math.sign(netY) && dy !== 0;
    // Retro-correction: the image lags the mouse by ~mouseTo ms, so when a stop is first detected the deltas
    // applied since (last image motion on that axis − lag) never moved the camera either. Report them for undo.
    const undo = (axis, key, sign) => {
      const moved = this.image.filter((s) => Math.abs(s[key]) >= this.imageThr / 2);
      const since = (moved.length ? moved[moved.length - 1].t : -Infinity) - this.mouseTo;
      return this.applied.filter((s) => s.t > since && Math.sign(s[axis]) === sign).reduce((a, s) => a + s[axis], 0);
    };
    const undoX = blockedX && !this.wasX ? undo('dx', 'sx', Math.sign(netX)) : 0;
    const undoY = blockedY && !this.wasY ? undo('dy', 'sy', Math.sign(netY)) : 0;
    if (undoX || undoY) this.applied = this.applied.map((s) => ({ ...s, dx: undoX ? 0 : s.dx, dy: undoY ? 0 : s.dy }));
    if (blockedX || blockedY || (dx === 0 && dy === 0)) { /* nothing applied */ }
    this.wasX = blockedX; this.wasY = blockedY;
    const out = { dx: blockedX ? 0 : dx, dy: blockedY ? 0 : dy };
    if (out.dx || out.dy) this.applied.push({ ...out, t });
    return { ...out, blockedX, blockedY, visual: true, undoX, undoY,
      undoSince: undoX || undoY ? (this.image.length ? this.image[this.image.length - 1].t : t) - this.imageWindow - this.mouseTo : null };
  }
}

/**
 * Global translation between two small grayscale frames (Uint8 arrays, w*h) by exhaustive block matching
 * over ±maxShift px on a centre crop. Returns { sx, sy, err } where (sx, sy) moves `prev` onto `cur`.
 */
function estimateShift(prev, cur, w, h, maxShift = 8) {
  const m = maxShift, step = 2;
  let best = { sx: 0, sy: 0, err: Infinity };
  for (let sy = -m; sy <= m; sy++) {
    for (let sx = -m; sx <= m; sx++) {
      let err = 0, n = 0;
      for (let y = m; y < h - m; y += step) {
        const ry = y * w, py = (y - sy) * w;
        for (let x = m; x < w - m; x += step) { err += Math.abs(cur[ry + x] - prev[py + x - sx]); n++; }
      }
      err /= n;
      if (err < best.err - 1e-9 || (Math.abs(err - best.err) < 1e-9 && Math.abs(sx) + Math.abs(sy) < Math.abs(best.sx) + Math.abs(best.sy))) best = { sx, sy, err };
    }
  }
  return best;
}

module.exports = { StopDetector, estimateShift };
