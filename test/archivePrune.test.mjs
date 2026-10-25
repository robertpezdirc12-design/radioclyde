// The archive_prune job (scheduler.js's pruneArchives): SUB/WAVE's
// day-granular retention. Everything here guards the same property from a
// different angle -- the prune may only ever remove WHOLE day directories
// that are strictly older than both the retention cutoff and today, so the
// currently-open hour file can never be unlinked from under Liquidsoap.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { setupTestConfig } from './fixtures.mjs';

setupTestConfig('archive-prune', {});

const { pruneArchives } = await import('../src/scheduler/scheduler.js');
const { dateKey } = await import('../src/scheduler/scheduleUtil.js');
const { config } = await import('../src/config/index.js');

const ARCHIVE_DIR = path.join(config.dataDir, 'archive');
const DAY_MS = 24 * 60 * 60 * 1000;

// Same local-date convention pruneArchives uses (scheduleUtil.dateKey), so
// the seeded dirs and the computed cutoff/today always agree.
const day = (offsetDays) => dateKey(new Date(Date.now() + offsetDays * DAY_MS));

function seedDay(name, files = ['10-00.mp3', '11-00.mp3']) {
  const dir = path.join(ARCHIVE_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) fs.writeFileSync(path.join(dir, file), Buffer.alloc(4));
  return dir;
}

describe('pruneArchives (day-granular retention)', () => {
  test('retention window: older-than-cutoff removed, boundary and newer kept, junk untouched', async () => {
    fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
    const old = seedDay(day(-9), ['08-00.mp3', 'stray-notes.txt']); // whole dir goes, stray file included
    const boundary = seedDay(day(-7)); // exactly the cutoff date -> KEPT (not strictly older)
    const recent = seedDay(day(-6));
    const today = seedDay(day(0));
    const tomorrow = seedDay(day(1));
    fs.mkdirSync(path.join(ARCHIVE_DIR, 'not-a-date'), { recursive: true });
    fs.writeFileSync(path.join(ARCHIVE_DIR, 'not-a-date', '10-00.mp3'), Buffer.alloc(4));

    const result = await pruneArchives({ retentionDays: 7 });
    assert.deepEqual(result, { removed: 1 });
    assert.ok(!fs.existsSync(old));
    assert.ok(fs.existsSync(boundary), 'the cutoff day itself is inside the window');
    assert.ok(fs.existsSync(recent));
    assert.ok(fs.existsSync(today));
    assert.ok(fs.existsSync(tomorrow));
    assert.ok(fs.existsSync(path.join(ARCHIVE_DIR, 'not-a-date')), 'non-date neighbours are never touched');

    // Per-run summary in the station log, cleanupOldShows style.
    const stationLog = fs.readFileSync(path.join(config.paths.logsDir, 'station.log'), 'utf8');
    assert.match(stationLog, /Archive prune complete: removed 1 day directory \(retention 7d\)/);
    assert.match(stationLog, new RegExp(`Removed ${old.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}`));
  });

  test('negative retentionDays: everything before today goes, today/future NEVER', async () => {
    fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
    seedDay(day(-3));
    seedDay(day(-1));
    const today = seedDay(day(0));
    const tomorrow = seedDay(day(1));

    const result = await pruneArchives({ retentionDays: -5 });
    assert.equal(result.removed, 2);
    assert.ok(fs.existsSync(today), 'today survives even when the cutoff lands in the future');
    assert.ok(fs.existsSync(tomorrow));
  });

  test('retentionDays 0 = keep forever', async () => {
    fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
    seedDay('2020-01-01');
    seedDay('2021-06-15');
    assert.deepEqual(await pruneArchives({ retentionDays: 0 }), { removed: 0 });
    assert.ok(fs.existsSync(path.join(ARCHIVE_DIR, '2020-01-01')));
    assert.ok(fs.existsSync(path.join(ARCHIVE_DIR, '2021-06-15')));
  });

  test('missing archive block is a no-op, NOT a default-30 sweep; missing dir is a no-op', async () => {
    fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
    seedDay('2020-01-01'); // far older than any default retention
    assert.deepEqual(await pruneArchives(undefined), { removed: 0 });
    assert.ok(fs.existsSync(path.join(ARCHIVE_DIR, '2020-01-01')));

    fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
    assert.deepEqual(await pruneArchives({ retentionDays: 7 }), { removed: 0 }); // no dir, no error
  });

  test('second run over an already-pruned archive removes nothing (idempotent)', async () => {
    fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
    seedDay(day(-9));
    seedDay(day(0));
    assert.equal((await pruneArchives({ retentionDays: 7 })).removed, 1);
    assert.deepEqual(await pruneArchives({ retentionDays: 7 }), { removed: 0 });
    assert.ok(fs.existsSync(path.join(ARCHIVE_DIR, day(0))));
  });
});
