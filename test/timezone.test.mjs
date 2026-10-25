// Timezone validation regression tests -- against the REAL production helper
// (audit 2026-10-24 finding: the previous version re-implemented
// isValidTimeZone inline three times and never imported the production
// function, so the tests passed while production behavior diverged).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('timezone');

const { isValidTimeZone, toLocalISOString } = await import('../src/lib/time.js');
const { currentLocalTimeString, currentLocalDateString } = await import('../src/director/weather.js');

describe('timezone validation (production helpers)', () => {
  test('valid IANA zones and UTC accepted', () => {
    assert.ok(isValidTimeZone('Europe/Ljubljana'));
    assert.ok(isValidTimeZone('UTC'));
    assert.ok(isValidTimeZone('America/New_York'));
    assert.ok(isValidTimeZone('Asia/Tokyo'));
  });

  test('invalid zones, empties and non-strings rejected', () => {
    assert.ok(!isValidTimeZone('INVALID_TZ_XYZ'));
    assert.ok(!isValidTimeZone('TBD')); // the value shipped in config.example.json at audit time
    assert.ok(!isValidTimeZone(''));
    assert.ok(!isValidTimeZone('   '));
    assert.ok(!isValidTimeZone(null));
    assert.ok(!isValidTimeZone(undefined));
    assert.ok(!isValidTimeZone(42));
  });

  test('toLocalISOString uses the configured zone when valid', () => {
    const iso = toLocalISOString(new Date('2026-10-24T12:00:00Z'), 'Europe/Ljubljana');
    assert.match(iso, /\+02:00$/); // CEST in October (DST ends 2026-10-25)
  });

  test('toLocalISOString falls back to UTC and logs for invalid zones', () => {
    const err = console.error;
    let logged = '';
    console.error = (m) => (logged = String(m));
    try {
      const iso = toLocalISOString(new Date('2026-10-24T12:00:00Z'), 'TBD');
      assert.match(iso, /Z$/); // UTC instant, not a shifted offset
      assert.match(logged, /invalid config\.weather\.timezone/);
    } finally {
      console.error = err;
    }
  });

  test('spoken time/date formatters survive an invalid zone (UTC fallback, no crash)', () => {
    assert.doesNotThrow(() => currentLocalTimeString('TBD'));
    assert.doesNotThrow(() => currentLocalDateString(''));
    assert.match(currentLocalTimeString('Europe/Ljubljana'), /^\d{1,2}:\d{2}(\s?[AP]M)?$/);
  });
});

// ---------------------------------------------------------------------------
// DST day-walk regression (scheduleUtil.js) -- THE fall-back-day fire.
//
// A fixed +24h/-24h epoch-ms step is NOT one calendar day on DST transition
// days: on the 25-hour fall-back day (Europe/Ljubljana 2026-10-25, verified
// live in this repo) `dateFromKey('2026-10-25') + 24h` re-lands on Oct 25
// 23:00 CET -- the SAME date -- so nextOccurrence's day walk re-selected the
// already-aired Sunday lineup (shows[0]) and updateNowPlaying replayed the
// morning show all night, state.date re-anchoring on every pass so the loop
// never ended. scheduleUtil now steps calendar days (addCalendarDays /
// setDate), and these tests pin that across the fall-back boundary, the
// spring-forward boundary, and a plain UTC day.
//
// Methodology: the day-walk is local-time dependent and Node caches the
// process timezone at boot, so each scenario runs in its OWN child process
// with TZ in its env (spawnSync -- reliable on Linux, the deployment target).
// The child imports the REAL scheduleUtil.js and prints JSON for the parent
// to assert on -- same "test the production helper, never a re-implementation"
// standard as the isValidTimeZone tests above.
//
// The child finds the repo-root config.json this file's setupTestConfig()
// wrote (scheduleUtil imports the config module), but none of the exercised
// functions touch the filesystem -- they are pure local-time arithmetic.
const SCHEDULE_UTIL_PATH = path.join(repoRoot(), 'src', 'scheduler', 'scheduleUtil.js');
// Payload travels via env, not argv: `node -e SCRIPT ARGS` does not reliably
// expose extra args to process.argv in every Node line, while env is the one
// channel every child sees verbatim.
const CHILD_PAYLOAD_ENV = 'RCDST_TEST_PAYLOAD';
const CHILD_SCRIPT = `
import * as scheduleUtil from ${JSON.stringify(SCHEDULE_UTIL_PATH)};
const input = JSON.parse(process.env[${JSON.stringify(CHILD_PAYLOAD_ENV)}]);
const now = input.now ? new Date(input.now.y, input.now.m - 1, input.now.d, input.now.hh, input.now.mm) : undefined;
let out;
switch (input.op) {
  case 'nextOccurrence': out = scheduleUtil.nextOccurrence(input.schedule, input.current); break;
  case 'nextOccurrences': out = scheduleUtil.nextOccurrences(input.schedule, now, input.count); break;
  case 'mostRecentOccurrence': out = scheduleUtil.mostRecentOccurrence(input.schedule, now); break;
  case 'upcomingOccurrences': out = scheduleUtil.upcomingOccurrences(input.schedule, now, input.horizon); break;
  case 'addCalendarDays': out = scheduleUtil.dateKey(scheduleUtil.addCalendarDays(now, input.days)); break;
}
process.stdout.write(JSON.stringify(out ?? null));
`;

// Runs one scenario in a child pinned to `tz`; returns the parsed result.
// Fails the test loudly (not silently) when the child itself errors.
function runInZone(t, tz, payload) {
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', CHILD_SCRIPT],
    { env: { ...process.env, TZ: tz, [CHILD_PAYLOAD_ENV]: JSON.stringify(payload) }, encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(res.status, 0, `child in TZ=${tz} failed: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

// Soft probe: does this machine's child process actually resolve the zone
// (needs tzdata, which every Linux deploy has)? Returns the local-UTC offset
// in minutes at the given local wall-clock, or null when the zone is
// unsupported -- callers skip the scenario honestly instead of failing on a
// stripped box, exactly like the PIPER_LIVE skip.
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

const SUNDAY_SHOW = { id: 'sunday-morning', startTime: '06:00', durationMinutes: 60, description: 'x' };
const MONDAY_SHOW = { id: 'monday-show', startTime: '07:00', durationMinutes: 60, description: 'x' };
const WEEKEND_SCHEDULE = { sunday: [SUNDAY_SHOW], monday: [MONDAY_SHOW] };

describe('DST calendar-day walks (scheduleUtil.js, spawned per TZ)', () => {
  test('fall-back 2026-10-25 (Europe/Ljubljana): nextOccurrence steps to Monday, not back onto the aired Sunday', (t) => {
    // Probe both sides of the fall-back: +120min at 00:30 (CEST) and +60min at
    // 23:30 (CET) prove the zone resolves AND the day is really 25 hours long.
    if (zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 0, 30) !== -120 ||
        zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 23, 30) !== -60) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    const next = runInZone(t, 'Europe/Ljubljana', {
      op: 'nextOccurrence',
      schedule: WEEKEND_SCHEDULE,
      // The Sunday-morning show that already aired on the fall-back day --
      // exactly the state the all-night replay loop was stuck in.
      current: { show: SUNDAY_SHOW, weekday: 'sunday', date: '2026-10-25', timeKey: '06-00' },
    });
    // The pre-fix epoch walk returned date '2026-10-25' / sunday-morning
    // (dateFromKey + 24h = Oct 25 23:00 CET = the SAME date).
    assert.equal(next.date, '2026-10-26');
    assert.equal(next.weekday, 'monday');
    assert.equal(next.show.id, 'monday-show');
    assert.equal(next.timeKey, '07-00');
  });

  test('spring-forward 2027-03-28 (Europe/Ljubljana): the calendar step lands on Monday too', (t) => {
    if (zoneOffsetMinutes('Europe/Ljubljana', 2027, 3, 28, 0, 30) !== -60 ||
        zoneOffsetMinutes('Europe/Ljubljana', 2027, 3, 28, 23, 30) !== -120) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    const next = runInZone(t, 'Europe/Ljubljana', {
      op: 'nextOccurrence',
      schedule: WEEKEND_SCHEDULE,
      current: { show: SUNDAY_SHOW, weekday: 'sunday', date: '2027-03-28', timeKey: '06-00' },
    });
    assert.equal(next.date, '2027-03-29');
    assert.equal(next.weekday, 'monday');
    assert.equal(next.show.id, 'monday-show');
  });

  test('UTC control: 2026-10-25 is a plain 24h day, the walk still steps one date', (t) => {
    const next = runInZone(t, 'UTC', {
      op: 'nextOccurrence',
      schedule: WEEKEND_SCHEDULE,
      current: { show: SUNDAY_SHOW, weekday: 'sunday', date: '2026-10-25', timeKey: '06-00' },
    });
    assert.equal(next.date, '2026-10-26');
    assert.equal(next.weekday, 'monday');
  });

  test('addCalendarDays itself: local midnight + 1 calendar day across the fall-back boundary', (t) => {
    if (zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 0, 30) !== -120) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    // The one-line repro of the original defect: midnight + 24h epoch-ms is
    // still Oct 25 (23:00 CET) in this zone; the calendar step must be Oct 26.
    const epochStep = runInZone(t, 'Europe/Ljubljana', {
      op: 'addCalendarDays', days: 0, now: { y: 2026, m: 10, d: 25, hh: 0, mm: 0 },
    });
    const calendarStep = runInZone(t, 'Europe/Ljubljana', {
      op: 'addCalendarDays', days: 1, now: { y: 2026, m: 10, d: 25, hh: 0, mm: 0 },
    });
    assert.equal(calendarStep, '2026-10-26');
    assert.notEqual(epochStep, calendarStep); // sanity: the boundary is real on this box
  });

  test('mostRecentOccurrence: Saturday late-night spill still found during Sunday 23:xx on the fall-back day', (t) => {
    if (zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 23, 30) !== -60) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    const best = runInZone(t, 'Europe/Ljubljana', {
      op: 'mostRecentOccurrence',
      // Sunday dark, Saturday's 23:00 show is the most recently started one.
      schedule: { saturday: [{ id: 'sat-late', startTime: '23:00', durationMinutes: 90 }] },
      now: { y: 2026, m: 10, d: 25, hh: 23, mm: 30 },
    });
    // Pre-fix: now - 24h = Oct 25 00:30 CEST = the SAME date, so the
    // "yesterday" candidate pointed at empty Sunday and best came back null.
    assert.equal(best.weekday, 'saturday');
    assert.equal(best.date, '2026-10-24');
    assert.equal(best.show.id, 'sat-late');
  });

  test('upcomingOccurrences: tomorrow really is Monday during the fall-back day’s first hour', (t) => {
    if (zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 0, 30) !== -120) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    const results = runInZone(t, 'Europe/Ljubljana', {
      op: 'upcomingOccurrences',
      schedule: WEEKEND_SCHEDULE,
      horizon: 2000,
      now: { y: 2026, m: 10, d: 25, hh: 0, mm: 30 },
    });
    // Pre-fix: now + 24h = Oct 25 23:30 CET (same date), so Sunday's 06:00
    // show appeared TWICE (offset 0 and +1440) and Monday never showed up.
    assert.equal(results.length, 2);
    assert.deepEqual(
      results.map((o) => [o.date, o.timeKey]),
      [['2026-10-25', '06-00'], ['2026-10-26', '07-00']]
    );
    assert.equal(results[0].minutesUntil, 330); // 06:00 - 00:30
    assert.equal(results[1].minutesUntil, 1830); // Mon 07:00 (+1440) - 00:30
  });

  test('nextOccurrences: the web page’s day walk visits each date once across the boundary', (t) => {
    if (zoneOffsetMinutes('Europe/Ljubljana', 2026, 10, 25, 0, 30) !== -120) {
      return t.skip('Europe/Ljubljana tzdata unavailable in child processes');
    }
    const results = runInZone(t, 'Europe/Ljubljana', {
      op: 'nextOccurrences',
      schedule: {
        sunday: [SUNDAY_SHOW],
        monday: [MONDAY_SHOW, { id: 'monday-two', startTime: '09:00', durationMinutes: 60 }],
      },
      count: 3,
      now: { y: 2026, m: 10, d: 25, hh: 0, mm: 30 },
    });
    // Pre-fix: day+24h re-landed on Oct 25 (23:30), duplicating the Sunday
    // entry and hiding Monday's shows from the "coming up" list.
    assert.deepEqual(
      results.map((o) => [o.date, o.show.id]),
      [['2026-10-25', 'sunday-morning'], ['2026-10-26', 'monday-show'], ['2026-10-26', 'monday-two']]
    );
  });
});
