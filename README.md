# CrewSight — WarDogs pilot/gunner viewpoint overlay

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

## Known limitations
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
