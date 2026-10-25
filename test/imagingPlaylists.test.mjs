// Imaging layer regression tests: scheduler/imagingPlaylists.js's directory
// scan + .m3u writing, which is the Node half of the contract with
// liquidsoap/radio.liq's four imaging sources (id / stingers / promos /
// emergency).
//
// What these pin down, following the repo's honesty standards:
//  - only audio files in the layer directory become entries (no subdirs, no
//    non-audio files), sorted for stable output
//  - entries carry the explicit hard-cut annotate liq_fade_in="0" (imaging
//    clips are speech-family: they must never be faded like music tracks)
//  - a missing or empty directory writes an EMPTY .m3u (honest degradation:
//    the Liquidsoap layer becomes unavailable instead of erroring or
//    fabricating content)
//  - the summary returned to the caller reports counts and dirMissing, so
//    callers/tests never have to parse logs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav } from './fixtures.mjs';

setupTestConfig('imaging-playlists', {
  imaging: { checkIntervalMinutes: 30 },
});

const { config } = await import('../src/config/index.js');
const { buildImagingEntries, writeImagingPlaylists, LAYER_TAGS } = await import(
  '../src/scheduler/imagingPlaylists.js'
);

describe('buildImagingEntries', () => {
  test('collects only audio files, sorted, with hard-cut annotate entries', () => {
    const dir = config.paths.imagingIdDir;
    fs.mkdirSync(dir, { recursive: true });
    writeWav(path.join(dir, 'b.wav'));
    writeWav(path.join(dir, 'a.wav'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not audio');
    // Uppercase extension: matched case-insensitively against the allow-list,
    // and .png is not an audio extension either way -- must be excluded.
    fs.writeFileSync(path.join(dir, 'Cover.PNG'), 'not audio');
    fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });
    writeWav(path.join(dir, 'subdir', 'nested.wav'));

    const { entries, dirMissing } = buildImagingEntries(dir);
    assert.equal(dirMissing, false);
    assert.deepEqual(entries, [path.join(dir, 'a.wav'), path.join(dir, 'b.wav')]);
  });

  test('a missing directory is reported, not thrown', () => {
    const missing = path.join(config.dataDir, 'imaging', 'does-not-exist');
    const { entries, dirMissing } = buildImagingEntries(missing);
    assert.equal(dirMissing, true);
    assert.deepEqual(entries, []);
  });

  test('an empty directory yields zero entries and no dirMissing flag', () => {
    const dir = config.paths.imagingStingerDir;
    fs.mkdirSync(dir, { recursive: true });
    const { entries, dirMissing } = buildImagingEntries(dir);
    assert.equal(dirMissing, false);
    assert.deepEqual(entries, []);
  });
});

describe('writeImagingPlaylists', () => {
  // Tests within this file share one dataDir (setupTestConfig wipes it once
  // per FILE, not per test), so each IO test resets the clip directories
  // itself to stay independent of buildImagingEntries tests above.
  function resetImagingDirs() {
    fs.rmSync(path.join(config.dataDir, 'imaging'), { recursive: true, force: true });
  }

  test('writes playlists from clip dirs; missing dirs become empty m3u files', () => {
    resetImagingDirs();
    fs.mkdirSync(config.paths.imagingIdDir, { recursive: true });
    fs.mkdirSync(config.paths.imagingStingerDir, { recursive: true });
    writeWav(path.join(config.paths.imagingIdDir, 'id-1.wav'));
    writeWav(path.join(config.paths.imagingIdDir, 'id-2.wav'));
    writeWav(path.join(config.paths.imagingStingerDir, 'sting-1.wav'));
    // The promos layer (Paket B2): same contract as the siblings -- the m3u
    // lists whatever is in the dir, whether the clips came from
    // promoProducer.js or the operator's hand.
    fs.mkdirSync(config.paths.imagingPromosDir, { recursive: true });
    writeWav(path.join(config.paths.imagingPromosDir, 'promo-hosted.wav'));
    writeWav(path.join(config.paths.imagingPromosDir, 'moj-promo.wav'));
    // emergency dir deliberately NOT created.

    const summary = writeImagingPlaylists();

    assert.deepEqual(
      summary.id,
      { count: 2, dirMissing: false, path: config.paths.imagingIdPath }
    );
    assert.deepEqual(
      summary.stingers,
      { count: 1, dirMissing: false, path: config.paths.imagingStingerPath }
    );
    assert.deepEqual(
      summary.promos,
      { count: 2, dirMissing: false, path: config.paths.imagingPromosPath }
    );
    assert.deepEqual(
      summary.emergency,
      { count: 0, dirMissing: true, path: config.paths.imagingEmergencyPath }
    );

    const idLines = fs.readFileSync(config.paths.imagingIdPath, 'utf8').trim().split('\n');
    assert.equal(idLines.length, 2);
    for (const line of idLines) {
      assert.match(line, /^annotate:source_tag="id",liq_fade_in="0":/);
      assert.match(line, /imaging\/id\/id-[12]\.wav$/);
    }

    const stingerLines = fs.readFileSync(config.paths.imagingStingerPath, 'utf8').trim().split('\n');
    assert.equal(stingerLines.length, 1);

    const promoLines = fs.readFileSync(config.paths.imagingPromosPath, 'utf8').trim().split('\n');
    assert.equal(promoLines.length, 2);
    for (const line of promoLines) {
      assert.match(line, /^annotate:source_tag="promo",liq_fade_in="0":/);
    }

    // Missing dir -> EMPTY file (not garbage, not fabricated entries).
    assert.equal(fs.readFileSync(config.paths.imagingEmergencyPath, 'utf8'), '');
  });

  test('a rescan with an emptied directory empties the playlist (watch reload refills honestly)', () => {
    resetImagingDirs();
    fs.mkdirSync(config.paths.imagingStingerDir, { recursive: true });
    writeWav(path.join(config.paths.imagingStingerDir, 'gone.wav'));
    writeImagingPlaylists();
    fs.rmSync(config.paths.imagingStingerDir, { recursive: true, force: true });
    const summary = writeImagingPlaylists();
    assert.equal(summary.stingers.count, 0);
    assert.equal(summary.stingers.dirMissing, true);
    assert.equal(fs.readFileSync(config.paths.imagingStingerPath, 'utf8'), '');
  });
});

// Atomic + idempotent write discipline (the writeStreamsLiq pattern, pinned
// here for the three Liquidsoap-WATCHED m3u files): radio.liq reloads on
// mtime (reload_mode="watch"), so (a) a re-scan with an IDENTICAL clip set
// must not touch the file at all -- the reload fires only when the SET
// changes -- and (b) a real change must swap atomically (tmp-<pid>+rename),
// never letting the watcher catch a half-written (momentarily empty) layer,
// the emergency bed included.
describe('writeImagingPlaylists write discipline (watched files)', () => {
  // Same reset as the suite above (its helper is scoped inside that describe).
  function resetImagingDirs() {
    fs.rmSync(path.join(config.dataDir, 'imaging'), { recursive: true, force: true });
  }

  test('identical clip set: no rewrite at all (mtime untouched, watch-reload stays quiet)', () => {
    resetImagingDirs();
    fs.mkdirSync(config.paths.imagingIdDir, { recursive: true });
    writeWav(path.join(config.paths.imagingIdDir, 'id-1.wav'));
    writeWav(path.join(config.paths.imagingIdDir, 'id-2.wav'));

    writeImagingPlaylists();
    const afterFirst = fs.statSync(config.paths.imagingIdPath).mtimeMs;

    // A plain 30-min-tick rescan with the same clips on disk.
    writeImagingPlaylists();
    assert.equal(fs.statSync(config.paths.imagingIdPath).mtimeMs, afterFirst);

    // Not even a fresh file timestamp sneaks a rewrite through: touching a
    // clip's mtime changes nothing, the SET is still identical.
    fs.utimesSync(path.join(config.paths.imagingIdDir, 'id-1.wav'), new Date(), new Date());
    writeImagingPlaylists();
    assert.equal(fs.statSync(config.paths.imagingIdPath).mtimeMs, afterFirst);
  });

  test('a changed clip set DOES rewrite (the watch-reload fires for real changes)', () => {
    resetImagingDirs();
    fs.mkdirSync(config.paths.imagingStingerDir, { recursive: true });
    writeWav(path.join(config.paths.imagingStingerDir, 'a.wav'));
    writeImagingPlaylists();
    const before = fs.statSync(config.paths.imagingStingerPath).mtimeMs;

    writeWav(path.join(config.paths.imagingStingerDir, 'b.wav'));
    writeImagingPlaylists();

    assert.notEqual(fs.statSync(config.paths.imagingStingerPath).mtimeMs, before);
    assert.equal(fs.readFileSync(config.paths.imagingStingerPath, 'utf8').trim().split('\n').length, 2);
  });

  test('the swap is atomic: no .tmp siblings left behind on any path', () => {
    resetImagingDirs();
    fs.mkdirSync(config.paths.imagingIdDir, { recursive: true });
    writeWav(path.join(config.paths.imagingIdDir, 'id-1.wav'));
    writeImagingPlaylists();
    writeImagingPlaylists(); // immediate second tick -- the identical-skip path
    const imagingDir = path.dirname(config.paths.imagingIdPath);
    const leftovers = fs.readdirSync(imagingDir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

// Fourth layer (Paket B2): the promos layer is additive to the summary and
// the LAYER_TAGS contract -- its clips are auto-produced by promoProducer.js
// when enabled, but the SCAN treats generated and operator clips
// identically, so these pins only re-state the shared contract for the new
// name.
describe('writeImagingPlaylists fourth layer (promos)', () => {
  function resetImagingDirs() {
    fs.rmSync(path.join(config.dataDir, 'imaging'), { recursive: true, force: true });
  }

  test('LAYER_TAGS.promos is "promo" (one tag per layer, closed set)', () => {
    assert.equal(LAYER_TAGS.promos, 'promo');
    assert.equal(Object.keys(LAYER_TAGS).length, 4);
  });

  test('missing promos dir -> empty promos.m3u + honest summary entry', () => {
    resetImagingDirs();
    // No imaging dirs at all: the promos entry must still exist and tell the
    // truth (count 0, dirMissing true) -- an additive key, never an
    // undefined one a Diagnostics surface would have to guess about.
    const summary = writeImagingPlaylists();
    assert.deepEqual(
      summary.promos,
      { count: 0, dirMissing: true, path: config.paths.imagingPromosPath }
    );
    assert.equal(fs.readFileSync(config.paths.imagingPromosPath, 'utf8'), '');
  });

  test('idempotence: an identical promos clip set leaves the file (and mtime) alone', () => {
    resetImagingDirs();
    fs.mkdirSync(config.paths.imagingPromosDir, { recursive: true });
    writeWav(path.join(config.paths.imagingPromosDir, 'promo_a.wav'));
    writeWav(path.join(config.paths.imagingPromosDir, 'promo_b.wav'));
    writeImagingPlaylists();
    const afterFirst = fs.statSync(config.paths.imagingPromosPath).mtimeMs;
    const bytes = fs.readFileSync(config.paths.imagingPromosPath, 'utf8');

    writeImagingPlaylists(); // the promoProducer's end-of-wave refresh: same set
    assert.equal(fs.readFileSync(config.paths.imagingPromosPath, 'utf8'), bytes);
    assert.equal(fs.statSync(config.paths.imagingPromosPath).mtimeMs, afterFirst);
  });
});
