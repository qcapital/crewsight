# Connection options

**Default: Direct peer-to-peer, nothing to host.** The app uses the free public PeerJS broker (0.peerjs.com) only to introduce the two PCs. This is the same approach the earlier CrewLink prototype used. Viewpoints travel over a WebRTC data channel and video over a WebRTC media call, both directly between the PCs and encrypted. If the broker is down, new lobbies can't be made, but existing links keep working. To remove that dependency, run [peerjs-server](https://github.com/peers/peerjs-server) yourself and set `"broker": {"host":"...","port":443,"path":"/","secure":true}` in config.json, or use the relay below.

# Optional: own relay deployment

Both crew members' apps must reach **one relay**. It only pairs lobbies and forwards small messages, about 3 KB/s per player.
Video does **not** pass through it; video goes peer-to-peer.

If the relay is down, nobody can create or join lobbies. Players who are already connected keep their video until the
connection drops, but viewpoint dots stop and show **STALE**.

Nothing has been deployed by the developer. Use one of the options below.

## Option A — free/cheap PaaS with automatic TLS (recommended)
Any host that runs a Dockerfile and terminates TLS works, for example Render, Fly.io or Railway. They typically cost $0–5 a month at this load.
1. Push this repository to GitHub.
2. Create a new web service from the repo. It uses the root `Dockerfile` and listens on `$PORT`.
3. You get a URL like `https://crewsight-relay.onrender.com`. In CrewSight, enter **`wss://crewsight-relay.onrender.com`**.

Free tiers may sleep when idle, so the first connection can take about 30 s.

## Option B — one player hosts it
1. Install Node 20+ and run `npm ci --omit=dev`, then `node relay/server.js 8787`.
2. Forward TCP port 8787 on your router and allow it through Windows Firewall.
3. The other player uses `ws://<your-public-ip>:8787`. **This is unencrypted.** The viewpoint angles and the lobby code can be read on the path. The video is still encrypted.

For TLS, put a reverse proxy (Caddy, for example) in front of the relay.

## Option C — same LAN / testing
Run `npm run relay` and use `ws://<lan-ip>:8787`.

## Environment
- `PORT` (default 8787)
- `HOST` (default 0.0.0.0)

No secrets are needed.

## TURN (only if video shows "VIDEO FAILED (NAT?)")
STUN (Google's public server, the default) works for most home networks. For symmetric NAT or strict firewalls, run a TURN server
(for example coturn, or a hosted one) and edit `%APPDATA%\CrewSight\config.json` on **both** PCs:
```json
"iceServers": [{"urls":"stun:stun.l.google.com:19302"},
               {"urls":"turn:turn.example.com:3478","username":"USER","credential":"PASS"}]
```
Credentials stay in your local config. Nothing is hard-coded.
