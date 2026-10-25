import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { getTrackByRatingKey } from '../plex/tracks.js';

const log = createLogger('web');

// Plex rating keys are digits (older Plex: numeric strings; some installs
// prefix a music-"library" prefix, still alphanumeric) -- the same
// reject-before-path.join discipline djPhotoProxy.js and showLogoProxy.js
// already apply to their params. Fastify decodes %2F in route params, so an
// unvalidated key here used to reach path.join as "../.." and let
// /api/art/..%2F..%2Ffoo read arbitrary *.jpg files outside the art cache.
const RATING_KEY_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function cachePath(ratingKey) {
  return path.join(config.paths.artCacheDir, `${ratingKey}.jpg`);
}

// Never expose the Plex token to the browser -- fetch art bytes server-side
// and disk-cache them (mirrors producer/research/wikipedia.js's
// wikipediaCacheDir pattern), keyed by ratingKey since art for a given track
// practically never changes.
export function registerArtRoute(fastify) {
  fastify.get('/api/art/:ratingKey', async (request, reply) => {
    const { ratingKey } = request.params;
    if (typeof ratingKey !== 'string' || !RATING_KEY_PATTERN.test(ratingKey)) {
      return reply.code(400).send();
    }
    const cached = cachePath(ratingKey);

    if (fs.existsSync(cached)) {
      reply.header('content-type', 'image/jpeg');
      return fs.createReadStream(cached);
    }

    let track;
    try {
      track = await getTrackByRatingKey(ratingKey);
    } catch (err) {
      log(`/api/art/${ratingKey}: Plex lookup failed: ${err.message}`);
      return reply.code(404).send();
    }
    if (!track.art) return reply.code(404).send();

    let bytes;
    let contentType;
    try {
      const res = await fetch(`${config.plex.baseUrl}${track.art}?X-Plex-Token=${config.plex.token}`);
      if (!res.ok) {
        log(`/api/art/${ratingKey}: Plex art fetch failed: ${res.status} ${res.statusText}`);
        return reply.code(502).send();
      }
      bytes = Buffer.from(await res.arrayBuffer());
      contentType = res.headers.get('content-type') ?? 'image/jpeg';
    } catch (err) {
      // A network-level rejection (DNS, ECONNREFUSED, connection cut
      // mid-body) used to escape as a raw 500 -- it is the same "Plex didn't
      // hand us art" failure the !res.ok branch above answers with 502.
      log(`/api/art/${ratingKey}: Plex art fetch failed: ${err.message}`);
      return reply.code(502).send();
    }

    fs.mkdirSync(config.paths.artCacheDir, { recursive: true });
    // Atomic tmp+rename (the write discipline requestsStore/pollsStore/
    // subscriptions.js already apply): a crash mid-write left a torn jpg
    // that existsSync above would then serve FOREVER -- unlike the state
    // files rewritten every tick (now_playing_track.json and friends, which
    // self-heal), this cache is write-once, so a torn write is permanent.
    // The pid suffix keeps concurrent art fetches from racing onto the same
    // temp name.
    const tmp = `${cached}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, cached);

    reply.header('content-type', contentType);
    return bytes;
  });
}
