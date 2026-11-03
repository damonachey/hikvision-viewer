import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const REQUEST_TIMEOUT_MS = 15_000;
// NVRs handle few simultaneous snapshot requests well, so queue the rest.
const MAX_CONCURRENT_REQUESTS = 4;

const HASHES = { MD5: 'md5', 'SHA-256': 'sha256' };

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

export function createNvrClient({ url, user, password, allowSelfSigned = false, rtspPort = 554 }) {
  const base = new URL(url);
  const transport = base.protocol === 'https:' ? https : http;

  let running = 0;
  const waiting = [];
  // Hikvision locks accounts after repeated failed logins, so one rejected
  // password stops all further attempts until the app is restarted.
  let credentialsRejected = false;

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

  function send(path, authorization) {
    return new Promise((resolve, reject) => {
      const target = new URL(path, base);
      const req = transport.request(
        target,
        {
          method: 'GET',
          headers: authorization ? { Authorization: authorization } : {},
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
      req.end();
    });
  }

  async function authedGet(path) {
    if (credentialsRejected) throw new NvrError(CREDENTIALS_MESSAGE, 503);

    try {
      let res = await send(path);
      if (res.status === 401) {
        const challenge = parseChallenge(res.headers['www-authenticate']);
        if (!challenge) throw new NvrError('The NVR did not offer a supported digest login.');

        res = await send(path, digestHeader(challenge, { method: 'GET', uri: path, user, password }));
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

  return {
    credentialsRejected: () => credentialsRejected,
    rejectCredentials() {
      credentialsRejected = true;
    },

    rtspUrl(cameraId) {
      const login = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
      return `rtsp://${login}@${base.hostname}:${rtspPort}/Streaming/Channels/${cameraId}01`;
    },

    async listCameras() {
      // Sequential so a wrong password costs one failed login, not two.
      const channels = await withSlot(() => authedGet('/ISAPI/ContentMgmt/InputProxy/channels'));
      // Status only adds the online flag, so the list still works without it.
      const statuses = await withSlot(() => authedGet('/ISAPI/ContentMgmt/InputProxy/channels/status')).catch(() => null);

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

    async snapshot(cameraId) {
      // ISAPI stream ids are the channel followed by 01 for the main stream.
      const res = await withSlot(() => authedGet(`/ISAPI/Streaming/channels/${cameraId}01/picture`));
      const contentType = res.headers['content-type'] ?? '';
      if (!contentType.startsWith('image/')) {
        throw new NvrError(`The NVR did not return an image for camera ${cameraId}`);
      }
      return { contentType, body: res.body };
    },
  };
}
