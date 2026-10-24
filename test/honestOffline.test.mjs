// Tests for P4 #30 "poštene offline vrstice" -- the honest offline lines for
// the three remaining network rubrics (novice / šport / obzorje):
//   A. pool integrity + the honesty guard (STRICTER than the weather pools:
//      no digits at all -- a headline service without numbers cannot pretend
//      to have headlines; no source blame on air; the rubric's shape marker
//      opens every variant),
//   B. rendering (renderSlot): determinism, seed rotation, no placeholders,
//   C. collectRubricData: the offline branch fills all three rubrics, the
//      brief is respected (unnamed rubric stays null), healthy local
//      rubrics coexist,
//   D. collectRubricData online: a dead source falls back, healthy RTV /
//      Wikidata still win, a legitimately empty Wikidata date is honest too
//      (the archive yielded nothing -> offline line),
//   E. script builder: fallback shapes -> the offline slots (never the data
//      slots, never both), data shapes -> data slots (no regression), null
//      stays null (skip-not-fail), taxonomy maps all three to news_analysis.
//
// No real network anywhere: globalThis.fetch is stubbed and restored.
// ORDER MATTERS in group D: the RTV feeds cache SUCCESS results in process
// for 30 min (the dead path caches nothing), so the dead-fetch test must run
// first; the two Wikidata tests use DIFFERENT dates because the WDQS cache
// key includes month/day (a null from an empty date would otherwise poison
// the healthy test).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('honest-offline', {});

const { collectRubricData } = await import('../src/auto/feeds.js');
const { renderSlot } = await import('../src/auto/templates.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { classifySegment } = await import('../src/script/segments.js');

// The honesty guard for headline rubrics: digits are the fingerprint of a
// fabricated story (scores, years, casualty counts) -- a line without them
// cannot be read as a real headline. Source names stay off air entirely:
// the station never blames RTV or Wikidata out loud, the pools are
// source-generic by construction.
const HONESTY_MATCHERS = [
  { re: /\d/, why: 'no digits -- a headline service without numbers cannot pretend to have headlines' },
  { re: /RTV|rtvslo/i, why: 'no RTV blame on air -- source-generic pool' },
  { re: /Wikidata|wikidata/i, why: 'no Wikidata blame on air -- source-generic pool' },
];

function assertHonest(line, context) {
  for (const { re, why } of HONESTY_MATCHERS) assert.ok(!re.test(line), `${context}: ${why}: ${line}`);
  assert.ok(!line.includes('{'), `${context}: no placeholders in the offline pools: ${line}`);
}

const POOL_CONTRACTS = [
  { key: 'newsOffline', opener: 'Novice:', why: 'news rubric keeps its shape marker' },
  { key: 'sportOffline', opener: 'Športne novice:', why: 'sport rubric keeps its shape marker' },
  { key: 'obzorjeOffline', opener: 'Na današnji dan:', why: 'obzorje rubric keeps its shape marker' },
];

// templates.js keeps DEFAULT_TEMPLATES internal (the public contract is
// renderSlot), but the pool-integrity tests need the RAW strings -- before
// substitution, before any config override. Parsing the object literal out
// of the module source keeps that honest: the test reads exactly what the
// operators would edit, pure string data, no module-state coupling.
let _defaults = null;
function getTemplates() {
  if (_defaults) return { DEFAULT_TEMPLATES: _defaults };
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'auto', 'templates.js'),
    'utf8'
  );
  const openBrace = src.indexOf('{', src.indexOf('const DEFAULT_TEMPLATES = {'));
  let depth = 0;
  let end = openBrace;
  for (let i = openBrace; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  _defaults = new Function(`return ${src.slice(openBrace, end + 1)};`)();
  return { DEFAULT_TEMPLATES: _defaults };
}

describe('P4 #30 pool integrity + honesty guard', () => {
  for (const { key, opener, why } of POOL_CONTRACTS) {
    test(`${key} pool: non-trivial, every variant keeps its shape marker and stays honest`, () => {
      const { DEFAULT_TEMPLATES } = getTemplates();
      const pool = DEFAULT_TEMPLATES[key];
      assert.ok(Array.isArray(pool) && pool.length >= 4, `expected >= 4 offline variants, got ${pool?.length}`);
      for (const line of pool) {
        assert.ok(typeof line === 'string' && line.length > 30, `too short: ${line}`);
        assert.ok(line.startsWith(opener), `${why} (must open "${opener}"): ${line}`);
        assertHonest(line, key);
      }
    });
  }

  test('the pools differ from the data pools (no accidental same line)', () => {
    const { DEFAULT_TEMPLATES } = getTemplates();
    const dataLines = [
      ...DEFAULT_TEMPLATES.newsHeadlines,
      ...DEFAULT_TEMPLATES.sportHeadlines,
      ...DEFAULT_TEMPLATES.obzorje.birth,
      ...DEFAULT_TEMPLATES.obzorje.birthF,
      ...DEFAULT_TEMPLATES.obzorje.death,
      ...DEFAULT_TEMPLATES.obzorje.deathF,
      ...DEFAULT_TEMPLATES.weatherOffline,
    ];
    for (const { key } of POOL_CONTRACTS) {
      for (const line of DEFAULT_TEMPLATES[key]) {
        assert.ok(!dataLines.includes(line), `${key} line collides with a data template: ${line}`);
      }
    }
  });
});

describe('P4 #30 rendering (renderSlot)', () => {
  test('rendered lines substitute nothing (no placeholders), stay honest, keep shape', () => {
    for (const { key, opener } of POOL_CONTRACTS) {
      const body = renderSlot(key, { values: { station: 'Radio Markec' }, seed: `p430-${key}` });
      assert.ok(body.startsWith(opener), `${key} rendered line lost its opener: ${body}`);
      assert.ok(!body.includes('{'), `${key} unsubstituted placeholder: ${body}`);
      assertHonest(body, `${key} rendered`);
    }
  });

  test('deterministic per seed', () => {
    for (const { key } of POOL_CONTRACTS) {
      const a = renderSlot(key, { values: {}, seed: 'x|y|z' });
      const b = renderSlot(key, { values: {}, seed: 'x|y|z' });
      assert.equal(a, b, `${key} not deterministic`);
    }
  });

  test('seeds rotate through more than one variant', () => {
    for (const { key } of POOL_CONTRACTS) {
      const seen = new Set();
      for (let i = 0; i < 14; i++) seen.add(renderSlot(key, { values: {}, seed: `seed-${i}` }));
      assert.ok(seen.size >= 2, `${key}: expected rotation across seeds, got ${seen.size} distinct lines`);
      for (const line of seen) assertHonest(line, `${key} rotation`);
    }
  });
});

describe('P4 #30 collectRubricData (offline branch)', () => {
  test('offline + novice/sport/obzorje -> honest fallback objects, rubrics alive', async () => {
    const rubricData = await collectRubricData({ names: ['news', 'sport', 'onthisday'], offline: true, date: '2026-10-24' });
    assert.equal(rubricData.offline, true);
    assert.deepEqual(rubricData.news, { source: 'fallback' });
    assert.deepEqual(rubricData.sport, { source: 'fallback' });
    assert.deepEqual(rubricData.onThisDay, { source: 'fallback' });
  });

  test('offline without the rubrics requested -> all three stay null (brief respected)', async () => {
    const rubricData = await collectRubricData({ names: ['quiz'], offline: true, date: '2026-10-24' });
    assert.equal(rubricData.news, null, 'the fallback must respect the brief, not invent a rubric');
    assert.equal(rubricData.sport, null);
    assert.equal(rubricData.onThisDay, null);
  });

  test('offline fallbacks coexist with the local rubrics (kviz/glasba/vreme)', async () => {
    const rubricData = await collectRubricData({ names: ['news', 'sport', 'onthisday', 'weather', 'onthisdaymusic', 'quiz'], offline: true, date: '2026-08-16' });
    assert.deepEqual(rubricData.news, { source: 'fallback' });
    assert.deepEqual(rubricData.sport, { source: 'fallback' });
    assert.deepEqual(rubricData.onThisDay, { source: 'fallback' });
    assert.equal(rubricData.weather?.source, 'fallback', 'P4 #29 vreme still fills');
    assert.equal(rubricData.onThisDayMusic?.source, 'local', 'P4 #28 corpus still fills glasba');
    assert.ok(rubricData.quiz?.questions?.length >= 1, 'P4 #22 quiz still fills');
  });
});

describe('P4 #30 collectRubricData (online branch)', () => {
  // DEAD SOURCE FIRST: the fetch-failure path caches nothing, the success
  // path below does (RTV 30 min).
  test('online with a dead source -> fallback covers all three, offline flag false', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('dead router (test stub)');
    };
    try {
      const rubricData = await collectRubricData({ names: ['news', 'sport', 'onthisday'], offline: false, date: '2026-10-24' });
      assert.equal(rubricData.offline, false);
      assert.deepEqual(rubricData.news, { source: 'fallback' });
      assert.deepEqual(rubricData.sport, { source: 'fallback' });
      assert.deepEqual(rubricData.onThisDay, { source: 'fallback' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('healthy RTV feeds still win for novice and sport (no regression)', async () => {
    const realFetch = globalThis.fetch;
    const rssFor = (titles) =>
      `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel>${titles
        .map((t) => `<item><title>${t}</title></item>`)
        .join('')}</channel></rss>`;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('rtvslo.si/sport')) {
        return { ok: true, text: async () => rssFor(['Šampiončev konj na pragu velikanskega uspeha', 'Kolesarji pobirali točke na svetovni turneji']) };
      }
      if (u.includes('rtvslo.si/feeds/novice')) {
        return { ok: true, text: async () => rssFor(['Ministrstvo napovedalo dogovor o svetovanju', 'V Ljubljani odprt javni prostor za mlade']) };
      }
      throw new Error(`unexpected url ${u}`);
    };
    try {
      const rubricData = await collectRubricData({ names: ['news', 'sport'], offline: false, date: '2026-10-24' });
      assert.equal(rubricData.news?.source, 'rtv');
      assert.equal(rubricData.news?.count, 2);
      assert.ok(rubricData.news?.headlines?.includes('Ministrstvo'), `real headline missing: ${rubricData.news?.headlines}`);
      assert.equal(rubricData.sport?.source, 'rtv');
      assert.equal(rubricData.sport?.count, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // Healthy Wikidata (date 2026-03-02) BEFORE the empty date (2026-05-05):
  // different WDQS cache keys, so the null from the empty date can never
  // poison the healthy test in the same process.
  test('healthy Wikidata with events still wins for obzorje (no regression)', async () => {
    const realFetch = globalThis.fetch;
    const wdqsJson = {
      results: {
        bindings: [
          { item: { value: 'https://www.wikidata.org/entity/Q42' }, year: { value: '1942' }, kind: { value: 'birth' } },
        ],
      },
    };
    const entitiesJson = {
      entities: {
        Q42: {
          labels: { sl: { value: 'Ime Priimek' } },
          claims: { P21: [{ mainsnak: { datavalue: { value: { id: 'Q6581097' } } } }] },
        },
      },
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('query.wikidata.org/sparql')) return { ok: true, json: async () => wdqsJson };
      if (u.includes('www.wikidata.org/w/api.php')) return { ok: true, json: async () => entitiesJson };
      throw new Error(`unexpected url ${u}`);
    };
    try {
      const rubricData = await collectRubricData({ names: ['onthisday'], offline: false, date: '2026-03-02' });
      assert.equal(rubricData.onThisDay?.source, 'wikidata');
      assert.equal(rubricData.onThisDay?.events?.length, 1);
      assert.equal(rubricData.onThisDay?.events?.[0]?.name, 'Ime Priimek');
      assert.equal(rubricData.onThisDay?.events?.[0]?.sex, 'male');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a legitimately event-less Wikidata date -> honest fallback (empty answer is honest too)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ results: { bindings: [] } }) });
    try {
      const rubricData = await collectRubricData({ names: ['onthisday'], offline: false, date: '2026-05-05' });
      assert.deepEqual(rubricData.onThisDay, { source: 'fallback' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('P4 #30 script builder', () => {
  const mkTracks = (count) =>
    Array.from({ length: count }, (_, i) => ({
      ratingKey: `rk${i}`,
      artist: `Artist ${i}`,
      title: `Song ${i}`,
      album: 'Album',
      year: 2001,
      durationMs: 180000,
    }));
  const baseBrief = { hasQuiz: false, hasWeather: true, primaryPersona: 'elena', title: 'Novice Show' };

  test('fallback shapes -> the three offline slots, never the data slots', () => {
    const { segments } = buildSegmentsAuto({
      tracks: mkTracks(4),
      brief: baseBrief,
      showId: 'novice-show',
      date: '2026-10-24',
      rubricData: { news: { source: 'fallback' }, sport: { source: 'fallback' }, onThisDay: { source: 'fallback' } },
    });
    for (const slot of ['newsOffline', 'sportOffline', 'obzorjeOffline']) {
      const hits = segments.filter((s) => s.slot === slot);
      assert.equal(hits.length, 1, `exactly one ${slot} segment, got ${hits.length}`);
      assert.equal(hits[0].type, 'dj');
      assert.equal(hits[0].persona, 'elena');
      assertHonest(hits[0].body, `${slot} body`);
    }
    for (const slot of ['newsHeadlines', 'sportHeadlines', 'obzorje']) {
      assert.equal(segments.filter((s) => s.slot === slot).length, 0, `${slot} must not fire for a fallback`);
    }
  });

  test('data shapes still render through the data slots (no regression)', () => {
    const { segments } = buildSegmentsAuto({
      tracks: mkTracks(4),
      brief: baseBrief,
      showId: 'novice-show',
      date: '2026-10-24',
      rubricData: {
        news: { source: 'rtv', headlines: 'Prva naslovnica. Druga naslovnica.', count: 2 },
        sport: { source: 'rtv', headlines: 'Športna naslovnica.', count: 1 },
        onThisDay: {
          source: 'wikidata',
          date: '3/2',
          events: [{ id: 'Q42', year: 1942, kind: 'birth', name: 'Ime Priimek', sex: 'male' }],
        },
      },
    });
    assert.equal(segments.filter((s) => s.slot === 'newsHeadlines').length, 1);
    assert.equal(segments.filter((s) => s.slot === 'sportHeadlines').length, 1);
    assert.equal(segments.filter((s) => s.slot === 'obzorje').length, 1);
    assert.equal(segments.filter((s) => s.slot === 'newsOffline' || s.slot === 'sportOffline' || s.slot === 'obzorjeOffline').length, 0);
    const obzorjeBody = segments.find((s) => s.slot === 'obzorje').body;
    assert.ok(obzorjeBody.includes('Ime Priimek') && obzorjeBody.includes('1942'), `wikidata event missing: ${obzorjeBody}`);
  });

  test('null rubricData still contributes nothing (skip-not-fail unchanged)', () => {
    const { segments } = buildSegmentsAuto({
      tracks: mkTracks(4),
      brief: baseBrief,
      showId: 'novice-show',
      date: '2026-10-24',
      rubricData: { news: null, sport: null, onThisDay: null },
    });
    assert.equal(
      segments.filter((s) =>
        ['newsHeadlines', 'newsOffline', 'sportHeadlines', 'sportOffline', 'obzorje', 'obzorjeOffline'].includes(s.slot)
      ).length,
      0
    );
  });

  test('same inputs -> same offline lines (reproducible transcripts)', () => {
    const build = (slot) =>
      buildSegmentsAuto({
        tracks: mkTracks(4),
        brief: baseBrief,
        showId: 'novice-show',
        date: '2026-10-24',
        rubricData: { news: { source: 'fallback' }, sport: { source: 'fallback' }, onThisDay: { source: 'fallback' } },
      }).segments.find((s) => s.slot === slot).body;
    for (const slot of ['newsOffline', 'sportOffline', 'obzorjeOffline']) {
      assert.equal(build(slot), build(slot), `${slot} not reproducible`);
    }
  });

  test('taxonomy: all three offline slots classify as news_analysis', () => {
    for (const slot of ['newsOffline', 'sportOffline', 'obzorjeOffline']) {
      assert.equal(classifySegment({ type: 'dj', slot }), 'news_analysis', `${slot} must stay news_analysis`);
    }
  });
});
