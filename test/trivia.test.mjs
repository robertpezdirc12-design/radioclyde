// Tests for P4 #17 ("Zanimivosti" rubric) + P4 #19 ("Na današnji dan v
// glasbi") -- the general rock-trivia layer:
//
//   A. the rockFacts corpus itself (integrity + deterministic rotation),
//   B. buildArtistFactFromMusicBrainz (pure fact builder, one safe sentence),
//   C. fetchArtistTrivia over a STUBBED global fetch (MusicBrainz fact,
//      sl.wikipedia fallback, entity guards, caching, 1 req/s spacing),
//   D. collectArtistTrivia (dedup, offline, maxArtists cap),
//   E. rubric keywords (briefQuery) incl. the fixed "na današnji dan" alias,
//   F. template rendering (triviaArtist / triviaGeneral / obzorjeGlasba),
//   G. segment placement in buildSegmentsAuto (sprinkle cadence, artist
//      facts before the artist's track, corpus filling the rest),
//   H. taxonomy classification of the new slots.
//
// No real network anywhere: globalThis.fetch is monkey-patched per test and
// restored after -- the same no-ffmpeg-no-network rule as the rest of the
// suite.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('trivia', {});

const { GENERAL_ROCK_FACTS, pickGeneralRockFacts } = await import('../src/auto/rockFacts.js');
const { foldArtist, buildArtistFactFromMusicBrainz, fetchArtistTrivia, collectArtistTrivia } = await import(
  '../src/auto/trivia.js'
);
const { parseBriefRubrics } = await import('../src/auto/briefQuery.js');
const { renderSlot } = await import('../src/auto/templates.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { classifySegment } = await import('../src/script/segments.js');

// ---------------------------------------------------------------------------
// fetch stubbing helpers
// ---------------------------------------------------------------------------

const MB_RE = /musicbrainz\.org\/ws\/2\/artist/;
const WIKI_RE = /sl\.wikipedia\.org\/api\/rest_v1\/page\/summary\//;

const jsonReply = (body) => ({ ok: true, status: 200, json: async () => body });
const errorReply = (status) => ({ ok: false, status, json: async () => ({}) });

function stubFetch(routes) {
  const original = globalThis.fetch;
  const calls = [];
  const fn = async (input) => {
    const url = String(input);
    calls.push({ url, at: performance.now() });
    for (const route of routes) {
      if (route.match.test(url)) return route.reply(url);
    }
    return errorReply(599);
  };
  fn.calls = calls;
  globalThis.fetch = fn;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const mbArtistBody = (artist) => ({ artists: [artist] });
const wikiBody = ({ title, extract, type = 'standard' }) => ({
  type,
  title,
  titles: { normalized: title },
  extract,
});

const MB_GROUP = {
  type: 'Group',
  name: 'Queen',
  country: 'GB',
  'life-span': { begin: '1970-06-27' },
  tags: [
    { name: 'rock', count: 12 },
    { name: 'pop', count: 8 },
    { name: 'progressive rock', count: 4 },
  ],
};

// MB route that echoes the QUERIED artist name back as the top hit, so the
// entity guard passes for whatever name the test asks about.
const mbEchoRoute = {
  match: MB_RE,
  reply: (url) => {
    const query = new URL(url).searchParams.get('query') ?? '';
    const name = /artist:"(.+)"/.exec(query)?.[1] ?? 'Unknown';
    return jsonReply({ artists: [{ ...MB_GROUP, name }] });
  },
};

// ---------------------------------------------------------------------------

describe('rockFacts corpus (P4 #17, offline half)', () => {
  test('corpus integrity: size, uniqueness, no trailing periods, no placeholders, chronological', () => {
    assert.ok(GENERAL_ROCK_FACTS.length >= 30, `corpus too small: ${GENERAL_ROCK_FACTS.length}`);
    const texts = GENERAL_ROCK_FACTS.map((f) => f.text);
    assert.equal(new Set(texts).size, texts.length, 'facts are unique');
    for (const fact of GENERAL_ROCK_FACTS) {
      assert.ok(typeof fact.text === 'string' && fact.text.length > 25, `too short: ${fact.text}`);
      assert.equal(/\.$/.test(fact.text), false, `fact carries its own period: ${fact.text}`);
      assert.ok(!fact.text.includes('{') && !fact.text.includes('}'), 'no template placeholders in facts');
      assert.ok(fact.year === null || (Number.isInteger(fact.year) && fact.year >= 1900 && fact.year <= 2020));
    }
    const years = GENERAL_ROCK_FACTS.filter((f) => f.year != null).map((f) => f.year);
    assert.deepEqual(years, [...years].sort((a, b) => a - b), 'corpus is roughly chronological');
  });

  test('pickGeneralRockFacts: deterministic, count-respecting, duplicate-free, usedTexts-aware', () => {
    const a = pickGeneralRockFacts(3, 'show-a|2026-10-24');
    const b = pickGeneralRockFacts(3, 'show-a|2026-10-24');
    assert.deepEqual(a, b, 'same seed -> same facts');
    assert.equal(a.length, 3);
    assert.equal(new Set(a.map((f) => f.text)).size, 3, 'no duplicates within one show');

    const c = pickGeneralRockFacts(5, 'show-a|2026-10-24', new Set(a.map((f) => f.text)));
    assert.equal(c.length, 5);
    for (const fact of a) assert.ok(!c.some((f) => f.text === fact.text), 'used facts are skipped');

    const everything = pickGeneralRockFacts(GENERAL_ROCK_FACTS.length + 10, 'x');
    assert.equal(everything.length, GENERAL_ROCK_FACTS.length, 'count is capped by corpus size');
  });
});

describe('buildArtistFactFromMusicBrainz (pure builder)', () => {
  test('Group + begin year + known country -> one safe sentence', () => {
    const fact = buildArtistFactFromMusicBrainz(MB_GROUP);
    assert.match(fact, /^Skupina Queen/);
    assert.match(fact, /iz Združenega kraljestva/);
    assert.match(fact, /nastala leta 1970/);
    assert.equal(/\.$/.test(fact), false, 'no trailing period (template adds it)');
  });

  test('Group without year falls back to country, then to genre tags (top-2 by count)', () => {
    assert.equal(buildArtistFactFromMusicBrainz({ type: 'Group', name: 'Bush', country: 'ZZ' }), null, 'unknown country code is dropped, not guessed');
    assert.match(buildArtistFactFromMusicBrainz({ type: 'Group', name: 'Bush', country: 'US' }), /prihaja iz ZDA/);
    const genres = buildArtistFactFromMusicBrainz({ type: 'Group', name: 'Bush', tags: [{ name: 'grunge', count: 5 }, { name: 'rock', count: 9 }] });
    assert.match(genres, /igra predvsem rock in grunge/);
  });

  test('Person -> null (begin dates mix birth/career; the wiki fallback speaks instead)', () => {
    assert.equal(buildArtistFactFromMusicBrainz({ type: 'Person', name: 'Freddie Mercury', country: 'GB', 'life-span': { begin: '1946-09-05' } }), null);
    assert.equal(buildArtistFactFromMusicBrainz(null), null);
    assert.equal(buildArtistFactFromMusicBrainz({ type: 'Group' }), null);
  });
});

describe('foldArtist', () => {
  test('folds case, diacritics, whitespace and punctuation', () => {
    assert.equal(foldArtist('The Beatles'), 'thebeatles');
    assert.equal(foldArtist('Beyoncé'), 'beyonce');
    assert.equal(foldArtist('AC/DC'), 'acdc');
    assert.equal(foldArtist('  Pankrti  '), 'pankrti');
    assert.equal(foldArtist(''), '');
    assert.equal(foldArtist(null), '');
  });
});

describe('fetchArtistTrivia (stubbed network)', () => {
  test('MusicBrainz Group fact wins; wikipedia is never asked', async () => {
    const stub = stubFetch([
      { match: MB_RE, reply: () => jsonReply(mbArtistBody(MB_GROUP)) },
      { match: WIKI_RE, reply: () => jsonReply(wikiBody({ title: 'Queen', extract: 'should not be used' })) },
    ]);
    try {
      const fact = await fetchArtistTrivia('Queen');
      assert.equal(fact.source, 'musicbrainz');
      assert.match(fact.text, /nastala leta 1970/);
      assert.equal(stub.calls.filter((c) => WIKI_RE.test(c.url)).length, 0, 'wiki fallback unused when MB speaks');
      assert.equal(stub.calls.length, 1, 'exactly one MB request');
    } finally {
      stub.restore();
    }
  });

  test('caching: a second call for the same artist makes no network calls', async () => {
    const stub = stubFetch([mbEchoRoute]);
    try {
      const first = await fetchArtistTrivia('Cache Queen');
      assert.ok(first, 'first call yields a fact');
      const afterFirst = stub.calls.length;
      const again = await fetchArtistTrivia('cache queen'); // fold-equal key
      assert.ok(again, 'cached value returned');
      assert.equal(stub.calls.length, afterFirst, 'no refetch within TTL');
    } finally {
      stub.restore();
    }
  });

  test('MB miss -> sl.wikipedia fallback, whole extract, trailing punctuation stripped', async () => {
    const stub = stubFetch([
      { match: MB_RE, reply: () => errorReply(404) },
      {
        match: WIKI_RE,
        reply: () => jsonReply(wikiBody({ title: 'Freddie Mercury', extract: 'Freddie Mercury, rojen kot Farrokh Bulsara, je bil britanski glasbenik, * 5. september 1946, Zanzibar.  ' })),
      },
    ]);
    try {
      const fact = await fetchArtistTrivia('Freddie Mercury');
      assert.equal(fact.source, 'wikipedia-sl');
      assert.match(fact.text, /Farrokh Bulsara/);
      assert.equal(/\.$/.test(fact.text), false, 'trailing period stripped (template adds it)');
      assert.equal(stub.calls.filter((c) => MB_RE.test(c.url)).length, 1, 'one MB attempt');
    } finally {
      stub.restore();
    }
  });

  test('entity guard: wikipedia disambiguation pages and title mismatches yield null', async () => {
    const disambig = stubFetch([
      { match: MB_RE, reply: () => errorReply(404) },
      { match: WIKI_RE, reply: () => jsonReply(wikiBody({ title: 'Bush (razločitev)', type: 'disambiguation', extract: 'Bush se lahko nanaša na ...' })) },
    ]);
    try {
      assert.equal(await fetchArtistTrivia('Bush'), null, 'disambiguation page -> null');
    } finally {
      disambig.restore();
    }

    const mismatch = stubFetch([
      { match: MB_RE, reply: () => errorReply(404) },
      { match: WIKI_RE, reply: () => jsonReply(wikiBody({ title: 'Grm', extract: 'Grm je rastlina ...' })) },
    ]);
    try {
      assert.equal(await fetchArtistTrivia('Bush'), null, 'wrong-page title -> null');
    } finally {
      mismatch.restore();
    }
  });

  test('entity guard: MusicBrainz top hit with a different name is ignored', async () => {
    const stub = stubFetch([
      { match: MB_RE, reply: () => jsonReply(mbArtistBody({ ...MB_GROUP, name: 'Some Other Band' })) },
      { match: WIKI_RE, reply: () => jsonReply(wikiBody({ title: 'Bush', extract: 'ne-uporabno, ker ne obstaja prava stran' })) },
    ]);
    try {
      // MB hit ignored (name mismatch) -> wiki fallback consulted; the wiki
      // page titled exactly "Bush" would pass the title guard, so the fact
      // comes from wikipedia, NOT from the mismatched MB row.
      const fact = await fetchArtistTrivia('Bush');
      assert.equal(fact.source, 'wikipedia-sl');
    } finally {
      stub.restore();
    }
  });

  test('total failure -> null (skip-not-fail contract)', async () => {
    const stub = stubFetch([
      { match: MB_RE, reply: () => errorReply(500) },
      { match: WIKI_RE, reply: () => errorReply(500) },
    ]);
    try {
      assert.equal(await fetchArtistTrivia('Nowhere Band'), null);
    } finally {
      stub.restore();
    }
  });

  test('MusicBrainz politeness: request starts stay >= 1 s apart', async () => {
    const stub = stubFetch([{ match: MB_RE, reply: () => jsonReply(mbArtistBody(MB_GROUP)) }]);
    try {
      await fetchArtistTrivia('Spacing One');
      await fetchArtistTrivia('Spacing Two');
      const mbCalls = stub.calls.filter((c) => MB_RE.test(c.url));
      assert.equal(mbCalls.length, 2);
      assert.ok(mbCalls[1].at - mbCalls[0].at >= 950, `gap only ${Math.round(mbCalls[1].at - mbCalls[0].at)} ms`);
    } finally {
      stub.restore();
    }
  });
});

describe('collectArtistTrivia', () => {
  const track = (artist, title) => ({ artist, title, ratingKey: title });

  test('offline: corpus half still works, network half is skipped', async () => {
    const stub = stubFetch([{ match: MB_RE, reply: () => { throw new Error('must not be called'); } }]);
    try {
      const data = await collectArtistTrivia({ tracks: [track('Offline Band', 'x')], offline: true, seed: 's1' });
      assert.deepEqual(data.artistFacts, []);
      assert.equal(data.generalFacts.length, 3, 'corpus facts work with zero network');
    } finally {
      stub.restore();
    }
  });

  test('artists are deduped and capped by triviaMaxArtists (default 6)', async () => {
    const stub = stubFetch([mbEchoRoute]);
    try {
      const tracks = [
        track('Dedup Band', 'a'),
        track('dedup band', 'b'), // same artist, folded
        ...Array.from({ length: 8 }, (_, i) => track(`Cap Artist ${i}`, `t${i}`)),
      ];
      const data = await collectArtistTrivia({ tracks, seed: 's2' });
      const mbCalls = stub.calls.filter((c) => MB_RE.test(c.url)).length;
      assert.equal(mbCalls, 6, 'unique artists dedup + cap at 6');
      assert.equal(data.artistFacts.length, 6);
      assert.equal(data.generalFacts.length, 3);
    } finally {
      stub.restore();
    }
  });

  test('facts without data simply do not appear (nulls filtered)', async () => {
    const stub = stubFetch([{ match: MB_RE, reply: () => jsonReply({ artists: [] }) }]);
    try {
      const data = await collectArtistTrivia({ tracks: [track('Ghost Band', 'x')], seed: 's3' });
      assert.deepEqual(data.artistFacts, []);
      assert.equal(data.generalFacts.length, 3);
    } finally {
      stub.restore();
    }
  });
});

describe('rubric keywords (briefQuery)', () => {
  test('zanimivosti maps to the trivia rubric', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: vreme, zanimivosti'), ['weather', 'trivia']);
    assert.deepEqual(parseBriefRubrics('Rubrike: trivia'), ['trivia']);
  });

  test('music on-this-day keywords, incl. diacritics', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: glasba'), ['onthisdaymusic']);
    assert.deepEqual(parseBriefRubrics('Rubrike: na današnji dan v glasbi'), ['onthisdaymusic']);
    assert.deepEqual(parseBriefRubrics('Rubrike: obzorje glasbe'), ['onthisdaymusic']);
  });

  test('the plain "na današnji dan" alias actually resolves (ASCII key fix)', () => {
    assert.deepEqual(parseBriefRubrics('Rubrike: na današnji dan'), ['onthisday']);
  });
});

describe('template rendering (new slots)', () => {
  test('triviaArtist / triviaGeneral substitute the fact and add the punctuation', () => {
    const fact = 'Skupina Queen je nastala leta 1970';
    const body = renderSlot('triviaArtist', { values: { fact }, seed: 's' });
    assert.ok(
      [
        `Če niste vedeli: ${fact}. Zdaj pa nazaj k glasbi.`,
        `Malo zanimivosti: ${fact}. In nadaljujemo z glasbo.`,
        `Malo zgodovine, preden sledi skladba: ${fact}.`,
      ].includes(body),
      `unexpected triviaArtist render: ${body}`
    );
    const generalFact = 'Fender je leta 1954 predstavil Stratocaster';
    const general = renderSlot('triviaGeneral', { values: { fact: generalFact }, seed: 's' });
    assert.ok(
      [
        `Ste to vedeli? ${generalFact}. Zdaj pa nadaljujemo z glasbo.`,
        `Zanimivost iz sveta rocka: ${generalFact}. In nazaj k glasbi.`,
        `Medtem, ko gre glasba naprej -- ${generalFact}.`,
      ].includes(general),
      `unexpected triviaGeneral render: ${general}`
    );
  });

  test('obzorjeGlasba pool names the rubric and honors kindKey', () => {
    const birth = renderSlot('obzorjeGlasba', { values: { year: 1946, name: 'Freddie Mercury', kindKey: 'birth' }, seed: 's' });
    assert.match(birth, /Na današnji dan v glasbi se je leta 1946 rodil Freddie Mercury\./);
    const deathF = renderSlot('obzorjeGlasba', { values: { year: 1991, name: 'Freddie Mercury', kindKey: 'deathF' }, seed: 's' });
    assert.match(deathF, /je leta 1991 umrla/);
  });
});

// ---------------------------------------------------------------------------
// segment placement in buildSegmentsAuto
// ---------------------------------------------------------------------------

const mkTracks = (count, artistFor) =>
  Array.from({ length: count }, (_, i) => ({
    ratingKey: `rk${i}`,
    artist: artistFor(i),
    title: `Song ${i}`,
    album: 'Album',
    year: 2001,
    durationMs: 180000,
  }));

const baseBrief = { hasQuiz: false, hasWeather: false, primaryPersona: 'ryan', title: 'Test Show' };

function slotSequence(segments) {
  return segments.map((s) => s.slot ?? (s.type === 'track' ? 'TRACK' : s.type));
}

describe('buildSegmentsAuto trivia placement (P4 #17)', () => {
  test('facts land before every 3rd track (i % 3 === 1), artist fact before ITS artist', () => {
    const tracks = mkTracks(12, (i) => `Artist ${i}`);
    const artistFacts = tracks.map((t) => ({ artist: t.artist, source: 'musicbrainz', text: `Skupina ${t.artist} je nastala leta 1970` }));
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: baseBrief,
      showId: 'triv-show',
      date: '2026-10-24',
      rubricData: { trivia: { artistFacts, generalFacts: [] } },
    });
    const slots = slotSequence(segments);
    const triviaIdx = slots.map((s, i) => [s, i]).filter(([s]) => s === 'triviaArtist').map(([, i]) => i);
    assert.equal(triviaIdx.length, 4, `12 tracks -> sprinkles at 1/4/7/10 (got ${slots.filter((s) => s === 'triviaArtist').length})`);
    for (const idx of triviaIdx) {
      assert.equal(slots[idx + 1], 'intro', 'trivia sits right before the track intro');
      const trackSeg = segments[idx + 2];
      assert.equal(trackSeg.type, 'track');
      assert.ok(segments[idx].body.includes(trackSeg.artist), 'the fact describes the artist about to play');
    }
  });

  test('one artist across the whole show: fact told once, corpus fills the remaining sprinkles', () => {
    const tracks = mkTracks(12, () => 'Queen');
    const { segments } = buildSegmentsAuto({
      tracks,
      brief: baseBrief,
      showId: 'queen-show',
      date: '2026-10-24',
      rubricData: {
        trivia: {
          artistFacts: [{ artist: 'Queen', source: 'musicbrainz', text: 'Skupina Queen, iz Združenega kraljestva, je nastala leta 1970' }],
          generalFacts: [
            { year: 1954, text: 'Fender je leta 1954 predstavil Stratocaster' },
            { year: 1969, text: 'Woodstock avgusta 1969 je zbrala okoli 400.000 ljudi' },
            { year: 1981, text: 'MTV je začela oddajati 1. avgusta 1981' },
          ],
        },
      },
    });
    const slots = slotSequence(segments);
    assert.equal(slots.filter((s) => s === 'triviaArtist').length, 1, 'artist fact once');
    assert.equal(slots.filter((s) => s === 'triviaGeneral').length, 3, 'corpus fills i=4/7/10');
    // trivia always precedes track #2, #5, #8, #11 (1-based) = track index 1, 4, 7, 10
    let trackOrdinal = 0;
    const precededTrack = [];
    for (const seg of segments) {
      if (seg.type === 'track') trackOrdinal++;
      else if (seg.slot?.startsWith('trivia')) precededTrack.push(trackOrdinal + 1);
    }
    assert.deepEqual(precededTrack, [2, 5, 8, 11]);
    // corpus queue order preserved
    const generalBodies = segments.filter((s) => s.slot === 'triviaGeneral').map((s) => s.body);
    assert.match(generalBodies[0], /Stratocaster/);
    assert.match(generalBodies[1], /Woodstock/);
    assert.match(generalBodies[2], /MTV/);
  });

  test('no trivia in rubricData -> no trivia segments (backward compatible)', () => {
    const tracks = mkTracks(6, (i) => `Artist ${i}`);
    const { segments } = buildSegmentsAuto({ tracks, brief: baseBrief, showId: 'plain', date: '2026-10-24', rubricData: {} });
    assert.equal(slotSequence(segments).filter((s) => s.startsWith('trivia')).length, 0);
  });

  test('new slots classify through the WRIT-FM taxonomy', () => {
    assert.equal(classifySegment({ type: 'dj', slot: 'triviaArtist' }), 'story');
    assert.equal(classifySegment({ type: 'dj', slot: 'triviaGeneral' }), 'music_essay');
    assert.equal(classifySegment({ type: 'dj', slot: 'obzorjeGlasba' }), 'news_analysis');
  });
});
