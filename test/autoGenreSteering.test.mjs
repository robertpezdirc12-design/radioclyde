// Tests for Val 20 item A4 -- activation of the prepared-but-unused
// `preferredGenres` time-of-day genre steering, together with the dead-code
// fix discovered during verification (the open/close greeting block variants
// never reached air because scriptBuilder passed `block: undefined` while
// renderSlot does no wall-clock resolution of its own):
//   A. narrowPoolByPreferredGenres (queue.js, pure): exact no-op paths,
//      narrowing, honest give-up, folded matching, genre-less tracks.
//   B. rules.blockGenrePreference: config lookup with [] fallbacks, and the
//      no-timeOfDayBlocks-config-at-all case (in-memory delete + restore, the
//      piperVoice.test.mjs pattern -- config is a plain object read live).
//   C. renderSlot block pools (templates.js): morning/night variants render,
//      an unknown block key falls back to the default pool, block
//      null/undefined behaves EXACTLY as before the fix.
//   D. buildSegmentsAuto (scriptBuilder.js): the block parameter reaches the
//      open/close slots; without it, the timeBlockKey() fallback still
//      renders a valid line (standalone-caller path).
//   E. wiring pins (source structure): preferredGenres into buildTrackQueue,
//      block into buildSegmentsAuto, block resolution BEFORE selection, and
//      the narrowing sitting between the cooldown bypass and the shuffle
//      line. The lesson of the original bug: a feature that looks wired but
//      never receives its input is indistinguishable from a feature that
//      does not exist -- so the data flow itself gets pinned.
//
// No network, no library: the queue tests call the PURE narrowing function
// directly; the script-builder harness mirrors test/weatherOffline.test.mjs
// group D (mkTracks + minimal brief + all-null rubricData).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('genreSteering', {
  autoRadio: {
    enabled: true,
    stationName: 'Test Station',
    music: { source: 'local', localDirs: [] },
    rules: {
      artistCooldownHours: 3,
      // Only morning carries a preference -- night deliberately does not, so
      // the []-when-unconfigured path is exercised against the SAME config
      // object that exercises the configured path.
      timeOfDayBlocks: {
        morning: { start: '05:00', end: '10:00', preferredGenres: ['Folk'] },
        night: { start: '23:00', end: '05:00' },
      },
    },
    voice: { mode: 'none' },
  },
});

const { config } = await import('../src/config/index.js');
const { narrowPoolByPreferredGenres } = await import('../src/producer/trackSelection/queue.js');
const { blockGenrePreference } = await import('../src/auto/rules.js');
const { renderSlot } = await import('../src/auto/templates.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');

// ---------------------------------------------------------------------------
// A. narrowPoolByPreferredGenres (pure)
// ---------------------------------------------------------------------------

describe('A. narrowPoolByPreferredGenres (pure)', () => {
  const mk = (i, genres, durationMs = 200000) => ({
    ratingKey: `rk${i}`,
    artist: `Artist ${i}`,
    title: `Song ${i}`,
    album: 'Album',
    year: 2001,
    durationMs,
    genre: genres, // undefined / [] / ['Rock'] -- the function guards itself
  });

  test('empty or absent preferredGenres -> exact no-op (same array identity)', () => {
    const pool = [mk(0, ['Rock']), mk(1, ['Pop']), mk(2, ['Rock', 'Pop'])];
    for (const absent of [[], undefined, null]) {
      const r = narrowPoolByPreferredGenres(pool, absent, 1);
      assert.equal(r.pool, pool, `pool must be the SAME array for ${JSON.stringify(absent)}`);
      assert.equal(r.matched, 0);
      assert.equal(r.applied, false);
    }
  });

  test('empty eligible -> exact no-op even with genres configured', () => {
    const empty = [];
    const r = narrowPoolByPreferredGenres(empty, ['Rock'], 3);
    assert.equal(r.pool, empty);
    assert.equal(r.matched, 0);
    assert.equal(r.applied, false);
  });

  test('matching pool fills the need -> narrowed to matching tracks only, applied true', () => {
    const rock = Array.from({ length: 6 }, (_, i) => mk(i, ['Rock']));
    const pop = Array.from({ length: 4 }, (_, i) => mk(100 + i, ['Pop']));
    const pool = [...rock, ...pop];
    const r = narrowPoolByPreferredGenres(pool, ['Rock'], 5);
    assert.equal(r.applied, true);
    assert.equal(r.matched, 6);
    assert.equal(r.pool.length, 6);
    assert.ok(r.pool.every((t) => t.genre.includes('Rock')), 'no non-matching track may survive');
    // ANY-OF: either listed genre counts, and a multi-genre track matches either.
    const anyOf = narrowPoolByPreferredGenres(pool, ['Pop', 'Jazz'], 4);
    assert.equal(anyOf.applied, true);
    assert.equal(anyOf.matched, 4);
    assert.ok(anyOf.pool.every((t) => t.genre.includes('Pop')));
  });

  test('matching pool too small -> honest give-up, pool untouched', () => {
    const pool = [mk(0, ['Rock']), mk(1, ['Rock']), mk(2, ['Pop']), mk(3, ['Pop'])];
    const r = narrowPoolByPreferredGenres(pool, ['Rock'], 3);
    assert.equal(r.applied, false);
    assert.equal(r.pool, pool, 'pool untouched (same identity)');
    assert.equal(r.matched, 2, 'matched still reported honestly');
  });

  test('folded matching: "rock" matches genre "Rock"; diacritics fold too', () => {
    const r = narrowPoolByPreferredGenres([mk(0, ['Rock']), mk(1, ['Pop'])], ['rock'], 1);
    assert.equal(r.applied, true, 'case-insensitive via rotationRules.js fold()');
    assert.equal(r.matched, 1);
    // fold() strips combining diacritics: fold("Šanson") === fold("sanson"),
    // the same normalization clockwheel.js's pool genres filter uses.
    const diacritic = narrowPoolByPreferredGenres([mk(0, ['Šanson']), mk(1, ['Pop'])], ['sanson'], 1);
    assert.equal(diacritic.applied, true, 'diacritics-folded match');
    assert.equal(diacritic.matched, 1);
  });

  test('tracks without genre never match (never assumed into the preference)', () => {
    const pool = [mk(0), mk(1), mk(2, ['Rock'])]; // first two carry NO genre
    const r = narrowPoolByPreferredGenres(pool, ['Rock'], 2);
    assert.equal(r.applied, false, 'one matching track cannot fill a 2-track need');
    assert.equal(r.matched, 1);
    assert.equal(r.pool, pool);
    const emptyGenre = narrowPoolByPreferredGenres([mk(0, []), mk(1, [])], ['Rock'], 1);
    assert.equal(emptyGenre.matched, 0);
    assert.equal(emptyGenre.applied, false);
  });
});

// ---------------------------------------------------------------------------
// B. rules.blockGenrePreference
// ---------------------------------------------------------------------------

describe('B. rules.blockGenrePreference', () => {
  test('resolves the configured block preference; unconfigured -> []', () => {
    assert.deepEqual(blockGenrePreference('morning'), ['Folk']);
    assert.deepEqual(blockGenrePreference('night'), [], 'night has no preferredGenres in this config');
    assert.deepEqual(blockGenrePreference('unknown'), [], 'unknown block key -> no preference');
  });

  test('no timeOfDayBlocks config at all -> [] (the defaults carry no preference)', () => {
    const saved = config.autoRadio.rules.timeOfDayBlocks;
    delete config.autoRadio.rules.timeOfDayBlocks;
    try {
      assert.deepEqual(blockGenrePreference('morning'), []);
      assert.deepEqual(blockGenrePreference('night'), []);
    } finally {
      config.autoRadio.rules.timeOfDayBlocks = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// C. renderSlot block pools (the greeting variants reach air)
// ---------------------------------------------------------------------------

describe('C. renderSlot block pools', () => {
  const values = { station: 'Test Station', show: 'Show' };

  test('block morning -> the substituted MORNING open variant', () => {
    const body = renderSlot('open', { values, block: 'morning', seed: 's1' });
    assert.ok(body.startsWith('Dobro jutro'), `expected the morning variant, got: ${body}`);
    assert.ok(body.includes('Test Station') && body.includes('Show'), `substitution broken: ${body}`);
    assert.ok(!body.includes('{'), `unsubstituted placeholder: ${body}`);
  });

  test('block night -> the substituted NIGHT open variant', () => {
    const body = renderSlot('open', { values, block: 'night', seed: 's1' });
    assert.ok(body.startsWith('Pozno v no'), `expected the night variant, got: ${body}`);
  });

  test('close pools pick block variants too (evening)', () => {
    const body = renderSlot('close', { values, block: 'evening', seed: 's2' });
    assert.ok(body.startsWith('Dober ve\u010der'), `expected the evening close variant, got: ${body}`);
  });

  test('unknown block key -> the default pool, never a throw', () => {
    const body = renderSlot('open', { values, block: 'wee-hours', seed: 's1' });
    assert.ok(!body.startsWith('Dobro jutro') && !body.startsWith('Pozno v no'), `unknown block must not pick a named variant: ${body}`);
    assert.ok(/^(Poslu\u0161ate|Dobrodo\u0161li)/.test(body), `a default-pool variant was expected: ${body}`);
  });

  test('block null/undefined behaves exactly as before the fix (default pool)', () => {
    const withNull = renderSlot('open', { values, block: null, seed: 'seed-x' });
    const withUndefined = renderSlot('open', { values, block: undefined, seed: 'seed-x' });
    const withoutBlock = renderSlot('open', { values, seed: 'seed-x' });
    assert.equal(withNull, withoutBlock);
    assert.equal(withUndefined, withoutBlock);
    assert.ok(/^(Poslu\u0161ate|Dobrodo\u0161li)/.test(withoutBlock), `default pool expected: ${withoutBlock}`);
  });
});

// ---------------------------------------------------------------------------
// D. buildSegmentsAuto (scriptBuilder) -- the block parameter flows to slots
// ---------------------------------------------------------------------------

describe('D. buildSegmentsAuto block parameter', () => {
  const mkTracks = (count) =>
    Array.from({ length: count }, (_, i) => ({
      ratingKey: `rk${i}`,
      artist: `Artist ${i}`,
      title: `Song ${i}`,
      album: 'Album',
      year: 2001,
      durationMs: 180000,
    }));
  const baseBrief = { hasQuiz: false, hasWeather: false, primaryPersona: 'elena', title: 'X' };
  const noRubrics = {
    weather: null,
    news: null,
    sport: null,
    onThisDay: null,
    onThisDayMusic: null,
    quiz: null,
    poll: null,
    listeners: null,
  };
  const build = (extra) =>
    buildSegmentsAuto({ tracks: mkTracks(4), brief: baseBrief, showId: 'genre-show', date: '2026-10-24', rubricData: noRubrics, ...extra });

  test("block 'morning' -> the FIRST segment (slot open) starts with the morning greeting", () => {
    const { segments } = build({ block: 'morning' });
    assert.equal(segments[0].slot, 'open');
    assert.ok(segments[0].body.startsWith('Dobro jutro'), `got: ${segments[0].body}`);
  });

  test("block 'night' -> the open segment starts with the night greeting", () => {
    const { segments } = build({ block: 'night' });
    const open = segments.find((s) => s.slot === 'open');
    assert.ok(open.body.startsWith('Pozno v no'), `got: ${open.body}`);
  });

  test('without a block param the timeBlockKey() fallback still renders a valid open line', () => {
    const { segments } = build({});
    const open = segments.find((s) => s.slot === 'open');
    assert.equal(typeof open.body, 'string');
    assert.ok(open.body.length > 0, 'the fallback must never render an empty greeting');
    assert.ok(!open.body.includes('{station}'), `unsubstituted placeholder: ${open.body}`);
    assert.ok(!open.body.includes('{show}'), `unsubstituted placeholder: ${open.body}`);
  });

  test("the LAST dj segment (slot close) speaks the block 'evening' variant", () => {
    const { segments } = build({ block: 'evening' });
    const djSegments = segments.filter((s) => s.type === 'dj');
    const close = djSegments[djSegments.length - 1];
    assert.equal(close.slot, 'close');
    assert.ok(close.body.startsWith('Dober ve\u010der'), `got: ${close.body}`);
  });
});

// ---------------------------------------------------------------------------
// E. wiring pins (source structure)
// ---------------------------------------------------------------------------

// Comments only, no template literals with "//": both pinned files are safe
// for this crude strip (their string literals contain no // or /*).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('E. produce.js wiring (structural)', () => {
  const src = stripComments(fs.readFileSync(path.join(repoRoot(), 'src', 'auto', 'produce.js'), 'utf8'));

  test('passes preferredGenres into the buildTrackQueue call', () => {
    assert.match(src, /await buildTrackQueue\(\{[^)]*preferredGenres/);
  });

  test('passes block into the buildSegmentsAuto call', () => {
    assert.match(src, /buildSegmentsAuto\(\{[^}]*\bblock\b/);
  });

  test('the block resolution sits BEFORE the buildTrackQueue call (one truth, both consumers)', () => {
    const resolvedAt = src.indexOf('const block = timeBlockKey()');
    const queueAt = src.indexOf('await buildTrackQueue(');
    assert.ok(resolvedAt !== -1, 'timeBlockKey() resolution present');
    assert.ok(queueAt !== -1, 'buildTrackQueue call present');
    assert.ok(resolvedAt < queueAt, 'the same resolution must feed steering AND greetings, so it comes first');
  });
});

describe('E. queue.js wiring (structural)', () => {
  const src = stripComments(fs.readFileSync(path.join(repoRoot(), 'src', 'producer', 'trackSelection', 'queue.js'), 'utf8'));

  test("buildTrackQueue's signature destructures preferredGenres = []", () => {
    assert.match(src, /preferredGenres = \[\]/);
  });

  test('the narrowing sits between the cooldown bypass and the shuffle line', () => {
    const bypassAt = src.indexOf('cooldownBypassed = true');
    // The CALL, not the function definition above it (the definition is
    // exported at module top and would always sort "before" everything).
    const narrowAt = src.indexOf('narrowPoolByPreferredGenres(eligible, preferredGenres, genreNeededCount)');
    const shuffleAt = src.indexOf('let ordered = weightPopular');
    assert.ok(bypassAt !== -1, 'cooldown bypass present');
    assert.ok(narrowAt !== -1, 'narrowing call present');
    assert.ok(shuffleAt !== -1, 'ordering/shuffle line present');
    assert.ok(bypassAt < narrowAt, 'narrowing happens after the cooldown bypass');
    assert.ok(narrowAt < shuffleAt, 'narrowing happens before the pool is ordered/shuffled');
  });
});
