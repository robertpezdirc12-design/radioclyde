// Deployment-config regression test (audit 2026-10-24 finding, CRITICAL):
// deploy/ubuntu/config.linux.json shipped without the schedule/filler/
// cleanup/backup blocks that src/scheduler/*.js read WITHOUT optional
// chaining -- startScheduler() threw TypeError at boot, so the production
// scheduler could never run (and generateFillerPlaylist, the filler rotation
// job, crashed for the same reason). This test pins every config key the
// scheduler's boot path reads, so a config block can never silently go
// missing from the shipped production config again.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readConfig(file) {
  const raw = fs.readFileSync(path.join(REPO, file), 'utf8');
  return JSON.parse(raw);
}

describe('shipped production config (deploy/ubuntu/config.linux.json)', () => {
  const cfg = readConfig('deploy/ubuntu/config.linux.json');

  test('parses as JSON with an absolute dataDir', () => {
    assert.equal(typeof cfg.dataDir, 'string');
    assert.ok(path.isAbsolute(cfg.dataDir), 'dataDir must be absolute for the systemd service');
  });

  test('has every scheduler block that is read without optional chaining', () => {
    // src/scheduler/scheduler.js every() calls + scheduleDirect.js module load
    for (const key of [
      'schedule.scriptLeadTimeMinutes',
      'schedule.scriptCheckIntervalMinutes',
      'schedule.directLeadTimeMinutes',
      'schedule.directCheckIntervalMinutes',
      'schedule.nowPlayingCheckIntervalMinutes',
      'schedule.maxCatchUpMinutes',
      'schedule.minLeadTimeMinutes',
      'filler.poolSize',
      'filler.regenerateIntervalMinutes',
      'filler.maxTrackDurationSeconds',
      'cleanup.intervalMinutes',
      'cleanup.retentionDays',
      'backup.intervalMinutes',
      'backup.dir',
      'backup.retentionDays',
    ]) {
      const [block, key2] = key.split('.');
      assert.ok(cfg[block], `missing config.${block} block (scheduler reads it without ?.)`);
      assert.ok(cfg[block][key2] !== undefined, `missing config.${key}`);
    }
  });

  test('backup retention is configured: 30 days of dated backup dirs, then they rotate away', () => {
    // src/scheduler/backupStation.js prunes date-named dirs past
    // config.backup.retentionDays (absent key = the same 30 default, but the
    // shipped config states it explicitly so the rotation is visible to the
    // operator reading the file; 0 would mean keep-forever).
    assert.equal(cfg.backup.retentionDays, 30);
    assert.equal(typeof cfg.backup.dir, 'string');
  });

  test('filler rotation window is configured', () => {
    assert.ok(cfg.filler.rotationWindowHours > 0, 'filler.rotationWindowHours drives cross-hour rotation');
  });

  test('plex block exists so per-segment scrobble processes do not crash', () => {
    // scrobbleTrack.js fires per aired segment; config.plex?.scrobbleEnabled
    // is now guarded, but the block must still exist and be false for a
    // Plex-less auto-radio install.
    assert.equal(cfg.plex.scrobbleEnabled, false);
  });

  test('liquidsoap telnet settings present for the studio Skip/Force Next controls', () => {
    assert.equal(cfg.liquidsoap.telnetHost, '127.0.0.1');
    assert.ok(Number.isInteger(cfg.liquidsoap.telnetPort));
  });

  test('icecast block carries what the web now-playing page needs', () => {
    for (const key of ['sourceHost', 'publicHost', 'port', 'mount']) {
      assert.ok(cfg.icecast[key], `missing icecast.${key}`);
    }
    assert.equal(typeof cfg.icecast.publicHost, 'string', 'icecast.publicHost drives the web now-playing streamUrl');
  });

  test('analytics block present (listener sampling + impact thresholds)', () => {
    // Read with ?. and defaults in code, but pinned here so the shipped
    // production config always carries an explicit sampling cadence and the
    // impact thresholds the studio Analytics view documents.
    assert.ok(cfg.analytics, 'missing config.analytics block');
    assert.ok(Number(cfg.analytics.sampleIntervalMinutes) >= 1, 'sampling cadence must be at least 1 minute');
    assert.ok(Number(cfg.analytics.maxEntries) > 0, 'ledger cap must be positive');
    assert.ok(Number(cfg.analytics.impactWindowHours) > 0);
    assert.ok(Number(cfg.analytics.impactMinSamples) >= 1);
    assert.ok(Number(cfg.analytics.impactMinCoverage) > 0 && Number(cfg.analytics.impactMinCoverage) <= 1);
  });

  test('every config.<block>.<key> read in scheduler.js is guarded for blocks the config lacks', () => {
    // Regression for the chatterbox boot crash (found by the listener-analytics
    // smoke test, 2026-10-24): scheduler.js read config.chatterbox.
    // restartIntervalMinutes unguarded while the shipped production config has
    // no chatterbox block at all -- startScheduler() threw TypeError before
    // "Scheduler started.", which silently killed EVERY job registered after
    // the throwing line (filler, backup, listener sampling...). This test
    // scans the scheduler source for config.<block>.<key> reads and asserts
    // each one is either backed by a block that exists in the shipped config
    // or uses optional chaining (?.) with a fallback.
    const src = fs
      .readFileSync(path.join(REPO, 'src/scheduler/scheduler.js'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '')) // strip // comments -- they mention config paths in prose
      .join('\n');
    const reads = [...src.matchAll(/config\.([A-Za-z_$][\w$]*)(\?)?\.[A-Za-z_$][\w$]*/g)];
    assert.ok(reads.length > 0, 'scan actually matched config reads');
    const unguarded = [];
    for (const [, block, optional] of reads) {
      if (optional === '?') continue; // guarded -- throws-free by construction
      if (block === 'paths') continue; // always derived at config load
      if (cfg[block] === undefined) unguarded.push(block);
    }
    assert.deepEqual(
      [...new Set(unguarded)],
      [],
      'scheduler.js reads config.<block>.<key> WITHOUT ?. for blocks missing from the shipped config -- a boot-time TypeError that kills every job registered after it'
    );
  });
});
