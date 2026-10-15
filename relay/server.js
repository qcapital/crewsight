'use strict';
// CrewSight relay: pairs exactly one pilot and one gunner per session code and forwards
// small viewpoint/ping messages between them. Stateless apart from in-memory sessions.
// It stamps the sender's role on every forwarded message, so a client cannot impersonate
// the other seat by editing a field. Run behind TLS (wss://) for internet use — see docs/RELAY.md.
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const P = require('../core/protocol');

const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
const RESUME_GRACE_MS = 2 * 60 * 1000;
const RATE_PER_SEC = 80, RATE_BURST = 200;
const MAX_SESSIONS = 5000;

function randomCode() {
  let s = '';
  const bytes = crypto.randomBytes(P.CODE_LEN * 2);
  for (let i = 0; s.length < P.CODE_LEN && i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 248) s += P.CODE_ALPHABET[b % P.CODE_ALPHABET.length]; // 248 = 8*31, unbiased
  }
  return s.length === P.CODE_LEN ? s : randomCode();
}
const randomToken = () => crypto.randomBytes(24).toString('base64url');
const other = (role) => (role === 'pilot' ? 'gunner' : 'pilot');

function createRelay({ port = 8787, host = '0.0.0.0', log = console.log } = {}) {
  const sessions = new Map(); // code -> { seats: {pilot, gunner}, lastActive }
  const wss = new WebSocketServer({ port, host, maxPayload: P.MAX_MESSAGE_BYTES });

  const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(P.encode(msg)); };
  const seatInfo = (s) => ({ pilot: !!s.seats.pilot?.ws, gunner: !!s.seats.gunner?.ws });
  const notifyPresence = (s) => {
    for (const r of P.ROLES) send(s.seats[r]?.ws, { t: 'presence', seats: seatInfo(s) });
  };

  function attach(ws, code, s, role, token) {
    s.seats[role] = { ws, token, leftAt: null };
    s.lastActive = Date.now();
    ws.session = { code, role };
    send(ws, { t: 'joined', code, role, token, seats: seatInfo(s) });
    notifyPresence(s);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.bucket = { tokens: RATE_BURST, t: Date.now() };
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw, isBinary) => {
      const now = Date.now();
      const b = ws.bucket;
      b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.t) / 1000) * RATE_PER_SEC); b.t = now;
      if (b.tokens < 1) { send(ws, { t: 'error', code: 'rate-limited' }); return; }
      b.tokens -= 1;
      if (isBinary) { ws.close(1003, 'binary'); return; }
      const { msg, error } = P.parse(raw);
      if (error) { send(ws, { t: 'error', code: error }); return; }

      if (msg.t === 'create') {
        if (ws.session) return send(ws, { t: 'error', code: 'already-in-session' });
        if (sessions.size >= MAX_SESSIONS) return send(ws, { t: 'error', code: 'relay-full' });
        let code; do { code = randomCode(); } while (sessions.has(code));
        const s = { seats: {}, lastActive: now };
        sessions.set(code, s);
        return attach(ws, code, s, msg.role, randomToken());
      }
      if (msg.t === 'join') {
        if (ws.session) return send(ws, { t: 'error', code: 'already-in-session' });
        const s = sessions.get(msg.code);
        if (!s) return send(ws, { t: 'error', code: 'no-such-session' });
        if (s.seats[msg.role]) return send(ws, { t: 'error', code: 'role-taken' });
        return attach(ws, msg.code, s, msg.role, randomToken());
      }
      if (msg.t === 'resume') {
        if (ws.session) return send(ws, { t: 'error', code: 'already-in-session' });
        const s = sessions.get(msg.code);
        const role = s && P.ROLES.find((r) => s.seats[r] &&
          s.seats[r].token.length === msg.token.length &&
          crypto.timingSafeEqual(Buffer.from(s.seats[r].token), Buffer.from(msg.token)));
        if (!role) return send(ws, { t: 'error', code: 'resume-rejected' });
        const old = s.seats[role].ws;
        if (old && old !== ws) old.close(4000, 'superseded');
        return attach(ws, msg.code, s, role, s.seats[role].token);
      }
      if (msg.t === 'leave') { detach(ws, true); return; }

      // Peer messages: only inside a session, forwarded with relay-assigned role.
      if (!ws.session) return send(ws, { t: 'error', code: 'not-in-session' });
      const s = sessions.get(ws.session.code);
      if (!s) return send(ws, { t: 'error', code: 'session-expired' });
      s.lastActive = now;
      send(s.seats[other(ws.session.role)]?.ws, { ...msg, from: ws.session.role });
    });

    ws.on('close', () => detach(ws, false));
    ws.on('error', () => {});
  });

  function detach(ws, explicit) {
    const info = ws.session; if (!info) return;
    ws.session = null;
    const s = sessions.get(info.code); if (!s) return;
    const seat = s.seats[info.role];
    if (!seat || seat.ws !== ws) return;
    if (explicit) delete s.seats[info.role];
    else { seat.ws = null; seat.leftAt = Date.now(); } // keep seat for resume grace period
    if (!s.seats.pilot && !s.seats.gunner) sessions.delete(info.code);
    else notifyPresence(s);
  }

  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
    const now = Date.now();
    for (const [code, s] of sessions) {
      for (const r of P.ROLES) {
        const seat = s.seats[r];
        if (seat && !seat.ws && now - seat.leftAt > RESUME_GRACE_MS) delete s.seats[r];
      }
      if ((!s.seats.pilot && !s.seats.gunner) || now - s.lastActive > SESSION_IDLE_MS) {
        for (const r of P.ROLES) s.seats[r]?.ws?.close(4001, 'session-expired');
        sessions.delete(code);
      }
    }
  }, 15000);

  wss.on('listening', () => log(`[relay] listening on ${host}:${wss.address().port}`));
  return {
    wss, sessions,
    get port() { return wss.address().port; },
    close: () => new Promise((res) => { clearInterval(timer); for (const c of wss.clients) c.terminate(); wss.close(() => res()); }),
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT || process.argv[2] || 8787);
  createRelay({ port, host: process.env.HOST || '0.0.0.0' });
}

module.exports = { createRelay, randomCode };
