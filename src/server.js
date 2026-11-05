import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createCache } from './cache.js';
import { attachLiveStreams } from './live.js';
import { createNvrClient, NvrError } from './nvr.js';

const { NVR_URL, NVR_USER, NVR_PASSWORD, NVR_ALLOW_SELF_SIGNED, NVR_RTSP_PORT = '554', HOST = '127.0.0.1', PORT = '3000', CACHE_DIR = 'cache', CACHE_YEARS_HOURS = '24', CACHE_MONTHS_HOURS = '24', CACHE_DAYS_HOURS = '24', CACHE_RECORDINGS_HOURS = '24', CACHE_TODAY_MINUTES = '5' } = process.env;

if (!NVR_URL || !NVR_USER || !NVR_PASSWORD) {
  console.error('Set NVR_URL, NVR_USER and NVR_PASSWORD in .env (see .env.example).');
  process.exit(1);
}

function cacheLifetimeMs(setting, amount, unit, unitMs) {
  if (!amount.trim() || !(Number(amount) >= 0)) {
    console.error(`Set ${setting} in .env to a number of ${unit}, or 0 to turn that cache off.`);
    process.exit(1);
  }
  return Number(amount) * unitMs;
}

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const todayLifetimeMs = cacheLifetimeMs('CACHE_TODAY_MINUTES', CACHE_TODAY_MINUTES, 'minutes', MINUTE_MS);

const nvr = createNvrClient({
  url: NVR_URL,
  user: NVR_USER,
  password: NVR_PASSWORD,
  allowSelfSigned: NVR_ALLOW_SELF_SIGNED === 'true',
  rtspPort: Number(NVR_RTSP_PORT),
});

const YEARS_BACK = 10;

const queryCache = createCache({
  file: path.join(CACHE_DIR, 'query-cache.json'),
  lifetimesMs: {
    recordingYear: cacheLifetimeMs('CACHE_YEARS_HOURS', CACHE_YEARS_HOURS, 'hours', HOUR_MS),
    recordingMonth: cacheLifetimeMs('CACHE_MONTHS_HOURS', CACHE_MONTHS_HOURS, 'hours', HOUR_MS),
    recordingDays: cacheLifetimeMs('CACHE_DAYS_HOURS', CACHE_DAYS_HOURS, 'hours', HOUR_MS),
    recordings: cacheLifetimeMs('CACHE_RECORDINGS_HOURS', CACHE_RECORDINGS_HOURS, 'hours', HOUR_MS),
    recordingYearNow: todayLifetimeMs,
    recordingMonthNow: todayLifetimeMs,
    recordingDaysNow: todayLifetimeMs,
    recordingsNow: todayLifetimeMs,
  },
});

// The current year, month and day are still gaining video, so they refresh sooner.
function cacheType(type, year, month, day) {
  const now = new Date();
  const isCurrent = year === now.getFullYear()
    && (month === undefined || month === now.getMonth() + 1)
    && (day === undefined || day === now.getDate());
  return isCurrent ? `${type}Now` : type;
}

const pages = new Map([
  ['/', new URL('../public/index.html', import.meta.url)],
  ['/recordings', new URL('../public/recordings.html', import.meta.url)],
]);

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function cameraKey(cameraIds) {
  return [...new Set(cameraIds)].sort().join(',');
}

function yearHasRecordings(cameraIds, year) {
  return queryCache.get(cacheType('recordingYear', year), `${year}:${cameraKey(cameraIds)}`, () => nvr.yearHasRecordings(cameraIds, year));
}

async function yearsWithRecordings(cameraIds) {
  const lastYear = new Date().getFullYear();
  const years = [];
  // Sequential so a wrong password costs one failed login, not one per year.
  for (let year = lastYear - YEARS_BACK; year <= lastYear; year++) {
    if (await yearHasRecordings(cameraIds, year)) years.push(year);
  }
  return years;
}

async function monthsWithRecordings(cameraIds, year) {
  // A year without video has no months with video, so skip their searches.
  if (!(await yearHasRecordings(cameraIds, year))) return [];

  const key = cameraKey(cameraIds);
  const months = [];
  // Sequential so a wrong password costs one failed login, not one per month.
  for (let month = 1; month <= 12; month++) {
    const hasRecordings = await queryCache.get(cacheType('recordingMonth', year, month), `${year}-${month}:${key}`, () => nvr.monthHasRecordings(cameraIds, year, month));
    if (hasRecordings) months.push(month);
  }
  return months;
}

function cameraDaysWithRecordings(cameraId, year, month) {
  // Saved per camera, so another mix of cameras can reuse these answers.
  return queryCache.get(cacheType('recordingDays', year, month), `${year}-${month}:${cameraId}`, () => nvr.daysWithRecordings(cameraId, year, month));
}

async function daysWithRecordings(cameraIds, year, month) {
  // A month without video has no days with video, so skip their requests.
  if (!(await monthsWithRecordings(cameraIds, year)).includes(month)) return [];

  const days = new Set();
  // Sequential so a wrong password costs one failed login, not one per camera.
  for (const cameraId of new Set(cameraIds)) {
    for (const day of await cameraDaysWithRecordings(cameraId, year, month)) days.add(day);
  }
  return [...days].sort((a, b) => a - b);
}

async function recordingsOnDay(cameraIds, year, month, day) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const cameras = {};
  // Days without video can skip their searches.
  const dayHasVideo = (await daysWithRecordings(cameraIds, year, month)).includes(day);
  // Sequential so a wrong password costs one failed login, not one per camera.
  for (const cameraId of new Set(cameraIds)) {
    const hasVideo = dayHasVideo && (await cameraDaysWithRecordings(cameraId, year, month)).includes(day);
    cameras[cameraId] = hasVideo
      ? await queryCache.get(cacheType('recordings', year, month, day), `${date}:${cameraId}`, () => nvr.recordingsOnDay(cameraId, date))
      : [];
  }
  return cameras;
}

function isValidYear(text) {
  const lastYear = new Date().getFullYear();
  return /^\d{4}$/.test(text) && Number(text) >= lastYear - YEARS_BACK && Number(text) <= lastYear;
}

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  // DELETE rather than POST because browsers won't let another website send one here.
  if (req.method === 'DELETE' && pathname === '/api/cache') {
    await queryCache.clear();
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

  if (['/api/recordings/years', '/api/recordings/months', '/api/recordings/days', '/api/recordings/list'].includes(pathname)) {
    const cameras = searchParams.get('cameras') ?? '';
    if (!/^(\d+(,\d+)*)?$/.test(cameras)) return sendJson(res, 400, { error: 'cameras must be a list of camera ids' });
    const cameraIds = cameras ? cameras.split(',') : [];

    if (pathname === '/api/recordings/years') {
      return sendJson(res, 200, { years: cameras ? await yearsWithRecordings(cameraIds) : [] });
    }

    const year = searchParams.get('year');
    if (!isValidYear(year)) return sendJson(res, 400, { error: `year must be within the last ${YEARS_BACK} years` });

    if (pathname === '/api/recordings/months') {
      return sendJson(res, 200, { months: cameras ? await monthsWithRecordings(cameraIds, Number(year)) : [] });
    }

    const month = searchParams.get('month');
    if (!/^(1[0-2]|[1-9])$/.test(month ?? '')) return sendJson(res, 400, { error: 'month must be from 1 to 12' });

    if (pathname === '/api/recordings/days') {
      return sendJson(res, 200, { days: cameras ? await daysWithRecordings(cameraIds, Number(year), Number(month)) : [] });
    }

    const day = searchParams.get('day');
    if (!/^([1-9]|[12]\d|3[01])$/.test(day ?? '')) return sendJson(res, 400, { error: 'day must be from 1 to 31' });
    return sendJson(res, 200, { cameras: cameras ? await recordingsOnDay(cameraIds, Number(year), Number(month), Number(day)) : {} });
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
