import { readFile, stat, statfs } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createCache } from './cache.js';
import { createNvrClient, NvrError } from './nvr.js';
import { createThumbnailBuilder } from './thumbnails.js';
import { attachVideoStreams, sendRecordingFile } from './video.js';

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
const YEAR_ERROR = `year must be within the last ${YEARS_BACK} years`;
const MONTH_ERROR = 'month must be from 1 to 12';
const DAY_ERROR = 'day must be from 1 to 31';

const queryCache = createCache({
  file: path.join(CACHE_DIR, 'query-cache.json'),
  lifetimesMs: {
    recordingYear: cacheLifetimeMs('CACHE_YEARS_HOURS', CACHE_YEARS_HOURS, 'hours', HOUR_MS),
    recordingMonth: cacheLifetimeMs('CACHE_MONTHS_HOURS', CACHE_MONTHS_HOURS, 'hours', HOUR_MS),
    recordingDays: cacheLifetimeMs('CACHE_DAYS_HOURS', CACHE_DAYS_HOURS, 'hours', HOUR_MS),
    recordingFiles: cacheLifetimeMs('CACHE_RECORDINGS_HOURS', CACHE_RECORDINGS_HOURS, 'hours', HOUR_MS),
    recordingYearNow: todayLifetimeMs,
    recordingMonthNow: todayLifetimeMs,
    recordingDaysNow: todayLifetimeMs,
    recordingFilesNow: todayLifetimeMs,
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
      ? await queryCache.get(cacheType('recordingFiles', year, month, day), `${date}:${cameraId}`, () => nvr.recordingsOnDay(cameraId, date))
      : [];
  }
  return cameras;
}

const thumbnails = createThumbnailBuilder({
  nvr,
  directory: path.join(CACHE_DIR, 'thumbnails'),
  listCameras: () => nvr.listCameras(),
  listRecordings: recordingsOnDay,
});

function isValidYear(text) {
  const lastYear = new Date().getFullYear();
  return /^\d{4}$/.test(text) && Number(text) >= lastYear - YEARS_BACK && Number(text) <= lastYear;
}

function isValidMonth(text) {
  return /^(1[0-2]|[1-9])$/.test(text ?? '');
}

function isValidDay(text) {
  return /^([1-9]|[12]\d|3[01])$/.test(text ?? '');
}

async function cacheInfo() {
  const queryFile = await stat(path.join(CACHE_DIR, 'query-cache.json')).catch(() => null);
  const disk = await statfs(CACHE_DIR).catch(() => null);
  return {
    queryBytes: queryFile?.size ?? 0,
    days: await thumbnails.info(),
    diskFreeBytes: disk ? disk.bavail * disk.bsize : null,
    diskTotalBytes: disk ? disk.blocks * disk.bsize : null,
  };
}

async function handle(req, res) {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');

  // DELETE rather than POST because browsers won't let another website send one here.
  if (req.method === 'DELETE' && pathname === '/api/cache') {
    await queryCache.clear();
    res.writeHead(204);
    return res.end();
  }

  // DELETE and PUT rather than POST because browsers won't let another website send them here.
  if (req.method === 'DELETE' && pathname === '/api/recordings/thumbnails') {
    await thumbnails.clear();
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'PUT' && pathname === '/api/recordings/thumbnails') {
    const year = searchParams.get('year');
    const month = searchParams.get('month');
    const day = searchParams.get('day');
    if (!isValidYear(year)) return sendJson(res, 400, { error: YEAR_ERROR });
    if (!isValidMonth(month)) return sendJson(res, 400, { error: MONTH_ERROR });
    if (!isValidDay(day)) return sendJson(res, 400, { error: DAY_ERROR });
    return sendJson(res, 200, thumbnails.start(Number(year), Number(month), Number(day)));
  }

  if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });

  if (pathname === '/api/cache') return sendJson(res, 200, await cacheInfo());

  if (pathname === '/api/recordings/thumbnails') {
    const cameras = searchParams.get('cameras') ?? '';
    const date = searchParams.get('date') ?? '';
    if (!/^(\d+(,\d+)*)?$/.test(cameras)) return sendJson(res, 400, { error: 'cameras must be a list of camera ids' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return sendJson(res, 400, { error: 'date must look like 2026-11-04' });
    return sendJson(res, 200, { status: thumbnails.status(), cameras: await thumbnails.list(cameras ? cameras.split(',') : [], date) });
  }

  const thumbnailRoute = pathname.match(/^\/api\/recordings\/thumbnails\/(\d+)\/(\d{4}-\d{2}-\d{2})\/(\d{6})\.jpg$/);
  if (thumbnailRoute) {
    const body = await readFile(thumbnails.filePath(thumbnailRoute[1], thumbnailRoute[2], thumbnailRoute[3])).catch(() => null);
    if (!body) return sendJson(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' });
    return res.end(body);
  }

  const clipRoute = pathname.match(/^\/api\/recordings\/clips\/(\d+)\/(\d{4})-(\d{2})-(\d{2})\/(\d+)$/);
  if (clipRoute) {
    const [, cameraId, year, month, day, start] = clipRoute;
    const skip = searchParams.get('skip') ?? '0';
    if (!/^\d+$/.test(skip)) return sendJson(res, 400, { error: 'skip must be a number of seconds' });
    if (!isValidYear(year)) return sendJson(res, 400, { error: YEAR_ERROR });
    if (!isValidMonth(String(Number(month)))) return sendJson(res, 400, { error: MONTH_ERROR });
    if (!isValidDay(String(Number(day)))) return sendJson(res, 400, { error: DAY_ERROR });
    const recordings = await recordingsOnDay([cameraId], Number(year), Number(month), Number(day));
    const clip = recordings[cameraId].find((recording) => recording.start === Number(start));
    if (!clip) return sendJson(res, 404, { error: 'That recording was not found' });
    return sendRecordingFile(res, nvr, clip.playbackUri, Number(skip));
  }

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
    if (!isValidYear(year)) return sendJson(res, 400, { error: YEAR_ERROR });

    if (pathname === '/api/recordings/months') {
      return sendJson(res, 200, { months: cameras ? await monthsWithRecordings(cameraIds, Number(year)) : [] });
    }

    const month = searchParams.get('month');
    if (!isValidMonth(month)) return sendJson(res, 400, { error: MONTH_ERROR });

    if (pathname === '/api/recordings/days') {
      return sendJson(res, 200, { days: cameras ? await daysWithRecordings(cameraIds, Number(year), Number(month)) : [] });
    }

    const day = searchParams.get('day');
    if (!isValidDay(day)) return sendJson(res, 400, { error: DAY_ERROR });
    const recordings = cameras ? await recordingsOnDay(cameraIds, Number(year), Number(month), Number(day)) : {};
    // The playback address is only for the server, and it reveals where the NVR is.
    const list = Object.fromEntries(Object.entries(recordings).map(([id, clips]) => [id, clips.map(({ playbackUri, ...clip }) => clip)]));
    return sendJson(res, 200, { cameras: list });
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

attachVideoStreams(server, nvr);

server.listen(Number(PORT), HOST, () => {
  console.log(`Camera viewer running at http://${HOST}:${PORT}`);
});
