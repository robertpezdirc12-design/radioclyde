// Weekly schedule grid (server/scheduleGrid.js) -- issue #2 section A
// ("Weekly programme schedule with current and next show clearly marked")
// and section D (repeat/diagnosis work needs an honest template view).
// Pins the date-scoped marking rules, including the overnight trap: a show
// past midnight belongs to YESTERDAY's date and must never light up NEXT
// week's same-weekday cell. Paket C1 (Val 22) additions: an override date
// renders its own entries + the additive dateOverride flag (the deeper
// override walker/writer/API coverage lives in scheduleDates.test.mjs).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

setupTestConfig('schedule-grid');

const { buildWeeklyGrid } = await import('../src/server/scheduleGrid.js');

// Fixed local wall-clock "now" values (deterministic regardless of when the
// suite runs). Wednesday 2026-10-21.
const WED_AT_1430 = new Date(2026, 9, 21, 14, 30, 0);
const WED_AT_0010 = new Date(2026, 9, 21, 0, 10, 0); // just after midnight

const SCHEDULE = {
  wednesday: [
    { id: 'afternoon', name: 'Popoldan', startTime: '14:00', durationMinutes: 60 },
    { id: 'evening', name: 'Večer', startTime: '16:00', durationMinutes: 60 },
    { id: 'latenight', name: 'Noč', startTime: '23:30', durationMinutes: 90 },
  ],
  thursday: [{ id: 'morning', name: 'Jutro', startTime: '08:00', durationMinutes: 60 }],
};

function findDay(grid, weekday) {
  return grid.days.find((d) => d.weekday === weekday);
}

describe('buildWeeklyGrid marks', () => {
  test('mid-slot show is on-air, the next occurrence is next', () => {
    const grid = buildWeeklyGrid(SCHEDULE, WED_AT_1430);
    const wed = findDay(grid, 'wednesday');
    const afternoon = wed.shows.find((s) => s.id === 'afternoon');
    const evening = wed.shows.find((s) => s.id === 'evening');
    const late = wed.shows.find((s) => s.id === 'latenight');
    assert.equal(afternoon.mark, 'on-air');
    assert.equal(evening.mark, 'next');
    assert.equal(late.mark, undefined);
    assert.equal(grid.currentShow.id, 'afternoon');
    assert.equal(grid.nextShow.id, 'evening');
    assert.equal(grid.days.length, 7);
    assert.ok(grid.timezone);
  });

  test('show whose slot ended is NOT marked on-air', () => {
    // 15:10 -- afternoon slot (14:00+60) is over, evening not started yet.
    const grid = buildWeeklyGrid(SCHEDULE, new Date(2026, 9, 21, 15, 10, 0));
    const wed = findDay(grid, 'wednesday');
    assert.equal(wed.shows.find((s) => s.id === 'afternoon').mark, undefined);
    assert.equal(grid.currentShow?.id, 'afternoon'); // still the most recent START
    assert.equal(grid.nextShow.id, 'evening');
  });

  test('overnight spill never marks next week cell (date-scoped keys)', () => {
    // Wednesday 00:10: tuesday's (nonexistent here) lineup isn't scheduled,
    // so mostRecent falls back within wednesday's own history -- but with a
    // TUESDAY overnight show it would belong to yesterday's date. Use a
    // schedule where yesterday had a late show and assert that NO cell in
    // the rendered week (which starts today) claims "on-air" for it.
    const withTue = {
      tuesday: [{ id: 'late', name: 'Late', startTime: '23:30', durationMinutes: 120 }],
      wednesday: [{ id: 'morning', name: 'Jutro', startTime: '06:00', durationMinutes: 60 }],
    };
    const grid = buildWeeklyGrid(withTue, WED_AT_0010);
    for (const day of grid.days) {
      for (const show of day.shows) {
        assert.notEqual(show.mark, 'on-air', `${day.weekday} ${show.startTime} must not be marked on-air`);
      }
    }
    // Next upcoming is today's morning show.
    assert.equal(grid.nextShow.id, 'morning');
  });

  test('empty schedule yields empty days and no crash', () => {
    const grid = buildWeeklyGrid({}, WED_AT_1430);
    assert.equal(grid.days.length, 7);
    for (const day of grid.days) assert.deepEqual(day.shows, []);
    assert.equal(grid.currentShow, null);
    assert.equal(grid.nextShow, null);
  });

  test('timezone is reported for explicit display', () => {
    const grid = buildWeeklyGrid(SCHEDULE, WED_AT_1430);
    assert.equal(typeof grid.timezone, 'string');
    assert.ok(grid.timezone.length > 0);
  });
});

describe('buildWeeklyGrid date overrides (Paket C1, Val 22)', () => {
  // The fixtures' scratch station.json is the read side buildWeeklyGrid
  // resolves overrides from (its own loadDateOverrides call) -- seeded per
  // test and restored in finally, the configGuards.test.mjs station-file
  // pattern.
  const stationFile = path.join(repoRoot(), 'data', 'test-schedule-grid', 'station.json');

  test('an override date renders its own entries, flags dateOverride, suppresses the template', () => {
    const original = fs.readFileSync(stationFile, 'utf8');
    // 2026-10-21 is this suite's fixed Wednesday.
    fs.writeFileSync(
      stationFile,
      JSON.stringify({
        station: { name: 'Test Station' },
        schedule: {
          wednesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
          dates: { '2026-10-21': [{ id: 'praznicni', startTime: '14:00', durationMinutes: 60 }] },
        },
      })
    );
    try {
      const grid = buildWeeklyGrid(SCHEDULE, WED_AT_1430);
      const wed = findDay(grid, 'wednesday');
      assert.equal(wed.dateOverride, true);
      assert.deepEqual(wed.shows.map((s) => s.id), ['praznicni'], 'the override replaces the whole day');
      // The injected SCHEDULE's wednesday template entries must NOT leak in:
      assert.ok(!wed.shows.some((s) => ['afternoon', 'evening', 'latenight'].includes(s.id)));
      assert.equal(wed.shows[0].mark, 'on-air', 'the mark logic is date-scoped on the override entry');
      assert.equal(grid.currentShow.id, 'praznicni');
      // next walks off the override to Thursday's template morning show:
      assert.equal(grid.nextShow.id, 'morning');
      assert.equal(findDay(grid, 'thursday').shows[0].mark, 'next');
      // The flag lives on the DATE, not the weekday -- every other rendered
      // day is unflagged:
      assert.ok(grid.days.filter((d) => d.date !== '2026-10-21').every((d) => d.dateOverride === undefined));
    } finally {
      fs.writeFileSync(stationFile, original);
    }
  });

  test('a deliberate dark day renders empty but flagged; every other day stays unflagged', () => {
    const original = fs.readFileSync(stationFile, 'utf8');
    fs.writeFileSync(
      stationFile,
      JSON.stringify({
        station: { name: 'Test Station' },
        schedule: {
          wednesday: [{ id: 'jutranji', startTime: '08:00', durationMinutes: 60 }],
          dates: { '2026-10-21': [] },
        },
      })
    );
    try {
      const grid = buildWeeklyGrid(SCHEDULE, WED_AT_1430);
      const wed = findDay(grid, 'wednesday');
      assert.deepEqual(wed.shows, [], 'an empty override suppresses the template too');
      assert.equal(wed.dateOverride, true);
      assert.ok(grid.days.filter((d) => d.date !== '2026-10-21').every((d) => d.dateOverride === undefined));
    } finally {
      fs.writeFileSync(stationFile, original);
    }
  });
});
