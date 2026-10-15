# Testing

## Automated: `npm test` (20 tests, all passing on 2026-10-15)
- **Projection:** centre, sign and direction per axis, axis independence, edges, out-of-range policy, tangent mode, NaN/∞ rejection, angle wrapping, letterbox/pillarbox, pixel mapping.
- **Protocol:** valid round-trip; rejects wrong types, out-of-range angles, negative or fractional seq, unknown source/state/version/type, oversize frames, non-objects, bad JSON; signalling size and kind limits; code normalisation.
- **Remote state:** out-of-order and duplicate rejection, gap counting, epoch restart, stale timeout, wrap-safe interpolation, smoothing.
- **Calibration and tracker:** a valid solve, plus rejection of same-sign, asymmetric, drifting and low-resolution input; states UNCALIBRATED, UNAVAILABLE, DEGRADED, NOSE_LOCKED and LIVE; pilot free-look and recentre; clamping.
- **Config:** defaults, corrupt-file backup and recovery, type-safe merge, future-version rejection.
- **Relay integration (real sockets):**
  - pairing and role conflicts
  - two-way viewpoints and signalling
  - reordering on the wire
  - RTT measurement
  - forced disconnect followed by automatic resume to the same seat
  - impersonation attempt (the client's `from` is overwritten)
  - garbage input, unknown lobby, oversize frame

## End-to-end, two real app instances: `node scripts/selftest.js`
This starts a relay and two CrewSight instances (pilot and gunner, separate profiles). They create and join a lobby by code,
share the primary screen to each other over WebRTC, and send simulated viewpoints.

Set `CREWSIGHT_EXE=dist\CrewSight-win32-x64\CrewSight.exe` to test the packaged build instead.

Results on this machine, 2026-10-15, loopback:

| | Video | Video fps | Viewpoint rate | Out-of-order / gaps | Peer RTT |
|---|---|---|---|---|---|
| Pilot (dev) | connected, 1280×720 | 32 | 29 Hz | 0 / 0 | 1.1 ms |
| Gunner (dev) | connected, 1280×720 | 32 | 30 Hz | 0 / 0 | 2.7 ms |
| Pilot (packaged) | connected, 1280×720 | 22 | 29 Hz | 0 / 0 | 0.6 ms |
| Gunner (packaged) | connected, 1280×720 | 34 | 28 Hz | 0 / 0 | 1.1 ms |

Overlay screenshots were checked visually:
- The remote video renders with the dot, the halo and the "SIMULATED (TEST)" label.
- After the content-protection fix, CrewSight's own windows are absent from the shared screen.

**This is loopback only.** Internet latency, NAT traversal and TURN have **not** been measured.

## Not yet verified (needs two people and the game)
- Raw-input tracking accuracy in WarDogs. The procedure is below.
- Click-through over the game, and hotkeys while the game has focus.
- Borderless versus exclusive fullscreen behaviour.
- High-DPI and multi-monitor layouts.
- Long sessions (more than 1 h).
- CPU and memory profiling.

## In-game accuracy procedure (manual)
The true camera angle cannot be observed externally, so accuracy is checked against visible references:
1. Gunner calibrates, then zeroes on the nose.
2. Turn to 5 reference directions you can identify in the cockpit or airframe, for example a door frame, a skid, or the rotor mast. Estimate each one's true angle from the airframe geometry.
3. At each reference, write down the `az` shown in Diagnostics. The error is the shown value minus the reference.
4. Swing randomly for 60 s, return to the nose, and record the residual `az`. That residual is the drift per minute.
5. Repeat with the pilot holding free-look.

Record the results in this file. Until that is done, CrewSight's in-game accuracy is **unmeasured**.

## Update 2026-10-15 — P2P transport, display, game and resource checks
**Direct P2P (default; public PeerJS broker for introduction only)**

`CREWSIGHT_TRANSPORT=p2p node scripts/selftest.js` passed for both seats: the lobby connected, video ran in both directions and viewpoints arrived at 28–30 Hz with 0 reordering and 0 gaps.

**Display test** (`node scripts/displaytest.js`), 72 dot placements:
- Both monitors (2560×1440 and 1920×1080) at 100%, plus emulated 150% and 200% scaling.
- Three overlay sizes and aspect ratios, four angles each.
- In-range dot error was at most 1.5 DIP. The out-of-range arrow sits about 10 DIP inside the edge by design.
- Click-through, checked with Win32 WindowFromPoint: the overlay is hit when click-through is off and the window underneath is hit when it is on. WS_EX_TOPMOST and WS_EX_TRANSPARENT are set, and the overlay is not focusable.
- Real non-100% Windows scaling was not tested: changing system settings was out of bounds, so 150% and 200% were emulated with `--force-device-scale-factor`.

**Over the game** (`node scripts/gametest.js <pid>`, WarDogs Early Access v0.0.1):
- The game was borderless: no caption, covering the monitor, Windows state "busy" rather than D3D exclusive.
- The overlay test dot was visible above the game in a real GDI desktop screenshot (98 matching pixels).
- **Exclusive fullscreen: not tested.** Switch the game to exclusive fullscreen and rerun the script.

**Resource use** (30 s P2P run, two instances on one PC, 1280×720 video in both directions):
- CPU: average about 9% of one core per app, peak 10.5%.
- Memory (working set summed over all Electron processes): 630→655 MB and 669→686 MB.
- Only 5 of 56 diagnostics samples were stale, all during the first ~2.5 s before the link came up.
- A long multi-hour soak was **not** run, at the user's request.

**Pilot default:** the pilot's dot is locked to the centre of the pilot's screen (the nose) with no calibration or mouse input, which matches the game's mouse-flight control. This is covered by a unit test.
