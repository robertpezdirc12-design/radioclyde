// Tests for P4 #28 "na današnji dan v glasbi" local corpus
// (src/auto/onThisDayFacts.js + feeds.js fallback):
//   A. corpus integrity (same frozen-operator rules as quizFacts),
//   B. pickOnThisDayMusic (date matching, limit, determinism, skip-not-fail),
//   C. collectRubricData offline branch -- the corpus keeps the rubric alive
//      with zero network, like the quiz,
//   D. template rendering through the EXISTING obzorjeGlasba pools (the
//      corpus must be indistinguishable from a Wikidata event).
//
// No real network anywhere: the same no-ffmpeg-no-network rule as the rest
// of the suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('onthisday', {});

const { ON_THIS_DAY_MUSIC, pickOnThisDayMusic } = await import('../src/auto/onThisDayFacts.js');
const { collectRubricData } = await import('../src/auto/feeds.js');
const { renderSlot } = await import('../src/auto/templates.js');
const { parseBriefRubrics } = await import('../src/auto/briefQuery.js');

describe('onThisDay corpus integrity (P4 #28)', () => {
  test('non-trivial calendar coverage', () => {
    assert.ok(ON_THIS_DAY_MUSIC.length >= 40, `expected >= 40 facts, got ${ON_THIS_DAY_MUSIC.length}`);
    const days = new Set(ON_THIS_DAY_MUSIC.map((e) => `${e.month}-${e.day}`));
    assert.ok(days.size >= 35, `expected >= 35 distinct calendar days, got ${days.size}`);
  });

  test('every entry is structurally valid', () => {
    for (const e of ON_THIS_DAY_MUSIC) {
      assert.ok(Number.isInteger(e.month) && e.month >= 1 && e.month <= 12, `bad month: ${JSON.stringify(e)}`);
      assert.ok(Number.isInteger(e.day) && e.day >= 1 && e.day <= 31, `bad day: ${JSON.stringify(e)}`);
      assert.ok(Number.isInteger(e.year) && e.year >= 1900 && e.year <= 2026, `bad year: ${JSON.stringify(e)}`);
      assert.ok(['birth', 'death'].includes(e.kind), `kind must be birth|death: ${JSON.stringify(e)}`);
      assert.ok(['male', 'female'].includes(e.sex), `sex must be male|female: ${JSON.stringify(e)}`);
      assert.ok(typeof e.name === 'string' && e.name.length >= 3, `name too short: ${JSON.stringify(e)}`);
      assert.ok(!e.name.includes('{'), `name carries a placeholder: ${e.name}`);
      assert.ok(!e.name.endsWith('.'), `name must not end with a period (template adds punctuation): ${e.name}`);
    }
  });

  test('no duplicate facts, sorted calendar order', () => {
    const seen = new Set();
    for (const e of ON_THIS_DAY_MUSIC) {
      const key = `${e.month}-${e.day}-${e.year}-${e.name}`;
      assert.ok(!seen.has(key), `duplicate corpus entry: ${key}`);
      seen.add(key);
    }
    const keys = ON_THIS_DAY_MUSIC.map((e) => e.month * 1_000_000 + e.day * 10_000 + e.year);
    const sorted = [...keys].sort((a, b) => a - b);
    assert.deepEqual(keys, sorted, 'corpus must stay sorted by month, day, year');
  });

  test('spot checks: the calendar knows its icons', () => {
    const has = (m, d, y, name, sex, kind) =>
      ON_THIS_DAY_MUSIC.some((e) => e.month === m && e.day === d && e.year === y && e.name === name && e.sex === sex && e.kind === kind);
    assert.ok(has(8, 16, 1977, 'Elvis Presley', 'male', 'death'), 'Aug 16: Elvis');
    assert.ok(has(8, 16, 2018, 'Aretha Franklin', 'female', 'death'), 'Aug 16: Aretha (female ending test)');
    assert.ok(has(11, 28, 1929, 'Slavko Avsenik', 'male', 'birth'), 'Nov 28: Avsenik (SI)');
    assert.ok(has(1, 8, 1947, 'David Bowie', 'male', 'birth'), 'Jan 8: Bowie');
    assert.ok(has(12, 8, 1980, 'John Lennon', 'male', 'death'), 'Dec 8: Lennon');
  });
});

describe('pickOnThisDayMusic', () => {
  test('known date returns same-shape events, limit respected', () => {
    const r = pickOnThisDayMusic({ month: 8, day: 16, limit: 2, seed: 'jutro|2026-08-16' });
    assert.ok(r, 'Aug 16 has corpus facts');
    assert.equal(r.source, 'local');
    assert.equal(r.events.length, 2);
    for (const ev of r.events) {
      assert.deepEqual(Object.keys(ev).sort(), ['kind', 'name', 'sex', 'year'], 'same shape as Wikidata events');
      assert.ok(['Madonna', 'Elvis Presley', 'Aretha Franklin'].includes(ev.name));
      assert.equal(ev.month, undefined, 'internal corpus fields must not leak into event shape');
    }
  });

  test('deterministic per seed: same input, same events, same order', () => {
    const a = pickOnThisDayMusic({ month: 8, day: 16, limit: 2, seed: 'abc' });
    const b = pickOnThisDayMusic({ month: 8, day: 16, limit: 2, seed: 'abc' });
    assert.deepEqual(a, b);
  });

  test('rotation over a multi-fact day stays a valid subset, never drops below 1', () => {
    const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];
    const all = new Set(['Madonna', 'Elvis Presley', 'Aretha Franklin']);
    const seenPairs = new Set();
    for (const seed of seeds) {
      const r = pickOnThisDayMusic({ month: 8, day: 16, limit: 2, seed });
      assert.equal(r.events.length, 2);
      for (const ev of r.events) assert.ok(all.has(ev.name), `rotation produced unknown name: ${ev.name}`);
      seenPairs.add(r.events.map((e) => e.name).sort().join('|'));
      const again = pickOnThisDayMusic({ month: 8, day: 16, limit: 2, seed });
      assert.deepEqual(r, again, `seed ${seed} not stable`);
    }
    assert.ok(seenPairs.size >= 2, `rotation should vary pairs across seeds, got ${seenPairs.size}`);
  });

  test('no facts for the date -> null (skip-not-fail)', () => {
    assert.equal(pickOnThisDayMusic({ month: 4, day: 7, limit: 2, seed: 'x' }), null, 'Apr 7 is corpus-empty');
    assert.equal(pickOnThisDayMusic({ month: 2, day: 30, limit: 2, seed: 'x' }), null, 'impossible date -> null');
    assert.equal(pickOnThisDayMusic({ month: 8, day: 16, limit: 0, seed: 'x' }), null, 'limit 0 disables');
    assert.equal(pickOnThisDayMusic({ month: NaN, day: 16, limit: 2, seed: 'x' }), null, 'garbage month -> null');
  });
});

describe('collectRubricData offline fallback (P4 #28)', () => {
  test('offline + onthisdaymusic -> corpus events, zero network', async () => {
    const rubricData = await collectRubricData({
      names: ['onthisdaymusic'],
      offline: true,
      date: '2026-08-16',
      seed: 's|2026-08-16',
    });
    assert.equal(rubricData.offline, true);
    assert.ok(rubricData.onThisDayMusic?.events?.length >= 1, 'corpus must fill the offline rubric');
    assert.equal(rubricData.onThisDayMusic.source, 'local');
    assert.equal(rubricData.onThisDay, null, 'plain obzorje stays network-only');
  });

  test('offline without the rubric requested -> null', async () => {
    const rubricData = await collectRubricData({ names: ['quiz'], offline: true, date: '2026-08-16' });
    assert.equal(rubricData.onThisDayMusic, null);
  });

  test('brief keywords still map to onthisdaymusic', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: obzorje glasbe'), ['onthisdaymusic']);
    assert.deepEqual(parseBriefRubrics('Rubrike: na danasnji dan v glasbi'), ['onthisdaymusic']);
  });
});

describe('corpus events render through existing obzorjeGlasba pools', () => {
  test('male birth renders with the name and year', () => {
    const body = renderSlot('obzorjeGlasba', { values: { year: 1958, name: 'Michael Jackson', kindKey: 'birth' }, seed: 'p428' });
    assert.match(body, /Michael Jackson/);
    assert.match(body, /1958/);
    assert.match(body, /^Na (današnji dan v glasbi|ta dan v glasbi)/, 'both variants open the rubric');
  });

  test('female death uses the female ending in every variant', () => {
    for (const seed of ['a', 'b', 'c', 'd']) {
      const body = renderSlot('obzorjeGlasba', { values: { year: 1970, name: 'Janis Joplin', kindKey: 'deathF' }, seed });
      assert.match(body, /Janis Joplin/);
      assert.match(body, /zapela|umrla/, `female ending missing with seed ${seed}: ${body}`);
      assert.ok(!body.match(/umrl |rodil /), `male ending leaked with seed ${seed}: ${body}`);
    }
  });
});
