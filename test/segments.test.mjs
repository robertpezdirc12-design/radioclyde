// Tests for the WRIT-FM segment taxonomy + min-inventory metric (P2 #7 --
// script/segments.js, its format.js `segment:` field, and the Diagnostics
// readiness util inventoryUtil.js).
//
// Three layers, mirroring how the feature is built:
//   A. the taxonomy itself: closed set, slot/position inference, explicit
//      tags always win, tracks are never speech content,
//   B. the min-inventory metric: counts, duration-scaled track threshold,
//      shortfalls spelled out, F2 config defaults,
//   C. end-to-end: parseScript carries the optional field, buildSegmentsAuto
//      output classifies through its slots, and inventoryForOccurrence
//      reports honestly over real files on disk.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('segments', {});

const {
  SEGMENT_TYPES,
  STATION_ID_OWNER,
  isSegmentType,
  classifySegment,
  segmentInventory,
} = await import('../src/script/segments.js');
const { parseScript, renderScript } = await import('../src/script/format.js');
const { inventoryForOccurrence, inventoryThresholds } = await import('../src/server/inventoryUtil.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { config: liveConfig } = await import('../src/config/index.js');

const dj = (body, extra = {}) => ({ type: 'dj', persona: 'ryan', body, ...extra });
const liveSeg = (extra = {}) => ({ type: 'live', persona: 'elena', kind: 'time-weather', brief: 'x', ...extra });
const trackSeg = (ratingKey = '123') => ({ type: 'track', artist: 'A', title: 'T', ratingKey });

describe('taxonomy (closed set + inference)', () => {
  test('the set is closed, unique, and contains every WRIT-FM type we adopted', () => {
    assert.equal(new Set(SEGMENT_TYPES).size, SEGMENT_TYPES.length, 'no duplicates');
    for (const t of ['show_intro', 'show_outro', 'listener_mailbag', 'news_analysis', 'deep_dive', 'story', 'music_essay', 'banter']) {
      assert.ok(SEGMENT_TYPES.includes(t), `${t} present`);
    }
    // Our reality adds the types WRIT never named:
    for (const t of ['track_intro', 'quiz', 'weather_check', 'interview', 'panel']) {
      assert.ok(SEGMENT_TYPES.includes(t), `${t} present`);
    }
    assert.ok(isSegmentType('banter'));
    assert.equal(isSegmentType('MAILBAG'), false, 'exact strings only, no case folding');
    assert.equal(isSegmentType(null), false);
    assert.ok(typeof STATION_ID_OWNER === 'string' && STATION_ID_OWNER.includes('imaging'), 'station_id ownership recorded');
  });

  test('classifySegment: explicit tag always wins over slot and position', () => {
    assert.equal(classifySegment(dj('x', { slot: 'open', segment: 'listener_mailbag' })), 'listener_mailbag');
    assert.equal(classifySegment(dj('x', { segment: 'deep_dive' }), { isFirstSpeech: true }), 'deep_dive');
    assert.equal(classifySegment(liveSeg({ segment: 'story' })), 'story', 'explicit tag on live too');
  });

  test('classifySegment: slot vocabulary maps to types; handoff and unknown slots are banter', () => {
    for (const [slot, expected] of [
      ['open', 'show_intro'],
      ['close', 'show_outro'],
      ['intro', 'track_intro'],
      ['recap', 'track_intro'],
      ['quizIntro', 'quiz'],
      ['quizReveal', 'quiz'],
      ['newsHeadlines', 'news_analysis'],
      ['sportHeadlines', 'news_analysis'],
      ['obzorje', 'news_analysis'],
      ['obzorjeGlasba', 'news_analysis'],
      ['triviaArtist', 'story'],
      ['triviaGeneral', 'music_essay'],
      ['weatherNow', 'weather_check'],
      ['handoff', 'banter'],
      ['mysterySlot', 'banter'],
    ]) {
      assert.equal(classifySegment(dj('x', { slot })), expected, `slot ${slot}`);
    }
  });

  test('classifySegment: unslotted speech infers intro/outro from position, banter in between', () => {
    assert.equal(classifySegment(dj('x'), { isFirstSpeech: true }), 'show_intro');
    assert.equal(classifySegment(dj('x'), { isLastSpeech: true }), 'show_outro');
    assert.equal(classifySegment(dj('x')), 'banter');
    assert.equal(classifySegment(liveSeg()), 'weather_check', 'any type: live is a check-in');
    assert.equal(classifySegment(trackSeg()), null, 'music is not speech content');
    assert.equal(classifySegment(null), null);
  });
});

describe('min-inventory metric (pure math)', () => {
  const slots = (n) => Array.from({ length: n }, (_, i) => dj(`line ${i}`, { slot: i === 0 ? 'open' : i === n - 1 ? 'close' : 'intro' }));

  test('counts speech and tracks separately, reports types sorted by volume', () => {
    const inv = segmentInventory([
      dj('open', { slot: 'open' }),
      trackSeg('1'),
      dj('in', { slot: 'intro' }),
      trackSeg('2'),
      dj('in', { slot: 'intro' }),
      trackSeg('3'),
      dj('close', { slot: 'close' }),
    ]);
    assert.equal(inv.speechCount, 4);
    assert.equal(inv.trackCount, 3);
    assert.deepEqual(inv.types[0], { type: 'track_intro', count: 2 });
    assert.ok(inv.hasIntro && inv.hasOutro);
  });

  test('thresholds: 6 tracks per 30 minutes (ceil-scaled), flat 3 speech, F2 defaults', () => {
    const tracks = (n) => Array.from({ length: n }, (_, i) => trackSeg(String(i)));
    assert.equal(segmentInventory([...slots(3), ...tracks(6)], { durationMinutes: 30 }).meets, true, '30 min: 3 speech + 6 tracks');
    assert.equal(segmentInventory([...slots(3), ...tracks(5)], { durationMinutes: 30 }).meets, false, '5 of 6 tracks misses');
    assert.equal(segmentInventory([...slots(3), ...tracks(11)], { durationMinutes: 60 }).meets, false, '60 min needs 12');
    assert.equal(segmentInventory([...slots(3), ...tracks(12)], { durationMinutes: 60 }).meets, true);
    assert.equal(segmentInventory([...slots(3), ...tracks(9)], { durationMinutes: 45 }).meets, true, '45 min -> ceil(9)');
    assert.equal(segmentInventory([...slots(2), ...tracks(12)], { durationMinutes: 60 }).meets, false, 'speech minimum is flat 3');
    // Unknown duration -> track threshold not judged, speech still is.
    const noDuration = segmentInventory([...slots(2), ...tracks(0)]);
    assert.equal(noDuration.meets, false);
    assert.deepEqual(noDuration.thresholds.minTracks, null);
    assert.match(noDuration.shortfalls[0], /speech segments: 2/);
    assert.equal(segmentInventory([...slots(3), ...tracks(6)], { durationMinutes: 30 }).thresholds.minSpeechSegments, 3, 'F2 default');
  });

  test('shortfalls spell out exactly what missed, in WRIT-FM terms', () => {
    const inv = segmentInventory([dj('only', { slot: 'open' }), trackSeg('1')], { durationMinutes: 30 });
    assert.equal(inv.meets, false);
    assert.equal(inv.shortfalls.length, 2);
    assert.match(inv.shortfalls[0], /WRIT-FM/);
    assert.match(inv.shortfalls[1], /tracks: 1 \(minimum 6 for 30 min\)/);
  });
});

describe('script.md `segment:` field (parse + render round-trip)', () => {
  test('an explicit tag rides through parse and render unchanged', () => {
    const md = [
      '# show',
      '',
      '**Duration:** 30 min',
      '',
      '---',
      '',
      '## Mailbag — Ryan',
      'type: dj',
      'persona: ryan',
      'segment: listener_mailbag',
      '',
      'Listener mail time!',
      '',
      '## Live — Elena',
      'type: live',
      'persona: elena',
      'kind: weather',
      'brief: quick check',
      'segment: weather_check',
      '',
    ].join('\n');
    const parsed = parseScript(md);
    assert.equal(parsed.ok, true, parsed.issues?.join(' | '));
    assert.equal(parsed.segments[0].segment, 'listener_mailbag');
    assert.equal(parsed.segments[1].segment, 'weather_check');
    const rendered = renderScript(parsed);
    assert.match(rendered, /segment: listener_mailbag/);
    assert.match(rendered, /segment: weather_check/);
    const reparsed = parseScript(rendered);
    assert.equal(reparsed.ok, true);
    assert.equal(reparsed.segments[0].segment, 'listener_mailbag', 'round-trip is stable');
  });

  test('an unknown tag is a parse error naming the taxonomy', () => {
    const md = [
      '# show',
      '',
      '**Duration:** 30 min',
      '',
      '---',
      '',
      '## DJ — Ryan',
      'type: dj',
      'persona: ryan',
      'segment: mailbag',
      '',
      'oops, singular',
      '',
    ].join('\n');
    const parsed = parseScript(md);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.issues.some((i) => i.includes('mailbag') && i.includes('taxonomy')));
  });

  test('scripts without the field parse as before and still classify (backward compat)', () => {
    const md = [
      '# show',
      '',
      '**Duration:** 30 min',
      '',
      '---',
      '',
      '## DJ — Ryan',
      'type: dj',
      'persona: ryan',
      '',
      'Open!',
      '',
      '## Track',
      'type: track',
      'artist: A',
      'title: T',
      'ratingKey: 123',
      '',
      '## DJ — Ryan',
      'type: dj',
      'persona: ryan',
      '',
      'Close!',
      '',
    ].join('\n');
    const parsed = parseScript(md);
    assert.equal(parsed.ok, true, parsed.issues?.join(' | '));
    assert.equal(parsed.segments[0].segment, null);
    const inv = segmentInventory(parsed.segments, { durationMinutes: 30 });
    assert.ok(inv.hasIntro && inv.hasOutro, 'first/last speech inference covers untagged scripts');
    assert.equal(inv.meets, false, '1 track under 6 -- the metric reports honestly');
  });
});

describe('auto script classification + diagnostics readiness (end-to-end)', () => {
  test('buildSegmentsAuto output classifies through its slots and meets the metric', () => {
    const tracks = Array.from({ length: 12 }, (_, i) => ({
      ratingKey: `rk${i}`,
      artist: 'Artist',
      title: `Song ${i}`,
      album: 'Album',
      year: 2001,
      durationMs: 180000,
    }));
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: { hasQuiz: true, hasWeather: true, primaryPersona: 'ryan', title: 'Test Show' },
      showId: 'test-show',
      date: '2026-10-24',
      rubricData: {
        weather: { station: 'Test Station', condition: 'jasno', temp: 12 },
        news: { headlines: ['a', 'b', 'c'] },
      },
    });
    const inv = segmentInventory(segments, { durationMinutes: 60 });
    assert.ok(inv.hasIntro && inv.hasOutro, 'open/close slots infer the bookends');
    const counts = new Map(inv.types.map((t) => [t.type, t.count]));
    assert.ok(counts.get('track_intro') >= 12, 'intro+recap per track');
    assert.equal(counts.get('quiz'), 2);
    assert.ok((counts.get('news_analysis') ?? 0) >= 1, 'news rubric lands in news_analysis');
    assert.ok((counts.get('weather_check') ?? 0) >= 2, 'weatherNow rubric + live weather segment');
    assert.equal(inv.meets, true, `${JSON.stringify(inv.shortfalls)}`);
  });

  test('inventoryForOccurrence reports honestly over real files on disk', async () => {
    const weekday = 'friday';
    const showId = 'inv-show';
    const date = '2026-10-30';
    const thresholds = inventoryThresholds();
    assert.deepEqual(thresholds, { minSpeechSegments: 3, minTracksPer30Minutes: 6 }, 'F2 defaults');

    const missing = inventoryForOccurrence({ id: showId, weekday, date, durationMinutes: 30 });
    assert.equal(missing.exists, false);
    assert.equal(missing.ready, false);
    assert.match(missing.note, /not generated yet/);

    // A valid, healthy script on disk.
    const dir = path.join(liveConfig.paths.runningDir, weekday, showId, date);
    fs.mkdirSync(dir, { recursive: true });
    const healthy = [
      '# inv show',
      '',
      '**Duration:** 30 min',
      '',
      '---',
      '',
      '## DJ — Ryan',
      'type: dj',
      'persona: ryan',
      '',
      'Open!',
      '',
      ...Array.from({ length: 6 }, (_, i) => [
        '## Track',
        'type: track',
        'artist: A',
        `title: Song ${i}`,
        `ratingKey: ${100 + i}`,
        '',
      ]).flat(),
      '## DJ — Ryan',
      'type: dj',
      'persona: ryan',
      '',
      'Middle!',
      '',
      '## DJ — Ryan',
      'type: dj',
      'persona: ryan',
      '',
      'Close!',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'script.md'), healthy);
    const ready = inventoryForOccurrence({ id: showId, weekday, date, durationMinutes: 30 });
    assert.equal(ready.exists, true);
    assert.equal(ready.parsedOk, true);
    assert.equal(ready.inventory.speechCount, 3);
    assert.equal(ready.inventory.trackCount, 6);
    assert.equal(ready.ready, true, JSON.stringify(ready.inventory?.shortfalls));

    // A thin script: parses fine, misses the metric.
    fs.writeFileSync(
      path.join(dir, 'script.md'),
      [
        '# inv show',
        '',
        '**Duration:** 30 min',
        '',
        '---',
        '',
        '## DJ — Ryan',
        'type: dj',
        'persona: ryan',
        '',
        'Open and close in one.',
        '',
        '## Track',
        'type: track',
        'artist: A',
        'title: One',
        'ratingKey: 1',
        '',
      ].join('\n')
    );
    const thin = inventoryForOccurrence({ id: showId, weekday, date, durationMinutes: 30 });
    assert.equal(thin.parsedOk, true);
    assert.equal(thin.ready, false);
    assert.equal(thin.inventory.shortfalls.length, 2);

    // A broken script: the parse issues ARE the report.
    fs.writeFileSync(
      path.join(dir, 'script.md'),
      ['# broken', '', '**Duration:** 30 min', '', '---', '', '## nope', 'type: wat', ''].join('\n')
    );
    const broken = inventoryForOccurrence({ id: showId, weekday, date, durationMinutes: 30 });
    assert.equal(broken.parsedOk, false);
    assert.ok(broken.issues.length > 0);
    assert.equal(broken.ready, false);
    assert.equal(broken.inventory, null);
  });
});
