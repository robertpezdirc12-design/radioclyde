// Tests for Paket C1 (Val 22, docs/programming-research.md §5 row C1) --
// date-bound full-day overrides (station.json's schedule.dates block):
//   A. the reader contract (loadSchedule excludes "dates"; loadDateOverrides
//      fails open per key),
//   B. effectiveDayLineup precedence (override > template; empty override =
//      deliberate dark day; absent = template) -- pure, injected dates,
//   C. the day-walkers with injected dates (mostRecent/upcoming/next honor
//      overrides and skip dark days; one DST-boundary pair in a child
//      process with TZ pinned, the timezone.test.mjs method),
//   D. stationWriter's date surface (replaceDateSchedule validation +
//      persistence; removeDateSchedule; removeShowOccurrences sweeps
//      overrides; a weekday write preserves the dates block -- the
//      expandSchedule wipe-regression pin),
//   E. the studio API surface (GET/PUT/DELETE /api/schedule/dates through
//      the real studio plugin + Basic auth, Fastify inject) and the shows
//      list's duration lookup scanning overrides,
//   F. buildWeeklyGrid renders the override day's own entries + the additive
//      dateOverride flag, suppresses the template, keeps marks date-scoped.
//
// No network anywhere. setupTestConfig runs BEFORE every src import
// (config.json is read once at module load) -- the weatherOffline /
// nextShowAnnounce discipline; the scratch station.json + briefs follow
// nextShowAnnounce.test.mjs:37-77.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Fastify from 'fastify';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('schedule-dates', {
  studio: { users: [{ username: 'studio', password: 'sekret' }] },
});

// --- scratch station --------------------------------------------------------
//
// 2026-10-25 is the Sunday DST fall-back day, so 2026-10-26 is a Monday --
// every date below derives from that first principle (same as
// nextShowAnnounce.test.mjs). Brief shape is parseShowBrief's exact header
// contract (H1 title + optional "**Personas:**" line); writer validation
// only checks that <id>.md EXISTS under show-descriptions/.
const DATA_DIR = path.join(repoRoot(), 'data', 'test-schedule-dates');
const STATION_PATH = path.join(DATA_DIR, 'station.json');

function writeBrief(id, title) {
  const md = [`# ${title}`, '', '## Description', '', `${title} -- testni brief.`, ''].join('\n');
  fs.mkdirSync(path.join(DATA_DIR, 'show-descriptions'), { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'show-descriptions', `${id}.md`), md);
}

writeBrief('jutranji', 'Jutranji');
writeBrief('vecerni', 'Večerni');
writeBrief('praznicni', 'Praznični');

function writeStation(schedule) {
  fs.writeFileSync(
    STATION_PATH,
    JSON.stringify({ station: { name: 'Test Station', neverPlay: { keywords: [], artists: [] } }, schedule }, null, 2)
  );
}
writeStation({});

const scheduleUtil = await import('../src/scheduler/scheduleUtil.js');
const stationWriter = await import('../src/scheduler/stationWriter.js');
const { buildWeeklyGrid } = await import('../src/server/scheduleGrid.js');
const { listShowSummaries } = await import('../src/server/studioShowsApi.js');
const { registerStudioRoutes } = await import('../src/server/studioAuth.js');

const AUTH = { authorization: `Basic ${Buffer.from('studio:sekret').toString('base64')}` };

async function studioApp() {
  const fastify = Fastify({ logger: false });
  await fastify.register(registerStudioRoutes, { prefix: '/studio' });
  await fastify.ready();
  return fastify;
}

// ---------------------------------------------------------------------------
// A. reader contract
// ---------------------------------------------------------------------------

describe('A. loadSchedule / loadDateOverrides', () => {
  test('loadSchedule excludes the "dates" key from the weekday map (collision guard pin)', () => {
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: { '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }] },
    });
    const schedule = scheduleUtil.loadSchedule();
    // Without the exclusion, "dates" would leak into every schedule[weekday]
    // consumer: generateScript.js's Object.keys walk, studioShowsApi's
    // Object.values, stationWriter's day sweeps (all TypeError on an object).
    assert.deepEqual(Object.keys(schedule), ['monday']);
    assert.equal(schedule.dates, undefined);
    assert.equal(schedule.monday.length, 1);
  });

  test('a dates-only station.json reads as an empty weekday map, not a throw', () => {
    writeStation({ dates: { '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }] } });
    assert.deepEqual(scheduleUtil.loadSchedule(), {});
    assert.deepEqual(Object.keys(scheduleUtil.loadDateOverrides()), ['2026-12-25']);
  });

  test('fail-open per key: typo\'d keys and non-array values skipped, valid key kept', () => {
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: {
        boats: [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }], // not a date key at all
        '2026-12-5': [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }], // not zero-padded
        '2026-12-25': 'not-an-array', // valid key, garbage value
        '2026-12-26': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }], // the one valid entry
      },
    });
    const dates = scheduleUtil.loadDateOverrides();
    assert.deepEqual(Object.keys(dates), ['2026-12-26']);
    assert.equal(dates['2026-12-26'][0].id, 'praznicni');
    // Reader doctrine note: "2026-13-45" is regex-shaped, so the READER keeps
    // it (inert -- no real date ever queries that key); the WRITER's calendar
    // round-trip is the strict gate and rejects it on every write path.
  });

  test('fail-open block level: dates as an array or a string reads as {}', () => {
    for (const garbage of [['2026-12-25'], 'oops', 42]) {
      writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }], dates: garbage });
      assert.deepEqual(scheduleUtil.loadDateOverrides(), {}, `dates=${JSON.stringify(garbage)} must fail open`);
    }
  });

  test('a missing dates block reads as {}', () => {
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    assert.deepEqual(scheduleUtil.loadDateOverrides(), {});
  });
});

// ---------------------------------------------------------------------------
// B. precedence (pure, injected dates)
// ---------------------------------------------------------------------------

describe('B. effectiveDayLineup precedence', () => {
  const TEMPLATE = { monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] };

  test('an override beats the weekday template for that date', () => {
    const dates = { '2026-10-26': [{ id: 'praznicni', startTime: '12:00', durationMinutes: 60 }] };
    assert.equal(scheduleUtil.effectiveDayLineup(TEMPLATE, dates, '2026-10-26')[0].id, 'praznicni');
  });

  test('an EMPTY override is a deliberate dark day, not a fall-through to the template', () => {
    assert.deepEqual(scheduleUtil.effectiveDayLineup(TEMPLATE, { '2026-10-26': [] }, '2026-10-26'), []);
  });

  test('a date without an override falls back to its weekday template', () => {
    const dates = { '2026-10-26': [{ id: 'praznicni', startTime: '12:00', durationMinutes: 60 }] };
    // A different Monday, no override for it:
    assert.equal(scheduleUtil.effectiveDayLineup(TEMPLATE, dates, '2026-11-02')[0].id, 'jutranji');
    // A non-Monday with no template:
    assert.deepEqual(scheduleUtil.effectiveDayLineup(TEMPLATE, dates, '2026-10-27'), []);
  });
});

// ---------------------------------------------------------------------------
// C. day-walkers with injected dates (2026-10-26 is a Monday)
// ---------------------------------------------------------------------------

describe('C. day-walkers with injected dates', () => {
  const MON_AT_1400 = new Date(2026, 9, 26, 14, 0, 0);

  test('mostRecentOccurrence finds the override entry, not the template show', () => {
    const schedule = { monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] };
    const dates = { '2026-10-26': [{ id: 'praznicni', startTime: '12:00', durationMinutes: 120 }] };
    const occ = scheduleUtil.mostRecentOccurrence(schedule, MON_AT_1400, dates);
    assert.equal(occ.show.id, 'praznicni');
    assert.equal(occ.date, '2026-10-26');
    assert.equal(occ.weekday, 'monday');
    // The template's 08:00 show is suppressed on the override date:
    const template = scheduleUtil.mostRecentOccurrence(schedule, MON_AT_1400, {});
    assert.equal(template.show.id, 'jutranji');
  });

  test('upcomingOccurrences suppresses the template on an override date and answers the next day', () => {
    const schedule = {
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }, { id: 'vecerni', startTime: '20:00', durationMinutes: 60 }],
      tuesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
    };
    const dates = { '2026-10-26': [{ id: 'praznicni', startTime: '12:00', durationMinutes: 60 }] };
    // Monday 14:00, 20h horizon: the override's own 12:00 already started
    // (absent), Monday's template 20:00 is suppressed, Tuesday 08:00 answers.
    const upcoming = scheduleUtil.upcomingOccurrences(schedule, MON_AT_1400, 1200, dates);
    assert.deepEqual(
      upcoming.map((u) => `${u.date}@${u.show.id}`),
      ['2026-10-27@jutranji']
    );
  });

  test('nextOccurrences skips a deliberate dark day (and keeps filling past it)', () => {
    const schedule = {
      monday: [{ id: 'jutranji', startTime: '23:00', durationMinutes: 60 }],
      wednesday: [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }],
    };
    const dates = { '2026-10-27': [] }; // Tuesday deliberately dark
    // Monday 23:30: today's 23:00 already started (skipped on day 0);
    // the dark Tuesday is honestly skipped; the walker fills the count from
    // Wednesday onward, never from the dark date.
    const next = scheduleUtil.nextOccurrences(schedule, new Date(2026, 9, 26, 23, 30), 3, dates);
    assert.deepEqual(
      next.map((n) => `${n.date}@${n.show.id}`),
      ['2026-10-28@vecerni', '2026-11-02@jutranji', '2026-11-04@vecerni']
    );
    assert.ok(!next.some((n) => n.date === '2026-10-27'), 'the dark day never appears');
  });

  test('nextOccurrence stays inside the override list first (same-date sibling before any walk)', () => {
    const schedule = { monday: [{ id: 'jutranji', startTime: '16:00', durationMinutes: 60 }] };
    const dates = {
      '2026-10-26': [
        { id: 'praznicni', startTime: '12:00', durationMinutes: 60 },
        { id: 'vecerni', startTime: '14:00', durationMinutes: 60 },
      ],
    };
    const current = {
      show: { id: 'praznicni', startTime: '12:00', durationMinutes: 60 },
      weekday: 'monday',
      date: '2026-10-26',
      timeKey: '12-00',
    };
    const next = scheduleUtil.nextOccurrence(schedule, current, dates);
    assert.equal(next.show.id, 'vecerni');
    assert.equal(next.date, '2026-10-26');
    assert.equal(next.timeKey, '14-00');
    // The suppressed template show must NOT be reachable from the override:
    assert.notEqual(next.show.id, 'jutranji');
  });

  test('nextOccurrence from an override occurrence walks to the next real day', () => {
    const schedule = {
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      wednesday: [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }],
    };
    const dates = { '2026-10-26': [{ id: 'praznicni', startTime: '12:00', durationMinutes: 60 }] };
    const current = {
      show: { id: 'praznicni', startTime: '12:00', durationMinutes: 60 },
      weekday: 'monday',
      date: '2026-10-26',
      timeKey: '12-00',
    };
    const next = scheduleUtil.nextOccurrence(schedule, current, dates);
    // Tuesday has no template; Wednesday's 20:00 is the next real occurrence.
    assert.equal(next.date, '2026-10-28');
    assert.equal(next.weekday, 'wednesday');
    assert.equal(next.show.id, 'vecerni');
    assert.equal(next.hasGap, true); // Mon 13:00 nominal end vs Wed 20:00 start
  });
});

// DST boundary, one pair, the timezone.test.mjs method: the day-walk is
// local-time dependent and Node caches the process timezone at boot, so the
// scenario runs in its OWN child with TZ in its env. The child imports the
// REAL scheduleUtil.js and prints JSON for the parent to assert on.
const CHILD_PAYLOAD_ENV = 'RCD_DATES_PAYLOAD';
const CHILD_SCRIPT = `
import * as scheduleUtil from ${JSON.stringify(path.join(repoRoot(), 'src', 'scheduler', 'scheduleUtil.js'))};
const input = JSON.parse(process.env[${JSON.stringify(CHILD_PAYLOAD_ENV)}]);
process.stdout.write(JSON.stringify(scheduleUtil.nextOccurrence(input.schedule, input.current, input.dates) ?? null));
`;

function runInZone(tz, payload) {
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD_SCRIPT],
    { env: { ...process.env, TZ: tz, [CHILD_PAYLOAD_ENV]: JSON.stringify(payload) }, encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(res.status, 0, `child in TZ=${tz} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

function zoneOffsetMinutes(tz, y, m, d, hh, mm) {
  const res = spawnSync(
    process.execPath,
    ['-e', `process.stdout.write(String(new Date(${y},${m - 1},${d},${hh},${mm}).getTime() - Date.UTC(${y},${m - 1},${d},${hh},${mm})))`],
    { env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 30000 }
  );
  if (res.status !== 0) return null;
  const ms = Number(res.stdout);
  return Number.isFinite(ms) ? ms / 60000 : null;
}

describe('C+. DST fall-back boundary with injected dates (child process)', () => {
  test('nextOccurrence from the fall-back Sunday\'s last override entry crosses to the next real day', (t) => {
    // Probe both sides of the 25-hour day: +120 at 00:30 (CEST), +60 at 23:30
    // (CET) prove the zone resolves AND the day is really 25 hours long.
    if (zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 0, 30) !== -120 ||
        zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 23, 30) !== -60) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    // Sunday 2026-10-25 carries an override whose last entry is 22:00; Monday
    // 2026-10-26 is itself a deliberate dark override day; Tuesday has the
    // template. A +24h epoch day-walk re-lands on the SAME Sunday (00:00 CEST
    // + 24h = 23:00 CET) and would re-select the override's own first entry;
    // the calendar walk must reach Tuesday.
    const next = runInZone('Europe/Ljubljana', {
      schedule: { tuesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] },
      dates: {
        '2026-10-25': [{ id: 'praznicni', startTime: '22:00', durationMinutes: 120 }],
        '2026-10-26': [],
      },
      current: {
        show: { id: 'praznicni', startTime: '22:00', durationMinutes: 120 },
        weekday: 'sunday',
        date: '2026-10-25',
        timeKey: '22-00',
      },
    });
    assert.equal(next.date, '2026-10-27');
    assert.equal(next.weekday, 'tuesday');
    assert.equal(next.show.id, 'jutranji');
  });
});

// ---------------------------------------------------------------------------
// D. stationWriter date surface
// ---------------------------------------------------------------------------

describe('D. replaceDateSchedule / removeDateSchedule (stationWriter)', () => {
  test('happy path: sorted, packed back-to-back, persisted, weekday template untouched', async () => {
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    const placed = await stationWriter.replaceDateSchedule('2026-12-25', [
      { id: 'vecerni', startTime: '20:00', durationMinutes: 60 },
      { id: 'praznicni', startTime: '10:00', durationMinutes: 120 },
    ]);
    assert.deepEqual(
      placed.map((o) => [o.id, o.startTime]),
      [['praznicni', '10:00'], ['vecerni', '12:00']] // sorted, then closeGaps
    );
    const onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.deepEqual(onDisk.schedule.dates['2026-12-25'], placed, 'persisted exactly as placed');
    assert.deepEqual(onDisk.schedule.monday.map((o) => o.id), ['jutranji'], 'the weekday template is untouched');
  });

  test('an empty occurrences array is stored (a deliberate dark day)', async () => {
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    const placed = await stationWriter.replaceDateSchedule('2026-12-25', []);
    assert.deepEqual(placed, []);
    const onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.deepEqual(onDisk.schedule.dates['2026-12-25'], []);
  });

  test('invalid date keys: format and calendar round-trip both rejected, nothing written', async () => {
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    await assert.rejects(stationWriter.replaceDateSchedule('2026-12-5', []), /Invalid date "2026-12-5" -- expected YYYY-MM-DD/);
    // "2026-13-45" passes the shape regex but new Date(2026, 12, 45) rolls
    // over into 2027 -- only the round-trip catches it.
    await assert.rejects(stationWriter.replaceDateSchedule('2026-13-45', []), /not a real calendar date/);
    assert.equal(JSON.parse(fs.readFileSync(STATION_PATH, 'utf8')).schedule.dates, undefined, 'nothing persisted on rejection');
  });

  test('invalid occurrences rejected: unknown show, bad startTime, bad duration', async () => {
    writeStation({});
    await assert.rejects(
      stationWriter.replaceDateSchedule('2026-12-25', [{ id: 'no-such-show', startTime: '10:00', durationMinutes: 60 }]),
      /No show "no-such-show"/
    );
    await assert.rejects(
      stationWriter.replaceDateSchedule('2026-12-25', [{ id: 'jutranji', startTime: '10:00:30', durationMinutes: 60 }]),
      /Invalid startTime/
    );
    await assert.rejects(
      stationWriter.replaceDateSchedule('2026-12-25', [{ id: 'jutranji', startTime: '10:00', durationMinutes: 0 }]),
      /Invalid durationMinutes/
    );
  });

  test('non-array occurrences rejected with the dark-day hint', async () => {
    await assert.rejects(stationWriter.replaceDateSchedule('2026-12-25', null), /must be an array/);
    await assert.rejects(stationWriter.replaceDateSchedule('2026-12-25', {}), /must be an array/);
  });

  test('replay occurrences: past sourceDate persists with type, future sourceDate rejected, "normal" stripped', async () => {
    writeStation({});
    const tomorrow = scheduleUtil.dateKey(scheduleUtil.addCalendarDays(new Date(), 1));
    await assert.rejects(
      stationWriter.replaceDateSchedule('2026-12-25', [
        { id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'replay', sourceDate: tomorrow },
      ]),
      /is in the future/
    );
    await assert.rejects(
      stationWriter.replaceDateSchedule('2026-12-25', [
        { id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'bogus' },
      ]),
      /Invalid occurrence type/
    );
    await assert.rejects(
      stationWriter.replaceDateSchedule('2026-12-25', [
        { id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'replay', sourceDate: '2020-01-01', sourceTimeKey: '8:00' },
      ]),
      /Invalid sourceTimeKey/ // HH-MM with the dash, never a colon
    );
    const placed = await stationWriter.replaceDateSchedule('2026-12-25', [
      { id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'replay', sourceDate: '2020-01-01', sourceTimeKey: '08-00' },
      { id: 'jutranji', startTime: '21:00', durationMinutes: 30, type: 'normal' },
    ]);
    assert.equal(placed[0].type, 'replay');
    assert.equal(placed[0].sourceDate, '2020-01-01');
    assert.equal(placed[0].sourceTimeKey, '08-00');
    assert.equal(placed[1].type, undefined, '"normal" normalizes away to a plain entry');
    assert.equal(placed[1].sourceDate, undefined);
  });

  test('removeDateSchedule: returns the entries, key gone, block dropped with the last key, throws when nonexistent', async () => {
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: {
        '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }],
        '2026-12-26': [{ id: 'vecerni', startTime: '20:00', durationMinutes: 60 }],
      },
    });
    const removed = await stationWriter.removeDateSchedule('2026-12-25');
    assert.deepEqual(removed.map((o) => o.id), ['praznicni']);
    let onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.ok(!('2026-12-25' in onDisk.schedule.dates));
    assert.ok('2026-12-26' in onDisk.schedule.dates, 'the sibling override survives');

    await stationWriter.removeDateSchedule('2026-12-26'); // the LAST key
    onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.equal(onDisk.schedule.dates, undefined, 'the whole dates block goes away with the last key');

    await assert.rejects(stationWriter.removeDateSchedule('2026-12-26'), /No date override for "2026-12-26" to remove/);
  });

  test('removeShowOccurrences sweeps date overrides: removed id gone, emptied keys dropped, {date,startTime} reported', async () => {
    writeStation({
      monday: [
        { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
        { id: 'vecerni', startTime: '09:00', durationMinutes: 60 },
      ],
      dates: {
        '2026-12-25': [{ id: 'vecerni', startTime: '10:00', durationMinutes: 60 }],
        '2026-12-26': [
          { id: 'jutranji', startTime: '08:00', durationMinutes: 60 },
          { id: 'vecerni', startTime: '09:00', durationMinutes: 60 },
        ],
      },
    });
    const removed = await stationWriter.removeShowOccurrences('vecerni');
    const onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    // '2026-12-25' emptied -> the key itself is dropped:
    assert.ok(!('2026-12-25' in onDisk.schedule.dates));
    // '2026-12-26' keeps jutranji, closed up:
    assert.deepEqual(onDisk.schedule.dates['2026-12-26'].map((o) => o.id), ['jutranji']);
    assert.equal(onDisk.schedule.dates['2026-12-26'][0].startTime, '08:00');
    // The weekday sweep is unchanged by the dates sweep:
    assert.deepEqual(onDisk.schedule.monday.map((o) => o.id), ['jutranji']);
    // Removals from overrides report {date, startTime}; weekday ones {weekday, startTime}:
    assert.ok(removed.some((r) => r.date === '2026-12-25' && r.startTime === '10:00'));
    assert.ok(removed.some((r) => r.date === '2026-12-26' && r.startTime === '09:00'));
    assert.ok(removed.some((r) => r.weekday === 'monday' && r.startTime === '09:00'));
  });

  test('WEEKDAY-WRITE PRESERVES DATES (the expandSchedule wipe-regression pin)', async () => {
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: { '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }] },
    });
    // A plain weekday write must not wipe the overrides block while
    // expanding the schedule's weekday keys.
    await stationWriter.addOccurrence('tuesday', { id: 'vecerni', startTime: '20:00', durationMinutes: 60 });
    const onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.deepEqual(onDisk.schedule.dates['2026-12-25'].map((o) => o.id), ['praznicni']);
    assert.deepEqual(onDisk.schedule.tuesday.map((o) => o.id), ['vecerni']);
    assert.deepEqual(onDisk.schedule.monday.map((o) => o.id), ['jutranji']);
  });
});

// ---------------------------------------------------------------------------
// E. studio API surface (the real plugin, Basic auth, Fastify inject)
// ---------------------------------------------------------------------------

describe('E. studio API /api/schedule/dates', () => {
  test('GET returns the persisted override block; {} when none', async () => {
    writeStation({});
    const fastify = await studioApp();
    const empty = await fastify.inject({ method: 'GET', url: '/studio/api/schedule/dates', headers: AUTH });
    assert.equal(empty.statusCode, 200);
    assert.deepEqual(empty.json(), { dates: {} });
    await fastify.close();

    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: { '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }] },
    });
    const fastify2 = await studioApp();
    const res = await fastify2.inject({ method: 'GET', url: '/studio/api/schedule/dates', headers: AUTH });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().dates['2026-12-25'], [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }]);
    await fastify2.close();
  });

  test('PUT replaces the whole day, echoes the placed occurrences, leaves the weekday template alone', async () => {
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: { '2026-11-01': [{ id: 'vecerni', startTime: '09:00', durationMinutes: 60 }] },
    });
    const fastify = await studioApp();
    const res = await fastify.inject({
      method: 'PUT',
      url: '/studio/api/schedule/dates/2026-11-01',
      headers: { ...AUTH, 'content-type': 'application/json' },
      payload: JSON.stringify({
        occurrences: [
          { id: 'vecerni', startTime: '20:00', durationMinutes: 60 },
          { id: 'praznicni', startTime: '10:00', durationMinutes: 120 },
        ],
      }),
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.date, '2026-11-01');
    // Full replacement, never a merge: the old 09:00 vecerni is GONE.
    assert.deepEqual(
      body.occurrences.map((o) => [o.id, o.startTime]),
      [['praznicni', '10:00'], ['vecerni', '12:00']]
    );
    const onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.deepEqual(onDisk.schedule.dates['2026-11-01'], body.occurrences);
    assert.deepEqual(onDisk.schedule.monday.map((o) => o.id), ['jutranji']);
    await fastify.close();
  });

  test('PUT rejects invalid input with 400 {error}: bad date key, bad occurrence, missing occurrences, non-array', async () => {
    writeStation({ monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }] });
    const fastify = await studioApp();
    const put = (url, payload) =>
      fastify.inject({
        method: 'PUT',
        url,
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });

    for (const [url, payload] of [
      ['/studio/api/schedule/dates/2026-13-45', { occurrences: [] }],
      ['/studio/api/schedule/dates/boats', { occurrences: [] }],
      ['/studio/api/schedule/dates/2026-12-25', { occurrences: [{ id: 'no-such-show', startTime: '10:00', durationMinutes: 60 }] }],
      ['/studio/api/schedule/dates/2026-12-25', { occurrences: 'not-an-array' }],
      ['/studio/api/schedule/dates/2026-12-25', {}],
    ]) {
      const res = await put(url, payload);
      assert.equal(res.statusCode, 400, `${url} ${JSON.stringify(payload)} must 400`);
      assert.ok(typeof res.json().error === 'string' && res.json().error.length > 0, 'the error message is present');
    }
    await fastify.close();
  });

  test('PUT accepts a replay occurrence (past sourceDate) and rejects a future sourceDate', async () => {
    writeStation({});
    const tomorrow = scheduleUtil.dateKey(scheduleUtil.addCalendarDays(new Date(), 1));
    const fastify = await studioApp();
    const put = (occurrences) =>
      fastify.inject({
        method: 'PUT',
        url: '/studio/api/schedule/dates/2026-12-25',
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: JSON.stringify({ occurrences }),
      });
    const bad = await put([{ id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'replay', sourceDate: tomorrow }]);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.json().error, /is in the future/);

    const ok = await put([{ id: 'vecerni', startTime: '20:00', durationMinutes: 60, type: 'replay', sourceDate: '2020-01-01' }]);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.json().occurrences[0].type, 'replay');
    assert.equal(ok.json().occurrences[0].sourceDate, '2020-01-01');
    await fastify.close();
  });

  test('DELETE removes an override (day falls back to its template); 400 when nonexistent', async () => {
    writeStation({
      monday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: { '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 60 }] },
    });
    const fastify = await studioApp();
    const del = (date) =>
      fastify.inject({
        method: 'DELETE',
        url: `/studio/api/schedule/dates/${date}`,
        headers: { ...AUTH, 'content-type': 'application/json' },
        payload: '{}',
      });
    const gone = await del('2026-05-05');
    assert.equal(gone.statusCode, 400, 'nothing stored at that date');
    assert.match(gone.json().error, /No date override/);

    const ok = await del('2026-12-25');
    assert.equal(ok.statusCode, 200);
    assert.deepEqual(ok.json().map((o) => o.id), ['praznicni']);
    const onDisk = JSON.parse(fs.readFileSync(STATION_PATH, 'utf8'));
    assert.equal(onDisk.schedule.dates, undefined, 'last key removed -> the block itself is gone');
    assert.deepEqual(onDisk.schedule.monday.map((o) => o.id), ['jutranji']);
    await fastify.close();
  });

  test('readiness answers the EFFECTIVE lineup per date (override entries in, suppressed template slots out)', async () => {
    const now = new Date();
    const todayKey = scheduleUtil.dateKey(now);
    const weekday = scheduleUtil.weekdayKey(now);
    writeStation({
      [weekday]: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      dates: { [todayKey]: [{ id: 'praznicni', startTime: '23:00', durationMinutes: 60 }] },
    });
    const fastify = await studioApp();
    const res = await fastify.inject({ method: 'GET', url: '/studio/api/schedule/readiness', headers: AUTH });
    assert.equal(res.statusCode, 200);
    const { readiness } = res.json();
    assert.equal(readiness[`${weekday}/23-00`], 'none', 'the override slot is answered (nothing produced yet)');
    assert.equal(readiness[`${weekday}/08-00`], undefined, 'the suppressed template slot is absent, not "not ready"');
    await fastify.close();
  });

  test('listShowSummaries reports a duration for a date-only show (the override lists are schedule rows too)', () => {
    writeStation({ dates: { '2026-12-25': [{ id: 'praznicni', startTime: '10:00', durationMinutes: 75 }] } });
    const summaries = listShowSummaries();
    const praznicni = summaries.find((s) => s.id === 'praznicni');
    assert.equal(praznicni.durationMinutes, 75);
    // A show placed on no weekday and no date still reports null:
    const vecerni = summaries.find((s) => s.id === 'vecerni');
    assert.equal(vecerni.durationMinutes, null);
  });
});

// ---------------------------------------------------------------------------
// F. buildWeeklyGrid with overrides (the listener "Spored" surface)
// ---------------------------------------------------------------------------

describe('F. buildWeeklyGrid with overrides', () => {
  test('an override day renders its own entries + the dateOverride flag, template suppressed, marks still date-scoped', () => {
    writeStation({
      wednesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      thursday: [{ id: 'vecerni', startTime: '10:00', durationMinutes: 60 }],
      dates: { '2026-10-21': [{ id: 'praznicni', startTime: '14:00', durationMinutes: 60 }] },
    });
    // Wednesday 2026-10-21 14:30 -- the override's 14:00 show is mid-slot.
    const grid = buildWeeklyGrid(scheduleUtil.loadSchedule(), new Date(2026, 9, 21, 14, 30));
    const wed = grid.days.find((d) => d.weekday === 'wednesday');
    assert.equal(wed.dateOverride, true);
    assert.deepEqual(wed.shows.map((s) => s.id), ['praznicni'], 'the override replaces the whole day');
    assert.ok(!wed.shows.some((s) => s.id === 'jutranji'), 'the template show is suppressed, never merged');
    assert.equal(wed.shows[0].mark, 'on-air', 'the mark logic is date-scoped on the override entry');
    assert.equal(grid.currentShow.id, 'praznicni');
    assert.equal(grid.nextShow.id, 'vecerni', 'next walks off the override to Thursday\'s template');
    const thu = grid.days.find((d) => d.weekday === 'thursday');
    assert.equal(thu.shows[0].mark, 'next');
    // The flag lives on the DATE, not the weekday: every other rendered day
    // is unflagged (in a 7-day window each weekday appears exactly once).
    assert.ok(grid.days.filter((d) => d.date !== '2026-10-21').every((d) => d.dateOverride === undefined));
  });

  test('a deliberate dark day renders an empty shows list but still carries the flag', () => {
    writeStation({
      wednesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
      thursday: [{ id: 'vecerni', startTime: '10:00', durationMinutes: 60 }],
      dates: { '2026-10-21': [] },
    });
    const grid = buildWeeklyGrid(scheduleUtil.loadSchedule(), new Date(2026, 9, 21, 14, 30));
    const wed = grid.days.find((d) => d.weekday === 'wednesday');
    assert.deepEqual(wed.shows, [], 'the client renders this honestly as "Brez oddaj"');
    assert.equal(wed.dateOverride, true);
    // Nothing on air (dark today, no Tuesday lineup), next is Thursday's:
    assert.equal(grid.currentShow, null);
    assert.equal(grid.nextShow.id, 'vecerni');
  });

  test('days without any override carry no dateOverride field at all (additive flag discipline)', () => {
    writeStation({
      wednesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
    });
    const grid = buildWeeklyGrid(scheduleUtil.loadSchedule(), new Date(2026, 9, 21, 14, 30));
    assert.ok(grid.days.every((d) => d.dateOverride === undefined));
    assert.ok(grid.days.every((d) => d.dateOverride !== false), 'the flag is never false -- it is simply absent');
  });
});
