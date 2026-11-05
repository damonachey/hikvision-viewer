import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { CREDENTIALS_MESSAGE } from './nvr.js';

const STREAM_SUFFIXES = { main: '01', sub: '02' };
// Enough for all 8 channels twice, which leaves room for a second tab or for
// reconnects while the old streams shut down.
const MAX_STREAMS = 16;
const STALL_TIMEOUT_MS = 20_000;
const MAX_CLIENT_BACKLOG_BYTES = 32 * 1024 * 1024;
// A viewer that sleeps or loses its network never closes its socket, and FFmpeg
// would keep pulling from the NVR, so one missed answer ends the stream.
const PING_INTERVAL_MS = 15_000;
const SECONDS_PER_DAY = 86_400;

const OUTPUT_ARGS = [
  '-c', 'copy',
  '-f', 'mp4',
  // Short fragments keep the delay low without waiting for each keyframe.
  '-frag_duration', '250000',
  '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
  'pipe:1',
];

function ffmpegArgs(rtspUrl) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    // Over TCP a DS-7608N-E2/8P sent about 1 Mbit/s and lost frames. UDP gave the full stream.
    '-rtsp_transport', 'udp',
    // Start quickly. Avoid -fflags nobuffer, which made the video arrive in long bursts.
    '-probesize', '1000000',
    '-analyzeduration', '1000000',
    '-i', rtspUrl,
    '-map', '0:v:0',
    ...OUTPUT_ARGS,
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

function streamCamera(socket, nvr, cameraId, rtspUrl, activeStreams) {
  const ffmpeg = spawn('ffmpeg', ffmpegArgs(rtspUrl), {
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

  let answeredPing = true;
  socket.on('pong', () => {
    answeredPing = true;
  });
  const pingTimer = setInterval(() => {
    if (!answeredPing) return socket.terminate();
    answeredPing = false;
    socket.ping();
  }, PING_INTERVAL_MS);

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
      return failStream(socket, 'Video needs the camera set to H.264', { fatal: true });
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

  socket.on('close', () => {
    clearInterval(pingTimer);
    ffmpeg.kill();
  });
  socket.on('error', () => ffmpeg.kill());
}

// Sends a downloaded recording as video the browser can play, at the speed the browser reads
// it. A download can't start partway through, so FFmpeg reads past the skipped seconds.
export async function sendRecordingFile(res, nvr, playbackUri, skipSeconds) {
  const download = await nvr.openDownload(playbackUri);
  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'mpeg',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-ss', String(skipSeconds),
    ...OUTPUT_ARGS,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

  let pendingInit = Buffer.alloc(0);
  let stderr = '';
  const fail = (status, message) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  };

  // Expected once the viewer hangs up.
  ffmpeg.stdin.on('error', () => {});
  // A lost download wouldn't end FFmpeg's input, so hang up rather than wait forever. That
  // also shows a saved file as failed, instead of as a complete one that's cut short.
  download.stream.on('error', () => res.destroy());
  download.stream.pipe(ffmpeg.stdin);

  const readInit = (chunk) => {
    pendingInit = Buffer.concat([pendingInit, chunk]);
    const initEnd = findInitSegmentEnd(pendingInit);
    if (initEnd === null) return;

    ffmpeg.stdout.off('data', readInit);
    const codec = readCodec(pendingInit.subarray(0, initEnd));
    if (!codec) {
      ffmpeg.kill();
      return fail(415, 'Video needs the camera set to H.264');
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'X-Video-Codec': codec });
    res.write(pendingInit);
    ffmpeg.stdout.pipe(res);
  };
  ffmpeg.stdout.on('data', readInit);

  ffmpeg.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  ffmpeg.on('error', (err) => {
    download.abort();
    fail(500, err.code === 'ENOENT' ? 'FFmpeg is not installed on the server' : 'Could not start FFmpeg');
  });
  ffmpeg.on('close', () => {
    download.abort();
    if (res.headersSent) return;
    if (stderr) console.error(`Recording file: ${stderr.trim()}`);
    fail(404, 'This part of the recording has no video');
  });
  res.on('close', () => {
    download.abort();
    ffmpeg.kill();
  });
}

// Saves a stretch of time as one file, feeding each clip's download into FFmpeg in turn. The
// first FFmpeg cuts by the video's own clock, which includes the time between clips, so the
// range ends when it should. The second then closes up those gaps.
export function sendRecordingRange(res, nvr, clips, skipSeconds, seconds) {
  const spawnFfmpeg = (args) => spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe', windowsHide: true });
  const cutter = spawnFfmpeg([
    // Without this, FFmpeg closes the gaps itself and the cut lands in the wrong place.
    '-dts_delta_threshold', String(SECONDS_PER_DAY),
    '-f', 'mpeg',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-ss', String(skipSeconds),
    '-t', String(seconds),
    '-c', 'copy',
    '-f', 'mpegts',
    'pipe:1',
  ]);
  const joiner = spawnFfmpeg([
    '-f', 'mpegts',
    '-i', 'pipe:0',
    '-c', 'copy',
    '-f', 'mp4',
    '-movflags', 'empty_moov+default_base_moof+frag_keyframe',
    'pipe:1',
  ]);
  let download;
  let finished = false;
  let stderr = '';

  const stop = () => {
    finished = true;
    download?.abort();
    cutter.kill();
    joiner.kill();
  };
  // A lost download shows as a failed save, instead of as a complete file that's cut short.
  const fail = (status, message) => {
    stop();
    if (res.headersSent) return res.destroy();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  };

  // Once the cutter has all it needs, the rest of the clips aren't wanted.
  let cutterClosed = false;
  const cutterDone = new Promise((resolve) => {
    cutter.once('close', () => {
      cutterClosed = true;
      resolve();
    });
  });

  async function feedClips() {
    for (const clip of clips) {
      if (finished || cutterClosed) return;
      download = await nvr.openDownload(clip.playbackUri);
      const sent = new Promise((resolve, reject) => {
        download.stream.on('error', reject);
        download.stream.on('end', resolve);
      });
      download.stream.pipe(cutter.stdin, { end: false });
      await Promise.race([sent, cutterDone]);
    }
    cutter.stdin.end();
  }

  for (const ffmpeg of [cutter, joiner]) {
    // Expected once FFmpeg has all it needs, or the viewer hangs up.
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    ffmpeg.on('error', () => fail(500, 'FFmpeg is not installed on the server'));
  }
  cutter.stdout.pipe(joiner.stdin);
  cutter.on('close', () => download?.abort());
  joiner.stdout.once('data', (chunk) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment' });
    res.write(chunk);
    joiner.stdout.pipe(res);
  });
  joiner.on('close', () => {
    if (res.headersSent || finished) return;
    if (stderr) console.error(`Recording range: ${stderr.trim()}`);
    fail(404, 'That range has no video');
  });
  res.on('close', stop);
  feedClips().catch((err) => {
    if (finished || cutterClosed) return;
    console.error(`Recording range: ${err.message}`);
    fail(502, 'The NVR stopped sending the recording');
  });
}

export function attachVideoStreams(server, nvr) {
  const wss = new WebSocketServer({ noServer: true });
  const activeStreams = new Set();

  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const route = pathname.match(/^\/api\/cameras\/(\d+)\/(live|recording)$/);
    let rtspUrl;
    if (route?.[2] === 'live') {
      const streamSuffix = STREAM_SUFFIXES[searchParams.get('stream')];
      if (streamSuffix) rtspUrl = nvr.rtspUrl(route[1], streamSuffix);
    } else if (route) {
      const start = searchParams.get('start')?.match(/^(\d{8})T(\d{6})$/);
      if (start) rtspUrl = nvr.recordingUrl(route[1], start[1], start[2]);
    }

    if (!rtspUrl || !isSameOrigin(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => {
      if (nvr.credentialsRejected()) return failStream(client, CREDENTIALS_MESSAGE, { fatal: true });
      if (activeStreams.size >= MAX_STREAMS) return failStream(client, 'Too many video streams are open');
      streamCamera(client, nvr, route[1], rtspUrl, activeStreams);
    });
  });
}
