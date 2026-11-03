import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { CREDENTIALS_MESSAGE } from './nvr.js';

// The page shows one camera at a time, and the NVR struggles with several streams.
// Two leaves room for a second tab or a reconnect while the old stream shuts down.
const MAX_STREAMS = 2;
const STALL_TIMEOUT_MS = 20_000;
const MAX_CLIENT_BACKLOG_BYTES = 32 * 1024 * 1024;

function ffmpegArgs(rtspUrl) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    // Start quickly. Avoid -fflags nobuffer, which made the video arrive in long bursts.
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-i', rtspUrl,
    '-map', '0:v:0',
    '-c', 'copy',
    '-f', 'mp4',
    // Short fragments keep the delay low without waiting for each keyframe.
    '-frag_duration', '250000',
    '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
    'pipe:1',
  ];
}

// Returns where the ftyp and moov boxes end, or null until all of moov has arrived.
function findInitSegmentEnd(buffer) {
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset);
    if (size < 8) return null;
    if (buffer.toString('latin1', offset + 4, offset + 8) === 'moov') {
      return offset + size <= buffer.length ? offset + size : null;
    }
    offset += size;
  }
  return null;
}

// Reads the profile and level the browser needs from the avcC box. Null if not H.264.
function readCodec(initSegment) {
  const avcC = initSegment.indexOf('avcC', 0, 'latin1');
  if (avcC === -1 || avcC + 8 > initSegment.length) return null;
  return `avc1.${initSegment.toString('hex', avcC + 5, avcC + 8)}`;
}

function isSameOrigin(req) {
  // Browsers don't apply same-origin rules to WebSockets, so without this any
  // website you visit could connect here and watch the cameras.
  const { origin } = req.headers;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function sendJson(socket, data) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(data));
}

function failStream(socket, message, { fatal = false } = {}) {
  sendJson(socket, { type: 'error', message, fatal });
  socket.close(fatal ? 1008 : 1011);
}

function streamCamera(socket, nvr, cameraId, activeStreams) {
  const ffmpeg = spawn('ffmpeg', ffmpegArgs(nvr.rtspUrl(cameraId)), {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  activeStreams.add(ffmpeg);

  let pendingInit = Buffer.alloc(0);
  let initSent = false;
  let stderr = '';
  let stallTimer;

  const resetStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => ffmpeg.kill(), STALL_TIMEOUT_MS);
  };
  resetStallTimer();

  ffmpeg.stdout.on('data', (chunk) => {
    resetStallTimer();
    if (socket.readyState !== socket.OPEN) return;

    if (initSent) {
      socket.send(chunk);
      // A viewer this far behind can't catch up, so let it reconnect at the live edge.
      if (socket.bufferedAmount > MAX_CLIENT_BACKLOG_BYTES) socket.close(1013);
      return;
    }

    pendingInit = Buffer.concat([pendingInit, chunk]);
    const initEnd = findInitSegmentEnd(pendingInit);
    if (initEnd === null) return;

    const codec = readCodec(pendingInit.subarray(0, initEnd));
    if (!codec) {
      ffmpeg.kill();
      return failStream(socket, 'Live view needs the camera set to H.264', { fatal: true });
    }
    initSent = true;
    sendJson(socket, { type: 'init', codec });
    socket.send(pendingInit);
    pendingInit = null;
  });

  ffmpeg.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });

  ffmpeg.on('error', (err) => {
    const message = err.code === 'ENOENT' ? 'FFmpeg is not installed on the server' : 'Could not start FFmpeg';
    console.error(`Camera ${cameraId}: ${message}: ${err.message}`);
    failStream(socket, message, { fatal: true });
  });

  ffmpeg.on('close', () => {
    clearTimeout(stallTimer);
    activeStreams.delete(ffmpeg);
    if (socket.readyState !== socket.OPEN) return;

    if (/401 Unauthorized/i.test(stderr)) {
      nvr.rejectCredentials();
      return failStream(socket, CREDENTIALS_MESSAGE, { fatal: true });
    }
    // FFmpeg can echo the RTSP address, which contains the password.
    if (stderr) console.error(`Camera ${cameraId}: ${stderr.replace(/\/\/[^\s/]*@/g, '//***@').trim()}`);
    failStream(socket, 'The video stream ended');
  });

  socket.on('close', () => ffmpeg.kill());
  socket.on('error', () => ffmpeg.kill());
}

export function attachLiveStreams(server, nvr) {
  const wss = new WebSocketServer({ noServer: true });
  const activeStreams = new Set();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const route = pathname.match(/^\/api\/cameras\/(\d+)\/live$/);

    if (!route || !isSameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      if (nvr.credentialsRejected()) return failStream(client, CREDENTIALS_MESSAGE, { fatal: true });
      if (activeStreams.size >= MAX_STREAMS) return failStream(client, 'Too many live streams are open');
      streamCamera(client, nvr, route[1], activeStreams);
    });
  });
}
