import { test, describe } from 'node:test';
import path from "node:path";
import assert from 'node:assert/strict';
import { allLocalTracks } from '../src/auto/localLibrary.js';

describe('localLibrary', () => {
  test('finds all 55 tracks', async () => {
    const tracks = await allLocalTracks();
    assert.equal(tracks.length, 55, 'Expected 55 tracks, got ' + tracks.length);
  });

  test('every track has artist and title', async () => {
    const tracks = await allLocalTracks();
    for (const t of tracks) {
      assert.ok(t.artist, 'Track missing artist: ' + t.localPath);
      assert.ok(t.title, 'Track missing title: ' + t.localPath);
    }
  });

  test('every track has at least one genre', async () => {
    const tracks = await allLocalTracks();
    for (const t of tracks) {
      assert.ok(Array.isArray(t.genre) && t.genre.length > 0, 'Track missing genre: ' + t.artist + ' - ' + t.title);
    }
  });

  test('genre includes directory name', async () => {
    const tracks = await allLocalTracks();
    const withDirGenre = tracks.filter(t => {
      const dir = path.basename(path.dirname(t.localPath));
      return t.genre.includes(dir);
    });
    assert.ok(withDirGenre.length > 0, 'No track has directory name as genre');
  });

  test('track has durationMs', async () => {
    const tracks = await allLocalTracks();
    const withDuration = tracks.filter(t => t.durationMs && t.durationMs > 0);
    assert.ok(withDuration.length > 0, 'No track has duration');
  });
});
