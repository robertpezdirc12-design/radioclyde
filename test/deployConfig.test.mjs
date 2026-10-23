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
    ]) {
      const [block, key2] = key.split('.');
      assert.ok(cfg[block], `missing config.${block} block (scheduler reads it without ?.)`);
      assert.ok(cfg[block][key2] !== undefined, `missing config.${key}`);
    }
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
});
