// /api/art/:ratingKey (server/artProxy.js) against a fake Plex on loopback:
// the 502-on-fetch-rejection path and the atomic art-cache write. The fake
// server answers real HTTP so plexGet/getTrackByRatingKey run for real; the
// "badnet" track's art path makes the composed URL invalid, so the art fetch
// itself REJECTS (the DNS/ECONNREFUSED class) instead of answering -- the
// exact case the new try/catch must turn into 502, not a raw 500.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), // SOI + APP0 marker bytes are enough -- nobody parses the cache
  Buffer.from('not really a jpeg, but bytes are bytes'),
]);

let artHits = 0;
const server = http.createServer((req, res) => {
  // Connection: close keeps undici from parking a keep-alive socket that
  // would hold the test process open after the last assertion.
  res.setHeader('Connection', 'close');
  const url = (req.url ?? '').split('?')[0];
  if (url === '/library/metadata/goodkey') {
    res.setHeader('content-type', 'application/json');
    // trackFromMetadata needs Media/Part to consider the track real.
    res.end(
      JSON.stringify({
        MediaContainer: {
          Metadata: [
            { ratingKey: 'goodkey', parentThumb: '/art/goodkey.jpg', Media: [{ Part: [{ file: '/music/a.flac' }] }] },
          ],
        },
      })
    );
    return;
  }
  if (url === '/library/metadata/badnet') {
    res.setHeader('content-type', 'application/json');
    // parentThumb WITHOUT a leading slash turns the art URL into
    // "host:PORTx?..." -- an invalid port, so fetch rejects (TypeError),
    // the network-level failure class the catch under test converts to 502.
    res.end(
      JSON.stringify({
        MediaContainer: {
          Metadata: [{ ratingKey: 'badnet', parentThumb: 'x', Media: [{ Part: [{ file: '/music/b.flac' }] }] }],
        },
      })
    );
    return;
  }
  if (url === '/art/goodkey.jpg') {
    artHits += 1;
    res.setHeader('content-type', 'image/jpeg');
    res.end(JPEG);
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
server.unref();

setupTestConfig('art-proxy', {
  plex: { baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'test-token' },
});

const { registerArtRoute } = await import('../src/server/artProxy.js');
const { config } = await import('../src/config/index.js');

async function app() {
  const fastify = Fastify({ logger: false });
  registerArtRoute(fastify);
  return fastify;
}

describe('/api/art/:ratingKey', () => {
  test('fetch + cache: 200 with Plex bytes, cache written atomically (no tmp leftovers)', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/art/goodkey' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'image/jpeg');
    assert.equal(Buffer.compare(res.rawPayload, JPEG), 0, 'exact Plex bytes through');
    const cached = path.join(config.paths.artCacheDir, 'goodkey.jpg');
    assert.ok(fs.existsSync(cached), 'art lands in the cache dir');
    const leftovers = fs.readdirSync(config.paths.artCacheDir).filter((f) => f.includes('.tmp'));
    assert.equal(leftovers.length, 0, 'no .tmp-<pid> leftovers: write completed via rename');
    await fastify.close();
  });

  test('second hit is served from the cache (Plex art fetch happens exactly once)', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/art/goodkey' });
    assert.equal(res.statusCode, 200);
    assert.equal(Buffer.compare(res.rawPayload, JPEG), 0);
    assert.equal(artHits, 1, 'no second fetch -- existsSync short-circuits');
    await fastify.close();
  });

  test('network-level fetch rejection answers 502, not a raw 500', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/art/badnet' });
    assert.equal(res.statusCode, 502, 'fetch rejection is caught and mapped like !res.ok');
    await fastify.close();
  });

  test('unknown track: Plex lookup 404 stays a 404', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/art/zzz' });
    assert.equal(res.statusCode, 404);
    await fastify.close();
  });

  test('traversal junk in the param is still rejected before any path.join', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/art/..%2F..%2Fetc' });
    assert.equal(res.statusCode, 400);
    await fastify.close();
  });
});

describe('structural pin (write discipline)', () => {
  test('art cache write is tmp-<pid> + rename, never an in-place writeFileSync', () => {
    const src = fs.readFileSync(path.join(repoRoot(), 'src', 'server', 'artProxy.js'), 'utf8');
    assert.match(src, /\.tmp-\$\{process\.pid\}/, 'pid-suffixed temp name');
    assert.match(src, /fs\.renameSync\(tmp, cached\)/, 'rename into place');
    assert.doesNotMatch(src, /writeFileSync\(cached,/, 'the old in-place write must stay gone');
    assert.match(src, /Plex art fetch failed: \$\{err\.message\}/, 'fetch rejections are logged + 502, not raw 500');
  });
});

test('cleanup: fake Plex down', async () => {
  await new Promise((resolve) => server.close(resolve));
});
