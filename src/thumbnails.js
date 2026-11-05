import { spawn } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// A file's first frame arrives early, so this only guards against a bad file.
const MAX_BYTES = 16 * 1024 * 1024;
const GRAB_TIMEOUT_MS = 30_000;
// A clip starting sooner than this after the last one with a thumbnail doesn't get its own.
const MIN_SECONDS_BETWEEN = 5 * 60;
// Stop instead of repeating a failure hundreds of times.
const MAX_FAILURES_IN_A_ROW = 5;
const WIDTH = 480;
const HEIGHT = 270;

function pad(number) {
  return String(number).padStart(2, '0');
}

function clipName(start) {
  const seconds = Math.floor(start);
  return `${pad(Math.floor(seconds / 3600))}${pad(Math.floor(seconds / 60) % 60)}${pad(seconds % 60)}`;
}

function clipsNeedingThumbnails(clips) {
  let lastKept = -Infinity;
  return clips.filter(({ start }) => {
    if (start - lastKept < MIN_SECONDS_BETWEEN) return false;
    lastKept = start;
    return true;
  });
}

// The first and last items, then the middle, then the middle of each half, and so on, so
// the whole range is covered roughly and then gets steadily finer.
function bisectionOrder(items) {
  if (items.length <= 2) return [...items];
  const order = [items[0], items.at(-1)];
  const ranges = [[0, items.length - 1]];
  for (const [low, high] of ranges) {
    if (high - low < 2) continue;
    const middle = Math.floor((low + high) / 2);
    order.push(items[middle]);
    ranges.push([low, middle], [middle, high]);
  }
  return order;
}

// Saves a clip's first frame from its download, then hangs up on the rest of the file.
async function saveFirstFrame(nvr, playbackUri, file) {
  const download = await nvr.openDownload(playbackUri);
  return new Promise((resolve) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'mpeg',
      '-i', 'pipe:0',
      '-map', '0:v:0',
      '-frames:v', '1',
      '-vf', `scale=${WIDTH}:${HEIGHT}`,
      '-q:v', '5',
      '-f', 'image2',
      file,
    ], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let bytes = 0;
    const timer = setTimeout(() => ffmpeg.kill(), GRAB_TIMEOUT_MS);

    ffmpeg.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-1000);
    });
    // Both of these are expected once FFmpeg has its frame and stops reading.
    ffmpeg.stdin.on('error', () => {});
    download.stream.on('error', () => {});
    download.stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) ffmpeg.stdin.end();
    });
    download.stream.pipe(ffmpeg.stdin);

    ffmpeg.on('error', (err) => {
      clearTimeout(timer);
      download.abort();
      resolve({ ok: false, error: err.message, bytes });
    });
    ffmpeg.on('close', (code) => {
      clearTimeout(timer);
      download.abort();
      resolve({ ok: code === 0, error: stderr.trim(), bytes });
    });
  });
}

// Saves a thumbnail from the start of every clip of the day being viewed.
export function createThumbnailBuilder({ nvr, directory, listCameras, listRecordings }) {
  const dayFolder = (cameraId, date) => path.join(directory, cameraId, date);
  let job = null;
  let lastJob = Promise.resolve();

  async function buildOne(cameraId, date, clip) {
    const file = path.join(dayFolder(cameraId, date), `${clipName(clip.start)}.jpg`);
    const exists = await stat(file).then(() => true, () => false);
    if (exists) return true;

    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    const { ok, error } = await saveFirstFrame(nvr, clip.playbackUri, temporary);
    if (ok) {
      await rename(temporary, file);
      return true;
    }
    await rm(temporary, { force: true });
    console.error(`Thumbnail for camera ${cameraId} at ${date} ${clipName(clip.start)}: ${error}`);
    return false;
  }

  async function runJob(current, year, month, day) {
    const cameras = await listCameras();
    const recordings = await listRecordings(cameras.map(({ id }) => id), year, month, day);
    const orders = cameras.map(({ id }) => bisectionOrder(clipsNeedingThumbnails(recordings[id] ?? [])).map((clip) => ({ cameraId: id, clip })));
    // Takes turns between cameras, so each one fills in at the same pace.
    const work = [];
    const longest = Math.max(0, ...orders.map((order) => order.length));
    for (let i = 0; i < longest; i++) {
      for (const order of orders) {
        if (order[i]) work.push(order[i]);
      }
    }
    current.total = work.length;

    let failuresInARow = 0;
    for (const { cameraId, clip } of work) {
      if (current.cancelled) return;
      const ok = await buildOne(cameraId, current.date, clip).catch((err) => {
        console.error(`Thumbnail for camera ${cameraId} at ${current.date} ${clipName(clip.start)}: ${err.message}`);
        return false;
      });
      current.done++;
      if (!ok) current.failed++;
      failuresInARow = ok ? 0 : failuresInARow + 1;
      if (failuresInARow >= MAX_FAILURES_IN_A_ROW) throw new Error('Stopped making thumbnails after repeated failures');
    }
  }

  function status() {
    if (!job) return { running: false };
    const { date, done, total, failed, running, error } = job;
    return { running, date, done, total, failed, error };
  }

  return {
    status,

    // Builds a day's missing thumbnails, in place of any other day still being built.
    start(year, month, day) {
      const date = `${year}-${pad(month)}-${pad(day)}`;
      if (job?.running && job.date === date) return status();
      if (job) job.cancelled = true;
      const current = { date, done: 0, total: 0, failed: 0, running: true, cancelled: false, error: null };
      job = current;
      lastJob = lastJob
        .then(() => (current.cancelled ? null : runJob(current, year, month, day)))
        .catch((err) => {
          console.error(`Thumbnails for ${date}: ${err.message}`);
          current.error = err.message;
        })
        .finally(() => {
          current.running = false;
        });
      return status();
    },

    // Stops any build, because it could otherwise write new files during the delete.
    async clear() {
      if (job) job.cancelled = true;
      await lastJob;
      job = null;
      await rm(directory, { recursive: true, force: true });
    },

    // How many thumbnails each day has, and their size in bytes.
    async info() {
      const days = new Map();
      for (const cameraId of await readdir(directory).catch(() => [])) {
        for (const date of await readdir(path.join(directory, cameraId)).catch(() => [])) {
          const day = days.get(date) ?? { date, files: 0, bytes: 0 };
          days.set(date, day);
          for (const name of await readdir(dayFolder(cameraId, date)).catch(() => [])) {
            if (!name.endsWith('.jpg')) continue;
            const file = await stat(path.join(dayFolder(cameraId, date), name)).catch(() => null);
            if (!file) continue;
            day.files++;
            day.bytes += file.size;
          }
        }
      }
      return [...days.values()].filter(({ files }) => files > 0).sort((a, b) => a.date.localeCompare(b.date));
    },

    // The start times with a thumbnail for each camera, in seconds since midnight.
    async list(cameraIds, date) {
      const cameras = {};
      for (const cameraId of cameraIds) {
        const names = await readdir(dayFolder(cameraId, date)).catch(() => []);
        cameras[cameraId] = names
          .filter((name) => /^\d{6}\.jpg$/.test(name))
          .map((name) => Number(name.slice(0, 2)) * 3600 + Number(name.slice(2, 4)) * 60 + Number(name.slice(4, 6)))
          .sort((a, b) => a - b);
      }
      return cameras;
    },

    filePath: (cameraId, date, name) => path.join(dayFolder(cameraId, date), `${name}.jpg`),
  };
}
