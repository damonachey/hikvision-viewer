# Hikvision Camera Viewer

A small local web app that shows snapshots from the cameras on a Hikvision NVR, using the NVR's ISAPI interface.

A Node server logs in to the NVR with digest auth and passes the images to a single web page, so your NVR credentials never reach the browser. It has no dependencies to install.

## Requirements

- Node.js 22.9 or newer
- A Hikvision NVR reachable from this machine, with ISAPI enabled
- An NVR account that is allowed to view the cameras

## Setup

1. Create your config file:

   ```powershell
   Copy-Item .env.example .env
   ```

2. Set `NVR_URL`, `NVR_USER` and `NVR_PASSWORD` in `.env`.
3. Start the app:

   ```powershell
   npm start
   ```

4. Open the address printed in the terminal, which is http://127.0.0.1:9999 if you keep the example port.

## Configuration

Settings live in `.env`, which git ignores. Restart the app after changing them.

| Setting | Required | Default | Description |
|---|---|---|---|
| `NVR_URL` | Yes | | Address of the NVR, such as `http://192.168.1.64` |
| `NVR_USER` | Yes | | NVR username |
| `NVR_PASSWORD` | Yes | | NVR password |
| `NVR_ALLOW_SELF_SIGNED` | No | `false` | Set to `true` if `NVR_URL` is `https` and the NVR uses a self-signed certificate |
| `HOST` | No | `127.0.0.1` | Address the app listens on |
| `PORT` | No | `3000` | Port the app listens on (`.env.example` sets `9999`) |

## Using the page

- **Cameras** lets you tick which cameras to show. Hidden cameras aren't requested from the NVR, and new cameras appear by default.
- **Refresh** gets new snapshots from every shown camera.
- **Auto refresh** repeats that on a timer, from every 5 seconds to every 5 minutes. A refresh is skipped if the last one is still loading or the tab is in the background.
- Each browser remembers its own camera and auto refresh choices, and clearing its site data resets them.
- Click an image to open it full size in a new tab.

## Security

- **The app has no login.** Anyone who can reach it can see your cameras, so it only listens on `127.0.0.1` by default. Add a login before setting `HOST` to anything else.
- **Failed logins can lock the NVR account.** Hikvision locks accounts after repeated failures, so the app stops trying after one rejected password. Fix `.env` and restart to try again.
- **Use a separate account if you can.** A low-privilege NVR user limits the damage if `.env` is exposed.

## Troubleshooting

| Problem | What to check |
|---|---|
| `EADDRINUSE` when starting | Another app is using that port, so change `PORT` |
| "The NVR rejected the username or password" | Fix `.env` and restart. The NVR may also have locked the account, so wait for the lock to clear first. |
| "Could not reach the NVR" | Check `NVR_URL` and that this machine can reach the NVR |
| Cameras are missing | Check the **Cameras** menu. Only IP camera channels are listed, so analog channels on a hybrid recorder won't appear. |
| "Camera offline" or "Snapshot failed" | Check the camera's status on the NVR and that the account is allowed to view it |

## API

| Endpoint | Returns |
|---|---|
| `GET /api/cameras` | JSON list of the cameras, each with `id`, `name` and `online` |
| `GET /api/cameras/:id/snapshot` | The camera's current main-stream image |

## Project layout

| Path | Purpose |
|---|---|
| `src/nvr.js` | NVR client: digest auth, camera list and snapshots |
| `src/server.js` | Config, routes and the web server |
| `public/index.html` | The camera grid page |
