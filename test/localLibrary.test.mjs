// localLibrary regression tests -- fixture-based, runnable on any clean
// checkout (audit 2026-10-24 finding: the previous version asserted a
// machine-specific 55-track library at a fixed path and failed everywhere
// else; the fixture library here is generated in-process).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, writeWav, repoRoot } from './fixtures.mjs';

const config = setupTestConfig('local-library');

// Library layout exercises every fallback the audit cares about:
//   folk/  -- tagless WAVs: title/artist must come from the FILENAME, genre
//             from the parent DIRECTORY name
//   rock/  -- one properly tagged file (written via a minimal ID3-free
//             approach is not possible for WAV+tags portably, so tags are
//             covered by the filenames that DO carry metadata patterns)
//   root   -- file directly in the library root: no directory genre to guess
const musicDir = path.join(config.dataDir, 'music');
const files = [
  writeWav(path.join(musicDir, 'folk', 'Ansambel Veseljak - Na okencu.wav'), 2),
  writeWav(path.join(musicDir, 'folk', 'Ansambel Veseljak - Po julijanski cesti.wav'), 2),
  writeWav(path.join(musicDir, 'rock', '03 - Skupina Ogenj - Zadnji vlak.wav'), 2), // leading track number
  writeWav(path.join(musicDir, 'rock', 'Skupina Ogenj - Brez_naslova.wav'), 2), // underscores in filename
  writeWav(path.join(musicDir, 'Brez Imena - Samota.wav'), 2), // no genre folder
];
config.autoRadio.music.localDirs = [musicDir];
fs.writeFileSync(path.join(repoRoot(), 'config.json'), JSON.stringify(config, null, 2));

const { allLocalTracks, fetchLocalCandidateTracks, localGenreTags } = await import('../src/auto/localLibrary.js');

describe('localLibrary (fixture-based)', () => {
  test('scans every fixture file exactly once', async () => {
    const tracks = await allLocalTracks();
    assert.equal(tracks.length, files.length, `expected ${files.length} tracks`);
  });

  test('every track has artist and title', async () => {
    const tracks = await allLocalTracks();
    for (const t of tracks) {
      assert.ok(t.artist, 'missing artist: ' + t.localPath);
      assert.ok(t.title, 'missing title: ' + t.localPath);
    }
  });

  test('title guessed from "Artist - Title" filename, track numbers stripped', async () => {
    const tracks = await allLocalTracks();
    const byFile = Object.fromEntries(tracks.map((t) => [path.basename(t.localPath), t]));
    assert.equal(byFile['03 - Skupina Ogenj - Zadnji vlak.wav'].title, 'Zadnji vlak');
    assert.equal(byFile['Ansambel Veseljak - Na okencu.wav'].title, 'Na okencu');
  });

  test('underscores in filenames become spaces in guessed titles', async () => {
    const tracks = await allLocalTracks();
    const t = tracks.find((x) => x.localPath.endsWith('Brez_naslova.wav'));
    assert.equal(t.title, 'Brez naslova');
  });

  test('genre falls back to the parent directory name for tagless files', async () => {
    const tracks = await allLocalTracks();
    const folk = tracks.filter((t) => t.localPath.includes('/folk/'));
    assert.ok(folk.length > 0);
    for (const t of folk) assert.ok(t.genre.includes('folk'), `${t.title} should carry folder genre "folk", got ${JSON.stringify(t.genre)}`);
    const rock = tracks.filter((t) => t.localPath.includes('/rock/'));
    for (const t of rock) assert.ok(t.genre.includes('rock'), `${t.title} should carry folder genre "rock", got ${JSON.stringify(t.genre)}`);
  });

  test('file directly in the library root still scans with at least a genre array', async () => {
    const tracks = await allLocalTracks();
    const root = tracks.find((t) => path.dirname(t.localPath) === musicDir);
    assert.ok(root, 'root-level file was scanned');
    assert.ok(Array.isArray(root.genre), 'genre is always an array');
  });

  test('genre query works against the folder fallback (rule engine compatibility)', async () => {
    const matched = await fetchLocalCandidateTracks({ genre: 'folk' });
    assert.equal(matched.length, 2, 'both folk tracks selectable by their folder genre');
    assert.deepEqual((await localGenreTags()).sort(), ['folk', 'rock']);
  });

  test('duration is real (from the WAV header), not the 210s fallback', async () => {
    const tracks = await allLocalTracks();
    for (const t of tracks) {
      assert.ok(t.durationMs >= 1900 && t.durationMs <= 2200, `2s WAV should report ~2000ms, got ${t.durationMs}`);
    }
  });
});
