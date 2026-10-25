// Optional mounts turned ON (mount "/stream.mp3", opus+flac enabled) in this
// process's own config: the multi-entry playlist bodies, now-playing's
// station.streams, the config-gated sibling proxy routes, and the agreement
// between the URL surface and the generated streams.liq. Own process (a
// different config shape needs one, same pattern as listenFilesPublic) and
// own web port so nothing collides with the other listen-file tests.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('stream-mounts', {
  icecast: {
    sourceHost: '127.0.0.1',
    publicHost: 'localhost',
    port: 8001,
    mount: '/stream.mp3',
    sourcePassword: 'pw',
    bitrate: 192,
    opus: { enabled: true, bitrate: 100 }, // clamps down to the 96 rung
    flac: { enabled: true },
  },
  web: { port: 3997 },
});

const { streamEntries, siblingStreamUrl, stripMp3Suffix } = await import('../src/server/streamUrls.js');
const { m3uBody, plsBody } = await import('../src/server/listenFiles.js');
const { composeNowPlaying } = await import('../src/server/nowPlaying.js');
const { registerStreamRoute } = await import('../src/server/streamProxy.js');
const { buildStreamsLiq } = await import('../src/liquidsoap/streamsLiqWriter.js');
const { config } = await import('../src/config/index.js');

describe('streamEntries (mounts on)', () => {
  test('mp3 always first, opus clamped to its rung, flac last without a bitrate', () => {
    assert.deepEqual(streamEntries(), [
      { url: 'http://localhost:3997/stream.mp3', format: 'mp3', bitrate: 192 },
      { url: 'http://localhost:3997/stream.opus', format: 'opus', bitrate: 96 },
      { url: 'http://localhost:3997/stream.flac', format: 'flac' },
    ]);
  });

  test('sibling URLs derive from the mount base (.mp3 stripped)', () => {
    assert.equal(siblingStreamUrl('.opus'), 'http://localhost:3997/stream.opus');
    assert.equal(siblingStreamUrl('.flac'), 'http://localhost:3997/stream.flac');
    assert.equal(stripMp3Suffix(config.icecast.mount), '/stream');
  });

  test('the .liq generator emits exactly the mounts the URLs advertise', () => {
    const liq = buildStreamsLiq(config);
    assert.ok(liq.includes('mount="/stream.opus"'));
    assert.ok(liq.includes('mount="/stream.flac"'));
    assert.ok(liq.includes('bitrate=96, samplerate=48000'), 'clamped opus rung is the literal');
    assert.ok(!liq.includes('bitrate=100'));
  });
});

describe('playlist files list every enabled entry', () => {
  test('m3u body: one #EXTINF per entry, Slovenian suffix per entry', () => {
    assert.equal(
      m3uBody(),
      '#EXTM3U\n' +
        '#EXTINF:-1,Test Station — MP3 192k\nhttp://localhost:3997/stream.mp3\n' +
        '#EXTINF:-1,Test Station — Opus 96k\nhttp://localhost:3997/stream.opus\n' +
        '#EXTINF:-1,Test Station — FLAC (brezizgubno)\nhttp://localhost:3997/stream.flac\n'
    );
  });

  test('pls body: File/Title/Length triples + NumberOfEntries=3', () => {
    assert.equal(
      plsBody(),
      '[playlist]\nNumberOfEntries=3\n' +
        'File1=http://localhost:3997/stream.mp3\nTitle1=Test Station — MP3 192k\nLength1=-1\n' +
        'File2=http://localhost:3997/stream.opus\nTitle2=Test Station — Opus 96k\nLength2=-1\n' +
        'File3=http://localhost:3997/stream.flac\nTitle3=Test Station — FLAC (brezizgubno)\nLength3=-1\n' +
        'Version=2\n'
    );
  });
});

describe('now-playing station surface', () => {
  test('station.streams mirrors streamEntries; streamUrl stays the legacy MP3 field', () => {
    const nowPlaying = composeNowPlaying();
    assert.deepEqual(nowPlaying.station.streams, streamEntries());
    assert.equal(nowPlaying.station.streamUrl, 'http://localhost:3997/stream.mp3');
    assert.equal(nowPlaying.station.name, 'Test Station');
  });
});

describe('sibling proxy routes (registered only when enabled)', () => {
  test('enabled mounts are routed; dead upstream answers 502, not 404', async () => {
    const fastify = Fastify({ logger: false });
    registerStreamRoute(fastify);
    // fixture icecast points at 127.0.0.1:8001 where nothing listens: the
    // routes ARE registered, so the honest answer is a proxy failure (502).
    const opus = await fastify.inject({ method: 'GET', url: '/stream.opus' });
    assert.equal(opus.statusCode, 502);
    const flac = await fastify.inject({ method: 'GET', url: '/stream.flac' });
    assert.equal(flac.statusCode, 502);
    const primary = await fastify.inject({ method: 'GET', url: '/stream' });
    assert.equal(primary.statusCode, 502);
    await fastify.close();
  });
});
