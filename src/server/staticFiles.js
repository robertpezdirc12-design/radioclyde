import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', '..', 'public');

const ASSETS = [
  { route: '/', file: 'index.html', contentType: 'text/html' },
  { route: '/app.js', file: 'app.js', contentType: 'application/javascript' },
  { route: '/style.css', file: 'style.css', contentType: 'text/css' },
  // Drop a station logo at public/logo.png to have it appear in the page
  // header -- optional, the page hides it gracefully if the file's missing.
  { route: '/logo.png', file: 'logo.png', contentType: 'image/png' },
  { route: '/favicon.svg', file: 'favicon.svg', contentType: 'image/svg+xml' },
  // PWA surface (docs/p1-listener-experience.md): installable app, cached
  // by public/sw.js (shell only -- the stream and APIs are never cached).
  // embed.html is the self-contained player for iframes; it is auth-gated
  // like everything else until the owner lists paths in
  // config.web.publicPaths (see auth.js).
  { route: '/manifest.webmanifest', file: 'manifest.webmanifest', contentType: 'application/manifest+json' },
  { route: '/sw.js', file: 'sw.js', contentType: 'text/javascript' },
  { route: '/embed.html', file: 'embed.html', contentType: 'text/html' },
];

// Station-wide default listener theme (config.themes.default). The listener
// shell falls back to it when a visitor has no saved choice; a saved choice
// always wins (the pre-paint script in public/index.html owns that
// precedence). Keep the id list in step with the [data-theme] blocks in
// style.css and THEMES in public/app.js -- test/stationTheme.test.mjs pins
// all three against each other.
const STATION_THEME_IDS = ['klasika', 'jutro', 'vinil', 'terminal'];
// First-paint browser-chrome color per theme -- the <meta name="theme-color">
// value the shell ships with and app.js keeps in sync after boot; the bg
// pairing is documented next to THEMES in public/app.js.
const THEME_BG = { klasika: '#0a0c12', jutro: '#f7f3ec', vinil: '#17120e', terminal: '#060a07' };

// Read per REQUEST (not memoized at load) so tests can flip liveConfig.themes
// between cases -- the same call-time-read discipline telnetClient uses for
// its host/port. Missing block = klasika (optional-config guard, the F2
// lesson: a missing block must never break the server). An INVALID value
// warns once per process, honestly, and degrades to klasika.
let warnedInvalidTheme = false;
function stationTheme() {
  const wanted = config.themes?.default;
  if (wanted === undefined) return 'klasika';
  if (STATION_THEME_IDS.includes(wanted)) return wanted;
  if (!warnedInvalidTheme) {
    warnedInvalidTheme = true;
    console.warn(
      `themes.default ${JSON.stringify(wanted)} ni veljavna tema (${STATION_THEME_IDS.join(', ')}) -- obiskovalci brez shranjene izbire bodo videli Klasiko.`
    );
  }
  return 'klasika';
}

// Four explicit routes, not a wildcard/@fastify/static setup -- the asset
// set is small and fixed, so no path-traversal handling is ever needed and
// the project's dependency footprint stays at just fastify itself.
export function registerStaticRoutes(fastify) {
  for (const { route, file, contentType } of ASSETS) {
    fastify.get(route, (request, reply) => {
      let body;
      try {
        // No encoding -- returns a Buffer, correct for both text assets and
        // binary ones (logo.png); reading as 'utf8' would corrupt an image.
        body = fs.readFileSync(path.join(publicDir, file));
      } catch {
        return reply.code(404).send();
      }
      // Station theme stamp: rewrite ONLY the listener shell. The file itself
      // ships klasika on both tokens, so it stays correct standalone; the
      // tokens are pinned byte-exactly by test/stationTheme.test.mjs, and a
      // failed replace would degrade to klasika (the pre-paint script
      // validates the attribute) rather than break the page.
      if (file === 'index.html') {
        const theme = stationTheme();
        if (theme !== 'klasika') {
          body = Buffer.from(
            body
              .toString('utf8')
              .replace('data-station-default="klasika"', `data-station-default="${theme}"`)
              .replace('<meta name="theme-color" content="#0a0c12">', `<meta name="theme-color" content="${THEME_BG[theme]}">`)
          );
        }
      }
      reply.header('content-type', contentType);
      // No cache-control/etag/last-modified are sent otherwise, which
      // leaves browsers free to cache these heuristically -- app.js in
      // particular is a live <script>, and a cached stale copy silently
      // keeps running old logic against the current server/API forever
      // (only a hard-refresh would ever notice). These assets are tiny and
      // served to a handful of personal devices, so there's no real cost
      // to always fetching fresh.
      reply.header('cache-control', 'no-store');
      return body;
    });
  }
}
