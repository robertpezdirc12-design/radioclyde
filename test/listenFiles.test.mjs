// P1 listener-experience regression tests: /listen.m3u + /listen.pls
// playlist files, the peak-listener math (peakListeners), the PWA static
// surface (manifest + service worker + embed page) and the /api/listeners
// peak ride-along. Same honesty standard as the rest of the repo: a peak
// number exists ONLY when the ledger actually measured one, derived URLs
// are exactly what /api/now-playing's station.streamUrl names, and a
// missing ledger is a null, never a zero.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('listen-files', {});

const { m3uBody, plsBody, resolveStreamUrl, registerListenFiles } = await import(
  '../src/server/listenFiles.js'
);
const { peakListeners } = await import('../src/analytics/listenerImpact.js');
const { registerStaticRoutes } = await import('../src/server/staticFiles.js');
const { registerApiRoutes } = await import('../src/server/api.js');
const { config: liveConfig } = await import('../src/config/index.js');

describe('listen files (m3u/pls)', () => {
  test('derived stream URL matches the composition now-playing reports', () => {
    // fixture: icecast.publicHost=localhost, web.port=3999, mount=/stream
    assert.equal(resolveStreamUrl(), 'http://localhost:3999/stream');
  });

  test('m3u body is a valid minimal M3U with the stream URL', () => {
    const body = m3uBody();
    const lines = body.split('\n').filter((l) => l.trim());
    assert.equal(lines[0], '#EXTM3U');
    assert.match(lines[1], /^#EXTINF:-1,/);
    assert.equal(lines[2], 'http://localhost:3999/stream');
  });

  test('pls body is a valid PLS v2 with one live entry', () => {
    const body = plsBody();
    const lines = body.split('\n').filter((l) => l.trim());
    assert.equal(lines[0], '[playlist]');
    assert.ok(lines.includes('NumberOfEntries=1'));
    assert.ok(lines.includes('File1=http://localhost:3999/stream'));
    assert.ok(lines.includes('Length1=-1'), 'live stream has no fixed duration');
    assert.ok(lines.includes('Version=2'));
  });

  test('routes serve the right content types and bodies', async () => {
    const fastify = Fastify({ logger: false });
    registerListenFiles(fastify);
    const m3u = await fastify.inject({ method: 'GET', url: '/listen.m3u' });
    assert.equal(m3u.statusCode, 200);
    assert.match(m3u.headers['content-type'], /audio\/x-mpegurl/);
    assert.match(m3u.body, /^#EXTM3U/);
    const pls = await fastify.inject({ method: 'GET', url: '/listen.pls' });
    assert.equal(pls.statusCode, 200);
    assert.match(pls.headers['content-type'], /audio\/x-scpls/);
    assert.match(pls.body, /^\[playlist\]/);
    await fastify.close();
  });
});

describe('peakListeners (pure math)', () => {
  const base = Date.now();

  test('highest non-gap sample wins; gaps are ignored, never zero', () => {
    const peak = peakListeners([
      { ts: new Date(base - 3000).toISOString(), listeners: 2 },
      { ts: new Date(base - 2000).toISOString(), listeners: null },
      { ts: new Date(base - 1000).toISOString(), listeners: 5 },
      { ts: new Date(base).toISOString(), listeners: 3 },
    ]);
    assert.equal(peak, 5);
  });

  test('window bounds filter samples', () => {
    const from = base - 1000;
    const to = base;
    const peak = peakListeners(
      [
        { ts: new Date(base - 5000).toISOString(), listeners: 99 }, // outside
        { ts: new Date(base - 500).toISOString(), listeners: 4 },
        { ts: new Date(base + 5000).toISOString(), listeners: 50 }, // outside
      ],
      { from, to }
    );
    assert.equal(peak, 4);
  });

  test('empty window, all-gap ledger, or torn timestamps -> null, not 0', () => {
    assert.equal(peakListeners([]), null);
    assert.equal(peakListeners([{ ts: new Date().toISOString(), listeners: null }]), null);
    assert.equal(peakListeners([{ ts: 'not-a-date', listeners: 7 }]), null);
    assert.equal(peakListeners(undefined), null);
  });
});

describe('PWA static surface', () => {
  test('manifest is served as JSON with the station identity', async () => {
    const fastify = Fastify({ logger: false });
    registerStaticRoutes(fastify);
    const res = await fastify.inject({ method: 'GET', url: '/manifest.webmanifest' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'], /application\/manifest\+json/);
    const manifest = JSON.parse(res.body);
    assert.equal(manifest.name, 'Radio Markec');
    assert.equal(manifest.lang, 'sl');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((i) => i.src === '/logo.png'));
    await fastify.close();
  });

  test('service worker and embed page are served', async () => {
    const fastify = Fastify({ logger: false });
    registerStaticRoutes(fastify);
    const sw = await fastify.inject({ method: 'GET', url: '/sw.js' });
    assert.equal(sw.statusCode, 200);
    assert.match(sw.headers['content-type'], /text\/javascript/);
    assert.match(sw.body, /PRECACHE/);
    const embed = await fastify.inject({ method: 'GET', url: '/embed.html' });
    assert.equal(embed.statusCode, 200);
    assert.match(embed.headers['content-type'], /text\/html/);
    assert.match(embed.body, /\/stream/);
    await fastify.close();
  });

  test('index.html links the manifest and carries the chips container', () => {
    const html = fs.readFileSync(path.join(repoRoot(), 'public', 'index.html'), 'utf8');
    assert.match(html, /rel="manifest"/);
    assert.match(html, /id="req-chips"/);
  });
});

describe('/api/listeners peak ride-along', () => {
  test('peak comes from the ledger even while Icecast is down', async () => {
    // Seed the ledger directly (same JSONL schema listenerSamples writes).
    const now = Date.now();
    const lines = [
      { ts: new Date(now - 120000).toISOString(), listeners: 2 },
      { ts: new Date(now - 60000).toISOString(), listeners: 9 },
      { ts: new Date(now - 30000).toISOString(), listeners: null, error: 'probe failed' },
      { ts: new Date(now - 10000).toISOString(), listeners: 4 },
    ];
    fs.mkdirSync(path.dirname(liveConfig.paths.listenerSamplesFile), { recursive: true });
    fs.writeFileSync(liveConfig.paths.listenerSamplesFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    const fastify = Fastify({ logger: false });
    registerApiRoutes(fastify);
    const res = await fastify.inject({ method: 'GET', url: '/api/listeners' });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    // fixture icecast points at 127.0.0.1:8001 where nothing listens -> the
    // live count is honestly null ...
    assert.equal(body.listeners, null);
    // ... while the ledger's peak is still a real measurement.
    assert.equal(body.peak, 9);
    await fastify.close();
  });

  test('no ledger -> peak is null, not 0', async () => {
    fs.rmSync(liveConfig.paths.listenerSamplesFile, { force: true });
    const fastify = Fastify({ logger: false });
    registerApiRoutes(fastify);
    const res = await fastify.inject({ method: 'GET', url: '/api/listeners' });
    const body = JSON.parse(res.body);
    assert.equal(body.peak, null);
    await fastify.close();
  });
});
