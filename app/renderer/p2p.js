'use strict';
/* global Peer */
// Serverless-by-default transport. The PeerJS public broker (0.peerjs.com; configurable) is used ONLY
// to introduce the two PCs. After that, viewpoints (data channel) and video (media call) go directly
// peer-to-peer over WebRTC (DTLS/SRTP encrypted). No relay to host.
// Exactly two parties: the host accepts one crew member whose seat differs from its own.
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../../core/protocol');

const ID_PREFIX = 'crewsight-v1-';

function randomCode() {
  let s = '';
  while (s.length < P.CODE_LEN) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) s += P.CODE_ALPHABET[b % P.CODE_ALPHABET.length]; // unbiased
  }
  return s;
}

class P2PSession extends EventEmitter {
  // Events: 'status' {state, code, role, seats, error, rttMs}, 'viewpoint' msg, 'stream' MediaStream|null
  constructor(opts) {
    super();
    this.opts = opts; // { iceServers, broker: {host,port,path,secure}|null }
    this.peer = null; this.conn = null; this.isHost = false; this.code = null; this.role = null;
    this.remoteId = null; this.peerRole = null; this.helloOk = false;
    this.localStream = null; this.outCall = null; this.inCall = null;
    this.state = 'idle'; this.error = null; this.rttMs = null; this.pingId = 0; this.pending = new Map();
    this.left = true;
  }
  _emitStatus() {
    const other = this.role === 'pilot' ? 'gunner' : 'pilot';
    this.emit('status', { state: this.state, code: this.code ? P.formatCode(this.code) : null, role: this.role,
      seats: this.role ? { [this.role]: true, [other]: this.helloOk } : null, error: this.error, rttMs: this.rttMs });
  }
  _set(state, error = null) { this.state = state; this.error = error; this._emitStatus(); }

  _newPeer(id) {
    const cfg = { debug: 1, config: { iceServers: this.opts.iceServers } };
    if (this.opts.broker) Object.assign(cfg, this.opts.broker);
    return new Promise((res, rej) => {
      const p = id ? new Peer(id, cfg) : new Peer(cfg);
      const onErr = (e) => { p.destroy(); rej(e); };
      p.once('error', onErr);
      p.once('open', () => { p.off('error', onErr); res(p); });
    });
  }
  _wirePeer() {
    const p = this.peer;
    p.on('error', (e) => {
      if (e.type === 'peer-unavailable') { this._set(this.isHost ? 'waiting' : 'reconnecting', 'host-not-found'); }
      else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) {
        if (!this.conn || !this.conn.open) this._set('reconnecting', 'broker-unreachable');
      } else console.warn('peer error', e.type);
    });
    // Losing the broker doesn't drop an existing crew link; quietly re-register.
    p.on('disconnected', () => { if (!p.destroyed && !this.left) setTimeout(() => !p.destroyed && p.reconnect(), 1000); });
    p.on('connection', (c) => {
      if (!this.isHost || (this.conn && this.conn.open)) { c.on('open', () => c.close()); return; }
      this._attach(c);
    });
    p.on('call', (call) => {
      if (!this.conn || call.peer !== this.remoteId) { call.close(); return; }
      if (this.inCall) this.inCall.close();
      this.inCall = call;
      call.answer(); // receive only; we send our own screen with our own call
      call.on('stream', (s) => this.emit('stream', s));
      call.on('close', () => { if (this.inCall === call) { this.inCall = null; this.emit('stream', null); } });
    });
  }

  async create(role) {
    this.leave(true);
    this.left = false; this.isHost = true; this.role = role; this._set('connecting');
    for (let i = 0; i < 4; i++) {
      const code = randomCode();
      try { this.peer = await this._newPeer(ID_PREFIX + code); }
      catch (e) { if (e.type === 'unavailable-id') continue; this._set('idle', 'broker-unreachable'); return; }
      this.code = code; this._wirePeer(); this._set('waiting');
      return;
    }
    this._set('idle', 'could-not-allocate-code');
  }
  async join(codeInput, role) {
    const code = P.normaliseCode(codeInput);
    if (!code) { this.error = 'invalid-code'; this._emitStatus(); return; }
    this.leave(true);
    this.left = false; this.isHost = false; this.role = role; this.code = code; this._set('connecting');
    try { this.peer = await this._newPeer(); } catch { this._set('idle', 'broker-unreachable'); return; }
    this._wirePeer();
    this._dial();
  }
  _dial() {
    if (this.left || this.isHost || (this.conn && this.conn.open)) return;
    this._attach(this.peer.connect(ID_PREFIX + this.code, { reliable: false, serialization: 'raw' }));
    clearTimeout(this._dialTimer);
    this._dialTimer = setTimeout(() => { if (!this.conn || !this.conn.open) { this._set('reconnecting', this.error); this._dial(); } }, 8000);
  }
  _attach(c) {
    if (this.conn && this.conn !== c) this.conn.close();
    this.conn = c; this.helloOk = false; this.remoteId = c.peer;
    c.on('open', () => {
      this._set('connected');
      clearInterval(this._hello);
      // Unordered channel: repeat hello until the other side's hello arrives.
      const hi = () => this._send({ t: 'hello', role: this.role });
      hi(); this._hello = setInterval(() => { if (!this.helloOk) hi(); }, 500);
      clearInterval(this._ping);
      this._ping = setInterval(() => {
        const id = ++this.pingId; this.pending.set(id, performance.now());
        if (this.pending.size > 10) this.pending.delete(this.pending.keys().next().value);
        this._send({ t: 'ping', id, ts: 0 });
      }, 1000);
    });
    c.on('data', (d) => this._onData(d));
    c.on('close', () => {
      if (this.conn !== c) return;
      this.conn = null; this.helloOk = false; clearInterval(this._ping); clearInterval(this._hello);
      this._closeCalls();
      if (this.left) return;
      if (this.isHost) this._set('waiting', 'crew-left');
      else { this._set('reconnecting', 'link-lost'); setTimeout(() => this._dial(), 1500); }
    });
    c.on('error', () => {});
  }
  _send(m) { if (this.conn && this.conn.open) this.conn.send(P.encode(m)); }
  _onData(d) {
    if (typeof d !== 'string') return;
    let raw; try { raw = JSON.parse(d); } catch { return; }
    if (raw && raw.t === 'hello' && raw.v === P.PROTOCOL_VERSION) {
      if (!P.ROLES.includes(raw.role)) return;
      if (raw.role === this.role) { if (!this.isHost) this.left = true; this._set(this.isHost ? 'waiting' : 'idle', 'role-taken'); this.conn.close(); return; }
      if (!this.helloOk) { this.helloOk = true; this.peerRole = raw.role; this._send({ t: 'hello', role: this.role }); this._emitStatus(); this._callPeer(); }
      return;
    }
    const { msg } = P.parse(d);
    if (!msg || !this.helloOk) return;
    if (msg.t === 'vp') this.emit('viewpoint', { ...msg, from: this.peerRole });
    else if (msg.t === 'att') this.emit('att', msg);
    else if (msg.t === 'mark') {
      // At most 3 pings per 2 s from the crew member.
      const now = performance.now(); this._marks = (this._marks || []).filter((t) => now - t < 2000);
      if (this._marks.length < 3) { this._marks.push(now); this.emit('mark', { ...msg, from: this.peerRole }); }
    }
    else if (msg.t === 'ping') this._send({ t: 'pong', id: msg.id, ts: msg.ts });
    else if (msg.t === 'pong') {
      const s = this.pending.get(msg.id);
      if (s !== undefined) { this.pending.delete(msg.id); this.rttMs = performance.now() - s; }
    }
  }
  sendViewpoint(vp) { if (this.helloOk) this._send({ t: 'vp', ...vp }); }
  sendAtt(a) { if (this.helloOk) this._send({ t: 'att', ...a }); }
  sendMark(mark) { if (!this.helloOk) return false; this._send({ t: 'mark', ...mark }); return true; }

  // ----- video -----
  setLocalStream(stream, tune) {
    this.localStream = stream; this.tune = tune;
    this._callPeer();
  }
  _callPeer() {
    if (this.outCall) { this.outCall.close(); this.outCall = null; }
    if (!this.localStream || !this.helloOk || !this.remoteId) return;
    const call = this.peer.call(this.remoteId, this.localStream);
    this.outCall = call;
    // Apply bitrate/framerate caps once the sender exists.
    const t = setInterval(async () => {
      if (this.outCall !== call) return clearInterval(t);
      const pc = call.peerConnection; if (!pc || pc.connectionState !== 'connected') return;
      clearInterval(t);
      for (const s of pc.getSenders()) {
        try {
          const p = s.getParameters();
          if (p.encodings && p.encodings.length) {
            p.encodings[0].maxBitrate = this.tune.maxBitrateKbps * 1000; p.encodings[0].maxFramerate = this.tune.maxFps;
            await s.setParameters(p);
          }
        } catch {}
      }
    }, 500);
    call.on('close', () => { if (this.outCall === call) this.outCall = null; });
  }
  videoState() {
    const pc = this.inCall && this.inCall.peerConnection;
    return pc ? pc.connectionState : 'none';
  }
  _closeCalls() {
    if (this.outCall) this.outCall.close(); if (this.inCall) this.inCall.close();
    this.outCall = this.inCall = null; this.emit('stream', null);
  }

  leave(silent) {
    this.left = true; clearTimeout(this._dialTimer); clearInterval(this._ping); clearInterval(this._hello);
    this._closeCalls();
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
    this.peer = this.conn = null; this.code = null; this.helloOk = false; this.rttMs = null; this.role = null;
    if (!silent) this._set('idle');
  }
}

module.exports = { P2PSession, randomCode };
