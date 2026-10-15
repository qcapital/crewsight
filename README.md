# CrewSight — WarDogs pilot/gunner viewpoint overlay

**New in 0.2.0: your crew member's dot is drawn directly over YOUR game screen.** The pilot sees a red dot exactly where the gunner is aiming. The gunner sees where the pilot is looking (the nose). When the point is off-screen, an arrow at the screen edge points the way. Toggle it with `Ctrl+Alt+H`. Before playing, set **Overlay & dot → Game horizontal FOV** to the game's vehicle FOV.

CrewSight is a floating, always-on-top window. It shows your crew member's game screen and a **dot marking where they are looking**, relative to the helicopter's nose. Each of you shares your own game window from inside the app, and the lobby code connects you. No Discord is needed.

**What it does not do:** it does not read or modify the game, inject input, automate anything, or record anything. The dot is an **estimate**: the label next to it always tells you where the estimate comes from.

## Requirements
- Windows 10 (2004+) or Windows 11, x64.
- The game in **windowed or borderless** mode.
- Internet access on both PCs. **No server to host:** by default the free PeerJS matchmaking service introduces the two PCs, and then everything (video and dot) flows directly between them. A self-hosted relay is optional ([docs/RELAY.md](docs/RELAY.md)).

## Install
Unzip `CrewSight-win32-x64.zip` anywhere and run `CrewSight.exe`. No installer or runtime is needed. Both players do this.

## Setup (both players)
1. **Lobby:** choose your seat (Pilot or Gunner). Leave Connection on **Direct peer-to-peer**.
   - One player clicks **Create lobby** and sends the `XXXX-XXXX-XXXX` code.
   - The other player enters it and clicks **Join**.
2. **Screen share:** click your **game window**. Your crew member's overlay shows it, and yours shows theirs.
3. **Tracking:** turn on **Observe my mouse** and calibrate (see below). Alternatively, choose **Manual**.
4. **Overlay & dot:** drag and resize the overlay by its top bar. Then turn on **click-through** (`Ctrl+Alt+C`) so the overlay ignores your mouse while you play.

## Calibration
Calibration is done in game. The focus filter defaults to process names containing "WarDogs".
1. Fill in the reference angles. The horizontal default is 90° (straight out the side door). The vertical default is 45°.
2. Press **Start calibration**. Then, without leaving the game, press `Ctrl+Alt+M` at each prompt: nose → right 90° → nose → left 90°, then the same for up and down.
   - **Pilots don't need to calibrate.** By default the pilot's dot is locked to the centre of their screen, because the mouse flies the helicopter. Calibrate only to track free-look (hold Alt while turning).
3. CrewSight runs these checks and only applies the calibration if **all** of them pass:
   - the left and right turns are symmetric
   - turning back to the nose returns to near zero
   - there are enough counts for resolution

   If a check fails, turn off in-game mouse smoothing or acceleration and try again.
4. During play, press `Ctrl+Alt+Z` while looking along the nose to remove drift. Recalibrate after changing sensitivity, seat or controls.

## What the dot means
| Label | Meaning |
|---|---|
| LIVE · MOUSE ESTIMATE | Calibrated mouse dead-reckoning |
| PILOT · NOSE / SCREEN CENTRE | Pilot default: the mouse flies the helicopter, so the view is the nose = centre of the pilot's screen |
| LIVE · MANUAL | Set by hand on the manual pad |
| DEGRADED | The game is not focused; the estimate is paused |
| STALE · NO UPDATES | Nothing received recently (grey dashed ring, or hidden) |
| CREW UNCALIBRATED / TRACKING UNAVAILABLE | No dot is shown |
| SIMULATED (TEST) | Test sweep, not real |

An arrow at the edge means they are looking beyond the angles set in **Projection**. Tip: use Perspective mode with edges set to half the game's FOV.

## Hotkeys (configurable)
| Keys | Action |
|---|---|
| `Ctrl+Alt+O` | Show/hide overlay |
| `Ctrl+Alt+C` | Click-through |
| `Ctrl+Alt+S` | Settings |
| `Ctrl+Alt+R` | Recalibrate |
| `Ctrl+Alt+T` | Mouse observation on/off |
| `Ctrl+Alt+Z` | Re-zero |
| `Ctrl+Alt+M` | Calibration mark |
| `Ctrl+Alt+H` | Crew dot on my screen (HUD) on/off |
| `Ctrl+Shift+Space` | Ping where I aim (marker + snapshot) |

Conflicts are listed on the Hotkeys tab. The tray menu provides the same toggles.

## Privacy
- **The PeerJS matchmaking server receives:** a lobby ID derived from the code, plus WebRTC connection setup (IP candidates). It does not receive viewpoints or video.
- **Your crew member receives (direct, encrypted):** your seat, two angles plus a status about 30 times a second, and pings.
- **Your crew member receives:** the video of the window you chose, peer-to-peer and encrypted (DTLS-SRTP).
- **Never sent or stored:** audio, recordings, and raw mouse data.
- The log at `%APPDATA%\CrewSight\crewsight.log` contains events only.

## Troubleshooting
- **"broker-unreachable":** the PeerJS matchmaking server is down or blocked. Switch Connection to your own relay ([docs/RELAY.md](docs/RELAY.md)), or point `network.broker` in config.json at a self-hosted peerjs-server.
- **Crew connected but no video, or "VIDEO FAILED (NAT?)":** one side has a strict NAT. Configure TURN ([docs/RELAY.md](docs/RELAY.md)).
- **Black or no video:** the shared window is minimised or in exclusive fullscreen. Switch the game to borderless.
- **The overlay is hidden behind the game:** switch the game to borderless.
- **Dot shows DEGRADED:** the focus filter doesn't match the game's process name. Edit it on the Tracking tab, or clear it.
- **The dot drifts:** press re-zero. If the drift is large, recalibrate, and check that the turret did not hit a stop during the swing.
- **Corrupt settings:** they are reset automatically and the old file is backed up. Hotkeys tab → Reset ALL resets manually.

## Helicopter manoeuvres (roll, pitch, yaw)
Both players' directions are shared **relative to the helicopter's nose**. Both cameras are attached to the same airframe, so when the helicopter rolls, pitches or yaws, both views and the shared directions turn together. The dot stays on the true point with no correction needed, and network delay adds no error while manoeuvring. This is tested against a 3D simulation with 500 random attitudes and is exact.

It relies on two game behaviours that need a 1-minute in-game check (please report the results):
1. **Gunner turret not gyro-stabilised.** The gunner puts the crosshair on a distant landmark, keeps the mouse still, and the pilot yaws 90°. If the crosshair swings with the helicopter, all is good. If it stays locked on the landmark, the turret is stabilised: the gunner's dot will then drift during manoeuvres until they re-zero (`Ctrl+Alt+Z` while aiming at the nose).
2. **Cameras roll with the helicopter.** The pilot rolls hard. If the horizon tilts on both screens, all is good. If the game keeps the horizon level, the dot will be rotated by the roll angle.

## Pings (new in 0.3.0)
Press **Ctrl+Shift+Space** (changeable on the Hotkeys tab) in game to ping the spot under your crosshair.
- **Marker:** your crew member sees a pulsing marker exactly where you're aiming, placed in their own view. It stays right while the helicopter manoeuvres. If the spot is off their screen, an arrow points the way.
- **Snapshot:** they also get a snapshot card of your screen around your crosshair. You must be sharing your game window for the snapshot to be taken.
- **Settings:** card on/off, zoom (Close / Medium / Wide), position and duration are under Overlay & dot → Pings. There's also a "Send a test ping" button.
- **Gunner calibration:** the marker needs the pinging player's direction, so a gunner who hasn't calibrated can only send the snapshot.
- **Relay mode:** pings sent over the optional relay carry no snapshot.

## Gun limits (gunner, new in 0.3.0)
Records exactly where the gun can point, so the gunner's tracked aim stops at the same limits as the real gun. Afterwards, pushing into a stop no longer makes the dot drift. Do this once, after calibrating:
1. Land the helicopter, so nothing else moves on screen, and share your game window on the Screen share tab.
2. Go to Tracking → Gun limits and press **Record limits**. Aim at the nose and press **Mark** (`Ctrl+Alt+M`).
3. Slowly sweep the gun around the **whole outer edge** of its range (top edge, far side, bottom edge, other side), come back to the nose and press **Mark** again.
4. Follow the edges closely and don't keep pushing into a stop. While your screen is shared, the app also spots when the picture stops moving and ignores that mouse movement, so an accidental push doesn't stretch the limits.

**Storage:** the limits are saved in degrees in `%APPDATA%\CrewSight\config.json`. They survive app updates and don't depend on mouse sensitivity. Use **Export…** to save them to a file, and **Import…** to load them on another PC or after a reinstall.

## World-locked pings (new in 0.4.0)
Pings now stay on their spot in the world while the helicopter turns, pitches and rolls.

**How it works:** the pilot's camera is fixed to the nose, so when the pilot's whole picture shifts or rotates, the helicopter is turning. The pilot's app measures that from its own game capture, about 30 times a second:
- It matches patches between frames and fits the exact rotation of a pinhole camera.
- It ignores patches that disagree, such as the static cockpit, other vehicles and smoke.
- It sends the resulting helicopter attitude to the gunner about 15 times a second.

Every ping carries the attitude at the moment it was made. Both HUDs keep re-placing the marker as the helicopter rotates.

**Requirements:**
- The pilot must be sharing their game window.
- **Game horizontal FOV** must be set correctly on the pilot's PC. It sets the scale of the measured rotation.
- Tracking pauses while the pilot holds free-look, because the camera then moves independently of the airframe.

**Accuracy:** tested on synthetic 3D scenes with known motion:
- Yaw, pitch and roll are recovered to within about 3–7%.
- Mixed manoeuvres stay within 10% over 3 s.
- A hovering helicopter doesn't drift.
- A static cockpit covering the lower third of the view is ignored.

In-game accuracy hasn't been measured yet.

**Marker labels:**
- **· not world-locked:** the ping had no attitude, because the pilot wasn't sharing.
- **· tracking lost:** the attitude stream is stale or low-confidence. The marker falls back to the airframe direction.

**Not handled: helicopter translation.** Only rotation is tracked. If the helicopter flies sideways or past a target, the marker drifts by the change in viewing angle. For example, flying 50 m past a target 500 m away moves it by up to about 6°; nearby targets drift more.

**Why not a full 3D ground map:** mapping the terrain from the gunner's view (monocular SLAM) was considered and not built:
- The gunner's camera moves on its own, so its view isn't tied to the airframe.
- A single camera can't measure distance or scale.
- Smoke, explosions and moving vehicles break feature tracking.

Rotation, which causes most of the error, is solved this way. Translation would need a much larger, less reliable system.

**Other limitations:**
- Roll is the weakest axis when a large cockpit frame fills the view.
- Starting or stopping the pilot's share restarts the attitude, so pings made before that lose their lock.

## Screen-based gunner tracking (new in 0.5.0, now the default)
The gunner's dot is now measured from the **gunner's own screen** instead of being added up from mouse movement:
- The gunner's app measures how their picture rotates, which is exactly what the gun optic did, turret speed limit and stops included.
- It subtracts the helicopter's own rotation (streamed from the pilot), which leaves the gun direction relative to the nose.

This fixes the dot running ahead of the optic during fast flicks and drifting after hitting a limit.

**Requirements:** both players share their game windows. The gunner's turret needs the gunner's own picture, and the helicopter rotation needs the pilot's.

**Plain sky:** when the picture has too little detail, the mouse fills in briefly. Its degrees-per-count scale is learned automatically from the screen, so a rough calibration doesn't matter. Calibration only provides a starting value.

**Recorded gun limits** still clamp the result.

**Re-zero:** press `Ctrl+Alt+Z` while aiming at the nose, after spawning or whenever the dot looks offset. The screen-based estimate slowly accumulates small errors over long sessions, as all such tracking does.

**Labels the pilot sees:**
- **LIVE · FROM SCREEN:** normal screen-based tracking.
- **LIVE · MOUSE ESTIMATE:** a brief mouse fill-in over plain sky.
- **DEGRADED:** the pilot isn't sharing, so helicopter turns can't be removed.

**Accuracy:** tested on simulated 3D scenes with the helicopter manoeuvring, the turret capped at 60°/s and hitting its stop, and a calibration 30% off:
- The screen-based estimate stayed within 6° of the true gun direction.
- Mouse-only tracking was off by more than 30° in the same test.

In-game accuracy hasn't been measured yet.

## Known limitations
- **Gunner calibration:** the pilot's HUD works with no setup. The gunner must calibrate mouse tracking; otherwise the gunner's own aim is unknown, so the gunner's HUD cannot place the pilot's dot, and the pilot's HUD cannot place the gunner's.
- **HUD accuracy:** the HUD assumes the game's horizontal FOV is set correctly and ignores the few metres between the two seats. Very close targets will be slightly off.
- **Accuracy:** in-game accuracy is **unmeasured**. The control model comes from community guides, not official docs ([docs/FEASIBILITY.md](docs/FEASIBILITY.md)).
- **Drift:** dead-reckoning drifts. It cannot detect respawns, seat swaps, turret limits or in-game recentering.
- **No visual tracking:** computer-vision tracking was evaluated and not built. There is no legible heading instrument to read.
- **No world heading:** only nose-relative angles are produced.
- **Internet testing:** the P2P path was tested through the real public broker on one PC. Two PCs on different networks have not been tested.
- **Exclusive fullscreen:** the overlay is verified above WarDogs in borderless mode only. Use borderless.
- **Game rules:** whether WarDogs' rules or anti-cheat allow raw-input observers is unconfirmed. Observation is opt-in.

## Developers
```
npm ci
npm run build:native     # compiles app/native/RawMouse.exe with Windows' built-in csc.exe
npm test                 # unit + relay integration
npm start                # run the app (CREWSIGHT_PROFILE=b npm start for a 2nd instance)
npm run relay            # local relay on :8787
node scripts/selftest.js # two-instance end-to-end check (CREWSIGHT_TRANSPORT=p2p for direct mode)
node scripts/displaytest.js        # dot alignment on all monitors, 100/150/200% scale, click-through
node scripts/gametest.js <gamePid> # overlay above a running game
npm run package          # dist/CrewSight-win32-x64(.zip)
```
More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/TESTING.md](docs/TESTING.md) · [docs/RELAY.md](docs/RELAY.md).

## Release notes — 0.1.0 (2026-10-15)
First release:
- Lobby codes and relay
- In-app WebRTC screen share
- Viewpoint dot with state labels
- Mouse calibration, manual and simulated sources
- Hotkeys and tray
- Diagnostics
- Portable build
