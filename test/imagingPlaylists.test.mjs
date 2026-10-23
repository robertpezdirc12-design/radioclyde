// Imaging layer regression tests: scheduler/imagingPlaylists.js's directory
// scan + .m3u writing, which is the Node half of the contract with
// liquidsoap/radio.liq's three imaging sources (id / stingers / emergency).
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
const { buildImagingEntries, writeImagingPlaylists } = await import(
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
      summary.emergency,
      { count: 0, dirMissing: true, path: config.paths.imagingEmergencyPath }
    );

    const idLines = fs.readFileSync(config.paths.imagingIdPath, 'utf8').trim().split('\n');
    assert.equal(idLines.length, 2);
    for (const line of idLines) {
      assert.match(line, /^annotate:liq_fade_in="0":/);
      assert.match(line, /imaging\/id\/id-[12]\.wav$/);
    }

    const stingerLines = fs.readFileSync(config.paths.imagingStingerPath, 'utf8').trim().split('\n');
    assert.equal(stingerLines.length, 1);

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
