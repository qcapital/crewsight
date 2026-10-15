# Feasibility report — CrewSight (WarDogs pilot–gunner viewpoint overlay)

Research date: 2026-10-15. Status labels: **Confirmed** (primary docs or measured here), **Reported** (secondary sources only), **Unknown**.

## Scope change during the project
The original brief said each player watches the other through a Discord stream. Partway through, the user asked for
**in-app screen sharing with a lobby code** instead. CrewSight now captures each player's own game window and sends
it straight to the other crew member over WebRTC. The overlay shows the other player's video with their viewpoint dot
on top. Discord is not needed.

## 1. Confirmed game-control information
No official developer documentation was found. Everything below comes from third-party guides
([allthings.how](https://allthings.how/wardogs-helicopter-controls-best-settings-for-flying/),
[games.gg](https://games.gg/news/wardogs-helicopter-mouse-controls-tips/),
[exitlag](https://www.exitlag.com/blog/wardogs-helicopter-controls/), [pixelnitro](https://pixelnitro.com/?p=15852)).
That makes all of it **Reported**, not Confirmed:
- Helicopter mouse flight is a setting ("Rotary Vehicle Mouse Control"). When it is off, the mouse moves the camera. When it is on, the mouse drives pitch and roll (or yaw).
- A free-look key (people suggest binding Left Alt) moves the camera without moving the aircraft.
- A separate gunner seat aims a door gun or nose gun with the mouse, independently of the pilot's flying.
- Sensitivity is set in-game as percentages, with an "Air Vehicle Multiplier" and an option to invert the Y axis.

## 2. Unknown game-control information
- Whether the game reads raw input or OS-accelerated cursor input, and whether it applies its own smoothing or acceleration.
- Turret traverse and elevation limits, and whether the turret slews at a capped rate. A capped slew rate would make mouse dead-reckoning overshoot.
- Whether free-look snaps back to the nose on release (CrewSight lets the user configure this).
- Whether the cockpit shows a usable heading or attitude instrument.
- Whether the game's rules or anti-cheat say anything about external overlays or raw-input observers. No statement was found, so this is **unresolved**. CrewSight is designed to be indistinguishable from Discord or OBS overlays plus an input-observing utility.

## 3. External signals available

| Source | Measures | Limitations | Reliability |
|---|---|---|---|
| Raw Input mouse counts (RIDEV_INPUTSINK) | Relative device counts before OS acceleration | Not the camera angle. Any mapping is an assumption validated by calibration. Drifts with clamping, rate limits or recentering | Good for gunner aim **if** calibration passes; drift grows over time → re-zero hotkey |
| Free-look key state (one key only) | Whether the pilot is free-looking | The game's semantics are assumed | Good |
| Foreground process name | Whether the game has focus | Name match only | Good |
| User calibration | Degrees per count, signs, symmetry, return-to-centre | Accuracy depends on the user hitting the reference angles | Medium. Validated by symmetry and return checks |
| Visual analysis of the shared video | Optical flow, HUD reading | Flow mixes aircraft rotation and translation and needs a world model. No confirmed heading HUD | **Not implemented**. Not justified without a legible instrument |
| Manual pad | Whatever the user indicates | Manual | Exact as a *declaration* |

## 4. Tracking method chosen
- **Gunner:** mouse dead-reckoning. Angle = Σcounts × deg/count × sign, clamped to limits, zeroed by the user on the nose.
- **Pilot:** the camera is assumed locked to the nose (`NOSE (ASSUMED)`). While the free-look key is held, the same dead-reckoning applies, snapping back on release if configured. A pilot with no free-look can declare "view fixed to nose".
- **Fallbacks:** Manual pad, or a simulated sweep for testing.

## 5. Expected failure modes
- Drift after hitting turret limits or after a slew-rate cap. Fix: the re-zero hotkey.
- In-game acceleration or smoothing. Calibration's return-to-centre and symmetry checks catch this.
- A sensitivity change after calibration invalidates the scale. Fix: recalibrate.
- Respawn or seat change resets the in-game view. Fix: re-zero.
- Strict NAT prevents the direct video path. Fix: a TURN server.
- An exclusive-fullscreen game may not capture, and the overlay may not draw above it. Use borderless.

## 6. Calibration requirements
For each seat, per axis, the user marks four times with a hotkey: nose → +reference angle → nose → −reference angle.
All of these checks must pass, or the calibration is rejected:
- opposite signs
- symmetry within 15 %
- return residual ≤ 10 %
- at least 50 counts

Vertical can be skipped. If it is, the vertical scale is labelled **ASSUMED**.

## 7. Minimum viable product (delivered)
Lobby, peer video, a 30 Hz viewpoint stream, the dot overlay with stale and state labels, calibration, the manual pad and diagnostics.

## 8. Fallback when automatic tracking is unavailable
Manual pad. The dot state is shown as `TRACKING UNAVAILABLE` / `CREW UNCALIBRATED` rather than as a frozen dot.

## 9. Test plan
See [TESTING.md](TESTING.md). It separates simulated or automated verification from the in-game accuracy procedure.

## 10. Accuracy guarantees
- **Can guarantee (tested):** the angle → dot mapping, ordering, staleness, and transport correctness.
- **Cannot guarantee:** that the estimate matches the in-game camera. The game's true camera angle is not externally observable. Accuracy depends on the reported control model holding and on calibration. **No in-game accuracy has been measured yet.**
- No world-relative heading is produced.

## Windows and API references
- Windows.Graphics.Capture (used by Chromium's window capture on Windows 10 1903+): https://learn.microsoft.com/windows/uwp/audio-video-camera/screen-capture. It cannot capture minimized windows, and capture of exclusive-fullscreen apps is not guaranteed.
- SetWindowDisplayAffinity / WDA_EXCLUDEFROMCAPTURE (Windows 10 2004+): https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity. Verified here: CrewSight's windows disappear from the shared screen once it is applied after the window is shown.
- Raw Input / RIDEV_INPUTSINK: https://learn.microsoft.com/windows/win32/inputdev/raw-input. Read-only; no driver or hooks.
- WebRTC encryption (DTLS-SRTP is mandatory): RFC 8827.
