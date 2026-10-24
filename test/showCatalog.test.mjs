// Tests for P4 #18 -- the themed show generator (auto/showCatalog.js) and its
// wiring into the schedule read (scheduleUtil.loadSchedule):
//
//   A. catalog integrity (unique slug ids, required fields, trivia rubric),
//   B. brief round-trip per theme: rendered markdown parses back through
//      parseShowBrief AND resolves a real selection through
//      produceTrackQueryDeterministic (the same parser production uses),
//   C. ISO-8601 week key against fixed dates (incl. the 2026-W53 -> 2027-W01
//      year boundary),
//   D. special-slot rotation (deterministic within a week, advances weekly,
//      honest errors for unknown/malformed themes),
//   E. ensureThemedBrief materialization (write, idempotent no-rewrite,
//      refresh on content change, honest persona/id errors),
//   F. loadSchedule integration (special entries resolve to description +
//      specialTheme/specialTitle, raw passthrough on misconfiguration,
//      comma-joined weekday keys still expand).
//
// No network, no real library: the brief parser needs only synthetic genre
// tags, and the schedule test writes its own station.json fixture.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('showCatalog', {});

const {
  THEMED_SHOWS,
  listThemedShows,
  getThemedShow,
  isoWeekKey,
  resolveSpecialTheme,
  themedBriefRelPath,
  renderThemedBrief,
  ensureThemedBrief,
} = await import('../src/auto/showCatalog.js');
const { parseShowBrief } = await import('../src/producer/showBrief.js');
const { produceTrackQueryDeterministic } = await import('../src/auto/briefQuery.js');
const { loadSchedule } = await import('../src/scheduler/scheduleUtil.js');
const { config } = await import('../src/config/index.js');

// Fixed LOCAL dates whose ISO-8601 week keys were computed independently
// (Python isocalendar): the Saturday of 2026-W43, the whole of W44, W45's
// Monday, W46's Monday, and the year boundary (2027-01-01 belongs to
// 2026-W53, 2027-01-04 opens 2027-W01).
const W43_SAT = new Date(2026, 9, 24); // 202643
const W44_MON = new Date(2026, 9, 26); // 202644
const W45_MON = new Date(2026, 10, 2); // 202645
const W46_MON = new Date(2026, 10, 9); // 202646
const NEW_YEAR_2027 = new Date(2027, 0, 1); // 202653 -- still the OLD year's W53
const W01_2027 = new Date(2027, 0, 4); // 202701

function localDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

describe('showCatalog: catalog integrity', () => {
  test('catalog is non-trivial with unique, slug-safe ids', () => {
    assert.ok(THEMED_SHOWS.length >= 8, `expected at least 8 themes, got ${THEMED_SHOWS.length}`);
    const ids = THEMED_SHOWS.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length, 'theme ids must be unique');
    for (const id of ids) {
      assert.match(id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `theme id "${id}" is not a slug`);
    }
  });

  test('every theme carries the fields a brief needs (incl. the trivia rubric)', () => {
    for (const theme of THEMED_SHOWS) {
      assert.ok(theme.title?.trim(), `${theme.id}: missing title`);
      assert.ok(theme.emoji, `${theme.id}: missing emoji`);
      assert.ok(theme.tagline?.trim().length > 80, `${theme.id}: tagline too thin`);
      assert.ok(Array.isArray(theme.rubrics) && theme.rubrics.includes('zanimivosti'), `${theme.id}: zanimivosti rubric required`);
      assert.ok(Array.isArray(theme.trackSelection) && theme.trackSelection.length >= 2, `${theme.id}: trackSelection too thin`);
    }
  });

  test('listThemedShows/getThemedShow agree with the catalog', () => {
    assert.equal(listThemedShows(), THEMED_SHOWS);
    assert.equal(getThemedShow(THEMED_SHOWS[0].id), THEMED_SHOWS[0]);
    assert.equal(getThemedShow('ne-obstaja'), null);
  });
});

describe('showCatalog: brief round-trip through the real parsers', () => {
  const GENRE_TAGS = ['Rock', 'Pop/Rock', 'Punk', 'Hard Rock', 'Heavy Metal', 'Blues'];
  const ALBUM_GENRE_TAGS = ['Live', 'Studio'];

  test('rendered brief parses back and resolves a deterministic selection (every theme)', () => {
    for (const theme of THEMED_SHOWS) {
      const markdown = renderThemedBrief(theme, { durationMinutes: 60, personas: ['testa'] });
      const brief = parseShowBrief(markdown, { defaultRepeatWindowDays: 7 });
      assert.equal(brief.primaryPersona, 'testa', `${theme.id}: primary persona lost`);
      assert.match(markdown, /^# 📻 /m, `${theme.id}: H1 must carry the 📻 emoji so the parsed title strips clean`);
      assert.ok(brief.title?.startsWith(theme.title), `${theme.id}: brief title "${brief.title}" should start with "${theme.title}"`);
      assert.equal(brief.repeatWindowDays, 7, `${theme.id}: themed shows repeat weekly`);
      assert.ok(brief.trackSelectionText?.includes('\n- ') || brief.trackSelectionText?.startsWith('- '), `${theme.id}: track selection empty`);

      const { query } = produceTrackQueryDeterministic({
        trackSelectionText: brief.trackSelectionText,
        genreTags: GENRE_TAGS,
        albumGenreTags: ALBUM_GENRE_TAGS,
      });
      const hasSelection =
        query.artist || query.genre || query.decade || query.artistList?.length || query.albumGenre || query.singleAlbum;
      assert.ok(hasSelection, `${theme.id}: selection did not resolve -- brief would fail in production`);
    }
  });

  test('decade themes carry the right structured decade', () => {
    for (const [id, decade] of [['rock-60s', '1960'], ['rock-70s', '1970'], ['rock-80s', '1980'], ['rock-90s', '1990']]) {
      const markdown = renderThemedBrief(getThemedShow(id), { durationMinutes: 60, personas: ['testa'] });
      const { query } = produceTrackQueryDeterministic({
        trackSelectionText: parseShowBrief(markdown).trackSelectionText,
        genreTags: GENRE_TAGS,
        albumGenreTags: ALBUM_GENRE_TAGS,
      });
      assert.equal(query.decade, decade, `${id}: wrong decade`);
      assert.ok(query.genre, `${id}: genre missing`);
    }
  });

  test('artistList themes pass the full list through; Live theme uses album genre', () => {
    for (const id of ['zgodovina-kitare', 'rock-jugoslavije', 'punk-nova-val']) {
      const markdown = renderThemedBrief(getThemedShow(id), { durationMinutes: 60, personas: ['testa'] });
      const { query } = produceTrackQueryDeterministic({
        trackSelectionText: parseShowBrief(markdown).trackSelectionText,
        genreTags: GENRE_TAGS,
        albumGenreTags: ALBUM_GENRE_TAGS,
      });
      assert.ok(Array.isArray(query.artistList) && query.artistList.length >= 5, `${id}: artistList lost`);
    }
    const live = produceTrackQueryDeterministic({
      trackSelectionText: parseShowBrief(renderThemedBrief(getThemedShow('veliki-nastopi'), { personas: ['testa'] })).trackSelectionText,
      genreTags: GENRE_TAGS,
      albumGenreTags: ALBUM_GENRE_TAGS,
    }).query;
    assert.equal(live.albumGenre, 'Live', 'veliki-nastopi must select on the Live album genre');
  });

  test('whole-album theme flips singleAlbum mode', () => {
    const { query } = produceTrackQueryDeterministic({
      trackSelectionText: parseShowBrief(renderThemedBrief(getThemedShow('album-v-celoti'), { personas: ['testa'] })).trackSelectionText,
      genreTags: GENRE_TAGS,
      albumGenreTags: ALBUM_GENRE_TAGS,
    });
    assert.equal(query.singleAlbum, true, 'album-v-celoti must request one whole random album');
    assert.equal(query.oneTrackPerAlbum, false, 'whole-album show must not cap at one track per album');
  });

  test('rendering is deterministic and honest about personas', () => {
    const theme = THEMED_SHOWS[0];
    const a = renderThemedBrief(theme, { durationMinutes: 45, personas: ['elena'] });
    const b = renderThemedBrief(theme, { durationMinutes: 45, personas: ['elena'] });
    assert.equal(a, b, 'same input must render byte-identical output');
    assert.match(a, /^\*\*Duration:\*\* 45 min$/m);
    assert.throws(() => renderThemedBrief(theme, { personas: [] }), /needs at least one persona/);
    assert.throws(() => renderThemedBrief({ id: 'izmislek' }, { personas: ['x'] }), /not a catalog theme/);
  });
});

describe('showCatalog: ISO week key', () => {
  test('fixed dates, including the 2026-W53 -> 2027-W01 year boundary', () => {
    assert.equal(isoWeekKey(W43_SAT), 202643);
    assert.equal(isoWeekKey(W44_MON), 202644);
    assert.equal(isoWeekKey(W45_MON), 202645);
    assert.equal(isoWeekKey(W46_MON), 202646);
    assert.equal(isoWeekKey(NEW_YEAR_2027), 202653, '2027-01-01 still belongs to 2026-W53');
    assert.equal(isoWeekKey(W01_2027), 202701);
  });

  test('every day of a week shares one key', () => {
    for (let day = 26; day <= 31; day++) {
      assert.equal(isoWeekKey(new Date(2026, 9, day)), 202644, `2026-10-${day} must stay in W44`);
    }
    assert.equal(isoWeekKey(new Date(2026, 10, 1)), 202644, '2026-11-01 (Sunday) closes W44');
  });
});

describe('showCatalog: special slot rotation', () => {
  const [a, b, c] = THEMED_SHOWS.map((t) => t.id);
  const special = { themes: [a, b, c] };

  test('rotates deterministically by ISO week key (not by week-of-year alone)', () => {
    // Full keys: 202643%3=2, 202644%3=0, 202645%3=1, 202646%3=2.
    assert.equal(resolveSpecialTheme(special, W43_SAT).id, c, 'W43 (202643%3=2) must pick themes[2]');
    assert.equal(resolveSpecialTheme(special, W44_MON).id, a, 'W44 (202644%3=0) must pick themes[0]');
    assert.equal(resolveSpecialTheme(special, W45_MON).id, b, 'W45 (202645%3=1) must pick themes[1]');
    assert.equal(resolveSpecialTheme(special, W46_MON).id, c, 'W46 (202646%3=2) wraps back to themes[2]');
  });

  test('the whole ISO week resolves identically (prewarm and air agree)', () => {
    for (let day = 26; day <= 31; day++) {
      assert.equal(resolveSpecialTheme(special, new Date(2026, 9, day)).id, a, `2026-10-${day} must match W44's theme`);
    }
    assert.equal(resolveSpecialTheme(special, new Date(2026, 10, 1)).id, a);
  });

  test('the year boundary rotates by the slot\'s OWN iso weeks, not calendar years', () => {
    assert.equal(resolveSpecialTheme(special, NEW_YEAR_2027).id, a, '2026-W53 (202653%3=0)');
    assert.equal(resolveSpecialTheme(special, W01_2027).id, a, '2027-W01 (202701%3=0)');
  });

  test('malformed specials fail with honest, actionable errors', () => {
    const expectThrow = (fn, pattern) => {
      try {
        fn();
        assert.fail('expected the special resolution to throw');
      } catch (err) {
        assert.ok(err instanceof Error, `threw a real Error, got ${String(err)}`);
        assert.match(err.message, pattern);
        return err;
      }
    };
    expectThrow(() => resolveSpecialTheme(undefined, W44_MON), /non-empty array of theme ids/);
    expectThrow(() => resolveSpecialTheme({}, W44_MON), /non-empty array of theme ids/);
    expectThrow(() => resolveSpecialTheme({ themes: [] }, W44_MON), /non-empty array of theme ids/);
    expectThrow(() => resolveSpecialTheme({ themes: 'rock' }, W44_MON), /non-empty array of theme ids/);
    const err = expectThrow(() => resolveSpecialTheme({ themes: ['ne-obstaja', a] }, W44_MON), /Unknown themed show/);
    assert.match(err.message, /ne-obstaja/, 'the error must name the unknown id');
    assert.match(err.message, new RegExp(a), 'the error must list available themes');
  });
});

describe('showCatalog: ensureThemedBrief', () => {
  const theme = THEMED_SHOWS[0];
  const file = path.join(config.paths.showDescriptionsDir, 'themed', `${theme.id}.md`);

  test('writes the brief and returns its station.json-style path', () => {
    const rel = ensureThemedBrief(theme, { durationMinutes: 60, personas: ['testa'] });
    assert.equal(rel, themedBriefRelPath(theme.id));
    assert.equal(rel, `show-descriptions/themed/${theme.id}.md`);
    const written = fs.readFileSync(file, 'utf8');
    assert.equal(written, renderThemedBrief(theme, { durationMinutes: 60, personas: ['testa'] }));
    assert.equal(parseShowBrief(written).primaryPersona, 'testa');
  });

  test('second call with unchanged content does not rewrite the file', async () => {
    const before = fs.statSync(file).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    ensureThemedBrief(theme.id, { durationMinutes: 60, personas: ['testa'] }); // by id, not object
    assert.equal(fs.statSync(file).mtimeMs, before, 'unchanged catalog must leave the file untouched');
  });

  test('content-changing call refreshes the file', () => {
    ensureThemedBrief(theme, { durationMinutes: 60, personas: ['druga'] });
    assert.equal(parseShowBrief(fs.readFileSync(file, 'utf8')).primaryPersona, 'druga');
    // leave the catalog's own expectations in place for later suites
    ensureThemedBrief(theme, { durationMinutes: 60, personas: ['testa'] });
  });

  test('honest errors: unknown theme, missing personas', () => {
    assert.throws(() => ensureThemedBrief('izmislek', { personas: ['x'] }), /Unknown themed show/);
    assert.throws(() => ensureThemedBrief(theme, { personas: [] }), /needs at least one persona/);
    assert.throws(() => ensureThemedBrief(theme, {}), /needs at least one persona/);
  });
});

describe('showCatalog: loadSchedule wiring', () => {
  const [a, b, c] = THEMED_SHOWS.map((t) => t.id);

  function writeStation(schedule) {
    fs.writeFileSync(
      config.paths.stationFile,
      JSON.stringify({ station: { name: 'Test Station' }, schedule }, null, 2)
    );
  }

  test('special entries resolve to this week\'s theme with description/specialTheme/specialTitle', () => {
    writeStation({
      wednesday: [
        { id: 'special', startTime: '20:00', durationMinutes: 60, special: { themes: [a, b, c], personas: ['elena'] } },
        { id: 'noc-auto', startTime: '21:00', durationMinutes: 60, description: 'show-descriptions/noc-auto.md' },
      ],
    });
    const schedule = loadSchedule();
    const special = schedule.wednesday.find((s) => s.id === 'special');
    const expectedId = THEMED_SHOWS[isoWeekKey(new Date()) % 3].id;
    assert.equal(special.specialTheme, expectedId);
    assert.equal(special.description, themedBriefRelPath(expectedId));
    assert.equal(special.specialTitle, getThemedShow(expectedId).title);
    assert.deepEqual(special.special, { themes: [a, b, c], personas: ['elena'] }, 'raw special block must survive for production-time re-resolution');
    // non-special neighbors pass through untouched
    const normal = schedule.wednesday.find((s) => s.id === 'noc-auto');
    assert.equal(normal.description, 'show-descriptions/noc-auto.md');
    assert.equal(normal.specialTheme, undefined);
  });

  test('an operator-written description on a special entry is overridden by the resolution', () => {
    writeStation({
      friday: [{ id: 'special', startTime: '20:00', durationMinutes: 60, description: 'show-descriptions/rocnik.md', special: { themes: [a] } }],
    });
    const special = loadSchedule().friday[0];
    assert.equal(special.description, themedBriefRelPath(a), 'the special block IS the slot\'s brief source');
  });

  test('misconfigured special passes through raw instead of killing the schedule read', () => {
    writeStation({
      monday: [{ id: 'special', startTime: '08:00', durationMinutes: 60, special: { themes: ['ne-obstaja'] } }],
    });
    const special = loadSchedule().monday[0];
    assert.equal(special.specialTheme, undefined, 'unresolvable special must carry no resolution');
    assert.deepEqual(special.special, { themes: ['ne-obstaja'] }, 'raw block preserved for the honest production error');
  });

  test('comma-joined weekday keys still expand (and resolve) through the same path', () => {
    writeStation({
      'saturday,sunday': [{ id: 'special', startTime: '18:00', durationMinutes: 60, special: { themes: [a, b] } }],
    });
    const schedule = loadSchedule();
    for (const day of ['saturday', 'sunday']) {
      const expectedId = THEMED_SHOWS[isoWeekKey(new Date()) % 2].id;
      assert.equal(schedule[day][0].specialTheme, expectedId, `${day} must resolve the shared entry`);
      assert.equal(schedule[day][0].specialTitle, getThemedShow(expectedId).title);
    }
  });
});
