import { config } from '../config/index.js';
import { isTrustedIp } from '../lib/ipRange.js';

// Single onRequest hook, registered before any routes in index.js, so it
// gates the page, the API, and /stream uniformly -- no per-route auth code
// anywhere else in src/server/. WWW-Authenticate on every 401 is what makes
// the browser's native credential prompt fire (and then cache/reuse
// credentials automatically) for the page, fetch() calls, and the <audio>
// element alike.
//
// request.ip (not request.socket.remoteAddress) is what respects index.js's
// trustProxy: 'loopback' setting -- today that's a no-op (nothing proxies
// through loopback yet), but once the planned Cloudflare Tunnel lands,
// cloudflared connects to Fastify over loopback and this is what lets
// request.ip keep resolving to the real remote client instead of always
// reading as local.
// Public-path exemption -- the one config lever that decides what (if
// anything) is reachable WITHOUT Basic Auth. Default: empty, i.e. the
// station stays fully private and this hook behaves exactly as before.
//
// Why it exists: an <iframe> cannot carry the owner's Basic Auth
// credentials to a visitor, so an embeddable player, an anonymous car/
// smart-speaker stream URL, or a public /listen.m3u are all impossible
// without letting SOME paths through. config.web.publicPaths is an array
// of path prefixes matched literally against request.url (e.g.
// ["/embed", "/embed.js", "/stream", "/api/now-playing", "/listen.m3u"]).
// Prefix matching is deliberate: /embed also covers /embed's future query
// strings; anything NOT listed still hits the credential check unchanged.
// Stream paths here are read-only broadcast -- studio/* and the write APIs
// must never appear in this list, and the embed page exposes nothing else.
export function publicPathsConfigured() {
  const paths = config.web.publicPaths;
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.startsWith('/')) : [];
}

function isPublicPath(url) {
  const path = (url ?? '').split('?')[0] || '/';
  return publicPathsConfigured().some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

export function registerAuthHook(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (isTrustedIp(request.ip, config.web.trustedNetworks)) return;
    if (isPublicPath(request.raw.url)) return;

    const header = request.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      return unauthorized(reply);
    }

    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    if (sepIndex === -1) return unauthorized(reply);

    const username = decoded.slice(0, sepIndex);
    const password = decoded.slice(sepIndex + 1);
    const authorized = (config.web.listeners ?? []).some(
      (l) => l.username === username && l.password === password
    );
    if (!authorized) return unauthorized(reply);
  });
}

function unauthorized(reply) {
  reply.header('WWW-Authenticate', 'Basic realm="radioclyde"').code(401).send('Unauthorized');
}
