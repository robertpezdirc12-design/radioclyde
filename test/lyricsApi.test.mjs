// Tests for the "Besedila" service + store + route (src/lyrics/lyricsService.js,
// lyricsStore.js, and GET /api/lyrics/current mounted in src/server/api.js):
// the honest state machine the frozen frontend contract demands (pending /
// never-found / no-music / disabled distinguishable), the 30-day recheck and
// 10-minute failure backoff, and the route answering through the REAL
// now_playing_track.json + lyrics-cache.json files in the test dataDir. The
// LRCLIB client is always a fake -- no test touches the network.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('lyrics-api', {});

const { config } = await import('../src/config/index.js');
const {
  createLyricsService,
  registerLyricsRoute,
  ensureLyrics,
  prefetchLyrics,
  lyricsEnabled,
  songKey,
  cacheKeyFor,
} = await import('../src/lyrics/lyricsService.js');
const {
  getCacheEntry,
  setCacheEntry,
  readLyricsCache,
  needsRecheck,
  lyricsCachePath,
  RECHECK_AFTER_MS,
} = await import('../src/lyrics/lyricsStore.js');

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;
const SYNCED_LRC = '[00:00.00]prva vrstica\n[00:05.00]\u266A\n[00:10.00]tretja vrstica';
const SYNCED_LINES = [
  { startMs: 0, text: 'prva vrstica' },
  { startMs: 5000, text: '' },
  { startMs: 10000, text: 'tretja vrstica' },
];
const TRACK = { artist: 'Ansambel', title: 'Tema', album: 'Album', durationMs: 187000 };
const KEY = cacheKeyFor(TRACK.artist, TRACK.title, TRACK.durationMs);

function fakeClient(handler) {
  const calls = [];
  return { calls, find: async (track) => { calls.push(track); return handler(track, calls.length); } };
}

function seedCache(key, entry) {
  fs.rmSync(lyricsCachePath(), { force: true });
  setCacheEntry(key, entry);
}

// The prior agent's hard-won lesson, kept: async assertions use waitFor with
// GENEROUS deadlines, never bare sleeps just under the expected gap.
async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}

function writeOnAir(track) {
  fs.writeFileSync(config.paths.nowPlayingTrackPath, JSON.stringify(track));
}

function buildApp(service) {
  const fastify = Fastify({ logger: false });
  registerLyricsRoute(fastify, { service });
  return fastify;
}

// ---------- store ----------

describe('lyrics store (lyricsStore.js)', () => {
  test('round-trip under dataDir, atomic tmp+rename leaves no leftovers', () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    setCacheEntry(KEY, { ...TRACK, syncedLrc: SYNCED_LRC, plainText: null, instrumental: false, externalId: '7', checkedAt: 0 });
    const entry = getCacheEntry(KEY);
    assert.equal(entry.syncedLrc, SYNCED_LRC);
    assert.equal(entry.externalId, '7');
    assert.ok(lyricsCachePath().startsWith(config.dataDir));
    assert.ok(lyricsCachePath().endsWith('lyrics-cache.json'));
    const leftovers = fs.readdirSync(path.dirname(lyricsCachePath())).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], 'no .tmp leftovers after the rename');
  });

  test('fails open: missing, corrupt and wrong-shape files all read as an empty cache', () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    assert.deepEqual(readLyricsCache(), { version: 1, entries: {} });
    fs.writeFileSync(lyricsCachePath(), '{not json');
    assert.deepEqual(readLyricsCache(), { version: 1, entries: {} });
    fs.writeFileSync(lyricsCachePath(), JSON.stringify({ nope: true }));
    assert.deepEqual(readLyricsCache(), { version: 1, entries: {} });
  });

  test('needsRecheck: fresh no, 30-day yes, missing / unparseable checkedAt yes', () => {
    const now = 5 * DAY;
    assert.equal(needsRecheck(null, now), true);
    assert.equal(needsRecheck({ checkedAt: now - 1 }, now), false);
    assert.equal(needsRecheck({ checkedAt: now - RECHECK_AFTER_MS }, now), true);
    assert.equal(needsRecheck({ checkedAt: 'yesterday' }, now), true);
  });
});

// ---------- service ----------

describe('lyrics service state machine (lyricsService.js)', () => {
  test('cache hit serves the full frozen payload with zero network', () => {
    const client = fakeClient(() => {
      throw new Error('the network must not be touched');
    });
    const service = createLyricsService({ client, now: () => 0, logger: () => {} });
    seedCache(KEY, { ...TRACK, syncedLrc: SYNCED_LRC, plainText: null, instrumental: false, externalId: null, checkedAt: 0 });
    assert.deepEqual(service.currentLyrics(TRACK), {
      songId: 'Ansambel \u2014 Tema',
      synced: true,
      lines: SYNCED_LINES,
      source: 'lrclib',
      pending: false,
      offsetMs: 0,
      stationOffsetMs: 0,
    });
    assert.equal(client.calls.length, 0);
  });

  test('cold cache: first ask is pending (frozen pending shape) and STARTS the lookup; next ask serves it', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    const client = fakeClient(() => ({ syncedLyrics: SYNCED_LRC, plainLyrics: null, instrumental: false, id: 9 }));
    const service = createLyricsService({ client, now: () => 0, logger: () => {} });
    const first = service.currentLyrics(TRACK);
    assert.deepEqual(
      { songId: first.songId, synced: first.synced, lines: first.lines, source: first.source, pending: first.pending },
      { songId: 'Ansambel \u2014 Tema', synced: false, lines: [], source: null, pending: true }
    );
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].artist, 'Ansambel');
    assert.equal(client.calls[0].durationSec, 187);
    assert.ok(await waitFor(() => getCacheEntry(KEY) !== null), 'lookup landed in the cache');
    const second = service.currentLyrics(TRACK);
    assert.equal(second.pending, false);
    assert.equal(second.synced, true);
    assert.deepEqual(second.lines, SYNCED_LINES);
  });

  test('a throwing client is "ask later": stays pending (never a definitive miss), nothing stored, 10-minute backoff gates the re-ask', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    let clock = 0;
    const client = fakeClient(() => {
      throw new Error('lrclib down');
    });
    const service = createLyricsService({ client, now: () => clock, logger: () => {} });
    assert.equal(service.currentLyrics(TRACK).pending, true);
    assert.ok(await waitFor(() => !service.lookupInFlight(TRACK.artist, TRACK.title, TRACK.durationMs)));
    assert.equal(getCacheEntry(KEY), null, 'a failure stores nothing');

    clock = 5 * MIN; // inside the backoff window
    assert.equal(service.currentLyrics(TRACK).pending, true, 'still owed -> still pending');
    assert.equal(client.calls.length, 1, 'backoff holds the re-ask');

    clock = 11 * MIN; // past the backoff
    assert.equal(service.currentLyrics(TRACK).pending, true);
    assert.equal(client.calls.length, 2, 'the ask fires again once the backoff lapses');
  });

  test('30-day recheck: a fresh hit is served untouched; 31 days later the ask re-fires while the stale answer stays cached', async () => {
    let clock = 0;
    const client = fakeClient(() => ({ syncedLyrics: SYNCED_LRC, plainLyrics: null, instrumental: false }));
    const service = createLyricsService({ client, now: () => clock, logger: () => {} });
    seedCache(KEY, { ...TRACK, syncedLrc: SYNCED_LRC, plainText: null, instrumental: false, externalId: null, checkedAt: 0 });
    assert.equal(service.currentLyrics(TRACK).pending, false);
    assert.equal(client.calls.length, 0);

    clock = 31 * DAY;
    const during = service.currentLyrics(TRACK);
    assert.equal(during.pending, true, 'recheck owed -> pending (the 4 s poll heals it)');
    assert.deepEqual(during.lines, [], 'pending mirrors the frozen empty-lines shape');
    assert.equal(client.calls.length, 1);
    assert.equal(getCacheEntry(KEY).syncedLrc, SYNCED_LRC, 'stale answer still on disk while rechecking');
    assert.ok(await waitFor(() => getCacheEntry(KEY).checkedAt === 31 * DAY));
    assert.equal(service.currentLyrics(TRACK).pending, false);
  });

  test('plain-only and definitive-miss entries: honest never-found states, songId still set', () => {
    const service = createLyricsService({ client: fakeClient(() => null), now: () => 0, logger: () => {} });
    seedCache(KEY, { ...TRACK, syncedLrc: null, plainText: 'first\nsecond', instrumental: false, externalId: null, checkedAt: 0 });
    const plain = service.currentLyrics(TRACK);
    assert.equal(plain.synced, false);
    assert.equal(plain.source, 'lrclib');
    assert.deepEqual(plain.lines, [
      { startMs: null, text: 'first' },
      { startMs: null, text: 'second' },
    ]);

    seedCache(KEY, { ...TRACK, syncedLrc: null, plainText: null, instrumental: false, externalId: null, checkedAt: 0 });
    const miss = service.currentLyrics(TRACK);
    assert.deepEqual(
      { songId: miss.songId, synced: miss.synced, lines: miss.lines, source: miss.source, pending: miss.pending },
      { songId: 'Ansambel \u2014 Tema', synced: false, lines: [], source: null, pending: false }
    );
  });

  test('no track on air / an unkeyable track: the honest no-music state (songId null)', () => {
    const service = createLyricsService({ client: fakeClient(() => null), now: () => 0, logger: () => {} });
    assert.deepEqual(service.currentLyrics(null), {
      songId: null, synced: false, lines: [], source: null, pending: false, offsetMs: 0, stationOffsetMs: 0,
    });
    assert.equal(service.currentLyrics({ artist: '  ', title: '', durationMs: 1000 }).songId, null);
  });

  test('an instrumental record serves one whole-track rest line (synced)', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    const client = fakeClient(() => ({ syncedLyrics: null, plainLyrics: null, instrumental: true }));
    const service = createLyricsService({ client, now: () => 0, logger: () => {} });
    service.currentLyrics(TRACK);
    assert.ok(await waitFor(() => getCacheEntry(KEY)?.instrumental === true));
    const payload = service.currentLyrics(TRACK);
    assert.deepEqual(payload.lines, [{ startMs: 0, text: '' }]);
    assert.equal(payload.synced, true);
  });

  test('ensureLyrics: the enqueue-time trigger looks an owed entry up ahead of airtime', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    const client = fakeClient(() => ({ syncedLyrics: SYNCED_LRC, plainLyrics: null, instrumental: false }));
    const service = createLyricsService({ client, now: () => 0, logger: () => {} });
    const running = service.ensureLyrics(TRACK);
    assert.ok(running, 'an owed lookup started');
    await running;
    assert.equal(client.calls.length, 1);
    assert.equal(service.currentLyrics(TRACK).pending, false);
    assert.equal(typeof ensureLyrics, 'function'); // the module-level export for the orchestrator
  });

  test('songKey is the panel like-key (em dash); cacheKey separates cuts, bare key without duration', () => {
    assert.equal(songKey(' Ansambel ', ' Tema '), 'Ansambel \u2014 Tema');
    assert.equal(cacheKeyFor('A', 'T', 187400), 'A \u2014 T (187s)');
    assert.notEqual(cacheKeyFor('A', 'T', 187000), cacheKeyFor('A', 'T', 205000));
    assert.equal(cacheKeyFor('A', 'T', null), 'A \u2014 T');
  });
});

// ---------- route ----------

describe('GET /api/lyrics/current (real now-playing + cache files)', () => {
  test('music on air + cached synced answer: the full frozen response shape', async () => {
    writeOnAir({ ratingKey: 'k1', ...TRACK, playedAt: new Date().toISOString() });
    seedCache(KEY, { ...TRACK, syncedLrc: SYNCED_LRC, plainText: null, instrumental: false, externalId: null, checkedAt: Date.now() });
    const service = createLyricsService({ client: fakeClient(() => null), now: () => Date.now(), logger: () => {} });
    const fastify = buildApp(service);
    const res = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = res.json();
    assert.deepEqual(Object.keys(body).sort(), ['lines', 'offsetMs', 'pending', 'songId', 'source', 'stationOffsetMs', 'synced']);
    assert.equal(body.songId, 'Ansambel \u2014 Tema');
    assert.equal(body.synced, true);
    assert.deepEqual(body.lines, SYNCED_LINES);
    assert.equal(body.source, 'lrclib');
    assert.equal(body.pending, false);
    assert.equal(body.offsetMs, 0);
    assert.equal(body.stationOffsetMs, 0);
    await fastify.close();
  });

  test('cold cache: pending on the first hit, healed by the next poll (the 4 s panel poll)', async () => {
    writeOnAir({ ratingKey: 'k1', ...TRACK, playedAt: new Date().toISOString() });
    fs.rmSync(lyricsCachePath(), { force: true });
    const client = fakeClient(() => ({ syncedLyrics: SYNCED_LRC, plainLyrics: null, instrumental: false }));
    const fastify = buildApp(createLyricsService({ client, now: () => Date.now(), logger: () => {} }));
    const first = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().pending, true);
    assert.deepEqual(first.json().lines, []);
    assert.ok(await waitFor(() => getCacheEntry(KEY) !== null));
    const second = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
    assert.equal(second.json().pending, false);
    assert.equal(second.json().lines.length, 3);
    await fastify.close();
  });

  test('lyrics disabled: terminal 503 { error: "lyrics-disabled" }, no lookup; missing block = enabled', async () => {
    writeOnAir({ ratingKey: 'k1', ...TRACK, playedAt: new Date().toISOString() });
    assert.equal(lyricsEnabled(), true, 'missing lyrics block defaults to enabled');
    config.lyrics = { enabled: false };
    try {
      const client = fakeClient(() => {
        throw new Error('must not be called');
      });
      const fastify = buildApp(createLyricsService({ client, now: () => Date.now(), logger: () => {} }));
      const res = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
      assert.equal(res.statusCode, 503);
      assert.deepEqual(res.json(), { error: 'lyrics-disabled' });
      assert.equal(client.calls.length, 0);
      await fastify.close();
    } finally {
      config.lyrics = undefined;
    }
  });

  test('no music on air (nothing aired / DJ speaking): songId null, pending false, 200', async () => {
    fs.rmSync(config.paths.nowPlayingTrackPath, { force: true });
    const fastify = buildApp(createLyricsService({ client: fakeClient(() => null), now: () => Date.now(), logger: () => {} }));
    let res = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().songId, null);
    assert.equal(res.json().pending, false);

    writeOnAir({ dj: 'Maja', startedAt: new Date().toISOString() }); // persona speaking = no music
    res = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
    assert.equal(res.json().songId, null);
    assert.deepEqual(res.json().lines, []);
    await fastify.close();
  });

  test('stored definitive miss: pending false, empty lines, source null -- songId still set (never-found)', async () => {
    writeOnAir({ ratingKey: 'k1', ...TRACK, playedAt: new Date().toISOString() });
    seedCache(KEY, { ...TRACK, syncedLrc: null, plainText: null, instrumental: false, externalId: null, checkedAt: Date.now() });
    const client = fakeClient(() => null);
    const fastify = buildApp(createLyricsService({ client, now: () => Date.now(), logger: () => {} }));
    const res = await fastify.inject({ method: 'GET', url: '/api/lyrics/current' });
    const body = res.json();
    assert.equal(body.songId, 'Ansambel \u2014 Tema');
    assert.equal(body.pending, false);
    assert.deepEqual(body.lines, []);
    assert.equal(body.source, null);
    assert.equal(client.calls.length, 0, 'a fresh miss is not re-asked');
    await fastify.close();
  });

  test('the route is mounted in src/server/api.js', async () => {
    const api = fs.readFileSync(`${repoRoot()}/src/server/api.js`, 'utf8');
    assert.match(api, /registerLyricsRoute\(fastify\)/);
    assert.match(api, /lyrics\/lyricsService\.js/);
  });
});

// ---------- prefetchLyrics (the enqueue-time half of the dual trigger) ----------

describe('prefetchLyrics (enqueue-time trigger, flag-gated)', () => {
  test('flag off (the default): nothing starts, even for a fully owed track', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    assert.equal(config.lyrics, undefined, 'fixtures write no lyrics block -> prefetch defaults off');
    const client = fakeClient(() => {
      throw new Error('must not be called');
    });
    const service = createLyricsService({ client, now: () => Date.now(), logger: () => {} });
    assert.equal(prefetchLyrics([TRACK], { service }), 0);
    assert.equal(client.calls.length, 0);
    assert.equal(service.lookupInFlight(TRACK.artist, TRACK.title, TRACK.durationMs), false);
  });

  test('flag on: one lookup per owed track, the duplicate joins it, keyless/durationless junk is skipped, a warm cache starts nothing', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    config.lyrics = { enabled: true, prefetch: true };
    try {
      const client = fakeClient(() => ({ syncedLyrics: SYNCED_LRC, plainLyrics: null, instrumental: false }));
      const service = createLyricsService({ client, now: () => Date.now(), logger: () => {} });
      const batch = [
        TRACK,
        { ...TRACK }, // same cut: joins the running lookup, never a second request
        { artist: 'X' }, // no title: not a track we can even key
        {}, // junk
        { artist: 'A', title: 'B', durationMs: 0 }, // no duration: the client would refuse it anyway; skipping keeps a definitive miss off the bare song key
      ];
      const started = prefetchLyrics(batch, { service });
      // 2, not 1: the duplicate JOINS the running lookup (ensureLyrics hands
      // it the same in-flight promise, which is truthy) -- the count is
      // "tracks whose answer is now in motion", while the request count
      // below proves only ONE went out.
      assert.equal(started, 2);
      assert.ok(await waitFor(() => getCacheEntry(KEY) !== null), 'the prefetch lookup landed in the cache');
      assert.equal(client.calls.length, 1, 'the duplicate joined the in-flight lookup');
      // Cached and fresh: the panel's read is instant, pending false.
      const payload = service.currentLyrics(TRACK);
      assert.equal(payload.pending, false);
      assert.equal(payload.lines.length, 3);
      // A second batch over the same tracks starts nothing at all.
      assert.equal(prefetchLyrics(batch, { service }), 0);
      assert.equal(client.calls.length, 1);
    } finally {
      config.lyrics = undefined;
    }
  });

  test('lyrics.enabled = false wins over prefetch = true (ensureLookup first guard)', async () => {
    fs.rmSync(lyricsCachePath(), { force: true });
    config.lyrics = { enabled: false, prefetch: true };
    try {
      const client = fakeClient(() => {
        throw new Error('must not be called');
      });
      const service = createLyricsService({ client, now: () => Date.now(), logger: () => {} });
      assert.equal(prefetchLyrics([TRACK], { service }), 0);
      assert.equal(client.calls.length, 0);
    } finally {
      config.lyrics = undefined;
    }
  });

  // Structural, same standard as the radio.liq wiring tests in
  // requestQueue.test.mjs: the flag defaults OFF in every test process (no
  // test may touch the network), so the three enqueue call sites are
  // asserted on source. Their BEHAVIOR is the unit-tested helper above; a
  // removed or misplaced call is exactly the regression this catches.
  test('the three enqueue call sites are wired (filler pool / listener request / show tracks)', () => {
    const filler = fs.readFileSync(`${repoRoot()}/src/scheduler/generateFillerPlaylist.js`, 'utf8');
    assert.match(filler, /import \{ prefetchLyrics \} from '\.\.\/lyrics\/lyricsService\.js';/);
    assert.ok(
      filler.indexOf('fs.renameSync(fillerTmp') < filler.indexOf('prefetchLyrics(pool)'),
      'prefetch fires only after the atomic playlist swap succeeded'
    );

    const requests = fs.readFileSync(`${repoRoot()}/src/liquidsoap/requestQueue.js`, 'utf8');
    assert.match(requests, /import \{ prefetchLyrics \} from '\.\.\/lyrics\/lyricsService\.js';/);
    assert.ok(
      requests.indexOf('V predvajalni vrsti') < requests.indexOf('prefetchLyrics([track])'),
      'prefetch fires only after the queued-note is written (a failed push never prefetches)'
    );

    const director = fs.readFileSync(`${repoRoot()}/src/director/index.js`, 'utf8');
    assert.match(director, /import \{ prefetchLyrics \} from '\.\.\/lyrics\/lyricsService\.js';/);
    assert.match(director, /showTracks\.push\(track\);/);
    assert.ok(
      director.indexOf('await mergeTrackRatingKeys(ratingKeyEntries);') < director.indexOf('prefetchLyrics(showTracks)'),
      'prefetch fires after the scrobble index is fed, exactly where the enqueue moment is'
    );
  });
});
