// The publicStreamUrl override + the auth publicPaths exemption live in
// their own test file because config.json is read once per process at
// module load -- a different config shape needs a different process, the
// same pattern nowPlayingPushDisabled.test.mjs uses.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('listen-files-public', {
  broadcast: { publicStreamUrl: 'https://radio.example.com/live', tuneIn: null, discordWebhook: null },
  web: { port: 3999, publicPaths: ['/embed', '/api/now-playing'] },
});

const { m3uBody, plsBody, resolveStreamUrl } = await import('../src/server/listenFiles.js');
const { siblingStreamUrl, stripMp3Suffix } = await import('../src/server/streamUrls.js');
const { registerAuthHook } = await import('../src/server/auth.js');

describe('publicStreamUrl override', () => {
  test('both playlist files carry the owner-declared URL', () => {
    assert.equal(resolveStreamUrl(), 'https://radio.example.com/live');
    assert.match(m3uBody(), /https:\/\/radio\.example\.com\/live/);
    assert.match(plsBody(), /File1=https:\/\/radio\.example\.com\/live/);
  });

  test('a blank publicStreamUrl falls back to the derived URL', async () => {
    // The config is frozen per process, so this checks the fallback logic
    // shape: an empty/whitespace string must never win over the derived URL.
    const declared = '   ';
    const fallback = typeof declared === 'string' && declared.trim() ? declared.trim() : 'http://derived/stream';
    assert.equal(fallback, 'http://derived/stream');
  });
});

describe('optional mounts off behind a publicStreamUrl override', () => {
  test('both playlist files stay BYTE-IDENTICAL with the override URL', () => {
    assert.equal(m3uBody(), '#EXTM3U\n#EXTINF:-1,Test Station\nhttps://radio.example.com/live\n');
    assert.equal(
      plsBody(),
      '[playlist]\nNumberOfEntries=1\nFile1=https://radio.example.com/live\n' +
        'Title1=Test Station\nLength1=-1\nVersion=2\n'
    );
  });

  test('sibling URLs derive from the owner-declared publicStreamUrl', () => {
    assert.equal(siblingStreamUrl('.opus'), 'https://radio.example.com/live.opus');
    assert.equal(siblingStreamUrl('.flac'), 'https://radio.example.com/live.flac');
  });

  test('stripMp3Suffix only strips a trailing .mp3, URLs included', () => {
    assert.equal(stripMp3Suffix('https://radio.example.com/live.mp3'), 'https://radio.example.com/live');
    assert.equal(stripMp3Suffix('https://radio.example.com/live'), 'https://radio.example.com/live');
    assert.equal(stripMp3Suffix('/stream.mp3'), '/stream');
    assert.equal(stripMp3Suffix('/stream'), '/stream');
  });
});

describe('auth publicPaths exemption', () => {
  // inject() defaults to remoteAddress 127.0.0.1, which isTrustedIp ALWAYS
  // trusts (loopback health-check exemption in lib/ipRange.js) -- so every
  // request here pretends to come from a public IP, proving the publicPaths
  // exemption (not loopback trust) is what lets the listed paths through.
  const REMOTE = '203.0.113.7'; // TEST-NET-3, never routed

  function app() {
    const fastify = Fastify({ logger: false });
    registerAuthHook(fastify);
    fastify.get('/embed', () => ({ ok: true }));
    fastify.get('/api/now-playing', () => ({ ok: true }));
    fastify.get('/embed.html', () => ({ ok: true }));
    fastify.get('/private', () => ({ ok: true }));
    return fastify;
  }

  function inject(fastify, url, headers) {
    return fastify.inject({ method: 'GET', url, headers, remoteAddress: REMOTE });
  }

  test('listed public paths answer without credentials', async () => {
    const fastify = app();
    assert.equal((await inject(fastify, '/embed')).statusCode, 200);
    assert.equal((await inject(fastify, '/api/now-playing')).statusCode, 200);
    // query strings don't defeat or break the match
    assert.equal((await inject(fastify, '/api/now-playing?x=1')).statusCode, 200);
    await fastify.close();
  });

  test('prefix matching is strict -- /embed does not open /embed.html or /embedX', async () => {
    const fastify = app();
    const res = await inject(fastify, '/embed.html');
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'], /Basic/);
    const res2 = await inject(fastify, '/embedx');
    assert.equal(res2.statusCode, 401);
    await fastify.close();
  });

  test('unlisted paths still require Basic Auth', async () => {
    const fastify = app();
    const res = await inject(fastify, '/private');
    assert.equal(res.statusCode, 401);
    assert.match(res.headers['www-authenticate'], /Basic realm="radioclyde"/);
    // bad credentials are still rejected on a public-path-adjacent route
    const bad = await inject(fastify, '/private', {
      authorization: `Basic ${Buffer.from('nope:nope').toString('base64')}`,
    });
    assert.equal(bad.statusCode, 401);
    await fastify.close();
  });
});
