#!/usr/bin/env node
// Daily safety copy of the hand-authored station config sources --
// station.json (schedule + personality), show-descriptions/ (per-show
// briefs), and prompts.json (persona + script-review system prompts) --
// into config.backup.dir, dated so a bad edit to any of them can be rolled
// back. Everything else under dataDir is generated/derived and already
// covered by cleanupOldShows.js's retention, not by this backup.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { dateKey } from './scheduleUtil.js';

const log = createLogger('station');

export async function backupStation() {
  const backupDir = config.backup.dir;
  const destDir = path.join(backupDir, dateKey(new Date()));
  fs.mkdirSync(destDir, { recursive: true });

  // Source dirs/files may legitimately not exist yet on a fresh dataDir
  // (install.sh creates them, but a hand-made dataDir may not have one) --
  // skip what's missing with a NOTE instead of crashing the daily tick
  // (audit 2026-10-24: a single ENOENT aborted the whole backup job).
  for (const [label, src, dest, recursive] of [
    ['station.json', config.paths.stationFile, path.join(destDir, 'station.json'), false],
    ['show-descriptions/', config.paths.showDescriptionsDir, path.join(destDir, 'show-descriptions'), true],
    ['prompts.json', config.paths.promptsFile, path.join(destDir, 'prompts.json'), false],
  ]) {
    if (!fs.existsSync(src)) {
      log(`NOTE: backup source ${label} does not exist yet -- skipping it this tick.`);
      continue;
    }
    fs.cpSync(src, dest, { recursive });
  }

  log(`Backed up station.json, show-descriptions/, and prompts.json to ${destDir}`);
  return { destDir };
}

async function main() {
  const { destDir } = await backupStation();
  console.log(`Backup complete: ${destDir}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
