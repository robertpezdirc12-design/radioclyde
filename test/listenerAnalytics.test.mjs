// Listener analytics regression tests: the sampling ledger
// (analytics/listenerSamples.js) and the impact math
// (analytics/listenerImpact.js) behind the studio Analytics view.
//
// What these pin down, following the repo's honesty standards:
//  - a failed Icecast poll is STORED as a gap entry ({listeners: null,
//    error}), not skipped and not fabricated
//  - showId correlation comes from now_playing_track.json and is null when
//    that file is absent/speech-only
//  - buildSeries buckets average non-null samples, count gaps per bucket,
//    and mark sample-less buckets as explicit holes
//  - trackImpact measures only plays with enough non-gap samples AND enough
//    time coverage; everything it can't measure honestly is counted in
//    `skipped` by reason, never silently dropped
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('listener-analytics', {
  analytics: {
    sampleIntervalMinutes: 1,
    maxEntries: 100,
    impactWindowHours: 168,
    impactMinSamples: 2,
    impactMinCoverage: 0.5,
  },
});

const { sampleOnce, readSamples, pruneSamples, samplesLedgerPath } = await import(
  '../src/analytics/listenerSamples.js'
);
const { buildSeries, trackImpact } = await import('../src/analytics/listenerImpact.js');
// The processed module config (has config.paths derived from dataDir).
const { config: liveConfig } = await import('../src/config/index.js');

describe('listener sampling ledger', () => {
  test('a successful poll stores an honest numeric entry with no error field', async () => {
    const entry = await sampleOnce(async () => 7);
    assert.equal(entry.listeners, 7);
    assert.equal(entry.showId, null, 'no now_playing_track.json in a fresh fixture dir -> showId is null');
    assert.ok(!('error' in entry), 'no error field on a good sample');
    const stored = JSON.parse(fs.readFileSync(samplesLedgerPath(), 'utf8').trim().split('\n').pop());
    assert.equal(stored.listeners, 7);
    assert.ok(Number.isFinite(new Date(stored.ts).getTime()), 'ts is a parseable ISO string');
  });

  test('a failed poll stores a gap entry with the real error text', async () => {
    const gap = await sampleOnce(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8000');
    });
    assert.equal(gap.listeners, null);
    assert.match(gap.error, /ECONNREFUSED/);
    const onDisk = readSamples();
    const last = onDisk[onDisk.length - 1];
    assert.equal(last.listeners, null, 'the gap is persisted, not swallowed');
    assert.match(last.error, /ECONNREFUSED/);
  });

  test('a non-numeric count is a gap, not a number', async () => {
    const bad = await sampleOnce(async () => 'lots');
    assert.equal(bad.listeners, null);
    assert.match(bad.error, /non-numeric/);
  });

  test('showId is correlated from now_playing_track.json when present', async () => {
    fs.writeFileSync(
      liveConfig.paths.nowPlayingTrackPath,
      JSON.stringify({ ratingKey: 'abc', artist: 'A', title: 'T', showId: 'morning-show', playedAt: '2026-10-24T10:00:00.000+02:00' })
    );
    const entry = await sampleOnce(async () => 3);
    assert.equal(entry.showId, 'morning-show');
    fs.rmSync(liveConfig.paths.nowPlayingTrackPath, { force: true });
  });

  test('readSamples skips torn lines and sorts chronologically', () => {
    const file = samplesLedgerPath();
    fs.writeFileSync(
      file,
      '{"ts":"2026-10-24T10:02:00.000+02:00","listeners":5}\n' +
        '{"ts":"2026-10-24T10:0\n' + // torn (interrupted append)
        '{"ts":"2026-10-24T10:01:00.000+02:00","listeners":9}\n'
    );
    const samples = readSamples();
    assert.equal(samples.length, 2);
    assert.ok(new Date(samples[0].ts) <= new Date(samples[1].ts), 'sorted oldest first');
    assert.equal(samples[0].listeners, 9);
  });

  test('pruneSamples keeps the newest maxEntries lines', () => {
    const file = samplesLedgerPath();
    const lines = [];
    for (let i = 0; i < 15; i++) {
      lines.push(JSON.stringify({ ts: new Date(Date.parse('2026-10-24T12:00:00Z') + i * 60_000).toISOString(), listeners: i }));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n');
    pruneSamples(10);
    const kept = readSamples();
    assert.equal(kept.length, 10);
    assert.equal(kept[0].listeners, 5, 'oldest five were dropped, newest ten kept');
    assert.equal(kept[kept.length - 1].listeners, 14);
  });
});

describe('buildSeries (chart downsampling)', () => {
  const t0 = Date.parse('2026-10-24T12:00:00Z');

  test('buckets average non-null samples, count gaps, mark holes', () => {
    const samples = [
      { ts: new Date(t0 + 10_000).toISOString(), listeners: 4 },
      { ts: new Date(t0 + 30_000).toISOString(), listeners: 6 },
      { ts: new Date(t0 + 70_000).toISOString(), listeners: 2 },
      { ts: new Date(t0 + 90_000).toISOString(), listeners: null, error: 'timeout' },
    ];
    const series = buildSeries(samples, { from: t0, to: t0 + 3 * 60_000, bucketMs: 60_000 });
    assert.equal(series.buckets.length, 3);
    assert.equal(series.buckets[0].listeners, 5, '(4+6)/2 = 5');
    assert.equal(series.buckets[0].samples, 2);
    assert.equal(series.buckets[1].listeners, 2);
    assert.equal(series.buckets[1].gaps, 1, 'the gap sample is counted, not hidden');
    assert.equal(series.buckets[2].listeners, null);
    assert.equal(series.buckets[2].empty, true, 'sample-less bucket is an explicit hole');
    assert.equal(series.gaps, 1);
  });

  test('a bucket where every sample was a gap reads listeners:null with gaps set', () => {
    const samples = [
      { ts: new Date(t0 + 10_000).toISOString(), listeners: null, error: 'down' },
      { ts: new Date(t0 + 20_000).toISOString(), listeners: null, error: 'down' },
    ];
    const series = buildSeries(samples, { from: t0, to: t0 + 60_000, bucketMs: 60_000 });
    assert.equal(series.buckets[0].listeners, null);
    assert.equal(series.buckets[0].gaps, 2);
    assert.equal(series.buckets[0].empty, false, 'samples existed -- an outage, not a hole');
  });

  test('samples outside [from,to] are excluded', () => {
    const samples = [
      { ts: new Date(t0 - 60_000).toISOString(), listeners: 99 },
      { ts: new Date(t0 + 10_000).toISOString(), listeners: 3 },
    ];
    const series = buildSeries(samples, { from: t0, to: t0 + 60_000, bucketMs: 60_000 });
    assert.equal(series.buckets[0].listeners, 3);
  });
});

describe('trackImpact (per-track listener delta)', () => {
  const now = Date.parse('2026-10-24T20:00:00Z');
  const min = 60_000;
  const at = (base, offsetSec) => new Date(base + offsetSec * 1000).toISOString();

  test('measures covered plays, aggregates repeats, skips the rest honestly', () => {
    const samples = [];
    // Track A, play 1 (5 min track, 5 covered samples): 5 5 4 4 3 -> start 5, end 3, delta -2
    const a1 = now - 120 * min;
    [[30, 5], [90, 5], [150, 4], [210, 4], [270, 3]].forEach(([s, v]) => samples.push({ ts: at(a1, s), listeners: v }));
    // Track A, play 2 (same track): 3 4 4 4 -> start 3, end 4, delta +1
    const a2 = now - 60 * min;
    [[30, 3], [90, 4], [150, 4], [210, 4]].forEach(([s, v]) => samples.push({ ts: at(a2, s), listeners: v }));
    // Track G (5 min, covered): 2 3 3 4 -> delta +2
    const g = now - 15 * min;
    [[30, 2], [90, 3], [150, 3], [210, 4]].forEach(([s, v]) => samples.push({ ts: at(g, s), listeners: v }));
    // Track B (4 min, ONE sample) -> tooFewSamples
    const b = now - 30 * min;
    samples.push({ ts: at(b, 30), listeners: 5 });
    // Track C (3 min, all-gap samples) -> noData
    const c = now - 20 * min;
    [[30, null], [90, null]].forEach(([s, v]) => samples.push({ ts: at(c, s), listeners: v, error: 'down' }));
    // Track E (10 min, span 30s < 50% of 600s) -> thinCoverage
    const e = now - 5 * min;
    [[30, 4], [60, 4]].forEach(([s, v]) => samples.push({ ts: at(e, s), listeners: v }));
    // Track F, aired 8 days ago (outside the 168h window) -> invisible
    const f = now - 8 * 24 * 60 * min;
    [[30, 9], [90, 9], [150, 9]].forEach(([s, v]) => samples.push({ ts: at(f, s), listeners: v }));

    const aired = [
      { ratingKey: 'track-a', artist: 'Artist A', title: 'Song A', durationMs: 5 * min, playedAt: new Date(a1).toISOString() },
      { ratingKey: 'track-a', artist: 'Artist A', title: 'Song A', durationMs: 5 * min, playedAt: new Date(a2).toISOString() },
      { ratingKey: 'track-g', artist: 'Artist G', title: 'Song G', durationMs: 5 * min, playedAt: new Date(g).toISOString() },
      { ratingKey: 'track-b', artist: 'Artist B', title: 'Song B', durationMs: 4 * min, playedAt: new Date(b).toISOString() },
      { ratingKey: 'track-c', artist: 'Artist C', title: 'Song C', durationMs: 3 * min, playedAt: new Date(c).toISOString() },
      { ratingKey: null, artist: 'Artist E', title: 'Song E', durationMs: 10 * min, playedAt: new Date(e).toISOString() },
      { ratingKey: 'track-d', artist: 'Artist D', title: 'Song D', durationMs: null, playedAt: new Date(now - 10 * min).toISOString() }, // noDuration
      { ratingKey: 'track-f', artist: 'Artist F', title: 'Song F', durationMs: 5 * min, playedAt: new Date(f).toISOString() },
    ];

    const impact = trackImpact(aired, samples, { windowHours: 168, minSamples: 2, minCoverage: 0.5, now });

    assert.equal(impact.measuredTracks, 2, 'only A and G are measurable');
    const a = impact.measured.find((t) => t.ratingKey === 'track-a');
    assert.ok(a, 'track A measured');
    assert.equal(a.plays, 2);
    assert.equal(a.avgDelta, -0.5, '(-2 + +1) / 2 plays');
    assert.equal(a.listenersAvg, 4, '(4.2 + 3.75) / 2 = 3.975 -> 4.0 at 1 decimal');
    const gRec = impact.measured.find((t) => t.ratingKey === 'track-g');
    assert.equal(gRec.avgDelta, 2);
    assert.ok(impact.measured[0].avgDelta <= impact.measured[1].avgDelta, 'biggest losses sort first');

    assert.deepEqual(impact.skipped, {
      noDuration: 1,
      noData: 1,
      tooFewSamples: 1,
      thinCoverage: 1,
    });
    assert.ok(!impact.measured.some((t) => t.ratingKey === 'track-f'), 'outside-window entry is absent, not "measured 0"');
  });

  test('entries without a ratingKey group by "artist — title"', () => {
    const start = now - 60 * min;
    const samples = [[30, 2], [90, 2], [150, 5], [210, 5]].map(([s, v]) => ({ ts: at(start, s), listeners: v }));
    const aired = [{ ratingKey: null, artist: 'Local', title: 'Band', durationMs: 5 * min, playedAt: new Date(start).toISOString() }];
    const impact = trackImpact(aired, samples, { windowHours: 168, minSamples: 2, minCoverage: 0.5, now });
    assert.equal(impact.measured.length, 1);
    assert.equal(impact.measured[0].key, 'Local — Band');
    assert.equal(impact.measured[0].ratingKey, null);
    assert.equal(impact.measured[0].avgDelta, 3);
  });

  test('an empty ledger yields an explicit empty result, not zeros dressed as data', () => {
    const impact = trackImpact([], [], { windowHours: 168, now });
    assert.equal(impact.measuredTracks, 0);
    assert.deepEqual(impact.skipped, { noDuration: 0, noData: 0, tooFewSamples: 0, thinCoverage: 0 });
    assert.deepEqual(impact.measured, []);
  });
});
