// Tests for P4 #25 "Sledi kasneje" tease + "Anketa" rubric segments in the
// auto script builder:
//   A. the tease: present for real show lengths, names the queue's back-half
//      artist, quiz-flavored when the brief opens the quiz position, absent
//      for tiny shows, deterministic,
//   B. the poll: active poll with votes -> pollResults (honest tally), fresh
//      poll -> pollRunning, no poll -> no segment,
//   C. taxonomy: tease lands in banter, poll slots in listener_mailbag.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('tease-poll', {});

const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { classifySegment } = await import('../src/script/segments.js');

const mkTracks = (count) =>
  Array.from({ length: count }, (_, i) => ({
    ratingKey: `rk${i}`,
    artist: `Artist ${i}`,
    title: `Song ${i}`,
    album: 'Album',
    year: 2001,
    durationMs: 180000,
  }));

const baseBrief = (hasQuiz) => ({ hasQuiz, hasWeather: false, primaryPersona: 'elena', title: 'Tone Show' });
const noRubrics = { weather: null, news: null, sport: null, onThisDay: null, onThisDayMusic: null, quiz: null, poll: null };

describe('P4 #25 tease placement', () => {
  test('tease lands after the rubrics, before the first track, and names the LAST queue artist', () => {
    const tracks = mkTracks(6);
    const { segments } = buildSegmentsAuto({ tracks, brief: baseBrief(false), showId: 'tease-show', date: '2026-10-24', rubricData: noRubrics });
    const slots = segments.map((s) => s.slot ?? (s.type === 'track' ? 'track' : null));
    const teaseIdx = slots.indexOf('tease');
    assert.ok(teaseIdx > 0, 'tease present');
    assert.ok(teaseIdx < slots.indexOf('track'), 'tease before the first track');
    assert.ok(teaseIdx > slots.indexOf('open'), 'tease after the open');
    assert.ok(segments[teaseIdx].body.includes('Artist 5'), 'tease names the back-half artist');
  });

  test('quiz brief gets the quiz-flavored tease', () => {
    const tracks = mkTracks(5);
    const { segments } = buildSegmentsAuto({ tracks, brief: baseBrief(true), showId: 'tease-show', date: '2026-10-24', rubricData: noRubrics });
    const tease = segments.find((s) => s.slot === 'teaseQuiz');
    assert.ok(tease, 'teaseQuiz slot present');
    assert.match(tease.body, /kviz/i);
    assert.ok(!segments.some((s) => s.slot === 'tease'), 'no plain tease when quiz flavor applies');
  });

  test('tiny shows (2 tracks) skip the tease silently', () => {
    const { segments } = buildSegmentsAuto({ tracks: mkTracks(2), brief: baseBrief(false), showId: 'tease-show', date: '2026-10-24', rubricData: noRubrics });
    assert.ok(!segments.some((s) => s.slot === 'tease' || s.slot === 'teaseQuiz'), 'no tease for a 2-track show');
  });

  test('deterministic: same show+date -> identical tease body', () => {
    const mk = () =>
      buildSegmentsAuto({ tracks: mkTracks(4), brief: baseBrief(false), showId: 'tease-show', date: '2026-10-24', rubricData: noRubrics })
        .segments.find((s) => s.slot === 'tease').body;
    assert.equal(mk(), mk());
  });
});

describe('P4 #25 poll segments', () => {
  test('active poll WITH votes -> pollResults carrying the honest tally', () => {
    const poll = { question: 'Kdo je najboljši kitarist?', options: ['A', 'B'], votes: [3, 1], total: 4, leader: 'A', leaderVotes: 3 };
    const { segments } = buildSegmentsAuto({ tracks: mkTracks(3), brief: baseBrief(false), showId: 'poll-show', date: '2026-10-24', rubricData: { ...noRubrics, poll } });
    const seg = segments.find((s) => s.slot === 'pollResults');
    assert.ok(seg, 'pollResults present');
    assert.ok(seg.body.includes('Kdo je najboljši kitarist?'), 'question carried');
    assert.ok(seg.body.includes('A') && seg.body.includes('3') && seg.body.includes('4'), 'tally carried');
  });

  test('fresh poll (zero votes) -> pollRunning, no tally claim', () => {
    const poll = { question: 'Anketa za jutri?', options: ['A', 'B'], votes: [0, 0], total: 0, leader: null, leaderVotes: 0 };
    const { segments } = buildSegmentsAuto({ tracks: mkTracks(3), brief: baseBrief(false), showId: 'poll-show', date: '2026-10-24', rubricData: { ...noRubrics, poll } });
    assert.ok(segments.some((s) => s.slot === 'pollRunning'), 'pollRunning present');
    assert.ok(!segments.some((s) => s.slot === 'pollResults'), 'no results when nobody voted');
  });

  test('no poll -> no poll segment (skip-not-fail)', () => {
    const { segments } = buildSegmentsAuto({ tracks: mkTracks(3), brief: baseBrief(false), showId: 'poll-show', date: '2026-10-24', rubricData: noRubrics });
    assert.ok(!segments.some((s) => s.slot === 'pollRunning' || s.slot === 'pollResults'));
  });
});

describe('P4 #25 taxonomy', () => {
  test('tease -> banter, poll slots -> listener_mailbag', () => {
    assert.equal(classifySegment({ type: 'dj', slot: 'tease' }), 'banter');
    assert.equal(classifySegment({ type: 'dj', slot: 'teaseQuiz' }), 'banter');
    assert.equal(classifySegment({ type: 'dj', slot: 'pollRunning' }), 'listener_mailbag');
    assert.equal(classifySegment({ type: 'dj', slot: 'pollResults' }), 'listener_mailbag');
  });
});
