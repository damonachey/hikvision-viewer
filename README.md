# Hikvision Camera Viewer

A small local web app that shows snapshots from the cameras on a Hikvision NVR, with live video in the tiles or full size, and plays back their recordings.

A Node server logs in to the NVR and passes the images and video to a single web page, so your NVR credentials never reach the browser. Snapshots, recording lists and thumbnail downloads use the NVR's ISAPI interface, and live video and playback use RTSP through FFmpeg. Playback faster than normal speed uses downloads instead.

<p>
  <img src="docs/images/live.png" alt="The Live page, showing a grid of cameras" width="55.9%" align="top">
  <img src="docs/images/recordings.png" alt="The Recordings page, showing the date rows, timeline bands and camera tiles" width="42.1%" align="top">
</p>

## Requirements

- Node.js 22.9 or newer
- [FFmpeg](https://ffmpeg.org/) on your `PATH`, for video and thumbnails
- A Hikvision NVR reachable from this machine, with ISAPI and RTSP enabled
- An NVR account that is allowed to view the cameras
- Cameras set to H.264, for video

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

5. Open the address printed in the terminal, which is http://127.0.0.1:3000 unless you set `PORT`.

## Configuration

Settings live in `.env`, which git ignores. Settings with a default are commented out in `.env.example`, so uncomment one to change it. Restart the app after changing them.

| Setting | Required | Default | Description |
|---|---|---|---|
| `NVR_URL` | Yes | | Address of the NVR, such as `http://192.168.1.64` |
| `NVR_USER` | Yes | | NVR username |
| `NVR_PASSWORD` | Yes | | NVR password |
| `NVR_RTSP_PORT` | No | `554` | RTSP port on the NVR, used for video |
| `NVR_ALLOW_SELF_SIGNED` | No | `false` | Set to `true` if `NVR_URL` is `https` and the NVR uses a self-signed certificate |
| `HOST` | No | `127.0.0.1` | Address the app listens on |
| `PORT` | No | `3000` | Port the app listens on |
| `CACHE_DIR` | No | `cache` | Folder for remembered NVR answers and thumbnails, which the app must be able to write to |
| `CACHE_YEARS_HOURS` | No | `24` | How long to remember whether a past year has video. `0` turns this cache off. |
| `CACHE_MONTHS_HOURS` | No | `24` | How long to remember whether another month has video. `0` turns this cache off. |
| `CACHE_DAYS_HOURS` | No | `24` | How long to remember which days of another month have video. `0` turns this cache off. |
| `CACHE_RECORDINGS_HOURS` | No | `24` | How long to remember the list of recordings for another day. `0` turns this cache off. |
| `CACHE_TODAY_MINUTES` | No | `5` | How long to remember all of those for the current year, month and day, which are still gaining video. `0` turns this cache off. |

## Using the Live page

- The links at the top of each page switch between **Live** and **Recordings**.
- The gear button lets you tick which cameras to show. Hidden cameras aren't requested from the NVR, and new cameras appear by default.
- **Refresh** gets new snapshots from every shown camera.
- The list next to **Refresh** sets the auto refresh, which repeats that every 1, 5, 30 or 60 seconds. A refresh is skipped if the last one is still loading, the tab is in the background or a full-size view is open.
- Setting that list to **Live** plays every shown camera's sub-stream in its tile and disables **Refresh**. Sub-streams are low resolution. The video stops while the tab is in the background.
- Click a tile to open that camera full size. The tiles pause while it's open, and it starts with the page's auto refresh setting.
- The full-size view has its own refresh list. It only applies while the view is open, doesn't change the page's setting and isn't saved.
- In the full-size view, **Live** plays the camera's main stream, without audio, and stops when you close the view or switch tabs. The other settings show snapshots at the highest resolution the NVR offers. The NVR may limit those below the camera's resolution, such as 1920×1080 on a DS-7608N-E2/8P, so use **Live** for the full resolution.
- The pop-out icon in the full-size view moves that camera to its own window with the same refresh setting and returns the page to its tiles. If your browser blocks the new window, the full-size view stays open. Press Esc to close a popped-out window.
- The pop-out icon on a tile opens that camera directly in its own window, using the page's auto refresh setting. The tile stays on the page.
- Each browser remembers its own camera and auto refresh choices, and clearing its site data resets them.

## Using the Recordings page

- The rows show the last 10 years, then the selected year's months, then the selected month's days, all brighter where the ticked cameras have video. Under them, each ticked camera has a band showing when it recorded that day, with one bar across all the bands that you drag to pick a time. The clip under the bar, or else the next one after it, is green, and each tile shows a thumbnail for it, or black if there's none.
- Opening a day makes 480×270 thumbnails, one at a time, by downloading just the start of each file. A clip gets its own unless it starts less than five minutes after the last clip that did, in which case it shares that one. Each camera's first and last come first, then the gaps are split in half repeatedly, with the cameras taking turns, so the whole day fills in gradually. Until a day is finished, a tile shows the nearest thumbnail so far. They're kept in `thumbnails` in `CACHE_DIR`, aren't removed by **Clear cached queries**, and are never deleted automatically. **Clear cached thumbnails** under the gear button deletes all of them, and the day being viewed then starts building again. **Cache info** there shows how much space the cache is using.
- Move the mouse over a tile and click its play button to play that camera in a popup. It works when the camera's band has a green clip. It plays from the bar if the bar is inside that clip, or else from the start of the next clip, then carries on through that camera's later clips. The popup has its own play and pause button, and the bar follows the video, so it stays where you stopped when you close the popup.
- The pop-out button under a tile, or the one in the popup, plays that camera in its own window instead. Press Esc to close the window.
- The popup and the window both have a speed menu, from 0.5× to 8×, and a progress bar for the current clip. Click or drag the bar to move within the clip.
- The NVR only streams recordings at normal speed, so 2× and above use downloads, which arrive about 10 times faster than normal speed. A download always starts at the start of its clip, so starting or moving far into a long clip at those speeds can take a while: about 7 to 10 seconds for a point 1.5 minutes in. Changing between 1× or slower and 2× or faster reconnects, which can take up to about 20 seconds if the NVR is still busy with the last stream.
- The NVR plays one recording at a time at 1× or slower, so there's only one pop-out window, and playing another camera there replaces the first. A popup won't start at those speeds while that window is playing.
- A browser extension that controls video speed can override the speed menu.
- The gear button keeps its own list of cameras, separate from the **Live** page's, and each browser remembers it. Thumbnails are made for every camera, ticked or not, so ticking one later shows its thumbnails straight away.
- The server saves each answer in `query-cache.json` in `CACHE_DIR` to spare the NVR, including across restarts. New video can take as long as the matching `CACHE_` setting to show. **Clear cached queries** under the gear button asks the NVR again.

## Security

- **The app has no login.** Anyone who can reach it can see your cameras, so it only listens on `127.0.0.1` by default. Add a login before setting `HOST` to anything else.
- **Failed logins can lock the NVR account.** Hikvision locks accounts after repeated failures, so the app stops trying after one rejected password. Fix `.env` and restart to try again.
- **The password is briefly visible to local programs.** FFmpeg needs it in the RTSP address, so other programs on this machine can see it while video is playing.
- **Use a separate account if you can.** A low-privilege NVR user limits the damage if the password is exposed.

## Troubleshooting

| Problem | What to check |
|---|---|
| `EADDRINUSE` when starting | Another app is using that port, so change `PORT` |
| "The NVR rejected the username or password" | Fix `.env` and restart. The NVR may also have locked the account, so wait for the lock to clear first. |
| "Could not reach the NVR" | Check `NVR_URL` and that this machine can reach the NVR |
| Cameras are missing | Check the list under the gear button. Only IP camera channels are listed, so analog channels on a hybrid recorder won't appear. |
| "Camera offline" or "Snapshot failed" | Check the camera's status on the NVR and that the account is allowed to view it. After the NVR reboots, snapshots can fail for 10 minutes or more, then recover by themselves. |
| "FFmpeg is not installed on the server" | Install FFmpeg, make sure it's on your `PATH`, and restart the app |
| Live view stays on "Reconnecting…" | Check that RTSP is enabled on the NVR, that `NVR_RTSP_PORT` is right, and that your firewall allows UDP video to reach FFmpeg. The server log has the reason. |
| "Could not play this camera" | The NVR plays one recording at a time and can be slow to free up, so the app retries for several seconds. Stop any other playback, such as another tab or the NVR's own app, and try again. If it stays busy, rebooting the NVR has cleared it. |
| "thumbnails could not be made" or "Stopped making thumbnails after repeated failures" | The server log has the reason for each one. Opening the day again retries the missing ones. |
| Live view is choppy or falls behind | Video travels over UDP, so check for packet loss between this machine and the NVR, and close other apps that are viewing its cameras. |

## Running as a service on Alpine

These steps run the app on Alpine Linux, such as in a Proxmox LXC container. The container needs its own address on the same network as the NVR, because video arrives as UDP. Don't put it behind NAT, and allow UDP from the NVR if a firewall is on.

1. Install the app as root, and set the time zone to the NVR's, replacing `America/Denver` with yours. Otherwise the app and the NVR's recorded times can disagree on which day is today:

   ```sh
   apk add nodejs npm ffmpeg git tzdata
   cp /usr/share/zoneinfo/America/Denver /etc/localtime
   echo America/Denver > /etc/timezone
   git clone https://github.com/damonachey/hikvision-viewer.git /opt/hikvision-viewer
   cd /opt/hikvision-viewer
   npm ci --omit=dev
   ```

2. Create a user to run it, and its config. Set `HOST=0.0.0.0` in `.env` so other machines can connect, and read the Security section first. Also uncomment and set `CACHE_DIR=/var/lib/hikvision-viewer`, which the service creates, because the service user can't write to the install folder:

   ```sh
   addgroup -S hikvision
   adduser -S -D -H -G hikvision hikvision
   cp .env.example .env
   chown root:hikvision .env
   chmod 640 .env
   ```

3. Start the service, and start it on boot:

   ```sh
   cp deploy/hikvision-viewer.openrc /etc/init.d/hikvision-viewer
   chmod +x /etc/init.d/hikvision-viewer
   rc-update add hikvision-viewer default
   rc-service hikvision-viewer start
   ```

To update it, run `sh deploy/update.sh` as root in `/opt/hikvision-viewer`. It gets the latest code, updates the service file, sets `CACHE_DIR` if it's missing, and restarts the service. Logs are in `/var/log/hikvision-viewer.log`.

## API

| Endpoint | Returns |
|---|---|
| `GET /api/cameras` | JSON list of the cameras, each with `id`, `name` and `online` |
| `GET /api/cameras/:id/snapshot` | The camera's current image at the NVR's default size. Add `?full=1` for the highest resolution the NVR offers. |
| `GET /api/recordings/years?cameras=1,2` | JSON list of the years, from the last 10, with main-stream video from any of those cameras. Sends the NVR one search per year, and remembers each answer for `CACHE_YEARS_HOURS`, or `CACHE_TODAY_MINUTES` for the current year. |
| `GET /api/recordings/months?cameras=1,2&year=2026` | JSON list of that year's months, numbered from 1, with main-stream video from any of those cameras. Sends the NVR one search per month, skipped if the year has no video, and remembers each answer for `CACHE_MONTHS_HOURS`, or `CACHE_TODAY_MINUTES` for the current month. |
| `GET /api/recordings/days?cameras=1,2&year=2026&month=11` | JSON list of that month's days with main-stream video from any of those cameras. Sends the NVR one request per camera, skipped if the month has no video, and remembers each answer for `CACHE_DAYS_HOURS`, or `CACHE_TODAY_MINUTES` for the current month. |
| `GET /api/recordings/list?cameras=1,2&year=2026&month=11&day=3` | JSON with each camera's recordings that day. Each has `start` and `end` in seconds since midnight, and a `type`. Sends the NVR at least one search per camera, skipped for days without video, and remembers each answer for `CACHE_RECORDINGS_HOURS`, or `CACHE_TODAY_MINUTES` for today. |
| WebSocket `/api/cameras/:id/recording?start=20261103T153000` | The camera's main-stream recordings in the same format as live video, from that local time to the end of that day |
| `PUT /api/recordings/thumbnails?year=2026&month=11&day=3` | Starts making that day's missing thumbnails, in place of any other day in progress |
| `GET /api/recordings/thumbnails?cameras=1,2&date=2026-11-03` | JSON with the progress, and each camera's thumbnail times in seconds since midnight |
| `GET /api/recordings/thumbnails/:id/:date/:hhmmss.jpg` | One thumbnail |
| `DELETE /api/recordings/thumbnails` | Stops any build and deletes every thumbnail |
| `GET /api/cache` | JSON with the size of the cached queries, each day's thumbnails and the free disk space |
| `DELETE /api/cache` | Forgets the remembered NVR answers |
| WebSocket `/api/cameras/:id/live?stream=main` or `sub` | The camera's stream as fragmented MP4, after a JSON message with its codec. Only same-origin pages can connect, and the server allows 16 streams at once. It pings every 15 seconds and ends a stream whose viewer stops answering. |

## Project layout

| Path | Purpose |
|---|---|
| `src/nvr.js` | NVR client: digest auth, camera list, snapshots, recording searches and downloads |
| `src/video.js` | Live video and playback: runs FFmpeg and sends its output over WebSockets, or over HTTP for fast playback |
| `src/thumbnails.js` | Makes a thumbnail from the start of each clip |
| `src/cache.js` | Saves NVR answers to a JSON file, for a set time per type of data |
| `src/server.js` | Config, routes and the web server |
| `public/index.html` | The Live page: the camera grid |
| `public/recordings.html` | The Recordings page |
| `deploy/hikvision-viewer.openrc` | Service file for Alpine Linux |
| `deploy/update.sh` | Updates an Alpine install to the latest code |
| `ISAPI.md` | Notes on the NVR's API |

## License

[MIT](LICENSE)
