// Tests for the Booth/Dnevnik (src/server/boothApi.js, Val 36) -- the public
// diary of the DJ's spoken words. Everything is driven through the real
// module against a scratch dataDir: real runningDir trees, real aired.jsonl
// ledgers, real now_playing_state.json, and the DIRECTOR'S OWN parseScript
// (src/script/format.js) over real script.md grammar -- the same parser
// contract the on-air director consumes, so the diary can never drift from
// what actually gets spoken. Zero network, zero liquidsoap.
// Matrix:
//   A. words: dj body text + live markers pass through, tracks do not;
//   B. the aired gate: produced-but-never-aired stays out, wrong showId
//      stays out, out-of-window stays out, filler inside the grace counts;
//   C. the currently-loaded occurrence: included without the gate (the
//      scheduler's own state is the authority for "on air right now");
//   D. ordering (newest first) + the double-sided limit clamp;
//   E. tolerance: missing script.md, garbage script, track-only script,
//      missing runningDir, non-date directory names -- each costs exactly
//      its entry, counted in `skipped`, never a crash;
//   F. the replay stamp from context.json;
//   G. future occurrences (produced for tomorrow) stay out silently;
//   H. the route (fastify inject) + wiring pins.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('booth');

const { config } = await import('../src/config/index.js');
const { getBoothDiary, registerBoothRoutes } = await import('../src/server/boothApi.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Real script.md grammar (script-format.md): title, duration, one dj
// segment with body text, one track segment (music -- NOT diary material),
// one live segment (marker only: its words are synthesized at airtime).
const SCRIPT = `# 📻 Večerni rock

**Duration:** 60 min

---

## DJ — Markec
type: dj
persona: markec

Dober večer, rockeri! Danes vrtimo samo klasike.

## Glasba
type: track
artist: AC/DC
title: Back in Black
ratingKey: 42

## Vreme
type: live
persona: markec
kind: weather
brief: kratek
`;

// The local wall-clock start of an occurrence, in ms -- the path components
// (date + timeKey) ARE the station's local clock, exactly like
// boothApi.occurrenceStartMs parses them. Relative-only arithmetic keeps the
// tests timezone-independent.
function startMs(date, timeKey = '20-00') {
  return Date.parse(`${date}T${timeKey.slice(0, 2)}:${timeKey.slice(3)}:00`);
}

// An aired.jsonl playedAt for a track that started offsetMs after the
// occurrence's local start -- absolute ISO so Date.parse is exact in any TZ.
function playedAt(date, timeKey, offsetMs) {
  return new Date(startMs(date, timeKey) + offsetMs).toISOString();
}

function writeOccurrence({
  weekday = 'monday',
  showId = 'vecerni',
  date,
  timeKey = '20-00',
  script = SCRIPT,
  durationSeconds = 3600,
  replayOf = null,
} = {}) {
  const dir = path.join(config.paths.runningDir, weekday, showId, date, timeKey);
  fs.mkdirSync(dir, { recursive: true });
  if (script !== null) fs.writeFileSync(path.join(dir, 'script.md'), script);
  fs.writeFileSync(
    path.join(dir, 'context.json'),
    JSON.stringify({ durationSeconds, ...(replayOf ? { replayOf } : {}) })
  );
  return dir;
}

// Appends, like the real append-only ledger (scrobbleTrack.js appends per
// aired track) -- tests that build several occurrences loop-write entries.
function writeAired(entries) {
  fs.mkdirSync(path.dirname(config.paths.airedHistoryFile), { recursive: true });
  fs.appendFileSync(config.paths.airedHistoryFile, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

function writeState(state) {
  fs.writeFileSync(config.paths.nowPlayingStatePath, JSON.stringify(state));
}

// A fresh station between tests: no occurrences, no ledger, no state.
function reset() {
  fs.rmSync(config.paths.runningDir, { recursive: true, force: true });
  fs.rmSync(config.paths.airedHistoryFile, { force: true });
  fs.rmSync(config.paths.nowPlayingStatePath, { force: true });
}

// ---------------------------------------------------------------------------
// A. The words themselves
// ---------------------------------------------------------------------------
describe('A. words (dj text + live markers; tracks are not diary material)', () => {
  test('dj body and live kind pass through; the track segment is absent; title picked up', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) }]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.equal(r.shows.length, 1);
    const show = r.shows[0];
    assert.equal(show.showTitle, '📻 Večerni rock');
    assert.equal(show.showId, 'vecerni');
    assert.equal(show.date, '2026-10-27');
    assert.equal(show.timeKey, '20-00');
    assert.equal(show.current, false);
    assert.equal(show.replay, false);
    assert.equal(show.segments.length, 2, 'dj + live only -- the AC/DC track is music, not speech');
    assert.deepEqual(show.segments[0], { type: 'dj', persona: 'markec', text: 'Dober večer, rockeri! Danes vrtimo samo klasike.' });
    assert.deepEqual(show.segments[1], { type: 'live', persona: 'markec', kind: 'weather' });
  });
});

// ---------------------------------------------------------------------------
// B. The aired gate
// ---------------------------------------------------------------------------
describe('B. aired gate (the ledger must prove the show went out)', () => {
  test('produced but never aired -> excluded, counted in skipped.notAired', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' });
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows, []);
    assert.equal(r.skipped.notAired, 1);
  });

  test('an aired entry with a different showId does not open the gate', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' });
    writeAired([{ showId: 'jutro', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) }]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows, []);
    assert.equal(r.skipped.notAired, 1);
  });

  test('entries outside the window (long before start, past end+grace) do not count', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' }); // 60 min show -> window = start-60s .. start+90min
    writeAired([
      { showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', -2 * 60 * 60 * 1000) }, // 2 h before
      { showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 120 * 60 * 1000) }, // start+120 > 90
    ]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows, []);
    assert.equal(r.skipped.notAired, 1);
  });

  test('filler attributed after the end but inside the 30 min grace DOES count', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 70 * 60 * 1000) }]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.equal(r.shows.length, 1);
  });

  test('the gate uses context.json durationSeconds, not a hardcoded hour', () => {
    reset();
    // A 30-minute show: window = start .. start+60 (30 end + 30 grace). An
    // entry at start+75 is past it -- a hardcoded 60-minute window (end at
    // start+90) would have let it in, which is exactly what this pins out.
    writeOccurrence({ date: '2026-10-26', durationSeconds: 1800 });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-26', '20-00', 75 * 60 * 1000) }]);
    // A 90-minute show: window = start .. start+120. An entry at start+100
    // is inside -- a hardcoded hour (window end start+90) would have
    // excluded it.
    writeOccurrence({ date: '2026-10-27', durationSeconds: 5400 });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 100 * 60 * 1000) }]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows.map((s) => s.date), ['2026-10-27']);
    assert.equal(r.skipped.notAired, 1);
  });
});

// ---------------------------------------------------------------------------
// C. The currently-loaded occurrence
// ---------------------------------------------------------------------------
describe('C. current show (scheduler state is the authority)', () => {
  test('included without any aired entry, flagged current, sorted first', () => {
    reset();
    // A fully-aired show yesterday, and the loaded show today with no ledger
    // entries yet (it just started -- first segment was speech, say).
    writeOccurrence({ date: '2026-10-26' });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-26', '20-00', 5 * 60 * 1000) }]);
    writeOccurrence({ date: '2026-10-27', timeKey: '21-30' });
    writeState({ weekday: 'monday', id: 'vecerni', date: '2026-10-27', timeKey: '21-30', estimatedEndAt: startMs('2026-10-27', '21-30') + 3600_000, confirmed: true });
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '21-40') });
    assert.equal(r.shows.length, 2);
    assert.equal(r.shows[0].current, true);
    assert.equal(r.shows[0].date, '2026-10-27');
    assert.equal(r.shows[1].current, false);
    assert.equal(r.shows[1].date, '2026-10-26');
    assert.equal(r.skipped.notAired, 0, 'the current occurrence bypasses the gate by design');
  });

  test('a corrupt or missing state file changes nothing (no current flag)', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) }]);
    fs.writeFileSync(config.paths.nowPlayingStatePath, '{torn json');
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.equal(r.shows.length, 1);
    assert.equal(r.shows[0].current, false);
  });
});

// ---------------------------------------------------------------------------
// D. Ordering + limit clamp
// ---------------------------------------------------------------------------
describe('D. ordering + limit', () => {
  test('newest first', () => {
    reset();
    for (const date of ['2026-10-25', '2026-10-26', '2026-10-27']) {
      writeOccurrence({ date });
      writeAired([{ showId: 'vecerni', playedAt: playedAt(date, '20-00', 5 * 60 * 1000) }]);
    }
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows.map((s) => s.date), ['2026-10-27', '2026-10-26', '2026-10-25']);
  });

  test('limit=2 keeps the two newest; default is 3; 0 honestly means none', () => {
    reset();
    for (const date of ['2026-10-25', '2026-10-26', '2026-10-27']) {
      writeOccurrence({ date });
      writeAired([{ showId: 'vecerni', playedAt: playedAt(date, '20-00', 5 * 60 * 1000) }]);
    }
    const nowMs = startMs('2026-10-27', '23-30');
    assert.deepEqual(getBoothDiary({ limit: 2, nowMs }).shows.map((s) => s.date), ['2026-10-27', '2026-10-26']);
    assert.equal(getBoothDiary({ nowMs }).shows.length, 3, 'default');
    const zero = getBoothDiary({ limit: 0, nowMs });
    assert.deepEqual(zero.shows, []);
    assert.deepEqual(zero.skipped, { noScript: 0, unparseable: 0, notAired: 0 });
  });

  test('a huge limit caps at 10 (never the whole disk)', () => {
    reset();
    const dates = [];
    for (let d = 16; d <= 27; d++) {
      const date = `2026-10-${String(d).padStart(2, '0')}`;
      dates.push(date);
      writeOccurrence({ date });
      writeAired([{ showId: 'vecerni', playedAt: playedAt(date, '20-00', 5 * 60 * 1000) }]);
    }
    assert.equal(dates.length, 12);
    const r = getBoothDiary({ limit: 99, nowMs: startMs('2026-10-27', '23-30') });
    assert.equal(r.shows.length, 10);
    assert.equal(r.shows[0].date, '2026-10-27', 'newest kept');
    assert.equal(r.shows[9].date, '2026-10-18', 'the oldest two fall off the cap');
  });
});

// ---------------------------------------------------------------------------
// E. Tolerance -- each failure costs exactly its entry
// ---------------------------------------------------------------------------
describe('E. tolerance', () => {
  test('script.md missing -> skipped.noScript, others unaffected', () => {
    reset();
    writeOccurrence({ date: '2026-10-26', script: null });
    writeOccurrence({ date: '2026-10-27' });
    writeAired([
      { showId: 'vecerni', playedAt: playedAt('2026-10-26', '20-00', 5 * 60 * 1000) },
      { showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) },
    ]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows.map((s) => s.date), ['2026-10-27']);
    assert.equal(r.skipped.noScript, 1);
  });

  test('garbage script and a track-only script -> skipped.unparseable (no speech to show)', () => {
    reset();
    const trackOnly = `# 📻 Samo glasba

**Duration:** 60 min

---

## Glasba
type: track
artist: Queen
title: Bohemian Rhapsody
ratingKey: 7
`;
    writeOccurrence({ date: '2026-10-26', script: 'to sploh ni markdown' });
    writeOccurrence({ date: '2026-10-27', script: trackOnly });
    writeAired([
      { showId: 'vecerni', playedAt: playedAt('2026-10-26', '20-00', 5 * 60 * 1000) },
      { showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) },
    ]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows, []);
    assert.equal(r.skipped.unparseable, 2);
  });

  test('no runningDir at all (fresh install) -> honest empty, no crash', () => {
    reset();
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows, []);
    assert.deepEqual(r.skipped, { noScript: 0, unparseable: 0, notAired: 0 });
  });

  test('non-date / non-time directory names in the tree are skipped silently', () => {
    reset();
    writeOccurrence({ date: '2026-10-27' });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) }]);
    // Odd trees: a file where a date dir would be, a non-date dir, a bad timeKey.
    fs.writeFileSync(path.join(config.paths.runningDir, 'monday', 'vecerni', 'opombe.txt'), 'x');
    fs.mkdirSync(path.join(config.paths.runningDir, 'monday', 'vecerni', 'ni-datum', '20-00'), { recursive: true });
    fs.mkdirSync(path.join(config.paths.runningDir, 'monday', 'vecerni', '2026-10-26', 'abc'), { recursive: true });
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.equal(r.shows.length, 1);
    assert.equal(r.shows[0].date, '2026-10-27');
    assert.equal(r.skipped.notAired, 0, 'unparsable path components never reach the gate');
  });
});

// ---------------------------------------------------------------------------
// F. The replay stamp
// ---------------------------------------------------------------------------
describe('F. replay stamp (context.json replayOf, Val 22 origin)', () => {
  test('replayOf present -> replay:true', () => {
    reset();
    writeOccurrence({ date: '2026-10-27', replayOf: '2026-10-20T20-00' });
    writeAired([{ showId: 'vecerni', playedAt: playedAt('2026-10-27', '20-00', 5 * 60 * 1000) }]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.equal(r.shows[0].replay, true);
  });
});

// ---------------------------------------------------------------------------
// G. Future occurrences
// ---------------------------------------------------------------------------
describe('G. future occurrences (produced for tomorrow)', () => {
  test('stay out silently -- produced is not aired, and not even "notAired"', () => {
    reset();
    writeOccurrence({ date: '2026-10-29' });
    writeAired([]);
    const r = getBoothDiary({ nowMs: startMs('2026-10-27', '23-30') });
    assert.deepEqual(r.shows, []);
    assert.equal(r.skipped.notAired, 0);
  });
});

// ---------------------------------------------------------------------------
// H. The route + wiring pins
// ---------------------------------------------------------------------------
describe('H. route + wiring', () => {
  test('GET /api/booth serves the diary; ?limit rides through', async () => {
    reset();
    for (const date of ['2026-10-26', '2026-10-27']) {
      writeOccurrence({ date });
      writeAired([{ showId: 'vecerni', playedAt: playedAt(date, '20-00', 5 * 60 * 1000) }]);
    }
    const fastify = Fastify({ logger: false });
    registerBoothRoutes(fastify);
    try {
      const res = await fastify.inject({ method: 'GET', url: '/api/booth' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.shows.length, 2);
      assert.deepEqual(Object.keys(body.skipped).sort(), ['noScript', 'notAired', 'unparseable']);
      assert.equal(body.shows[0].segments[0].type, 'dj');

      const limited = await fastify.inject({ method: 'GET', url: '/api/booth?limit=1' });
      assert.equal(limited.statusCode, 200);
      assert.equal(limited.json().shows.length, 1);
    } finally {
      await fastify.close();
    }
  });

  test('wiring pin: api.js registers the route; the listener page has the tab, panel, fetch and styles', () => {
    const api = fs.readFileSync(path.join(repoRoot(), 'src/server/api.js'), 'utf8');
    assert.match(api, /registerBoothRoutes\(fastify\)/);
    assert.match(api, /boothApi\.js/);

    const html = fs.readFileSync(path.join(repoRoot(), 'public/index.html'), 'utf8');
    assert.match(html, /id="tab-booth"/);
    assert.match(html, /aria-controls="panel-booth"/);
    assert.match(html, /id="booth-list"/);

    const appJs = fs.readFileSync(path.join(repoRoot(), 'public/app.js'), 'utf8');
    assert.match(appJs, /tab: 'tab-booth', panel: 'panel-booth', onShow: fetchBooth/);
    assert.match(appJs, /fetch\('\/api\/booth'\)/);
    // The generic retry mechanism knows about the booth panel's button.
    assert.match(appJs, /if \(what === 'booth'\) fetchBooth\(\)/);

    const css = fs.readFileSync(path.join(repoRoot(), 'public/style.css'), 'utf8');
    assert.match(css, /\.booth-item \{/);
    assert.match(css, /\.booth-persona \{/);
  });
});
