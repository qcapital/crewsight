# Architecture

## Stack: Electron 33 (Chromium + Node), a C# Raw Input helper, and a Node WebSocket relay
**Why this stack:** Chromium provides several things out of the box:
- Window and screen capture (Windows Graphics Capture under the hood)
- WebRTC video with NAT traversal and mandatory encryption
- Hardware video encoding

Electron adds transparent, always-on-top and click-through windows (`setIgnoreMouseEvents`), global hotkeys, the tray and content protection.

**Alternatives considered:** WPF or WinUI would have needed a third-party WebRTC stack (for example MixedReality-WebRTC, now archived) to deliver the in-app video share. They were rejected for that reason.

**Missing piece:** Electron cannot see Raw Input while unfocused. A ~130-line C# helper does that. It is compiled with the `csc.exe` that ships with Windows (.NET Framework 4), so no runtime has to be installed.

**Dependencies and licences:**
- electron (MIT)
- ws (MIT)
- @electron/packager (BSD-2)

## Modules
| Module | File | Responsibility |
|---|---|---|
| Shell | `app/main.js` | Lifecycle, config, windows, tray, hotkeys, calibration flow, send loop, IPC |
| Share + overlay renderer | `app/renderer/overlay.*` | Local window capture, the WebRTC peer connection, peer video, dot rendering, status badges |
| Control UI | `app/renderer/control.*` | Lobby, source picker, tracking/calibration, appearance, hotkeys, diagnostics |
| Input observer | `app/native/RawMouse.cs` | Read-only raw mouse counts, one key, foreground match |
| Tracking engine | `core/tracker.js` | Calibration solving, dead-reckoning, honest state |
| Projection | `core/projection.js` | Angles → normalised point; letterbox rect → pixels |
| Remote state | `core/remoteState.js` | Sequence/epoch ordering, staleness, interpolation, smoothing |
| Protocol | `core/protocol.js` | Versioned schema and validation (shared with the relay) |
| Session client | `core/netClient.js` | Create/join/resume, reconnect with backoff, RTT, signalling (transport hidden from the tracker) |
| Config | `core/config.js` | Versioned JSON, type-safe merge, corrupt-file recovery |
| Relay | `relay/server.js` | Lobby pairing, role stamping, forwarding, rate limits |

## Data flow
```
 LOCAL PC (e.g. gunner)                                         REMOTE PC (pilot)
 mouse ─► RawMouse.exe ─"M dx dy"─► MouseTracker ─(az,el,state)─┐
            (read-only)            (calibration)                │ 30 Hz  vp{seq,epoch,az,el,src,st,cal}
                                                                ▼
 game window ─► getUserMedia(desktop) ─► RTCPeerConnection ═════╪════ DTLS-SRTP video (P2P) ════► <video>
                                               ▲  ▲             │                                  │
                         SDP/ICE "sig" ────────┘  │             ▼                                  ▼
                                          SessionClient ─wss─► RELAY ─wss─► SessionClient ─► RemoteViewpoint
                                                                (stamps sender role)          (order, stale, interp)
                                                                                                   │ project()
                                                                                                   ▼
                                                                          overlay canvas: video + dot
```

## Coordinate conventions
- `az`: degrees, 0 = helicopter nose, **+ right**, range (−180, 180].
- `el`: degrees, 0 = nose level, **+ up**, range [−90, 90].
- Raw mouse: +dx is right and +dy is **down** (Windows). Calibration learns the signs. The default vertical sign is −1, so moving the mouse up means looking up.
- Projection:
  - `linear`: `x = cx + (az/azMax)·half`
  - `tangent`: `x = cx + tan(az)/tan(azMax)·half`. This is perspective-correct when azMax equals half the horizontal FOV.
  - `y` is the same, with + going up.
  - Out of range: the point is clamped to the edge, `inRange=false`, and the renderer draws an arrow.
- Points are normalised to the **cropped content rectangle**, then letterboxed into the overlay and multiplied by devicePixelRatio. Pixels are never transmitted.

## Protocol v1
Messages are JSON `{v:1, t, ...}`. Frames are capped at 1 KB, except `sig`, which is capped at 16 KB. Every message is validated on both the relay and the client.
- Client → relay:
  - `create{role}`
  - `join{code,role}`
  - `resume{code,token}`
  - `leave`
- Relay → client:
  - `joined{code,role,token,seats}`
  - `presence{seats}`
  - `error{code}`
- Peer messages (forwarded with `from` set by the relay):
  - `vp{seq,ts,epoch,az|null,el|null,src,st,cal}`
  - `sig{kind:'description'|'candidate',data}`
  - `ping/pong{id,ts}`
- Ordering: `(epoch, seq)`. A new epoch (tracker restart or recalibration) resets the receiver. If `seq` is not greater than the last one received, the message is dropped. Peer `ts` values are never compared with local clocks.

## Threat model (summary)
| Threat | Mitigation |
|---|---|
| Guessing a lobby code | 12 symbols from a 31-letter alphabet (~59 bits). One seat per role. Sessions expire after 2 h idle |
| Impersonating the other seat | The relay overwrites `from` with the seat bound to the socket. Resume needs a 192-bit token, compared in constant time |
| Eavesdropping on video | WebRTC DTLS-SRTP. The relay never sees media |
| Eavesdropping or tampering on signalling and viewpoints | Use `wss://`. The UI warns about non-LAN `ws://`. A malicious relay could MITM the SDP, so the relay is trusted for signalling |
| Message flooding or malformed data | ws maxPayload. Token bucket of 80/s with a burst of 200. Strict schema validation. Max 5000 sessions |
| Privacy | No raw mouse data leaves the PC or reaches logs. No audio. No recording. Session tokens are not persisted |

## Risk register
| Risk | Impact | Mitigation |
|---|---|---|
| Control model differs from the reports | The dot is wrong | Calibration checks, explicit state labels, manual fallback |
| Anti-cheat flags raw-input observers | Account risk | Observation is opt-in and read-only. Users should check the game's rules (unresolved) |
| Strict NAT | No video | Configure a TURN server (`network.iceServers` in config.json) |
| Exclusive fullscreen | No capture, or the overlay is hidden | Use borderless |
