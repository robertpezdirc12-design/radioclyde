// Regression test for the audited "songs repeat every hour" defect
// (robertpezdirc12-design/radioclyde issue #1, Priority 1).
//
// Root cause this guards against: filler.m3u regenerations had NO memory of
// what filler had aired (played.jsonl is reserved for show plays by design),
// so on a library that fits inside one playlist pass every regeneration
// re-picked the same songs -- measured pre-fix: 12/12 identical tracks in two
// consecutive generations -- and Liquidsoap replayed the same static file in
// between. The fix is the filler rotation ledger (scheduler/fillerRotation.js)
// + rotation-aware pool selection (scheduler/generateFillerPlaylist.js).
//
// These tests run the REAL pipeline end-to-end: real WAV fixtures on disk,
// real localLibrary scan, real generateFillerPlaylist, real ledger file --
// with filler plays recorded between "hours" exactly the way scrobbleTrack.js
// records them from radio.liq's on_metadata hook on a live station.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav, m3uPaths, repoRoot } from './fixtures.mjs';

const config = setupTestConfig('filler-rotation', {
  filler: { poolSize: 6, regenerateIntervalMinutes: 360, maxTrackDurationSeconds: 600, rotationWindowHours: 24 },
});

// 12 tracks (2x poolSize) -- enough for two fully disjoint consecutive pools.
const musicDir = path.join(config.dataDir, 'music');
for (let i = 1; i <= 12; i++) {
  writeWav(path.join(musicDir, `Artist ${String(i).padStart(2, '0')} - Song ${String(i).padStart(2, '0')}.wav`), 2);
}
config.autoRadio.music.localDirs = [musicDir];
// config.json was already written by setupTestConfig BEFORE localDirs pointed
// anywhere; rewrite it with the final value, then import src modules (their
// module-load is what reads config.json).
fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(config, null, 2));

const { generateFillerPlaylist } = await import('../src/scheduler/generateFillerPlaylist.js');
const { recordFillerPlays, fillerLedgerPath, recentFillerPlays, pruneLedger } = await import('../src/scheduler/fillerRotation.js');
const { lookupRatingKey } = await import('../src/plex/ratingKeyIndex.js');
// The processed module config (has config.paths derived from dataDir).
const { config: liveConfig } = await import('../src/config/index.js');

// One "hour" of station life: regenerate the pool, then record what aired
// (scrobbleTrack.js does recordFillerPlays([ratingKey]) per filler segment).
async function generation(label) {
  const { trackCount } = await generateFillerPlaylist();
  const paths = m3uPaths(liveConfig.paths.fillerPath);
  assert.equal(paths.length, trackCount, `${label}: playlist entry count matches report`);
  recordFillerPlays(paths.map((p) => ({ ratingKey: lookupRatingKey(p) })));
  return paths;
}

describe('filler rotation (hourly repetition regression)', () => {
  test('consecutive generations on a 12-track library pick disjoint halves', async () => {
    const gen1 = await generation('gen1');
    assert.equal(gen1.length, 6, 'pool is poolSize=6');

    const gen2 = await generation('gen2');
    const overlap = gen2.filter((p) => gen1.includes(p));
    assert.equal(
      overlap.length, 0,
      `consecutive hours must not repeat tracks (pre-fix behavior: 12/12 identical across generations; got ${overlap.length} repeated: ${overlap.join(', ')})`
    );

    // Second hour aired: the whole library is now inside the 24h window. The
    // pool must STILL come out full-size (backfill from oldest-rotated), never
    // decay into an even tinier loop.
    const gen3 = await generation('gen3');
    assert.equal(gen3.length, 6, 'backfill keeps the pool at poolSize when every track is inside the window');
  });

  test('rotation window expiry makes tracks eligible again', async () => {
    // A track aired 25h ago (window=24h) must be eligible again -- the ledger
    // is a rolling window, not a ban.
    const ledgerFile = fillerLedgerPath();
    const old = [{ ratingKey: 'oldkey000001', playedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }];
    fs.writeFileSync(ledgerFile, old.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const recent = recentFillerPlays(24);
    assert.equal(recent.size, 0, 'entries outside the window are not excluded');
  });

  test('torn ledger lines never crash a regeneration', async () => {
    const ledgerFile = fillerLedgerPath();
    fs.writeFileSync(
      ledgerFile,
      '{"ratingKey":"abc123",\n' + // torn line (simulated interrupted append)
        '{"ratingKey":"def456","playedAt":"2026-10-24T10:00:00.000Z"}\n'
    );
    const recent = recentFillerPlays(24);
    assert.equal(recent.size, 1, 'only the well-formed line counts');
    assert.ok(pruneLedger(2) === undefined, 'prune is safe to call');
  });
});
