// Tests for P4 #29 "vreme brez omrežja" -- the honest offline weather:
//   A. pool integrity + the honesty guard (NO fabricated data in any
//      variant: no digits, no degrees, no "stopinj", no word the WMO map
//      could render as a real condition),
//   B. rendering (renderSlot): substitution, determinism, seed rotation,
//   C. collectRubricData: the offline branch fills the rubric, the online
//      branch still lets ARSO win, and a dead ARSO answer falls back,
//   D. script builder: fallback weather -> weatherOffline slot, ARSO shape
//      -> weatherNow, never both, null stays null (skip-not-fail),
//   E. live lines: a dead Open-Meteo must RESOLVE to the offline line --
//      directShow() awaits resolveLiveLine() with no retry, so a throw
//      would abort the whole occurrence (no playlist.m3u -> dead air).
//
// No real network anywhere: globalThis.fetch is stubbed and restored.
// ORDER MATTERS in group C: fetchArsoCurrentWeather caches its success in
// process for 15 min (the dead path caches nothing), so the dead-fetch test
// must run before the ARSO-success test in the same process.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('weather-offline', {});

const { collectRubricData } = await import('../src/auto/feeds.js');
const { renderSlot, slovenianWeatherDescription } = await import('../src/auto/templates.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { resolveLiveLineAuto } = await import('../src/auto/liveLines.js');

// The exact word set the WMO map can produce as a spoken "condition" -- the
// offline pools must never contain any of them, or an offline line could be
// read as a real observation.
const WMO_WORDS = new Set(
  Array.from({ length: 100 }, (_, code) => slovenianWeatherDescription(code)).filter((w) => w !== 'nenavadne razmere')
);

const HONESTY_MATCHERS = [
  { re: /\d/, why: 'no digits -- a weather report without numbers cannot pretend to be data' },
  { re: /°/, why: 'no degrees' },
  { re: /stopinj/i, why: 'no "stopinj"' },
];

function assertHonest(line, context) {
  for (const { re, why } of HONESTY_MATCHERS) assert.ok(!re.test(line), `${context}: ${why}: ${line}`);
  for (const word of WMO_WORDS) {
    assert.ok(!line.includes(word), `${context}: must not name a WMO condition "${word}": ${line}`);
  }
}

describe('P4 #29 pool integrity + honesty guard', () => {
  test('weatherOffline pool: non-trivial, every variant names the station', () => {
    const { DEFAULT_TEMPLATES } = getTemplates();
    const pool = DEFAULT_TEMPLATES.weatherOffline;
    assert.ok(Array.isArray(pool) && pool.length >= 4, `expected >= 4 offline rubric variants, got ${pool.length}`);
    for (const line of pool) {
      assert.ok(typeof line === 'string' && line.length > 30, `too short: ${line}`);
      assert.ok(line.includes('{station}'), `variant must name the ARSO station: ${line}`);
      assertHonest(line, 'weatherOffline');
    }
  });

  test('live.weatherOffline pool: non-trivial, opens with the live clock', () => {
    const { DEFAULT_TEMPLATES } = getTemplates();
    const pool = DEFAULT_TEMPLATES.live.weatherOffline;
    assert.ok(Array.isArray(pool) && pool.length >= 3, `expected >= 3 live offline variants, got ${pool.length}`);
    for (const line of pool) {
      assert.ok(line.startsWith('Je {time}'), `live variant must open with the local clock: ${line}`);
      assertHonest(line, 'live.weatherOffline');
    }
  });

  test('the pools differ from the data pools (no accidental same line)', () => {
    const { DEFAULT_TEMPLATES } = getTemplates();
    const dataLines = [
      ...DEFAULT_TEMPLATES.weatherNow.withTemp,
      ...DEFAULT_TEMPLATES.weatherNow.tempOnly,
      ...DEFAULT_TEMPLATES.weatherNow.generic,
      ...DEFAULT_TEMPLATES.live.weather,
      ...DEFAULT_TEMPLATES.live['time-weather'],
    ];
    for (const offline of [...DEFAULT_TEMPLATES.weatherOffline, ...DEFAULT_TEMPLATES.live.weatherOffline]) {
      assert.ok(!dataLines.includes(offline), `offline line collides with a data template: ${offline}`);
    }
  });
});

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

describe('P4 #29 rendering (renderSlot)', () => {
  test('weatherOffline substitutes the station and stays honest', () => {
    const body = renderSlot('weatherOffline', { values: { station: 'Ljubljana' }, seed: 'p429' });
    assert.match(body, /^Vreme/);
    assert.ok(body.includes('Ljubljana'), `station missing: ${body}`);
    assert.ok(!body.includes('{station}'), `unsubstituted placeholder: ${body}`);
    assertHonest(body, 'weatherOffline rendered');
  });

  test('deterministic per seed', () => {
    const a = renderSlot('weatherOffline', { values: { station: 'Celje' }, seed: 'x|y|z' });
    const b = renderSlot('weatherOffline', { values: { station: 'Celje' }, seed: 'x|y|z' });
    assert.equal(a, b);
  });

  test('seeds rotate through more than one variant', () => {
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      seen.add(renderSlot('weatherOffline', { values: { station: 'Nova Gorica' }, seed: `seed-${i}` }));
    }
    assert.ok(seen.size >= 2, `expected rotation across seeds, got ${seen.size} distinct lines`);
    for (const line of seen) assert.ok(line.includes('Nova Gorica'));
  });

  test('live:weatherOffline substitutes the clock and never invents facts', () => {
    const body = renderSlot('live:weatherOffline', { values: { time: '2:35 PM' }, seed: 'live-p429' });
    assert.ok(body.startsWith('Je 2:35 PM'), `clock substitution broken: ${body}`);
    assert.ok(!body.includes('{time}'), `unsubstituted placeholder: ${body}`);
    assert.ok(!body.includes('temperatura') && !body.includes('°'), `fabricated data leaked: ${body}`);
  });
});

describe('P4 #29 collectRubricData', () => {
  test('offline + vreme -> honest fallback object, rubric alive', async () => {
    const rubricData = await collectRubricData({ names: ['weather'], offline: true, date: '2026-10-24' });
    assert.equal(rubricData.offline, true);
    assert.deepEqual(rubricData.weather, { source: 'fallback', station: 'Ljubljana' }, 'fixtures default station');
  });

  test('offline without the rubric requested -> weather stays null', async () => {
    const rubricData = await collectRubricData({ names: ['quiz'], offline: true, date: '2026-10-24' });
    assert.equal(rubricData.weather, null, 'the fallback must respect the brief, not invent a rubric');
  });

  test('offline vreme coexists with the other local rubrics', async () => {
    const rubricData = await collectRubricData({ names: ['weather', 'onthisdaymusic', 'quiz'], offline: true, date: '2026-08-16' });
    assert.equal(rubricData.weather?.source, 'fallback');
    assert.equal(rubricData.onThisDayMusic?.source, 'local', 'P4 #28 corpus still fills glasba');
    assert.ok(rubricData.quiz?.questions?.length >= 1, 'P4 #22 quiz still fills kviz');
    assert.equal(rubricData.news, null, 'novice stay network-only');
    assert.equal(rubricData.sport, null, 'sport stays network-only');
  });

  // NOTE: order -- the ARSO cache (15 min, in process) makes the SUCCESS
  // result sticky, so the dead-fetch run must come first. The dead path
  // caches nothing, so the success run below fetches fresh.
  test('online with a dead ARSO -> fallback covers the gap, offline flag false', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('dead router (test stub)');
    };
    try {
      const rubricData = await collectRubricData({ names: ['weather'], offline: false, date: '2026-10-24' });
      assert.equal(rubricData.offline, false);
      assert.deepEqual(rubricData.weather, { source: 'fallback', station: 'Ljubljana' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('online with a healthy ARSO -> the real observation wins, never the fallback', async () => {
    const realFetch = globalThis.fetch;
    const arsoRss = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><item><title>LJUBLJANA: Jasno, 18 °C.</title></item></channel></rss>`;
    globalThis.fetch = async () => ({ ok: true, text: async () => arsoRss });
    try {
      const rubricData = await collectRubricData({ names: ['weather'], offline: false, date: '2026-10-24' });
      assert.deepEqual(rubricData.weather, { source: 'arso', station: 'LJUBLJANA', condition: 'Jasno', temp: 18 });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('P4 #29 script builder', () => {
  const mkTracks = (count) =>
    Array.from({ length: count }, (_, i) => ({
      ratingKey: `rk${i}`,
      artist: `Artist ${i}`,
      title: `Song ${i}`,
      album: 'Album',
      year: 2001,
      durationMs: 180000,
    }));
  const baseBrief = { hasQuiz: false, hasWeather: true, primaryPersona: 'elena', title: 'Vreme Show' };

  test('fallback weather -> weatherOffline slot, honest body, no weatherNow', () => {
    const { segments } = buildSegmentsAuto({
      tracks: mkTracks(4),
      brief: baseBrief,
      showId: 'vreme-show',
      date: '2026-10-24',
      rubricData: { weather: { source: 'fallback', station: 'Ljubljana' } },
    });
    const offline = segments.filter((s) => s.slot === 'weatherOffline');
    assert.equal(offline.length, 1, `exactly one offline weather segment, got ${offline.length}`);
    assert.equal(segments.filter((s) => s.slot === 'weatherNow').length, 0, 'the data slot must not fire for a fallback');
    assert.equal(offline[0].type, 'dj');
    assert.equal(offline[0].persona, 'elena');
    assert.ok(offline[0].body.includes('Ljubljana'));
    assert.match(offline[0].body, /^Vreme/);
  });

  test('ARSO shape still renders through weatherNow (no regression)', () => {
    const { segments } = buildSegmentsAuto({
      tracks: mkTracks(4),
      brief: baseBrief,
      showId: 'vreme-show',
      date: '2026-10-24',
      rubricData: { weather: { source: 'arso', station: 'CELJE', condition: 'Jasno', temp: 18 } },
    });
    assert.equal(segments.filter((s) => s.slot === 'weatherNow').length, 1);
    assert.equal(segments.filter((s) => s.slot === 'weatherOffline').length, 0);
    const body = segments.find((s) => s.slot === 'weatherNow').body;
    assert.ok(body.includes('CELJE') && body.includes('18'), `ARSO data missing: ${body}`);
  });

  test('null weather still contributes nothing (skip-not-fail unchanged)', () => {
    const { segments } = buildSegmentsAuto({
      tracks: mkTracks(4),
      brief: baseBrief,
      showId: 'vreme-show',
      date: '2026-10-24',
      rubricData: { weather: null },
    });
    assert.equal(segments.filter((s) => s.slot === 'weatherNow' || s.slot === 'weatherOffline').length, 0);
  });

  test('same inputs -> same offline line (reproducible transcripts)', () => {
    const build = () =>
      buildSegmentsAuto({
        tracks: mkTracks(4),
        brief: baseBrief,
        showId: 'vreme-show',
        date: '2026-10-24',
        rubricData: { weather: { source: 'fallback', station: 'Maribor' } },
      }).segments.find((s) => s.slot === 'weatherOffline').body;
    assert.equal(build(), build());
  });
});

describe('P4 #29 live lines (show-saver)', () => {
  test('dead Open-Meteo RESOLVES to the honest offline line -- the show survives', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('dead router (test stub)');
    };
    try {
      const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'weather' });
      assert.match(line, /^Je \d/, `must open with the live clock: ${line}`);
      assert.ok(!line.includes('temperatura') && !line.includes('°'), `fabricated data leaked: ${line}`);
      assertHonest(line.replace(/^Je \S+/, 'Je {time}'), 'live offline rendered');
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('time-weather kind also survives a dead Open-Meteo (no °C invented)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('dead router (test stub)');
    };
    try {
      const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'time-weather' });
      assert.match(line, /^Je \d/, `offline line must open with the clock: ${line}`);
      assert.ok(!line.includes('°'), `time-weather fallback must not invent degrees: ${line}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('kind "time" never needed the network (regression)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('dead router (test stub)');
    };
    try {
      const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'time' });
      assert.match(line, /^Trenutno je /);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('healthy Open-Meteo still renders the normal data line (no regression)', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ current: { temperature_2m: 21.4, weather_code: 0, wind_speed_10m: 3.2 } }),
    });
    try {
      const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'weather' });
      assert.match(line, /^Zunaj je jasno, temperatura 21 °C, veter piha s hitrostjo 3 km\/h\.$/, `got: ${line}`);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
