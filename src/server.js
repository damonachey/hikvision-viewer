import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createNvrClient, NvrError } from './nvr.js';

const { NVR_URL, NVR_USER, NVR_PASSWORD, NVR_ALLOW_SELF_SIGNED, CAMERAS, HOST = '127.0.0.1', PORT = '3000' } = process.env;

if (!NVR_URL || !NVR_USER || !NVR_PASSWORD) {
  console.error('Set NVR_URL, NVR_USER and NVR_PASSWORD in .env (see .env.example).');
  process.exit(1);
}

const nvr = createNvrClient({
  url: NVR_URL,
  user: NVR_USER,
  password: NVR_PASSWORD,
  allowSelfSigned: NVR_ALLOW_SELF_SIGNED === 'true',
});

const indexPage = new URL('../public/index.html', import.meta.url);

const shownCameras = CAMERAS?.trim() ? new Set(CAMERAS.split(',').map((id) => id.trim())) : null;
const isShown = (id) => !shownCameras || shownCameras.has(id);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handle(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  if (pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(await readFile(indexPage));
  }

  if (pathname === '/api/cameras') {
    const cameras = await nvr.listCameras();
    return sendJson(res, 200, { cameras: cameras.filter((camera) => isShown(camera.id)) });
  }

  const snapshotRoute = pathname.match(/^\/api\/cameras\/(\d+)\/snapshot$/);
  if (snapshotRoute && isShown(snapshotRoute[1])) {
    const { contentType, body } = await nvr.snapshot(snapshotRoute[1]);
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  sendJson(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!(err instanceof NvrError)) console.error(err);
    console.error(`${req.url}: ${err.message}`);
    if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
    else res.end();
  });
});

server.listen(Number(PORT), HOST, () => {
  console.log(`Camera viewer running at http://${HOST}:${PORT}`);
});
