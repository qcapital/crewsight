'use strict';
// Integration: real relay + two SessionClients over loopback WebSockets.
const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createRelay } = require('../relay/server');
const { SessionClient } = require('../core/netClient');
const { RemoteViewpoint } = require('../core/remoteState');

const once = (em, ev, pred = () => true) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + ev)), 4000);
  const h = (x) => { if (pred(x)) { clearTimeout(t); em.off(ev, h); res(x); } };
  em.on(ev, h);
});
const vp = (seq, az) => ({ seq, ts: performance.now(), epoch: 'e1', az, el: 0, src: 'simulated', st: 'LIVE_SIMULATED', cal: true });

test('relay: pair, exchange, roles, reconnect, latency', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  await once(relay.wss, 'listening');
  const url = `ws://127.0.0.1:${relay.port}`;
  const pilot = new SessionClient(), gunner = new SessionClient();
  t.after(async () => { pilot.leave(); gunner.leave(); await relay.close(); });

  pilot.create(url, 'pilot');
  const { code } = await once(pilot, 'joined');

  // role conflict rejected
  const dup = new SessionClient(); dup.join(url, code, 'pilot');
  assert.equal(await once(dup, 'error'), 'role-taken'); dup.leave();

  gunner.join(url, code, 'gunner');
  await once(gunner, 'joined');
  await once(pilot, 'presence', (s) => s.gunner);

  // both directions, sender role stamped by relay
  const recv = once(gunner, 'viewpoint'); pilot.sendViewpoint(vp(1, 12.5));
  const m = await recv; assert.equal(m.from, 'pilot'); assert.equal(m.az, 12.5);
  const recv2 = once(pilot, 'viewpoint'); gunner.sendViewpoint(vp(1, -40));
  assert.equal((await recv2).from, 'gunner');

  // out-of-order delivery doesn't roll back receiver state
  const rs = new RemoteViewpoint();
  const got = [];
  gunner.on('viewpoint', (x) => got.push(x));
  pilot.sendViewpoint(vp(5, 50)); pilot.sendViewpoint(vp(4, 40)); pilot.sendViewpoint(vp(6, 60));
  await once(gunner, 'viewpoint', (x) => x.seq === 6);
  for (const x of got) rs.accept(x, 0);
  assert.equal(rs.latest.az, 60); assert.equal(rs.stats.rejectedOld, 1);

  // RTT measured
  const rtt = await once(pilot, 'rtt'); assert.ok(rtt >= 0 && rtt < 1000);

  // forced disconnect -> automatic resume to same seat, updates restored
  pilot.ws.terminate();
  await once(pilot, 'status', (s) => s.state === 'reconnecting');
  await once(pilot, 'joined');
  assert.equal(pilot.role, 'pilot');
  const r3 = once(gunner, 'viewpoint', (x) => x.seq === 7); pilot.sendViewpoint(vp(7, 1)); await r3;

  // WebRTC signalling is forwarded intact
  const r5 = once(gunner, 'signal'); pilot.sendSignal('description', JSON.stringify({ type: 'offer', sdp: 'v=0' + 'a'.repeat(4000) }));
  assert.equal(JSON.parse((await r5).data).type, 'offer');

  // impersonation attempt: client-sent `from` is overwritten
  const r4 = once(gunner, 'viewpoint', (x) => x.seq === 8);
  pilot.ws.send(JSON.stringify({ v: 1, t: 'vp', from: 'gunner', ...vp(8, 0) }));
  assert.equal((await r4).from, 'pilot');
});

test('relay: rejects garbage and unknown sessions', async (t) => {
  const relay = createRelay({ port: 0, host: '127.0.0.1', log: () => {} });
  await once(relay.wss, 'listening');
  t.after(() => relay.close());
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}`);
  await once(ws, 'open');
  const next = () => once(ws, 'message').then((d) => JSON.parse(d.toString()));
  let r = next(); ws.send('{"v":1,"t":"vp","seq":1}'); assert.equal((await r).code, 'invalid-fields');
  r = next(); ws.send(JSON.stringify({ v: 1, t: 'vp', ...vp(1, 0) })); assert.equal((await r).code, 'not-in-session');
  r = next(); ws.send(JSON.stringify({ v: 1, t: 'join', code: 'AAAA-BBBB-CCCC', role: 'gunner' }));
  assert.equal((await r).code, 'no-such-session');
  const closed = once(ws, 'close'); ws.send('x'.repeat(20000)); await closed; // > maxPayload
  ws.terminate();
});
