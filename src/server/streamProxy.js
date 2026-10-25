import http from 'node:http';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { opusEnabled, flacEnabled, mountBaseOf } from '../liquidsoap/streamsLiqWriter.js';

const log = createLogger('web');

// One pass-through proxy route: whatever comes in on the public port is
// forwarded verbatim to the same mount on Icecast's internal-only port. The
// implementation is unchanged from the original /stream route -- headers
// passed through untouched, no content-type forcing, no transcoding; only
// the route path and upstream mount are parameters so the optional sibling
// mounts reuse it.
//
// The auth hook runs before these routes (registered first in index.js), so
// an unauthenticated request never reaches here and never opens an upstream
// Icecast connection.
export function addStreamProxyRoute(fastify, routePath, upstreamMount) {
  fastify.get(routePath, (request, reply) => {
    // No Icy-MetaData request header -- browsers/<audio> elements don't send
    // one, and forwarding it would make Icecast interleave binary ICY
    // metadata frames into the byte stream, corrupting playback.
    const upstreamReq = http.request({
      host: config.icecast.sourceHost,
      port: config.icecast.port,
      path: upstreamMount,
      method: 'GET',
    });

    upstreamReq.on('response', (upstreamRes) => {
      reply.code(upstreamRes.statusCode);
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        reply.header(key, value);
      }
      reply.send(upstreamRes);
    });

    upstreamReq.on('error', (err) => {
      log(`${routePath} proxy: upstream Icecast connection failed: ${err.message}`);
      if (!reply.sent) reply.code(502).send('Stream unavailable');
    });

    // Listener disconnected -- stop pulling bytes from Icecast rather than
    // leaking a permanent upstream connection for an abandoned response.
    request.raw.on('close', () => upstreamReq.destroy());

    upstreamReq.end();
  });
}

export function registerStreamRoute(fastify) {
  // Primary mount: /stream on the public port proxies straight through to
  // config.icecast.mount on Icecast's internal port -- exactly the route
  // that has been there since the Icecast-port takeover, unchanged.
  addStreamProxyRoute(fastify, '/stream', config.icecast.mount);

  // Optional sibling mounts (SUB/WAVE's /stream.opus // /stream.flac),
  // registered ONLY when the matching block is enabled in config.json --
  // a disabled mount must 404 (route absent), not 502 (route present but
  // upstream dead). Route path and upstream mount both derive from the
  // mount base + suffix, which equals the literal /stream.opus and
  // /stream.flac for every shipped mount shape ("/stream" or "/stream.mp3"),
  // and keeps the published URL (streamUrls.js derives from the same base)
  // in agreement with the route for exotic mounts too.
  const base = mountBaseOf(config.icecast.mount);
  if (opusEnabled(config)) addStreamProxyRoute(fastify, `${base}.opus`, `${base}.opus`);
  if (flacEnabled(config)) addStreamProxyRoute(fastify, `${base}.flac`, `${base}.flac`);
}
