'use strict';
// Session client. Hides the transport (WebSocket relay) from the tracker/UI.
// Events: 'signal' {kind,data}, 'status' {state, detail}, 'joined' {code, role}, 'presence' seats,
//         'viewpoint' msg, 'rtt' ms, 'error' code.
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const P = require('./protocol');

const now = () => performance.now();

class SessionClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null; this.url = null; this.code = null; this.role = null; this.token = null;
    this.intent = null; this.retry = 0; this.closedByUser = false;
    this.pingId = 0; this.pending = new Map(); this.rttMs = null; this.state = 'idle';
  }
  _status(state, detail) { this.state = state; this.emit('status', { state, detail }); }

  create(url, role) { this._start(url, { t: 'create', role }); }
  join(url, code, role) {
    const c = P.normaliseCode(code);
    if (!c) { this.emit('error', 'invalid-code'); return; }
    this._start(url, { t: 'join', code: c, role });
  }
  _start(url, intent) {
    if (!/^wss?:\/\//i.test(url)) { this.emit('error', 'invalid-url'); return; }
    this.leave(true);
    this.url = url; this.intent = intent; this.closedByUser = false; this.retry = 0;
    this._open();
  }
  _open() {
    this._status('connecting');
    let ws;
    try { ws = new WebSocket(this.url, { maxPayload: P.MAX_MESSAGE_BYTES, handshakeTimeout: 5000 }); }
    catch (e) { this._status('error', String(e.message)); return; }
    this.ws = ws;
    ws.on('open', () => {
      this.retry = 0;
      // After the first join, reconnects resume the same seat with the relay-issued token.
      this._raw(this.token ? { t: 'resume', code: this.code, token: this.token } : this.intent);
    });
    ws.on('message', (raw) => this._onMessage(raw));
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null; this.pending.clear();
      if (this.closedByUser) { this._status('idle'); return; }
      const delay = Math.min(10000, 500 * 2 ** this.retry++);
      this._status('reconnecting', `retry in ${Math.round(delay / 1000)}s`);
      this._timer = setTimeout(() => this._open(), delay);
    });
    ws.on('error', (e) => this.emit('error', e.code || e.message));
  }
  _raw(msg) { if (this.ws && this.ws.readyState === 1) this.ws.send(P.encode(msg)); }

  _onMessage(raw) {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    if (!m || m.v !== P.PROTOCOL_VERSION) return;
    switch (m.t) {
      case 'joined':
        if (!P.normaliseCode(m.code) || !P.ROLES.includes(m.role)) return;
        this.code = m.code; this.role = m.role; this.token = m.token;
        this._status('connected');
        this.emit('joined', { code: m.code, role: m.role });
        this.emit('presence', m.seats);
        this._startPing();
        return;
      case 'presence': this.emit('presence', m.seats); return;
      case 'error':
        if (m.code === 'resume-rejected') { this.token = null; this.code = null; this.leave(); }
        this.emit('error', String(m.code).slice(0, 40)); return;
    }
    // Peer messages are re-validated here; the relay is not trusted for content.
    const { msg } = P.parse(raw.toString());
    if (!msg || !P.PEER_TYPES.has(msg.t) || m.from !== (this.role === 'pilot' ? 'gunner' : 'pilot')) return;
    if (msg.t === 'vp') this.emit('viewpoint', { ...msg, from: m.from });
    else if (msg.t === 'sig') this.emit('signal', { kind: msg.kind, data: msg.data });
    else if (msg.t === 'mark') this.emit('mark', { ...msg, from: m.from });
    else if (msg.t === 'att') this.emit('att', msg);
    else if (msg.t === 'ping') this._raw({ t: 'pong', id: msg.id, ts: msg.ts });
    else if (msg.t === 'pong') {
      const sent = this.pending.get(msg.id);
      if (sent !== undefined) { this.pending.delete(msg.id); this.rttMs = now() - sent; this.emit('rtt', this.rttMs); }
    }
  }
  _startPing() {
    clearInterval(this._ping);
    this._ping = setInterval(() => {
      const id = ++this.pingId; this.pending.set(id, now());
      if (this.pending.size > 10) this.pending.delete(this.pending.keys().next().value);
      this._raw({ t: 'ping', id, ts: 0 });
    }, 1000);
  }
  sendSignal(kind, data) { this._raw({ t: 'sig', kind, data }); }
  sendAtt(a) { this._raw({ t: 'att', ...a }); }
  sendMark(mark) { this._raw({ t: 'mark', ...mark, img: null }); }
  sendViewpoint(vp) { this._raw({ t: 'vp', ...vp }); }
  leave(silent) {
    this.closedByUser = true; clearTimeout(this._timer); clearInterval(this._ping);
    if (this.ws) { this._raw({ t: 'leave' }); this.ws.close(); this.ws = null; }
    this.token = null; this.code = null;
    if (!silent) this._status('idle');
  }
}

module.exports = { SessionClient };
