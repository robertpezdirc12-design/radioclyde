// F2-class config-guard regressions: a hand-edited config.json missing whole
// blocks (schedule/filler/backup/...) is a SUPPORTED state per the scheduler's
// own ?. chains -- these tests import and RUN the guarded code paths against
// a minimal config with those blocks stripped, asserting the boot-fatal
// module-level read (scheduleDirect.js) and the per-tick job functions no
// longer throw. Plus the cadence() unit tests for the every() tick-storm
// guard, and scheduleUtil's fail-open station.json read.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig, repoRoot } from './fixtures.mjs';

// Strip every optional block: JSON.stringify drops undefined-valued keys, so
// the written config.json genuinely lacks schedule/filler/backup/cleanup/
// analytics/imaging/autocue/chatterbox/archive/push -- exactly the
// hand-edited minimal config the F2 class of defect bites.
setupTestConfig('config-guards', {
  schedule: undefined,
  filler: undefined,
  backup: undefined,
  cleanup: undefined,
  analytics: undefined,
  imaging: undefined,
  autocue: undefined,
  chatterbox: undefined,
  archive: undefined,
  push: undefined,
});

const { config } = await import('../src/config/index.js');
// THE boot-fatal one: this import itself used to throw (module-level
// config.schedule.directStallWarningMinutes), which killed the whole
// web-server boot because startScheduler imports this file at startup.
const scheduleDirect = await import('../src/scheduler/scheduleDirect.js');
const scheduler = await import('../src/scheduler/scheduler.js');
const scheduleUtil = await import('../src/scheduler/scheduleUtil.js');
const { generateFillerPlaylist } = await import('../src/scheduler/generateFillerPlaylist.js');
const { backupStation } = await import('../src/scheduler/backupStation.js');
const { updateNowPlaying } = await import('../src/scheduler/updateNowPlaying.js');
const { checkAndTriggerScripts } = await import('../src/scheduler/scheduleScripts.js');
const { checkScheduleChanged } = await import('../src/scheduler/scheduleWatch.js');
const { checkAndTriggerPrewarmAudio } = await import('../src/scheduler/schedulePrewarmAudio.js');

describe('missing config blocks (the F2 class)', () => {
  test('scheduleDirect.js imports at all (the module-level boot-fatal read is guarded)', () => {
    assert.equal(typeof scheduleDirect.checkAndTriggerDirect, 'function');
    assert.equal(config.schedule, undefined, 'fixtures really wrote no schedule block');
  });

  test('the per-tick job functions tolerate a missing schedule block', async () => {
    await assert.doesNotReject(scheduleDirect.checkAndTriggerDirect());
    await assert.doesNotReject(checkAndTriggerScripts());
    await assert.doesNotReject(checkAndTriggerPrewarmAudio());
    await assert.doesNotReject(updateNowPlaying());
    assert.doesNotThrow(() => checkScheduleChanged());
    // hasLeadTime falls back to its own 30-minute default (a far-future
    // occurrence has runway, a long-past one doesn't -- both directions).
    assert.equal(scheduleUtil.hasLeadTime('2099-01-01', { id: 'x', startTime: '00:00' }, new Date(), 'monday'), true);
    assert.equal(scheduleUtil.hasLeadTime('2000-01-01', { id: 'x', startTime: '23:00' }, new Date(), 'monday'), false);
  });

  test('generateFillerPlaylist runs with no filler block (defaults apply, empty library is honest)', async () => {
    const result = await generateFillerPlaylist();
    assert.equal(config.filler, undefined, 'fixtures really wrote no filler block');
    assert.deepEqual(result, { trackCount: 0 });
    assert.ok(fs.existsSync(config.paths.fillerPath), 'filler.m3u still written (empty)');
  });

  test('backupStation skips honestly with no backup block instead of TypeError', async () => {
    assert.equal(config.backup, undefined, 'fixtures really wrote no backup block');
    const result = await backupStation();
    assert.deepEqual(result, { skipped: true });
    assert.ok(!fs.existsSync(path.join(config.dataDir, 'backups')), 'nothing was backed up anywhere');
  });
});

describe('scheduleUtil fail-open station.json read', () => {
  test('a corrupt or missing station.json reads as an empty station, never a throw', () => {
    const stationFile = config.paths.stationFile;
    const original = fs.readFileSync(stationFile, 'utf8');

    fs.writeFileSync(stationFile, '{not json at all');
    try {
      assert.deepEqual(scheduleUtil.loadSchedule(), {});
      assert.deepEqual(scheduleUtil.loadStation(), {});
      assert.equal(scheduleUtil.loadDowntime(), null);
      assert.deepEqual(scheduleUtil.loadNeverPlay(), { keywords: [], artists: [] });
    } finally {
      fs.writeFileSync(stationFile, original);
    }

    fs.rmSync(stationFile, { force: true });
    try {
      assert.deepEqual(scheduleUtil.loadSchedule(), {});
    } finally {
      fs.writeFileSync(stationFile, original);
    }
  });

  test('a valid station.json still parses exactly as before the guard', () => {
    const stationFile = config.paths.stationFile;
    fs.writeFileSync(stationFile, JSON.stringify({ station: { name: 'N' }, schedule: { monday: [{ id: 'm' }] }, downtime: { start: '01:00', end: '05:00' } }));
    try {
      assert.deepEqual(scheduleUtil.loadSchedule().monday, [{ id: 'm' }]);
      assert.equal(scheduleUtil.loadStation().name, 'N');
      assert.deepEqual(scheduleUtil.loadDowntime(), { start: '01:00', end: '05:00' });
    } finally {
      // Restore the fixtures' minimal station.json for any later test.
      fs.writeFileSync(stationFile, JSON.stringify({ station: { name: 'Test Station', neverPlay: { keywords: [], artists: [] } } }));
    }
  });

  // Paket C1 (Val 22) fail-open pin: a hand-corrupted schedule.dates block
  // must not take the weekday map down with it -- /api/schedule (grid,
  // now-playing, upcoming) all keep answering on the template while the
  // overrides read as none.
  test('a corrupt schedule.dates block fails open: loadDateOverrides() {} and the weekday map still loads', () => {
    const stationFile = config.paths.stationFile;
    const original = fs.readFileSync(stationFile, 'utf8');
    for (const garbage of ['corrupt', ['2026-12-25'], 42]) {
      fs.writeFileSync(
        stationFile,
        JSON.stringify({
          station: { name: 'N' },
          schedule: {
            monday: [{ id: 'm', startTime: '08:00', durationMinutes: 60 }],
            dates: garbage,
          },
        })
      );
      try {
        assert.deepEqual(scheduleUtil.loadDateOverrides(), {}, `dates=${JSON.stringify(garbage)} must fail open`);
        assert.deepEqual(scheduleUtil.loadSchedule().monday, [{ id: 'm', startTime: '08:00', durationMinutes: 60 }]);
        assert.equal('dates' in scheduleUtil.loadSchedule(), false, 'the weekday map never leaks the dates key');
      } finally {
        fs.writeFileSync(stationFile, original);
      }
    }
  });
});

describe('cadence() (the every() tick-storm guard)', () => {
  const { cadence } = scheduler;

  test('valid values pass through unchanged, fractional ones included', () => {
    assert.equal(cadence(5, 15), 5);
    assert.equal(cadence(0.1, 15), 0.1); // nowPlayingCheckIntervalMinutes' 6 s default
    assert.equal(cadence('7', 15), 7); // numeric strings are finite numbers after coercion
    assert.equal(cadence(1, 15), 1);
  });

  test('junk falls back: 0, negative, non-numeric strings, NaN, null, undefined', () => {
    assert.equal(cadence(0, 15), 15); // setInterval(0) = 1ms storm
    assert.equal(cadence(-5, 15), 15);
    assert.equal(cadence('abc', 15), 15); // Math.max(1,'abc') used to be NaN = same storm
    assert.equal(cadence(Number.NaN, 15), 15);
    assert.equal(cadence(null, 15), 15); // ?? only caught this before
    assert.equal(cadence(undefined, 30), 30);
    assert.equal(cadence('', 15), 15); // Number('') is 0, not NaN -- refused too
  });

  // Structural: every registration is wrapped, the four old Math.max(1, ...)
  // sites included -- a raw every(config...) left anywhere re-opens the
  // storm for exactly that job. Same standard as the radio.liq wiring tests.
  // 15 since Paket B2 (the OPT-IN promo_producer registration; it is
  // cadence-wrapped exactly like the unconditional 14, it is merely gated by
  // an if (config.imaging?.promos?.enabled === true) around the every()
  // call).
  test('all 15 every() registrations route through cadence(), none raw', () => {
    const source = fs.readFileSync(`${repoRoot()}/src/scheduler/scheduler.js`, 'utf8');
    // Registrations always start their own line; plain every( mentions inside
    // comments ("every()'s own immediate first tick") must not confuse the count.
    const registrations = source.match(/^\s*every\(/gm) ?? [];
    assert.equal(registrations.length, 15, 'exactly the 15 job registrations, nothing raw');
    const wrapped = source.match(/^\s*every\(cadence\(/gm) ?? [];
    assert.equal(wrapped.length, 15, 'every job registration is cadence-wrapped');
    assert.equal(source.includes('Math.max(1, config.'), false, 'the old Math.max guard form is gone');
  });
});
