// Tests for Paket B1 (Val 21, docs/programming-research.md §5) -- the closing
// next-show announcement (`kind: "nextShow"`, resolved at DIRECT time):
//   A. slovenianDayLabel / slovenianWeekdayPhrase units (src/lib/time.js),
//   B. resolveNextShowValues against a real scratch station.json + briefs
//      (the ONE shared resolver both the auto and AI paths import),
//   C. resolveLiveLineAuto rendering: withHost/noHost pools, offline honesty,
//   C+. pool integrity of live.nextShow / live.nextShowOffline (raw source
//      strings, weatherOffline.test.mjs's source-parse trick),
//   D. buildSegmentsAuto: the last two segments are [live nextShow, dj close],
//   E. wiring pins (comment-stripped source structure) + the format.js
//      grammar (parse round-trip, the closed-kind error message, and the
//      8000ms estimate applied to the runtime warning),
//   F. config override of live.nextShow.noHost (in-memory mutation, the
//      autoGenreSteering.test.mjs liveConfig pattern).
//
// No network anywhere: the nextShow kind resolves from the local
// station.json + show briefs only. setupTestConfig runs BEFORE every
// dynamic import (config.json is read once at module load), the
// weatherOffline.test.mjs discipline; the offline line's zero-fabrication
// pin (no digits) is honestOffline.test.mjs's discipline.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('nextshow', {});

// --- scratch station: two shows monday, two tuesday, one wednesday ---------
//
// 2026-10-25 is the Sunday DST fall-back day, so 2026-10-26 is a Monday --
// every date below is derived from that first principle. Brief shape is
// parseShowBrief's exact header contract (H1 title + "**Personas:**" line,
// src/producer/showBrief.js); description paths are dataDir-relative,
// mirroring sample-data/station.json.
const DATA_DIR = path.join(repoRoot(), 'data', 'test-nextshow');
const STATION_PATH = path.join(DATA_DIR, 'station.json');

const STATION = {
  station: { name: 'Test Station', neverPlay: { keywords: [], artists: [] } },
  schedule: {
    monday: [
      { id: 'jutranji', startTime: '08:00', durationMinutes: 60, description: 'show-descriptions/jutranji.md' },
      { id: 'vecerni', startTime: '20:00', durationMinutes: 90, description: 'show-descriptions/vecerni.md' },
    ],
    tuesday: [
      { id: 'nocni', startTime: '06:00', durationMinutes: 30, description: 'show-descriptions/nocni.md' },
      { id: 'pozna', startTime: '23:30', durationMinutes: 60, description: 'show-descriptions/pozna.md' },
    ],
    wednesday: [
      { id: 'jutranji', startTime: '08:00', durationMinutes: 60, description: 'show-descriptions/jutranji.md' },
    ],
  },
};

function writeBrief(file, title, personas) {
  const md = [
    `# ${title}`,
    '',
    ...(personas ? [`**Personas:** ${personas}`, ''] : []),
    '## Description',
    '',
    `${title} -- testni brief.`,
    '',
  ].join('\n');
  fs.mkdirSync(path.join(DATA_DIR, 'show-descriptions'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'show-descriptions', file), md);
}

// nocni is deliberately HOSTLESS (no Personas line -> primaryPersona
// undefined -> resolveShowInfo's host null): it is the noHost-pool case.
writeBrief('jutranji.md', 'Jutranji z Eleno', 'elena');
writeBrief('vecerni.md', 'Večerni maraton', 'ryan');
writeBrief('nocni.md', 'Nočni patrol', null);
writeBrief('pozna.md', 'Pozna noč', 'elena');
fs.writeFileSync(STATION_PATH, JSON.stringify(STATION, null, 2));

const OCC_JUTRANJI = { show: 'jutranji', weekday: 'monday', date: '2026-10-26', timeKey: '08-00' };
const OCC_VECERNI = { show: 'vecerni', weekday: 'monday', date: '2026-10-26', timeKey: '20-00' };
const OCC_POZNA = { show: 'pozna', weekday: 'tuesday', date: '2026-10-27', timeKey: '23-30' };

const { slovenianDayLabel, slovenianWeekdayPhrase } = await import('../src/lib/time.js');
const { resolveLiveLineAuto, resolveNextShowValues } = await import('../src/auto/liveLines.js');
const { buildSegmentsAuto } = await import('../src/auto/scriptBuilder.js');
const { parseScript, renderScript } = await import('../src/script/format.js');
const { config: liveConfig } = await import('../src/config/index.js');

// ---------------------------------------------------------------------------
// A. slovenianDayLabel / slovenianWeekdayPhrase (src/lib/time.js)
// ---------------------------------------------------------------------------

describe('A. slovenianDayLabel / slovenianWeekdayPhrase units', () => {
  test('same day -> "danes"; +1 day -> "jutri"', () => {
    assert.equal(slovenianDayLabel('2026-10-28', '2026-10-28'), 'danes');
    assert.equal(slovenianDayLabel('2026-10-29', '2026-10-28'), 'jutri');
  });

  test('+2 days -> the weekday phrase of the ACTUAL weekday (2026-10-28 is a Wednesday, so 2026-10-30 is a Friday -> "v petek")', () => {
    assert.equal(slovenianDayLabel('2026-10-30', '2026-10-28'), 'v petek');
  });

  test('slovenianWeekdayPhrase: the absolute accusative form from a plain dateKey', () => {
    assert.equal(slovenianWeekdayPhrase('2026-10-28'), 'v sredo'); // Wednesday
    assert.equal(slovenianWeekdayPhrase('2026-10-26'), 'v ponedeljek'); // Monday
    assert.equal(slovenianWeekdayPhrase('2026-11-15'), 'v nedeljo'); // Sunday
    // NOTE, reported to the orchestrator (time.js is orchestrator-owned
    // pre-work, untouchable here): SLOVENIAN_WEEKDAY_ACC[6] is 'sobota', but
    // the table's own comment says the feminine days take -o -- correct
    // Slovenian is "v soboto". Deliberately NOT pinned either way here; the
    // Wednesday/Monday/Sunday pins above cover the mapping itself.
  });

  test('the 2026-10-25 DST fall-back pair still says "jutri" (calendar-day walk, never a +24h epoch step)', () => {
    assert.equal(slovenianDayLabel('2026-10-26', '2026-10-25'), 'jutri');
  });

  test('beyond +1 day the label is the absolute weekday phrase, still true whenever spoken', () => {
    assert.equal(slovenianDayLabel('2026-10-30', '2026-10-25'), 'v petek');
  });

  test('>13 days out -> the weekday phrase (the relative walk caps at 13 steps)', () => {
    // 2026-10-28 -> 2026-11-15 is 18 days; 2026-11-15 is a Sunday.
    assert.equal(slovenianDayLabel('2026-11-15', '2026-10-28'), 'v nedeljo');
  });

  test('unparseable keys -> null, never a guess', () => {
    assert.equal(slovenianDayLabel('ni-veljaven', '2026-10-28'), null);
    assert.equal(slovenianDayLabel('2026-10-28', 'xxxx'), null);
    assert.equal(slovenianDayLabel('2026-10', '2026-10-28'), null); // missing day component
    assert.equal(slovenianWeekdayPhrase('ne-veljaven'), null);
    assert.equal(slovenianWeekdayPhrase('2026-10'), null);
  });
});

// ---------------------------------------------------------------------------
// B. resolveNextShowValues (auto/liveLines.js -- the ONE shared resolver)
// ---------------------------------------------------------------------------

describe('B. resolveNextShowValues (the one shared resolver)', () => {
  test('same-day next: jutranji 08:00 -> vecerni 20:00, host from the brief, "danes"', async () => {
    const res = await resolveNextShowValues(OCC_JUTRANJI);
    assert.equal(res.offline, false);
    assert.deepEqual(res.values, {
      nextShow: 'Večerni maraton', // the brief's H1, not the raw id
      nextHost: 'Ryan', // capitalized primaryPersona, resolveShowInfo's contract
      nextTime: '20:00',
      nextDayWord: 'danes',
      nextDateKey: '2026-10-26',
    });
  });

  test("monday's last show -> tuesday's first: hostless host, 'jutri'", async () => {
    const res = await resolveNextShowValues(OCC_VECERNI);
    assert.equal(res.offline, false);
    assert.equal(res.values.nextShow, 'Nočni patrol');
    assert.equal(res.values.nextHost, null, 'hostless brief -> resolveShowInfo host null');
    assert.equal(res.values.nextTime, '06:00');
    assert.equal(res.values.nextDayWord, 'jutri');
    assert.equal(res.values.nextDateKey, '2026-10-27');
  });

  test('a show crossing midnight labels the next MORNING show "danes" (nominal-end reference)', async () => {
    // pozna starts tuesday 23:30 + 60min -> nominal end 2026-10-28 00:30,
    // already Wednesday -- the reference the listener hears when the line airs.
    const res = await resolveNextShowValues(OCC_POZNA);
    assert.equal(res.offline, false);
    assert.equal(res.values.nextShow, 'Jutranji z Eleno');
    assert.equal(res.values.nextTime, '08:00');
    assert.equal(res.values.nextDayWord, 'danes');
    assert.equal(res.values.nextDateKey, '2026-10-28');
  });

  test('a multi-day walk over dark days: wednesday -> next monday, absolute weekday phrase', async () => {
    const res = await resolveNextShowValues({ show: 'jutranji', weekday: 'wednesday', date: '2026-10-28', timeKey: '08-00' });
    assert.equal(res.offline, false);
    assert.equal(res.values.nextShow, 'Jutranji z Eleno');
    assert.equal(res.values.nextDateKey, '2026-11-02'); // thu-sun are dark in this fixture
    assert.equal(res.values.nextDayWord, 'v ponedeljek');
  });

  test('a timeKey no longer in the schedule -> offline, honestly', async () => {
    const res = await resolveNextShowValues({ show: 'jutranji', weekday: 'monday', date: '2026-10-26', timeKey: '07-30' });
    assert.equal(res.offline, true);
    assert.ok(typeof res.reason === 'string' && res.reason.length > 0, 'the reason is the operator-visible why');
  });

  test('a weekday with no lineup but a foreign timeKey -> offline (schedule edited after direction)', async () => {
    const res = await resolveNextShowValues({ show: 'x', weekday: 'saturday', date: '2026-10-31', timeKey: '09-00' });
    assert.equal(res.offline, true);
  });

  test('an empty schedule -> offline with a reason (never a throw into directShow)', async () => {
    fs.writeFileSync(STATION_PATH, JSON.stringify({ station: STATION.station, schedule: {} }, null, 2));
    try {
      const res = await resolveNextShowValues(OCC_JUTRANJI);
      assert.equal(res.offline, true);
      assert.ok(res.reason.length > 0, 'the reason is the operator-visible why');
    } finally {
      fs.writeFileSync(STATION_PATH, JSON.stringify(STATION, null, 2));
    }
  });

  test('no occurrence identity at all -> offline (standalone caller)', async () => {
    const res = await resolveNextShowValues(null);
    assert.equal(res.offline, true);
    assert.match(res.reason, /no occurrence identity/);
  });

  test('a partial occurrence (missing timeKey) -> offline', async () => {
    const res = await resolveNextShowValues({ weekday: 'monday', date: '2026-10-26' });
    assert.equal(res.offline, true);
    assert.match(res.reason, /no occurrence identity/);
  });
});

// ---------------------------------------------------------------------------
// C. resolveLiveLineAuto (the template render)
// ---------------------------------------------------------------------------

describe('C. resolveLiveLineAuto (template render)', () => {
  test('withHost: the rendered line names the show, the time and the host', async () => {
    const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'nextShow', occurrence: OCC_JUTRANJI });
    assert.ok(line.includes('Večerni maraton'), `show name missing: ${line}`);
    assert.ok(line.includes('20:00'), `start time missing: ${line}`);
    assert.ok(line.includes('Ryan'), `the withHost pool must name the host: ${line}`);
    // Every withHost variant introduces the host one of two ways; the variant
    // is deterministic per seed (elena's seed picks "za mikrofonom bo
    // {nextHost}", ryan's below picks "z voditeljem {nextHost}").
    assert.ok(/voditeljem|za mikrofonom/.test(line), `host clause missing: ${line}`);
    assert.ok(!line.includes('{'), `unsubstituted placeholder: ${line}`);
  });

  test("withHost, spec letter: ryan's deterministic seed lands a 'z voditeljem' variant", async () => {
    const line = await resolveLiveLineAuto({ persona: 'ryan', kind: 'nextShow', occurrence: OCC_JUTRANJI });
    assert.ok(line.includes('voditeljem'), `expected the 'z voditeljem' phrasing: ${line}`);
    assert.ok(line.includes('Večerni maraton') && line.includes('20:00') && line.includes('Ryan'), `got: ${line}`);
  });

  test('noHost: a hostless next show never renders a dangling host clause', async () => {
    const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'nextShow', occurrence: OCC_VECERNI });
    assert.ok(line.includes('Nočni patrol'), `show name missing: ${line}`);
    assert.ok(line.includes('06:00'), `start time missing: ${line}`);
    assert.ok(!line.includes('voditeljem'), `the noHost pool must never say 'z voditeljem': ${line}`);
    assert.ok(!line.includes('{'), `unsubstituted placeholder: ${line}`);
  });

  test('offline: unresolvable -> the honest offline line, ZERO digits (zero-fabrication pin)', async () => {
    const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'nextShow', occurrence: null });
    assert.ok(typeof line === 'string' && line.length > 30, `a real line was expected: ${line}`);
    assert.ok(!/\d/.test(line), `an offline line must contain no digits (no invented day/time/show): ${line}`);
    assert.ok(!line.includes('{'), `unsubstituted placeholder: ${line}`);
  });

  test('same schedule state + same seed -> the same line (reproducible transcripts)', async () => {
    const a = await resolveLiveLineAuto({ persona: 'elena', kind: 'nextShow', occurrence: OCC_JUTRANJI });
    const b = await resolveLiveLineAuto({ persona: 'elena', kind: 'nextShow', occurrence: OCC_JUTRANJI });
    assert.equal(a, b);
  });
});

// templates.js keeps DEFAULT_TEMPLATES internal (the public contract is
// renderSlot); the pool-integrity tests need the RAW strings -- same
// source-parse trick as weatherOffline.test.mjs.
let _defaults = null;
function getTemplates() {
  if (_defaults) return { DEFAULT_TEMPLATES: _defaults };
  const src = fs.readFileSync(path.join(repoRoot(), 'src', 'auto', 'templates.js'), 'utf8');
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

describe('C+. pool integrity (the honesty contract at the source)', () => {
  test('live.nextShow.withHost / noHost: non-trivial pools, full placeholder coverage', () => {
    const { DEFAULT_TEMPLATES } = getTemplates();
    const { withHost, noHost } = DEFAULT_TEMPLATES.live.nextShow;
    assert.ok(Array.isArray(withHost) && withHost.length >= 2, `expected >= 2 withHost variants, got ${withHost?.length}`);
    assert.ok(Array.isArray(noHost) && noHost.length >= 2, `expected >= 2 noHost variants, got ${noHost?.length}`);
    for (const line of withHost) {
      for (const ph of ['{nextShow}', '{nextHost}', '{nextTime}', '{nextDayWord}']) {
        assert.ok(line.includes(ph), `withHost variant must carry ${ph}: ${line}`);
      }
    }
    for (const line of noHost) {
      for (const ph of ['{nextShow}', '{nextTime}', '{nextDayWord}']) {
        assert.ok(line.includes(ph), `noHost variant must carry ${ph}: ${line}`);
      }
      assert.ok(!line.includes('{nextHost}'), `noHost variant must never carry a host placeholder: ${line}`);
    }
  });

  test('live.nextShowOffline: >= 3 variants, and not one digit or placeholder in any of them', () => {
    const { DEFAULT_TEMPLATES } = getTemplates();
    const pool = DEFAULT_TEMPLATES.live.nextShowOffline;
    assert.ok(Array.isArray(pool) && pool.length >= 3, `expected >= 3 offline variants, got ${pool?.length}`);
    for (const line of pool) {
      assert.ok(typeof line === 'string' && line.length > 30, `too short: ${line}`);
      assert.ok(!/\d/.test(line), `an offline variant must contain no digits: ${line}`);
      assert.ok(!line.includes('{'), `an offline variant invents nothing, so it has nothing to substitute: ${line}`);
    }
  });
});

// ---------------------------------------------------------------------------
// D. buildSegmentsAuto (order pin)
// ---------------------------------------------------------------------------

describe('D. buildSegmentsAuto (order pin)', () => {
  const mkTracks = (count) =>
    Array.from({ length: count }, (_, i) => ({
      ratingKey: `rk${i}`,
      artist: `Artist ${i}`,
      title: `Song ${i}`,
      album: 'Album',
      year: 2001,
      durationMs: 180000,
    }));
  const baseBrief = { hasQuiz: false, hasWeather: false, primaryPersona: 'elena', title: 'Napoved Show' };
  const build = (extra) =>
    buildSegmentsAuto({ tracks: mkTracks(4), brief: baseBrief, showId: 'ns-show', date: '2026-10-26', rubricData: null, ...extra });

  test('the LAST TWO segments are [live nextShow, dj close] in that order', () => {
    const { segments } = build({});
    const [secondLast, last] = segments.slice(-2);
    assert.equal(secondLast.type, 'live');
    assert.equal(secondLast.kind, 'nextShow');
    assert.equal(last.type, 'dj');
    assert.equal(last.slot, 'close');
  });

  test("the live nextShow segment's persona is the brief's primaryPersona", () => {
    const { segments } = build({});
    const liveSeg = segments.find((s) => s.type === 'live' && s.kind === 'nextShow');
    assert.equal(liveSeg.persona, 'elena');
  });

  test('exactly one live nextShow segment per show, and it stays last even with a weather live segment', () => {
    const { segments } = build({ brief: { ...baseBrief, hasWeather: true }, tracks: mkTracks(5) });
    assert.equal(segments.filter((s) => s.type === 'live' && s.kind === 'nextShow').length, 1);
    assert.equal(segments.filter((s) => s.type === 'live' && s.kind === 'weather').length, 1, 'the mid-show weather live segment is untouched');
    const [secondLast, last] = segments.slice(-2);
    assert.equal(secondLast.kind, 'nextShow');
    assert.equal(last.slot, 'close');
  });

  test('the full auto segment list parses through renderScript -> parseScript with kind: nextShow', () => {
    const { segments } = build({});
    const rendered = renderScript({ title: 'Napoved Show', durationMinutes: 60, segments });
    const parsed = parseScript(rendered);
    assert.equal(parsed.ok, true, parsed.issues?.join(' | '));
    assert.equal(parsed.segments.find((s) => s.type === 'live').kind, 'nextShow');
  });
});

// ---------------------------------------------------------------------------
// E. wiring pins (source structure) + the format.js grammar
// ---------------------------------------------------------------------------

// Comments only, no template literals with "//": all pinned files are safe
// for this crude strip (the same helper autoGenreSteering.test.mjs uses).
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}
const srcOf = (rel) => stripComments(fs.readFileSync(path.join(repoRoot(), rel), 'utf8'));

describe('E. wiring pins (source structure)', () => {
  test("scriptBuilder.js pushes the live nextShow segment BEFORE the close push", () => {
    const src = srcOf('src/auto/scriptBuilder.js');
    assert.match(src, /segments\.push\(\{\s*type: 'live',\s*persona: primaryPersona,\s*kind: 'nextShow',/);
    const liveAt = src.indexOf("kind: 'nextShow'");
    const closeAt = src.indexOf("slot: 'close'");
    assert.ok(liveAt !== -1, 'nextShow segment present');
    assert.ok(closeAt !== -1, 'close segment present');
    assert.ok(liveAt < closeAt, 'announcement first, sign-off second');
  });

  // (Val 28: the boundaryWalk.js AI-mode twin of this pin is gone with the
  // AI producer -- scriptBuilder.js is the only script builder left.)

  test('director/index.js threads the occurrence identity into resolveLiveLine', () => {
    const src = srcOf('src/director/index.js');
    assert.match(src, /await resolveLiveLine\(seg, \{ show: id, weekday, date, timeKey \}\)/);
  });

  test('liveSegments.js delegates to liveLines.js (no-cycle pin: ONE resolver, no director-side twin)', () => {
    // Val 28 ("samo skripte brez AI modelov"): the AI branch that used to
    // import resolveNextShowValues directly is gone -- the director side
    // is now a pure delegation to the auto resolver, so both concerns of
    // the old pin (no import cycle, no second resolver) hold by construction.
    const src = srcOf('src/director/liveSegments.js');
    assert.match(src, /import \{ resolveLiveLineAuto \} from '\.\.\/auto\/liveLines\.js';/);
    assert.ok(!src.includes('resolveNextShowValues'), 'the director side must not grow its own schedule resolver');
    assert.ok(!src.includes('loadSchedule'), 'no schedule reading on the director side');
  });

  test("format.js: VALID_LIVE_KINDS contains 'nextShow', the estimate is 8000", () => {
    const src = srcOf('src/script/format.js');
    assert.match(src, /VALID_LIVE_KINDS = new Set\(\['time', 'weather', 'time-weather', 'nextShow'\]\)/);
    assert.match(src, /LIVE_SEGMENT_ESTIMATE_MS = \{ time: 10000, weather: 15000, 'time-weather': 20000, nextShow: 8000 \}/);
  });
});

describe('E. format.js grammar (behavioral)', () => {
  // One track (duration pinned via knownRatingKeys, the authoritative
  // durationMs path format.js uses) plus an optional live segment -- the
  // minimal script whose runtime estimate is exactly predictable.
  const scriptMd = ({ liveKind, trackMs }) =>
    [
      '# est show',
      '',
      '**Duration:** 60 min',
      '',
      '---',
      '',
      '## Track',
      'type: track',
      'artist: A',
      'title: T',
      'ratingKey: rk1',
      '',
      ...(liveKind
        ? ['## Live — Elena', 'type: live', 'persona: elena', `kind: ${liveKind}`, 'brief: announce the next show', '']
        : []),
    ].join('\n');
  const known = (trackMs) => new Map([['rk1', { artist: 'A', title: 'T', durationMs: trackMs }]]);

  test('a kind: nextShow live segment round-trips render -> parse', () => {
    const parsed = parseScript(scriptMd({ liveKind: 'nextShow', trackMs: 180000 }), { knownRatingKeys: known(180000) });
    assert.equal(parsed.ok, true, parsed.issues?.join(' | '));
    assert.equal(parsed.segments.find((s) => s.type === 'live').kind, 'nextShow');
    const rendered = renderScript(parsed);
    assert.match(rendered, /kind: nextShow/);
    const reparsed = parseScript(rendered, { knownRatingKeys: known(180000) });
    assert.equal(reparsed.ok, true, reparsed.issues?.join(' | '));
    assert.equal(reparsed.segments.find((s) => s.type === 'live').kind, 'nextShow');
  });

  test('an unknown kind is a parse error whose message names the full closed set', () => {
    const parsed = parseScript(scriptMd({ liveKind: 'bogusKind', trackMs: 180000 }), { knownRatingKeys: known(180000) });
    assert.equal(parsed.ok, false);
    const issue = parsed.issues.find((i) => i.includes('must be one of'));
    assert.ok(issue, `expected the kind error, got: ${parsed.issues.join(' | ')}`);
    assert.ok(issue.includes('nextShow'), `the closed set must be named in full: ${issue}`);
  });

  test('the 8000ms estimate is applied: ~3 min without the segment -> ~4 min with it', () => {
    // estimatedMs is internal to parseScript, but the short-runtime warning
    // carries Math.round(estimatedMs/60000): 203000ms rounds to 3 min while
    // 203000+8000=211000 rounds to 4 -- exactly the flip the nextShow kind's
    // 8 seconds should cause (a 6s estimate would stay at ~3 min).
    const without = parseScript(scriptMd({ liveKind: null, trackMs: 203000 }), { knownRatingKeys: known(203000) });
    const withSeg = parseScript(scriptMd({ liveKind: 'nextShow', trackMs: 203000 }), { knownRatingKeys: known(203000) });
    assert.ok(without.warnings.some((w) => w.includes('~3 min')), JSON.stringify(without.warnings));
    assert.ok(withSeg.warnings.some((w) => w.includes('~4 min')), JSON.stringify(withSeg.warnings));
  });

  test('and it is NOT the time estimate: 201000+8000 still rounds to ~3 min, where time (10000) would flip it', () => {
    const withNextShow = parseScript(scriptMd({ liveKind: 'nextShow', trackMs: 201000 }), { knownRatingKeys: known(201000) });
    assert.ok(withNextShow.warnings.some((w) => w.includes('~3 min')), JSON.stringify(withNextShow.warnings));
    // The pin discriminates 8000 from the time kind's 10000:
    const withTime = parseScript(scriptMd({ liveKind: 'time', trackMs: 201000 }), { knownRatingKeys: known(201000) });
    assert.ok(withTime.warnings.some((w) => w.includes('~4 min')), JSON.stringify(withTime.warnings));
  });
});

// ---------------------------------------------------------------------------
// F. config override (autoRadio.templates)
// ---------------------------------------------------------------------------

describe('F. config override of live.nextShow.noHost', () => {
  test('the operator line wins over the default pool, real data still substitutes', async () => {
    // mergedTemplates() replaces the TOP-LEVEL slot it names (templates.js),
    // so overriding the noHost pool means providing the whole `live` block
    // -- the documented "poljuben slot lahko prepišeš" contract. In-memory
    // mutation + restore, the autoGenreSteering.test.mjs liveConfig pattern.
    const saved = liveConfig.autoRadio.templates;
    liveConfig.autoRadio.templates = {
      live: {
        nextShow: {
          noHost: ['PREPISANA NAPROVED: {nextShow} ob {nextTime}, {nextDayWord} -- test prepisa.'],
        },
      },
    };
    try {
      const line = await resolveLiveLineAuto({ persona: 'elena', kind: 'nextShow', occurrence: OCC_VECERNI });
      assert.ok(line.startsWith('PREPISANA NAPROVED:'), `the override must win: ${line}`);
      assert.ok(
        line.includes('Nočni patrol') && line.includes('06:00') && line.includes('jutri'),
        `real data still substitutes: ${line}`
      );
    } finally {
      liveConfig.autoRadio.templates = saved;
    }
  });
});
