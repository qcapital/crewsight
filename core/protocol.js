'use strict';
// Versioned wire protocol shared by the desktop client and the relay.
// All messages are small JSON objects. Anything not matching a schema is rejected.
const { isFiniteNum } = require('./projection');

const PROTOCOL_VERSION = 1;
const MAX_MESSAGE_BYTES = 16384;          // relay frames (SDP offers are a few KB)
const MAX_PING_BYTES = 300000;            // P2P ping with a JPEG snapshot
const MAX_PING_IMG = 290000;
const IMG_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/;
const MAX_SMALL_BYTES = 1024;            // every non-signalling message
const MAX_SIGNAL_DATA = 15000;
const SIGNAL_KINDS = ['description', 'candidate'];
const ROLES = ['pilot', 'gunner'];
const SOURCES = ['mouse', 'visual', 'center', 'manual', 'simulated', 'nose-assumed', 'none'];
const STATES = ['UNCALIBRATED', 'CALIBRATING', 'LIVE_ESTIMATED', 'LIVE_VISUAL', 'LIVE_CENTER', 'LIVE_MANUAL', 'LIVE_SIMULATED',
  'NOSE_LOCKED', 'DEGRADED', 'UNAVAILABLE'];
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 31 symbols, no 0/O/1/I/L
const CODE_LEN = 12; // ~59 bits of entropy
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

function normaliseCode(s) {
  if (typeof s !== 'string') return null;
  const c = s.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(c) ? c : null;
}
function formatCode(c) { return c.match(/.{1,4}/g).join('-'); }

const isStr = (v, max = 64) => typeof v === 'string' && v.length > 0 && v.length <= max;
const isUInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isTokenStr = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{22,64}$/.test(v);

// Validators return the cleaned object or null. Unknown fields are dropped.
const validators = {
  // client -> relay
  create: (m) => ROLES.includes(m.role) ? { t: 'create', role: m.role } : null,
  join: (m) => {
    const code = normaliseCode(m.code);
    return code && ROLES.includes(m.role) ? { t: 'join', code, role: m.role } : null;
  },
  resume: (m) => {
    const code = normaliseCode(m.code);
    return code && isTokenStr(m.token) ? { t: 'resume', code, token: m.token } : null;
  },
  leave: () => ({ t: 'leave' }),
  // peer <-> peer (forwarded by relay, relay stamps `from` role)
  vp: (m) => {
    if (!isUInt(m.seq) || !isFiniteNum(m.ts) || m.ts < 0) return null;
    if (!SOURCES.includes(m.src) || !STATES.includes(m.st) || typeof m.cal !== 'boolean') return null;
    if (!isStr(m.epoch, 32)) return null;
    let az = null, el = null;
    if (m.az !== null || m.el !== null) {
      if (!isFiniteNum(m.az) || !isFiniteNum(m.el)) return null;
      if (m.az < -180 || m.az > 180 || m.el < -90 || m.el > 90) return null;
      az = m.az; el = m.el;
    }
    return { t: 'vp', seq: m.seq, ts: m.ts, epoch: m.epoch, az, el, src: m.src, st: m.st, cal: m.cal };
  },
  // WebRTC signalling for the in-app screen share; data is an opaque JSON string that the
  // receiving renderer parses again and hands to RTCPeerConnection (which validates it).
  sig: (m) => SIGNAL_KINDS.includes(m.kind) && typeof m.data === 'string' && m.data.length <= MAX_SIGNAL_DATA
    ? { t: 'sig', kind: m.kind, data: m.data } : null,
  ping: (m) => isUInt(m.id) && isFiniteNum(m.ts) ? { t: 'ping', id: m.id, ts: m.ts } : null,
  // Helicopter attitude change estimated from the pilot's view (unit quaternion, arbitrary world frame).
  att: (m) => {
    if (!isUInt(m.seq) || !Array.isArray(m.q) || m.q.length !== 4 || !m.q.every(isFiniteNum)) return null;
    if (Math.abs(Math.hypot(...m.q) - 1) > 1e-3 || !isFiniteNum(m.conf) || m.conf < 0 || m.conf > 1 || typeof m.ok !== 'boolean') return null;
    return { t: 'att', seq: m.seq, q: m.q, conf: m.conf, ok: m.ok };
  },
  // Crew ping: my aim direction (nose-relative, null if unknown) + optional JPEG snapshot around my crosshair.
  mark: (m) => {
    if (!isUInt(m.id)) return null;
    let az = null, el = null;
    if (m.az !== null || m.el !== null) {
      if (!isFiniteNum(m.az) || !isFiniteNum(m.el) || m.az < -180 || m.az > 180 || m.el < -90 || m.el > 90) return null;
      az = m.az; el = m.el;
    }
    let img = null;
    if (m.img !== null && m.img !== undefined) {
      if (typeof m.img !== 'string' || m.img.length > MAX_PING_IMG || !IMG_RE.test(m.img)) return null;
      img = m.img;
    }
    let q = null;
    if (m.q !== null && m.q !== undefined) {
      if (!Array.isArray(m.q) || m.q.length !== 4 || !m.q.every(isFiniteNum) || Math.abs(Math.hypot(...m.q) - 1) > 1e-3) return null;
      q = m.q;
    }
    return { t: 'mark', id: m.id, az, el, img, q };
  },
  pong: (m) => isUInt(m.id) && isFiniteNum(m.ts) ? { t: 'pong', id: m.id, ts: m.ts } : null,
};
const PEER_TYPES = new Set(['vp', 'sig', 'ping', 'pong', 'mark', 'att']);

/** Parse+validate a raw frame. Returns { msg } or { error }. */
function parse(raw) {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : null;
  if (text === null) return { error: 'not-text' };
  if (Buffer.byteLength(text, 'utf8') > Math.max(MAX_MESSAGE_BYTES, MAX_PING_BYTES)) return { error: 'too-large' };
  let m;
  try { m = JSON.parse(text); } catch { return { error: 'bad-json' }; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { error: 'not-object' };
  if (m.v !== PROTOCOL_VERSION) return { error: 'bad-version' };
  const bytes = Buffer.byteLength(text, 'utf8');
  const limit = m.t === 'mark' ? MAX_PING_BYTES : m.t === 'sig' ? MAX_MESSAGE_BYTES : MAX_SMALL_BYTES;
  if (bytes > limit) return { error: 'too-large' };
  const fn = validators[m.t];
  if (!fn) return { error: 'unknown-type' };
  const clean = fn(m);
  return clean ? { msg: clean } : { error: 'invalid-fields' };
}

function encode(msg) { return JSON.stringify({ v: PROTOCOL_VERSION, ...msg }); }

module.exports = { PROTOCOL_VERSION, MAX_MESSAGE_BYTES, ROLES, SOURCES, STATES, CODE_ALPHABET, CODE_LEN,
  PEER_TYPES, SIGNAL_KINDS, MAX_PING_BYTES, parse, encode, normaliseCode, formatCode };
