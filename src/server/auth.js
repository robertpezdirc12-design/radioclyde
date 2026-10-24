import { config } from '../config/index.js';
import { isTrustedIp } from '../lib/ipRange.js';
import { credentialEqual } from '../lib/credentialEqual.js';

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
// Public paths are read-only broadcast -- studio/* and the write APIs must
// never appear in this list, and the hook below ENFORCES that half of the
// contract: only GET/HEAD may ride a public path anonymously. A too-broad
// prefix like "/api" therefore exposes reads but never POST /api/requests
// or the polls write endpoints -- the method gate turns a config mistake
// into a smaller mistake instead of an anonymous write surface.
//
// The ONE deliberate exception: config.web.publicWritePaths, a SEPARATE
// list for the narrow class of endpoints that are safe for anonymous
// writes because they only touch an opt-in, per-device record and are
// rate-limited/capped at the route (today: push subscribe/unsubscribe --
// a public station's listeners have no credentials, yet the browser must
// be able to register its push subscription). Listing "/api/push" HERE
// would not help anyway: the method gate above would still block POSTs,
// which is exactly the point of keeping the two levers apart.
export function publicPathsConfigured() {
  const paths = config.web.publicPaths;
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.startsWith('/')) : [];
}

export function publicWritePathsConfigured() {
  const paths = config.web.publicWritePaths;
  return Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p.startsWith('/')) : [];
}

function matchesPathList(list, url) {
  const path = (url ?? '').split('?')[0] || '/';
  return list.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : `${p}/`));
}

function isPublicPath(url) {
  return matchesPathList(publicPathsConfigured(), url);
}

function isPublicWritePath(url) {
  return matchesPathList(publicWritePathsConfigured(), url);
}

export function registerAuthHook(fastify) {
  fastify.addHook('onRequest', async (request, reply) => {
    if (isTrustedIp(request.ip, config.web.trustedNetworks)) return;
    const readOnly = request.method === 'GET' || request.method === 'HEAD';
    if (readOnly && isPublicPath(request.raw.url)) return;
    if (!readOnly && isPublicWritePath(request.raw.url)) return; // narrow, explicit anonymous-write allowlist

    const header = request.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      return unauthorized(reply);
    }

    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const sepIndex = decoded.indexOf(':');
    if (sepIndex === -1) return unauthorized(reply);

    const username = decoded.slice(0, sepIndex);
    const password = decoded.slice(sepIndex + 1);
    // credentialEqual: constant-time compare, so a caller can't time-resonate
    // the password byte by byte (plain === short-circuits on the first diff).
    const authorized = (config.web.listeners ?? []).some(
      (l) => credentialEqual(l.username, username) && credentialEqual(l.password, password)
    );
    if (!authorized) return unauthorized(reply);
  });
}

function unauthorized(reply) {
  reply.header('WWW-Authenticate', 'Basic realm="radioclyde"').code(401).send('Unauthorized');
}
