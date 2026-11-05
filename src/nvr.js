import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const REQUEST_TIMEOUT_MS = 15_000;
// NVRs handle few simultaneous snapshot requests well, so queue the rest.
const MAX_CONCURRENT_REQUESTS = 4;

const HASHES = { MD5: 'md5', 'SHA-256': 'sha256' };
// The most a DS-7608N-E2/8P returns per search, from its maxSearchMatchResults.
const SEARCH_PAGE_SIZE = 64;
const SECONDS_PER_DAY = 24 * 60 * 60;

export const CREDENTIALS_MESSAGE = 'The NVR rejected the username or password. Fix .env and restart the app.';

export class NvrError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

function parseChallenge(header) {
  // Multiple WWW-Authenticate headers arrive joined with commas.
  const challenges = (header ?? '').split(/,\s*(?=(?:Digest|Basic)\s)/i);
  for (const challenge of challenges) {
    if (!/^Digest\s/i.test(challenge)) continue;
    const params = {};
    for (const [, key, quoted, bare] of challenge.matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) {
      params[key.toLowerCase()] = quoted ?? bare;
    }
    if (HASHES[(params.algorithm ?? 'MD5').toUpperCase()]) return params;
  }
  return null;
}

function digestHeader(challenge, { method, uri, user, password }) {
  const algorithm = (challenge.algorithm ?? 'MD5').toUpperCase();
  const hash = (value) => crypto.createHash(HASHES[algorithm]).update(value).digest('hex');

  const ha1 = hash(`${user}:${challenge.realm}:${password}`);
  const ha2 = hash(`${method}:${uri}`);
  const fields = {
    username: `"${user}"`,
    realm: `"${challenge.realm}"`,
    nonce: `"${challenge.nonce}"`,
    uri: `"${uri}"`,
    algorithm,
  };

  if (challenge.qop?.split(/[\s,]+/).includes('auth')) {
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    fields.qop = 'auth';
    fields.nc = nc;
    fields.cnonce = `"${cnonce}"`;
    fields.response = `"${hash(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`;
  } else {
    fields.response = `"${hash(`${ha1}:${challenge.nonce}:${ha2}`)}"`;
  }
  if (challenge.opaque) fields.opaque = `"${challenge.opaque}"`;

  const params = Object.entries(fields).map(([key, value]) => `${key}=${value}`);
  return `Digest ${params.join(', ')}`;
}

function xmlBlocks(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
}

function xmlValue(xml, tag) {
  const value = xmlBlocks(xml, tag)[0]?.trim();
  return value
    ?.replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

// Searches the cameras' main-stream recordings. One result is enough to show the time span has video.
function recordingSearch(cameraIds, startDay, endDay, { maxResults = 1, position = 0 } = {}) {
  const tracks = cameraIds.map((id) => `<trackID>${id}01</trackID>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${crypto.randomUUID()}</searchID>
  <trackList>${tracks}</trackList>
  <timeSpanList><timeSpan><startTime>${startDay}T00:00:00Z</startTime><endTime>${endDay}T23:59:59Z</endTime></timeSpan></timeSpanList>
  <maxResults>${maxResults}</maxResults>
  <searchResultPostion>${position}</searchResultPostion>
  <metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
}

export function createNvrClient({ url, user, password, allowSelfSigned = false, rtspPort = 554 }) {
  const base = new URL(url);
  const transport = base.protocol === 'https:' ? https : http;

  let running = 0;
  const waiting = [];
  // Hikvision locks accounts after repeated failed logins, so one rejected
  // password stops all further attempts until the app is restarted.
  let credentialsRejected = false;
  let lastSearch = Promise.resolve();

  async function withSlot(task) {
    if (running >= MAX_CONCURRENT_REQUESTS) {
      await new Promise((resolve) => waiting.push(resolve));
    } else {
      running++;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  }

  function send(method, path, body, authorization) {
    return new Promise((resolve, reject) => {
      const target = new URL(path, base);
      const headers = authorization ? { Authorization: authorization } : {};
      if (body) {
        headers['Content-Type'] = 'application/xml';
        headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = transport.request(
        target,
        {
          method,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
          rejectUnauthorized: !allowSelfSigned,
        },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () =>
            resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }

  async function authedRequest(path, body) {
    if (credentialsRejected) throw new NvrError(CREDENTIALS_MESSAGE, 503);

    const method = body ? 'POST' : 'GET';
    try {
      let res = await send(method, path, body);
      if (res.status === 401) {
        const challenge = parseChallenge(res.headers['www-authenticate']);
        if (!challenge) throw new NvrError('The NVR did not offer a supported digest login.');

        res = await send(method, path, body, digestHeader(challenge, { method, uri: path, user, password }));
        if (res.status === 401) {
          credentialsRejected = true;
          throw new NvrError(CREDENTIALS_MESSAGE, 503);
        }
      }
      if (res.status !== 200) throw new NvrError(`The NVR returned HTTP ${res.status} for ${path}`);
      return res;
    } catch (err) {
      if (err instanceof NvrError) throw err;
      throw new NvrError(`Could not reach the NVR at ${base.origin}: ${err.message}`);
    }
  }

  // Starts downloading a recording. The answer is streamed, because a file can be over 1 GB
  // and the caller may only want the start of it.
  async function openDownload(playbackUri) {
    if (credentialsRejected) throw new NvrError(CREDENTIALS_MESSAGE, 503);
    const path = '/ISAPI/ContentMgmt/download';
    const uri = playbackUri.replaceAll('&', '&amp;');
    const body = `<?xml version="1.0" encoding="UTF-8"?><downloadRequest version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema"><playbackURI>${uri}</playbackURI></downloadRequest>`;

    const request = (authorization) => new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(body) };
      if (authorization) headers.Authorization = authorization;
      const req = transport.request(new URL(path, base), { method: 'GET', headers, timeout: REQUEST_TIMEOUT_MS, rejectUnauthorized: !allowSelfSigned }, (res) => resolve({ req, res }));
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      req.end(body);
    });

    let { req, res } = await request();
    if (res.statusCode === 401) {
      res.resume();
      const challenge = parseChallenge(res.headers['www-authenticate']);
      if (!challenge) throw new NvrError('The NVR did not offer a supported digest login.');
      ({ req, res } = await request(digestHeader(challenge, { method: 'GET', uri: path, user, password })));
      if (res.statusCode === 401) {
        res.resume();
        credentialsRejected = true;
        throw new NvrError(CREDENTIALS_MESSAGE, 503);
      }
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new NvrError(`The NVR returned HTTP ${res.statusCode} for a download`);
    }
    return { stream: res, abort: () => req.destroy() };
  }

  // The NVR reports maxConcurrentSearches of 1, so searches wait for each other.
  function searchInTurn(path, body) {
    const search = lastSearch.then(async () => (await withSlot(() => authedRequest(path, body))).body.toString());
    lastSearch = search.catch(() => {});
    return search;
  }

  async function hasRecordings(cameraIds, startDay, endDay) {
    const xml = await searchInTurn('/ISAPI/ContentMgmt/search', recordingSearch(cameraIds, startDay, endDay));
    return Number(xmlValue(xml, 'numOfMatches')) > 0;
  }

  return {
    credentialsRejected: () => credentialsRejected,
    openDownload,
    rejectCredentials() {
      credentialsRejected = true;
    },

    rtspUrl(cameraId, streamSuffix) {
      const login = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      return `rtsp://${login}@${base.hostname}:${rtspPort}/Streaming/Channels/${cameraId}${streamSuffix}`;
    },

    // Plays from the start time to the end of that day. A slash before the query, as in the
    // address the search returns, makes the NVR answer FFmpeg's SETUP with a 401.
    recordingUrl(cameraId, day, time) {
      const login = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      return `rtsp://${login}@${base.hostname}:${rtspPort}/Streaming/tracks/${cameraId}01?starttime=${day}T${time}Z&endtime=${day}T235959Z`;
    },

    async listCameras() {
      // Sequential so a wrong password costs one failed login, not two.
      const channels = await withSlot(() => authedRequest('/ISAPI/ContentMgmt/InputProxy/channels'));
      // Status only adds the online flag, so the list still works without it.
      const statuses = await withSlot(() => authedRequest('/ISAPI/ContentMgmt/InputProxy/channels/status')).catch(() => null);

      const online = new Map();
      if (statuses) {
        for (const block of xmlBlocks(statuses.body.toString(), 'InputProxyChannelStatus')) {
          online.set(xmlValue(block, 'id'), xmlValue(block, 'online') === 'true');
        }
      }

      return xmlBlocks(channels.body.toString(), 'InputProxyChannel').map((block) => {
        const id = xmlValue(block, 'id');
        return { id, name: xmlValue(block, 'name') || `Camera ${id}`, online: online.get(id) ?? null };
      });
    },

    async snapshot(cameraId, { full = false } = {}) {
      // ISAPI stream ids are the channel followed by 01 for the main stream.
      const stream = `/ISAPI/Streaming/channels/${cameraId}01`;
      let query = '';
      if (full) {
        // Without a size the NVR sends 704x576. It may still send less than the size
        // requested: a DS-7608N-E2/8P returns 1920x1080 for a 2560x1440 camera.
        const settings = (await withSlot(() => authedRequest(stream))).body.toString();
        query = `?videoResolutionWidth=${xmlValue(settings, 'videoResolutionWidth')}&videoResolutionHeight=${xmlValue(settings, 'videoResolutionHeight')}`;
      }
      const res = await withSlot(() => authedRequest(`${stream}/picture${query}`));
      const contentType = res.headers['content-type'] ?? '';
      if (!contentType.startsWith('image/')) {
        throw new NvrError(`The NVR did not return an image for camera ${cameraId}`);
      }
      return { contentType, body: res.body };
    },

    yearHasRecordings(cameraIds, year) {
      return hasRecordings(cameraIds, `${year}-01-01`, `${year}-12-31`);
    },

    monthHasRecordings(cameraIds, year, month) {
      const monthText = String(month).padStart(2, '0');
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return hasRecordings(cameraIds, `${year}-${monthText}-01`, `${year}-${monthText}-${lastDay}`);
    },

    // Start and end are seconds since the day's midnight. The NVR marks its times as UTC
    // but they're local, so they're compared with a midnight marked the same way.
    async recordingsOnDay(cameraId, day) {
      const midnight = Date.parse(`${day}T00:00:00Z`);
      const secondsIntoDay = (time) => Math.min(Math.max((Date.parse(time) - midnight) / 1000, 0), SECONDS_PER_DAY);
      const recordings = [];
      while (true) {
        const xml = await searchInTurn(
          '/ISAPI/ContentMgmt/search',
          recordingSearch([cameraId], day, day, { maxResults: SEARCH_PAGE_SIZE, position: recordings.length }),
        );
        const items = xmlBlocks(xml, 'searchMatchItem');
        for (const item of items) {
          recordings.push({
            start: secondsIntoDay(xmlValue(item, 'startTime')),
            end: secondsIntoDay(xmlValue(item, 'endTime')),
            type: xmlValue(item, 'metadataDescriptor')?.split('/').pop() ?? 'unknown',
            playbackUri: xmlValue(item, 'playbackURI'),
          });
        }
        if (!items.length || xmlValue(xml, 'responseStatusStrg') !== 'MORE') return recordings;
      }
    },

    // Answers for one camera at a time, because this request takes a single track.
    async daysWithRecordings(cameraId, year, month) {
      const xml = await searchInTurn(
        `/ISAPI/ContentMgmt/record/tracks/${cameraId}01/dailyDistribution`,
        `<?xml version="1.0" encoding="utf-8"?><trackDailyParam><year>${year}</year><monthOfYear>${month}</monthOfYear></trackDailyParam>`,
      );
      return xmlBlocks(xml, 'day')
        .filter((day) => xmlValue(day, 'record') === 'true')
        .map((day) => Number(xmlValue(day, 'dayOfMonth')));
    },
  };
}
