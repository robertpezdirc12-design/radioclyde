// Tests for the smart rotation rules (P2 #6, defenestratexp borrow --
// scheduler/rotationRules.js + its generateFillerPlaylist.js integration).
//
// Three layers, mirroring how the feature is built:
//   A. pure cap/weight math on synthetic track arrays (exact counts),
//   B. stationPlayCounts over real play ledgers on disk (played.jsonl +
//      filler-rotation.jsonl merged, torn lines skipped),
//   C. end-to-end filler generation on real WAV fixtures with an
//      artist cap binding -- the pool must shrink per-artist AND still come
//      out full-size via the uncapped oldest-first backfill.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav, m3uPaths, repoRoot } from './fixtures.mjs';

setupTestConfig('rotation-rules', {
  filler: {
    poolSize: 12,
    regenerateIntervalMinutes: 360,
    maxTrackDurationSeconds: 600,
    rotationWindowHours: 24,
    rotation: {
      maxTracksPerArtist: 4,
      maxTracksPerArtistAlbum: 0, // album cap off in the e2e below (WAV fixtures carry no album tags)
      weightWindowDays: 7,
      noveltyDays: 7,
      noveltyBoost: 3,
    },
  },
});

const { capPerArtist, capPerArtistAlbum, rotationWeight, weightedRotationOrder, stationPlayCounts, fillerRotationConfig } =
  await import('../src/scheduler/rotationRules.js');
const { fillerLedgerPath, recordFillerPlays } = await import('../src/scheduler/fillerRotation.js');
const { lookupRatingKey } = await import('../src/plex/ratingKeyIndex.js');
const { config: liveConfig } = await import('../src/config/index.js');
const { generateFillerPlaylist } = await import('../src/scheduler/generateFillerPlaylist.js');

const DAY_MS = 24 * 60 * 60 * 1000;

function track(artist, title, album = null, extra = {}) {
  return { ratingKey: extra.ratingKey ?? `${artist}/${title}`.toLowerCase(), artist, title, album, ...extra };
}

describe('rotation caps (pure math)', () => {
  test('capPerArtist keeps the first N per artist in input order', () => {
    const fortyA = Array.from({ length: 40 }, (_, i) => track('A', `A song ${i}`));
    const twoB = [track('B', 'B one'), track('B', 'B two')];
    const kept = capPerArtist([...fortyA, ...twoB], 30);
    assert.equal(kept.length, 32, '30 of A plus both of B');
    assert.equal(kept.filter((t) => t.artist === 'A').length, 30);
    assert.equal(kept.filter((t) => t.artist === 'B').length, 2);
    // Input order is the priority order: the survivors are the FIRST 30.
    assert.deepEqual(
      kept.filter((t) => t.artist === 'A').map((t) => t.title),
      fortyA.slice(0, 30).map((t) => t.title)
    );
  });

  test('capPerArtist folds case and diacritics into one group', () => {
    const tracks = [track('Beyoncé', 'x'), track('beyonce', 'y'), track('BEYONCÉ', 'z')];
    const kept = capPerArtist(tracks, 2);
    assert.equal(kept.length, 2, 'all three spellings are one artist for the cap');
  });

  test('capPerArtist caps the unknown-artist group too', () => {
    const untagged = [track('', 'one'), track('', 'two'), track('', 'three')];
    assert.equal(capPerArtist(untagged, 2).length, 2, 'empty artist folds to its own group');
  });

  test('capPerArtistAlbum caps per (artist, album), leaves null albums alone', () => {
    const albumX = Array.from({ length: 8 }, (_, i) => track('A', `x${i}`, 'Album X'));
    const albumY = Array.from({ length: 3 }, (_, i) => track('A', `y${i}`, 'Album Y'));
    const noAlbum = Array.from({ length: 9 }, (_, i) => track('B', `n${i}`, null));
    const kept = capPerArtistAlbum([...albumX, ...albumY, ...noAlbum], 5);
    assert.equal(kept.filter((t) => t.album === 'Album X').length, 5, 'compilation flood capped at 5');
    assert.equal(kept.filter((t) => t.album === 'Album Y').length, 3, 'other album untouched');
    assert.equal(kept.filter((t) => t.album === null).length, 9, 'no album identity -> never capped');
    assert.equal(kept.length, 17);
  });

  test('a zero or negative cap disables the rule and returns a copy', () => {
    const tracks = [track('A', 'one'), track('A', 'two')];
    const kept = capPerArtist(tracks, 0);
    assert.equal(kept.length, 2);
    assert.notEqual(kept, tracks, 'a copy, not the input array');
    assert.equal(capPerArtistAlbum(tracks, -1).length, 2);
  });
});

describe('rotation weight (pure math)', () => {
  const now = Date.now();

  test('weight is 1/(1+playCount): less played -> heavier', () => {
    const counts = new Map([['played2', 2]]);
    assert.equal(rotationWeight(track('A', 'fresh', null, { ratingKey: 'fresh' }), { counts, now }), 1);
    assert.equal(rotationWeight(track('A', 'old', null, { ratingKey: 'played2' }), { counts, now }), 1 / 3);
  });

  test('novelty boost applies only inside the window and above multiplier 1', () => {
    const fresh = track('A', 'fresh', null, { ratingKey: 'f', addedAtMs: now - 1 * DAY_MS });
    const stale = track('A', 'stale', null, { ratingKey: 's', addedAtMs: now - 8 * DAY_MS });
    const opts = { counts: new Map(), noveltyDays: 7, noveltyBoost: 3, now };
    assert.equal(rotationWeight(fresh, opts), 3, 'added yesterday -> 3x');
    assert.equal(rotationWeight(stale, opts), 1, 'added 8 days ago -> no boost');
    assert.equal(
      rotationWeight(fresh, { ...opts, noveltyBoost: 1 }),
      1,
      'multiplier 1 (or below) is treated as off'
    );
    assert.equal(rotationWeight(track('A', 'nosig', null, { ratingKey: 'n' }), opts), 1, 'no addedAt signal -> never boosts');
  });

  test('weightedRotationOrder sorts weight-descending under a constant random', () => {
    const random = Math.random;
    Math.random = () => 0.5; // key = 0.5^(1/w) is monotonic in w
    try {
      const playedTwice = track('A', 'played twice', null, { ratingKey: 'p2' });
      const fresh = track('A', 'fresh', null, { ratingKey: 'p0' });
      const novel = track('A', 'novel', null, { ratingKey: 'pn', addedAtMs: Date.now() - 1000 });
      const counts = new Map([['p2', 2]]);
      const ordered = weightedRotationOrder([playedTwice, fresh, novel], { counts, now: Date.now() });
      assert.deepEqual(
        ordered.map((t) => t.ratingKey),
        ['pn', 'p0', 'p2'],
        'novel (3x) first, then never-played, then 2x-played'
      );
    } finally {
      Math.random = random;
    }
  });

  test('weightWindowDays 0 turns weighting off (plain shuffle, same multiset)', () => {
    const tracks = [track('A', 'one', null, { ratingKey: '1' }), track('A', 'two', null, { ratingKey: '2' })];
    const out = weightedRotationOrder(tracks, { weightWindowDays: 0 });
    assert.deepEqual([...out].sort((a, b) => a.ratingKey.localeCompare(b.ratingKey)), [...tracks].sort((a, b) => a.ratingKey.localeCompare(b.ratingKey)));
  });
});

describe('stationPlayCounts (real ledgers on disk)', () => {
  test('merges show history and filler ledger inside the window, skips torn lines and stale entries', () => {
    const now = Date.now();
    const history = [
      { ratingKey: 'k1', playedAt: new Date(now - 1 * DAY_MS).toISOString() },
      { ratingKey: 'k2', playedAt: new Date(now - 8 * DAY_MS).toISOString() }, // outside 7d
      '{"ratingKey":"torn"', // torn final line
    ];
    fs.mkdirSync(path.dirname(liveConfig.paths.historyFile), { recursive: true });
    fs.writeFileSync(
      liveConfig.paths.historyFile,
      history.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n'
    );
    const ledger = [
      { ratingKey: 'k1', playedAt: new Date(now - 2 * DAY_MS).toISOString() }, // second play of k1
      { ratingKey: 'k3', playedAt: new Date(now - 20 * DAY_MS).toISOString() }, // outside
      'not json at all', // torn line
    ];
    fs.mkdirSync(path.dirname(fillerLedgerPath()), { recursive: true });
    fs.writeFileSync(fillerLedgerPath(), ledger.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n');

    const counts = stationPlayCounts(7, now);
    assert.equal(counts.get('k1'), 2, 'show play + filler play merge into one counter');
    assert.equal(counts.has('k2'), false, 'outside the window does not count');
    assert.equal(counts.has('k3'), false, 'ledger entries outside the window do not count');
    assert.equal(counts.size, 1);
  });

  test('missing ledgers read as zero plays; window 0 disables counting', () => {
    fs.rmSync(liveConfig.paths.historyFile, { force: true });
    fs.rmSync(fillerLedgerPath(), { force: true });
    assert.equal(stationPlayCounts(7).size, 0);
    assert.equal(stationPlayCounts(0).size, 0);
  });
});

describe('filler integration (end-to-end, real WAV library)', () => {
  const musicDir = path.join(liveConfig.dataDir, 'music-rotation');
  const artists = ['Alpha', 'Beta', 'Gamma', 'Delta'];
  for (const artist of artists) {
    for (let i = 1; i <= 6; i++) {
      // Titles must be unique across artists: shared dedupeByTitle() collapses
      // same-titled tracks station-wide (deliberate "never the same song
      // twice" behavior), so "Song 1" x4 artists would shrink the pool to 6.
      writeWav(path.join(musicDir, `${artist} - ${artist} Song ${i}.wav`), 2);
    }
  }
  if (!liveConfig.autoRadio.music.localDirs.includes(musicDir)) {
    liveConfig.autoRadio.music.localDirs = [musicDir];
    // config.json was written by setupTestConfig before localDirs pointed
    // anywhere; src modules read config.json at import, and the localLibrary
    // scan reads config.autoRadio.music.localDirs live per scan call -- write
    // it back so a fresh process (CLI path) sees the same library.
    fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(liveConfig, null, 2));
  }

  function artistCounts(paths) {
    const perArtist = new Map();
    for (const p of paths) {
      const artist = path.basename(p).split(' - ')[0];
      perArtist.set(artist, (perArtist.get(artist) ?? 0) + 1);
    }
    return perArtist;
  }

  test('artist cap binds: no artist exceeds maxTracksPerArtist in a full pool', async () => {
    const { trackCount } = await generateFillerPlaylist();
    const paths = m3uPaths(liveConfig.paths.fillerPath);
    assert.equal(paths.length, trackCount, 'report matches playlist length');
    assert.equal(trackCount, 12, 'pool stays at poolSize');
    const perArtist = artistCounts(paths);
    for (const [artist, count] of perArtist) {
      assert.ok(count <= 4, `${artist} has ${count} tracks, cap is 4`);
    }
  });

  test('caps never starve the pool: fully-aired library still backfills to poolSize', async () => {
    // Second generation: the other 12 tracks are now the eligible pool.
    const first = m3uPaths(liveConfig.paths.fillerPath);
    recordFillerPlays(first.map((p) => ({ ratingKey: lookupRatingKey(p) })));
    const second = await generateFillerPlaylist();
    assert.equal(second.trackCount, 12, 'unaired half fills the pool');

    // Third generation: everything aired within the 24h window -> backfill
    // from ledger-oldest, which deliberately ignores the caps -- the pool
    // must still come out full, never decay.
    const secondPaths = m3uPaths(liveConfig.paths.fillerPath);
    recordFillerPlays(secondPaths.map((p) => ({ ratingKey: lookupRatingKey(p) })));
    const third = await generateFillerPlaylist();
    assert.equal(third.trackCount, 12, 'backfill keeps the pool full with caps active');
    const perArtist = artistCounts(m3uPaths(liveConfig.paths.fillerPath));
    assert.ok(perArtist.size >= 2, 'backfilled pool still spans multiple artists');
  });

  test('fillerRotationConfig honors the config block and falls back to defaults without it', () => {
    const rot = fillerRotationConfig();
    assert.deepEqual(rot, {
      maxTracksPerArtist: 4,
      maxTracksPerArtistAlbum: 0,
      weightWindowDays: 7,
      noveltyDays: 7,
      noveltyBoost: 3,
    });
    // F2 pattern: a config without the rotation block still behaves sensibly.
    const saved = liveConfig.filler.rotation;
    try {
      delete liveConfig.filler.rotation;
      assert.deepEqual(fillerRotationConfig(), {
        maxTracksPerArtist: 30,
        maxTracksPerArtistAlbum: 5,
        weightWindowDays: 7,
        noveltyDays: 7,
        noveltyBoost: 3,
      });
    } finally {
      liveConfig.filler.rotation = saved;
    }
  });
});
