// Diagnostics primitives (server/diagnosticsUtil.js) + error ring
// (lib/errorRing.js) -- issue #2 section B.1/B.6: real stream/service
// status, recent errors, and duplicate/repeat warnings. The repeat detector
// here is the runtime-facing half of the hourly-repeat regression guard
// (test/fillerRotation.test.mjs covers the generation side).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

const config = setupTestConfig('diagnostics-util');

const { playlistStats, tailFile, repeatOffenders, probeIcecast } = await import('../src/server/diagnosticsUtil.js');
const { recordError, recentErrors, clearErrorsForTest } = await import('../src/lib/errorRing.js');

describe('playlistStats', () => {
  test('counts real entries, ignores comments and blanks', () => {
    const file = path.join(config.dataDir, 'np.m3u');
    fs.writeFileSync(file, '#EXTM3U\nannotate:title="A":/music/a.mp3\n\nannotate:title="B":/music/b.mp3\n');
    const stats = playlistStats(file);
    assert.equal(stats.exists, true);
    assert.equal(stats.entries, 2);
    assert.ok(stats.mtime);
  });

  test('missing playlist reports exists:false, not an error', () => {
    const stats = playlistStats(path.join(config.dataDir, 'nope.m3u'));
    assert.deepEqual({ exists: stats.exists, mtime: stats.mtime, entries: stats.entries }, { exists: false, mtime: null, entries: 0 });
  });
});

describe('tailFile', () => {
  test('returns the last N lines oldest-first; missing file is empty', () => {
    const file = path.join(config.dataDir, 'fake.log');
    fs.writeFileSync(file, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const tail = tailFile(file, 3);
    assert.deepEqual(tail, ['line 8', 'line 9', 'line 10']);
    assert.deepEqual(tailFile(path.join(config.dataDir, 'missing.log'), 3), []);
  });
});

describe('repeatOffenders (aired-history repeat detector)', () => {
  const NOW = Date.now();
  const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

  test('flags tracks aired minCount+ times inside the window only', () => {
    const entries = [
      { ratingKey: 'r1', artist: 'A', title: 'T1', playedAt: hoursAgo(1) },
      { ratingKey: 'r1', artist: 'A', title: 'T1', playedAt: hoursAgo(5) },
      { ratingKey: 'r2', artist: 'B', title: 'T2', playedAt: hoursAgo(2) }, // once -- not an offender
      { ratingKey: 'r3', artist: 'C', title: 'T3', playedAt: hoursAgo(30) }, // repeated but OUTSIDE 24h window
      { ratingKey: 'r3', artist: 'C', title: 'T3', playedAt: hoursAgo(50) },
    ];
    const offenders = repeatOffenders(entries, 24, NOW);
    assert.equal(offenders.length, 1);
    assert.equal(offenders[0].ratingKey, 'r1');
    assert.equal(offenders[0].count, 2);
    assert.equal(offenders[0].artist, 'A');
  });

  test('sorts by count then recency', () => {
    const entries = [
      { ratingKey: 'x1', artist: 'X', title: 'X1', playedAt: hoursAgo(1) },
      { ratingKey: 'x1', artist: 'X', title: 'X1', playedAt: hoursAgo(2) },
      { ratingKey: 'x1', artist: 'X', title: 'X1', playedAt: hoursAgo(3) },
      { ratingKey: 'y1', artist: 'Y', title: 'Y1', playedAt: hoursAgo(1) },
      { ratingKey: 'y1', artist: 'Y', title: 'Y1', playedAt: hoursAgo(2) },
    ];
    const offenders = repeatOffenders(entries, 24, NOW);
    assert.equal(offenders[0].ratingKey, 'x1');
    assert.equal(offenders[1].ratingKey, 'y1');
  });

  test('clean history yields zero offenders (the number the issue asks to expose)', () => {
    assert.deepEqual(repeatOffenders([{ ratingKey: 'z', artist: 'Z', title: 'Z1', playedAt: hoursAgo(1) }], 24, NOW), []);
  });
});

describe('probeIcecast (honest failure reporting)', () => {
  test('unreachable Icecast reports reachable:false with the error', async () => {
    // Port 1 on loopback: nothing listens there in the test environment.
    const res = await probeIcecast('http://127.0.0.1:1', 500);
    assert.equal(res.reachable, false);
    assert.equal(res.listeners, null);
    assert.ok(res.error);
  });
});

describe('errorRing', () => {
  test('records, orders newest-first, and caps entries', () => {
    clearErrorsForTest();
    for (let i = 0; i < 130; i++) recordError('test', new Error(`e${i}`));
    const all = recentErrors(200);
    assert.equal(all.length, 100); // MAX_ENTRIES cap
    assert.equal(all[0].message, 'e129'); // newest first
    assert.equal(all[0].source, 'test');
    const few = recentErrors(3);
    assert.equal(few.length, 3);
    assert.equal(few[0].message, 'e129');
    clearErrorsForTest();
    assert.equal(recentErrors(10).length, 0);
  });

  test('recording never throws, even on garbage input', () => {
    assert.doesNotThrow(() => recordError('x', undefined));
    assert.doesNotThrow(() => recordError('x', null, { extra: true }));
  });
});
