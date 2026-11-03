# Hikvision Camera Viewer

A small local web app that shows snapshots from the cameras on a Hikvision NVR, with live video in the tiles or full size.

A Node server logs in to the NVR and passes the images and video to a single web page, so your NVR credentials never reach the browser. Snapshots use the NVR's ISAPI interface, and live video uses RTSP through FFmpeg.

## Requirements

- Node.js 22.9 or newer
- [FFmpeg](https://ffmpeg.org/) on your `PATH`, for live video
- A Hikvision NVR reachable from this machine, with ISAPI and RTSP enabled
- An NVR account that is allowed to view the cameras
- Cameras set to H.264, for live video

## Setup

1. Install the dependencies:

   ```powershell
   npm install
   ```

2. Create your config file:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Set `NVR_URL`, `NVR_USER` and `NVR_PASSWORD` in `.env`.
4. Start the app:

   ```powershell
   npm start
   ```

5. Open the address printed in the terminal, which is http://127.0.0.1:9999 if you keep the example port.

## Configuration

Settings live in `.env`, which git ignores. Restart the app after changing them.

| Setting | Required | Default | Description |
|---|---|---|---|
| `NVR_URL` | Yes | | Address of the NVR, such as `http://192.168.1.64` |
| `NVR_USER` | Yes | | NVR username |
| `NVR_PASSWORD` | Yes | | NVR password |
| `NVR_RTSP_PORT` | No | `554` | RTSP port on the NVR, used for live video |
| `NVR_ALLOW_SELF_SIGNED` | No | `false` | Set to `true` if `NVR_URL` is `https` and the NVR uses a self-signed certificate |
| `HOST` | No | `127.0.0.1` | Address the app listens on |
| `PORT` | No | `3000` | Port the app listens on (`.env.example` sets `9999`) |

## Using the page

- The gear button lets you tick which cameras to show. Hidden cameras aren't requested from the NVR, and new cameras appear by default.
- **Refresh** gets new snapshots from every shown camera.
- The list next to **Refresh** sets the auto refresh, which repeats that every 1, 5, 30 or 60 seconds. A refresh is skipped if the last one is still loading, the tab is in the background or a full-size view is open.
- Setting that list to **Live** plays every shown camera's sub-stream in its tile and disables **Refresh**. Sub-streams are low resolution. The video stops while the tab is in the background.
- Click a tile to open that camera full size. The tiles pause while it's open, and it starts with the page's auto refresh setting.
- The full-size view has its own refresh list. It only applies while the view is open, doesn't change the page's setting and isn't saved.
- In the full-size view, **Live** plays the camera's main stream, without audio, and stops when you close the view or switch tabs. The other settings show snapshots at the highest resolution the NVR offers. The NVR may limit those below the camera's resolution, such as 1920×1080 on a DS-7608N-E2/8P, so use **Live** for the full resolution.
- Each browser remembers its own camera and auto refresh choices, and clearing its site data resets them.

## Security

- **The app has no login.** Anyone who can reach it can see your cameras, so it only listens on `127.0.0.1` by default. Add a login before setting `HOST` to anything else.
- **Failed logins can lock the NVR account.** Hikvision locks accounts after repeated failures, so the app stops trying after one rejected password. Fix `.env` and restart to try again.
- **The password is briefly visible to local programs.** FFmpeg needs it in the RTSP address, so other programs on this machine can see it while a live view is open.
- **Use a separate account if you can.** A low-privilege NVR user limits the damage if the password is exposed.

## Troubleshooting

| Problem | What to check |
|---|---|
| `EADDRINUSE` when starting | Another app is using that port, so change `PORT` |
| "The NVR rejected the username or password" | Fix `.env` and restart. The NVR may also have locked the account, so wait for the lock to clear first. |
| "Could not reach the NVR" | Check `NVR_URL` and that this machine can reach the NVR |
| Cameras are missing | Check the list under the gear button. Only IP camera channels are listed, so analog channels on a hybrid recorder won't appear. |
| "Camera offline" or "Snapshot failed" | Check the camera's status on the NVR and that the account is allowed to view it |
| "FFmpeg is not installed on the server" | Install FFmpeg, make sure it's on your `PATH`, and restart the app |
| Live view stays on "Reconnecting…" | Check that RTSP is enabled on the NVR, that `NVR_RTSP_PORT` is right, and that your firewall allows UDP video to reach FFmpeg. The server log has the reason. |
| Live view is choppy or falls behind | Video travels over UDP, so check for packet loss between this machine and the NVR, and close other apps that are viewing its cameras. |

## API

| Endpoint | Returns |
|---|---|
| `GET /api/cameras` | JSON list of the cameras, each with `id`, `name` and `online` |
| `GET /api/cameras/:id/snapshot` | The camera's current image at the NVR's default size. Add `?full=1` for the highest resolution the NVR offers. |
| WebSocket `/api/cameras/:id/live?stream=main` or `sub` | The camera's stream as fragmented MP4, after a JSON message with its codec. Only same-origin pages can connect, and the server allows 16 streams at once. |

## Project layout

| Path | Purpose |
|---|---|
| `src/nvr.js` | NVR client: digest auth, camera list and snapshots |
| `src/live.js` | Live video: runs FFmpeg and sends its output over WebSockets |
| `src/server.js` | Config, routes and the web server |
| `public/index.html` | The camera grid page |
