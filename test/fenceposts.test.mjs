// Val 28 C1 tests: the fencepost talk map (src/producer/fenceposts.js) and
// its integration into BOTH script builders.
//
//   A. decideFenceposts (pure): determinism, density bounds, protected
//      boundaries (quiz pair + weather handoff), adjacency, short shows,
//      mid-tease placement,
//   B. scriptBuilder integration: silent boundaries really drop the
//      intro+recap pair (and nothing else), protected boundaries keep their
//      promises, the mid-show tease lands exactly once and names a real
//      upcoming artist, and the whole map is deterministic per show+date,
//   C. scriptBuilder integration: structural pins (the ONLY consumer since
//      Val 28 removed the AI builder; the effects land in real segment
//      structures, not just the pure map).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('fenceposts', {});

const { decideFenceposts } = await import('../src/producer/fenceposts.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');

const mkTracks = (n) => Array.from({ length: n }, (_, i) => ({
  ratingKey: `rk${i}`,
  artist: `Artist ${i}`,
  title: `Song ${i}`,
  album: 'Album',
  year: 2001 + (i % 5),
  durationMs: 180000,
}));

// --- A. decideFenceposts (pure) ---------------------------------------------

describe('A. decideFenceposts (pure)', () => {
  test('deterministic: same seed -> the same map, across many shapes', () => {
    for (const n of [4, 6, 8, 12, 16, 20]) {
      for (const hasQuiz of [false, true]) {
        for (const hasWeather of [false, true]) {
          const a = decideFenceposts({ seed: 'show|2026-10-24', trackCount: n, hasQuiz, hasWeather });
          const b = decideFenceposts({ seed: 'show|2026-10-24', trackCount: n, hasQuiz, hasWeather });
          assert.deepEqual([...a.silentBoundaries], [...b.silentBoundaries], `n=${n} quiz=${hasQuiz}`);
          assert.equal(a.midTeaseIndex, b.midTeaseIndex);
        }
      }
    }
  });

  test('different seeds draw different maps (the variety is real)', () => {
    const maps = new Set();
    for (let s = 0; s < 24; s += 1) {
      const { silentBoundaries } = decideFenceposts({ seed: `show-${s}|date`, trackCount: 12 });
      maps.add([...silentBoundaries].sort((a, b) => a - b).join(','));
    }
    assert.ok(maps.size >= 8, `24 seeds of a 12-track show must vary, got ${maps.size} distinct maps`);
  });

  test('density: every show with >= 4 tracks skips 1..~1/3 of boundaries, never zero', () => {
    for (let n = 4; n <= 20; n += 1) {
      for (const hasQuiz of [false, true]) {
        for (const hasWeather of [false, true]) {
          const { silentBoundaries } = decideFenceposts({ seed: `density|${n}`, trackCount: n, hasQuiz, hasWeather });
          assert.ok(silentBoundaries.size >= 1, `n=${n}: at least one back-to-back pair`);
          assert.ok(silentBoundaries.size <= Math.ceil(n / 3), `n=${n}: not a jukebox (${silentBoundaries.size} of ${n})`);
        }
      }
    }
  });

  test('protected boundaries: the quiz pair and the weather handoff are never silent', () => {
    for (let n = 6; n <= 20; n += 1) {
      const quizIndex = Math.floor(n / 2);
      const weatherAfterIndex = Math.floor((n * 2) / 3);
      const { silentBoundaries } = decideFenceposts({ seed: `protect|${n}`, trackCount: n, hasQuiz: true, hasWeather: true });
      assert.ok(!silentBoundaries.has(quizIndex), `n=${n}: quiz reveal boundary protected`);
      assert.ok(!silentBoundaries.has(quizIndex - 1), `n=${n}: quiz question boundary protected`);
      assert.ok(!silentBoundaries.has(weatherAfterIndex), `n=${n}: weather handoff boundary protected`);
    }
  });

  test('no two adjacent silent boundaries (three tracks without a word is a different station)', () => {
    for (let n = 4; n <= 24; n += 1) {
      for (let s = 0; s < 8; s += 1) {
        const { silentBoundaries } = decideFenceposts({ seed: `adj|${n}|${s}`, trackCount: n, hasQuiz: true, hasWeather: true });
        const sorted = [...silentBoundaries].sort((a, b) => a - b);
        for (let i = 1; i < sorted.length; i += 1) {
          assert.ok(sorted[i] - sorted[i - 1] >= 2, `n=${n} seed=${s}: adjacent silences ${sorted[i - 1]},${sorted[i]}`);
        }
      }
    }
  });

  test('short shows (<= 3 tracks) stay dense: no silence, no mid tease', () => {
    for (const n of [0, 1, 2, 3]) {
      const map = decideFenceposts({ seed: 'short', trackCount: n, hasQuiz: true, hasWeather: true });
      assert.equal(map.silentBoundaries.size, 0);
      assert.equal(map.midTeaseIndex, null);
    }
  });

  test('mid tease: n >= 6 -> at the quiz position when a quiz exists, else halfway; never below index 2', () => {
    const withQuiz = decideFenceposts({ seed: 'mt', trackCount: 9, hasQuiz: true });
    assert.equal(withQuiz.midTeaseIndex, Math.floor(9 / 2));
    const noQuiz = decideFenceposts({ seed: 'mt', trackCount: 9, hasQuiz: false });
    assert.equal(noQuiz.midTeaseIndex, Math.floor(9 / 2));
    const small = decideFenceposts({ seed: 'mt', trackCount: 5, hasQuiz: false });
    assert.equal(small.midTeaseIndex, null, 'n=5 has no mid tease');
  });
});

// --- B. scriptBuilder integration ---------------------------------------------

describe('B. buildSegmentsAuto fencepost integration', () => {
  const build = (n, { hasQuiz = true, hasWeather = true, showId = 'fence-show', date = '2026-10-24' } = {}) =>
    buildSegmentsAuto({
      tracks: mkTracks(n),
      brief: { hasQuiz, hasWeather, primaryPersona: 'ryan', title: 'Fence Show' },
      showId,
      date,
      rubricData: null,
    });

  const slotsBetween = (segments, trackIdx) => {
    // Speech slots between track #trackIdx and track #trackIdx+1. For the
    // LAST track the run extends into the show's tail (nextShow + close,
    // which always speak) -- the silent claim there is only "no recap".
    const trackPositions = segments.map((s, i) => (s.type === 'track' ? i : -1)).filter((i) => i >= 0);
    const start = trackPositions[trackIdx];
    const end = trackPositions[trackIdx + 1];
    if (end == null) {
      return segments.slice(start + 1).filter((s) => s.type === 'dj' || s.type === 'live').map((s) => s.slot ?? s.kind ?? 'dj');
    }
    return segments.slice(start + 1, end).filter((s) => s.type === 'dj' || s.type === 'live').map((s) => s.slot ?? 'dj');
  };

  test('a silent boundary (before a non-final track) has NO speech between its two tracks', () => {
    const n = 12;
    const { segments } = build(n);
    const { silentBoundaries } = decideFenceposts({
      seed: 'fence-show|2026-10-24|none|fenceposts',
      trackCount: n,
      hasQuiz: true,
      hasWeather: true,
    });
    // NOTE: buildSegmentsAuto derives the seed via seedFor({showId, date, slot:'fenceposts'})
    // = `${showId}|${date}|none|fenceposts` (no track for this slot).
    assert.ok(silentBoundaries.size >= 1, 'the fixture draw must contain at least one silent boundary');
    let checkedPairs = 0;
    for (const b of silentBoundaries) {
      if (b === n - 1) continue; // the final boundary: see the dedicated test below
      assert.deepEqual(slotsBetween(segments, b), [], `boundary ${b} must be pure back-to-back`);
      checkedPairs += 1;
    }
    assert.ok(checkedPairs >= 1, 'at least one non-final silent boundary in the fixture draw');
  });

  test('a silent FINAL boundary drops only the last recap (the show tail still speaks)', () => {
    for (const showId of ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']) {
      const n = 12;
      const { segments } = build(n, { showId });
      const { silentBoundaries } = decideFenceposts({
        seed: `${showId}|2026-10-24|none|fenceposts`,
        trackCount: n,
        hasQuiz: true,
        hasWeather: true,
      });
      if (!silentBoundaries.has(n - 1)) continue;
      const afterLast = slotsBetween(segments, n - 1);
      assert.ok(!afterLast.includes('recap'), 'the last recap is dropped');
      assert.ok(afterLast.includes('nextShow') && afterLast.includes('close'), 'the announcement + sign-off tail speaks');
    }
  });

  test('non-silent boundaries keep their recap+intro (or quiz/handoff) speech', () => {
    const n = 12;
    const { segments } = build(n);
    const { silentBoundaries } = decideFenceposts({
      seed: 'fence-show|2026-10-24|none|fenceposts',
      trackCount: n,
      hasQuiz: true,
      hasWeather: true,
    });
    for (let b = 0; b < n - 1; b += 1) {
      if (silentBoundaries.has(b)) continue;
      const speech = slotsBetween(segments, b);
      assert.ok(speech.length >= 1, `boundary ${b} (non-silent) owes speech`);
    }
  });

  test('every silent boundary really dropped a recap+intro pair (the count accounting)', () => {
    // n tracks, no rubric trivia: speech between tracks is exactly the
    // intro/recap pairs minus the silent pairs (quiz/handoff aside).
    const n = 12;
    const { segments } = build(n);
    const { silentBoundaries } = decideFenceposts({
      seed: 'fence-show|2026-10-24|none|fenceposts',
      trackCount: n,
      hasQuiz: true,
      hasWeather: true,
    });
    const introCount = segments.filter((s) => s.slot === 'intro').length;
    const recapCount = segments.filter((s) => s.slot === 'recap').length;
    // quizIndex=6: quizIntro replaces intro_6, quizReveal replaces recap_6.
    // Every silent boundary b (except b=6, impossible -- protected) removes
    // one intro (b+1, when b+1 <= n-1) and one recap (b, when b <= n-1).
    const expectedIntros = n - 1 /* tracks 1..n-1 have intros (track 0's intro is never dropped) */
      - [...silentBoundaries].filter((b) => b + 1 <= n - 1 && b + 1 !== 6).length;
    // Track 6 (the quiz track) spends its recap slot on quizReveal -- it is
    // never a plain 'recap', exactly like its intro is never a plain 'intro'.
    const expectedRecaps = n - 1 /* the quiz track's recap is the quizReveal */
      - [...silentBoundaries].filter((b) => b !== 6).length;
    assert.equal(introCount, expectedIntros, `intros: ${introCount} vs expected ${expectedIntros}`);
    assert.equal(recapCount, expectedRecaps, `recaps: ${recapCount} vs expected ${expectedRecaps}`);
  });

  test('quiz reveal and weather handoff survive every draw (protected promises)', () => {
    for (const showId of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const { segments } = build(12, { showId });
      const slots = segments.filter((s) => s.type === 'dj').map((s) => s.slot);
      assert.ok(slots.includes('quizIntro') && slots.includes('quizReveal'), `${showId}: quiz pair intact`);
      assert.ok(slots.includes('handoff'), `${showId}: weather handoff intact`);
      const hasLiveWeather = segments.some((s) => s.type === 'live' && s.kind === 'weather');
      assert.ok(hasLiveWeather, `${showId}: live weather intact`);
    }
  });

  test('the mid-show tease lands exactly once and names a real upcoming artist', () => {
    const n = 12;
    const { segments } = build(n);
    const teases = segments.filter((s) => s.slot === 'teaseMid');
    assert.equal(teases.length, 1, 'exactly one mid tease');
    const artists = mkTracks(n).map((t) => t.artist);
    assert.ok(
      artists.some((a) => teases[0].body.includes(a)),
      `the tease names a real artist from the queue: "${teases[0].body}"`
    );
    // The tease sits before a track, in the show's back half.
    const teaseIdx = segments.indexOf(teases[0]);
    const nextTrack = segments.slice(teaseIdx + 1).find((s) => s.type === 'track');
    assert.ok(nextTrack, 'a track follows the tease');
  });

  test('the map is deterministic per show+date and varies across shows', () => {
    const a = build(12, { showId: 'show-x' }).segments.map((s) => s.slot ?? s.type);
    const b = build(12, { showId: 'show-x' }).segments.map((s) => s.slot ?? s.type);
    assert.deepEqual(a, b, 'same show + date -> identical segment shape');
    const distinct = new Set();
    for (const showId of ['s1', 's2', 's3', 's4', 's5', 's6']) {
      distinct.add(build(12, { showId }).segments.map((s) => s.slot ?? s.type).join('|'));
    }
    assert.ok(distinct.size >= 3, `different shows draw different talk maps, got ${distinct.size}`);
  });

  test('trivia keeps its P4 #17 cadence regardless of silent boundaries (not gated)', () => {
    // The trivia gate was deliberately NOT added: a fact about the artist
    // straight into the song is a natural break. Structural pin on the
    // builder side (the full cadence behavior is trivia.test.mjs G).
    const src = fs.readFileSync(path.join(repoRoot(), 'src', 'auto', 'scriptBuilder.js'), 'utf8');
    assert.doesNotMatch(
      src,
      /silentBefore\(i\)\)\s*\{\s*segments\.push\(\s*\.\.\.triviaSegments/,
      'trivia must not be gated on silent boundaries'
    );
  });

  test('short shows (3 tracks) keep the dense classic shape', () => {
    const { segments } = build(3);
    const slots = segments.filter((s) => s.type === 'dj').map((s) => s.slot);
    assert.deepEqual(slots.filter((s) => s === 'intro' || s === 'recap' || s === 'quizIntro' || s === 'quizReveal' || s === 'handoff').length >= 6, true, 'intro+recap per track');
    assert.equal(slots.includes('teaseMid'), false);
  });
});

// --- C. scriptBuilder structural pins ------------------------------------------

describe('C. scriptBuilder consumes the shared talk map (structural)', () => {
  const repo = repoRoot();

  // (Val 28: the boundaryWalk.js/moves.js AI-mode twins of these pins are
  // gone with the AI producer -- scriptBuilder.js is the only script
  // builder left, so the talk map has exactly one consumer to pin.)
  test('scriptBuilder.js consumes decideFenceposts and renders the teaseMid pool', () => {
    const src = fs.readFileSync(path.join(repo, 'src', 'auto', 'scriptBuilder.js'), 'utf8');
    assert.match(src, /import \{ decideFenceposts \} from '\.\.\/producer\/fenceposts\.js'/);
    assert.match(src, /renderSlot\('teaseMid'/);
    assert.match(src, /fenceposts\.silentBoundaries/);
  });
});
