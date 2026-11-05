import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { createCache } from './cache.js';
import { attachLiveStreams } from './live.js';
import { createNvrClient, NvrError } from './nvr.js';

const { NVR_URL, NVR_USER, NVR_PASSWORD, NVR_ALLOW_SELF_SIGNED, NVR_RTSP_PORT = '554', HOST = '127.0.0.1', PORT = '3000' } = process.env;

if (!NVR_URL || !NVR_USER || !NVR_PASSWORD) {
  console.error('Set NVR_URL, NVR_USER and NVR_PASSWORD in .env (see .env.example).');
  process.exit(1);
}

const nvr = createNvrClient({
  url: NVR_URL,
  user: NVR_USER,
  password: NVR_PASSWORD,
  allowSelfSigned: NVR_ALLOW_SELF_SIGNED === 'true',
  rtspPort: Number(NVR_RTSP_PORT),
});

const YEARS_BACK = 10;
const YEAR_CACHE_MS = 24 * 60 * 60 * 1000;

const queryCache = createCache();

const pages = new Map([
  ['/', new URL('../public/index.html', import.meta.url)],
  ['/recordings', new URL('../public/recordings.html', import.meta.url)],
]);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function yearsWithRecordings(cameraIds) {
  const key = [...new Set(cameraIds)].sort().join(',');
  const lastYear = new Date().getFullYear();
  const years = [];
  // Sequential so a wrong password costs one failed login, not one per year.
  for (let year = lastYear - YEARS_BACK; year <= lastYear; year++) {
    const hasRecordings = await queryCache.get(`recording-year:${year}:${key}`, YEAR_CACHE_MS, () => nvr.yearHasRecordings(cameraIds, year));
    if (hasRecordings) years.push(year);
  }
  return years;
}

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  // DELETE rather than POST because browsers won't let another website send one here.
  if (req.method === 'DELETE' && pathname === '/api/cache') {
    queryCache.clear();
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  if (pages.has(pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(await readFile(pages.get(pathname)));
  }

  if (pathname === '/api/cameras') {
    return sendJson(res, 200, { cameras: await nvr.listCameras() });
  }

  const snapshotRoute = pathname.match(/^\/api\/cameras\/(\d+)\/snapshot$/);
  if (snapshotRoute) {
    const { contentType, body } = await nvr.snapshot(snapshotRoute[1], { full: searchParams.get('full') === '1' });
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  if (pathname === '/api/recordings/years') {
    const cameras = searchParams.get('cameras') ?? '';
    if (!/^(\d+(,\d+)*)?$/.test(cameras)) return sendJson(res, 400, { error: 'cameras must be a list of camera ids' });
    if (!cameras) return sendJson(res, 200, { years: [] });
    return sendJson(res, 200, { years: await yearsWithRecordings(cameras.split(',')) });
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

attachLiveStreams(server, nvr);

server.listen(Number(PORT), HOST, () => {
  console.log(`Camera viewer running at http://${HOST}:${PORT}`);
});
