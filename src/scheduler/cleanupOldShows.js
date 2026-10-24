#!/usr/bin/env node
// Reclaims disk space by deleting produced/directed show occurrences (script,
// transcript, dj-audio, playlist.m3u, etc. -- everything under
// config.paths.runningDir/<weekday>/<showId>/<date>/) once they're older
// than config.cleanup.retentionDays. Safe to run against a live station:
// only whole date-named directories are removed, and only by parsing the
// date out of the directory name itself, not mtime -- a script/audio file
// touched today for a show that aired last week must not save it from
// cleanup, and conversely files untouched since creation but for a
// yesterday-dated show must not be removed early.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

const DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// history/aired.jsonl is append-only and parsed WHOLE by /api/history, the
// studio on-air view, rotation analysis and the as-run exporter -- unbounded
// growth is a slow leak that eventually makes every one of those reads
// expensive. Default retention comfortably outlives the year of history an
// as-run/license report (SAZAS/ZKP) could reasonably ask for.
const AIRED_RETENTION_DAYS_DEFAULT = 400;
// Floor: never prune below the most recent 10k entries, so a huge (or
// misconfigured) retention value can't combine with a burst of airing to
// erode recent history -- the part every live view actually reads.
const AIRED_MIN_KEEP = 10_000;

// Prunes the aired ledger by age (and quietly drops torn lines it happens to
// walk past -- same skip-and-count contract as every other JSONL reader).
// Rewrites atomically. Honest about the tiny race: appenders run in separate
// detached processes (scrobbleTrack.js), so a track starting within the
// few-ms read->rename window could append a line the rewrite drops; cleanup
// runs 4x/day and the floor keeps the blast radius at a single stale line in
// a year-old archive -- cheaper than unbounded growth.
function pruneAiredHistory(retentionDays) {
  const file = config.paths.airedHistoryFile;
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0; // no ledger yet (fresh install) or unreadable -- nothing to prune
  }
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const keptByAge = [];
  let dropped = 0;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      dropped++; // torn line (crash mid-append) -- drop it while we're here
      continue;
    }
    if (new Date(entry.playedAt).getTime() < cutoff) {
      dropped++;
      continue;
    }
    keptByAge.push(line);
  }
  const keep = keptByAge.length >= AIRED_MIN_KEEP ? keptByAge : lines.slice(-AIRED_MIN_KEEP);
  if (keep.length === lines.length) return 0; // nothing aged out, nothing torn -- leave the file (and its mtime) alone
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
  fs.renameSync(tmp, file);
  log(`Pruned aired history: kept ${keep.length}, dropped ${lines.length - keep.length} (retention ${retentionDays}d).`);
  return lines.length - keep.length;
}

function listSubdirs(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

export async function cleanupOldShows(retentionDays = config.cleanup?.retentionDays ?? 7) {
  const runningDir = config.paths.runningDir;
  // No early return here anymore: the aired-history prune below must run even
  // on a fresh install whose running/ dir doesn't exist yet (the ledger is
  // written by scrobbleTrack processes, not by anything under running/).
  const cutoff = Date.now() - retentionDays * DAY_MS;
  let removed = 0;

  if (fs.existsSync(runningDir)) {
    for (const weekday of listSubdirs(runningDir)) {
      const weekdayDir = path.join(runningDir, weekday);
      for (const showId of listSubdirs(weekdayDir)) {
        const showDir = path.join(weekdayDir, showId);
        for (const dateName of listSubdirs(showDir)) {
          if (!DATE_DIR_RE.test(dateName)) continue; // not a date dir -- leave anything unexpected alone
          // Local midnight for that date, same convention scheduleUtil.js's
          // dateKey()/weekdayKey() use elsewhere.
          const occurrenceDate = new Date(`${dateName}T00:00:00`);
          if (occurrenceDate.getTime() >= cutoff) continue; // within retention window

          const target = path.join(showDir, dateName);
          fs.rmSync(target, { recursive: true, force: true });
          removed++;
          log(`Removed ${target} (older than ${retentionDays}d)`);
        }
        // Prune the showId dir too once every date under it is gone, so a
        // show that's been removed from station.json doesn't leave an empty
        // shell behind forever.
        if (fs.existsSync(showDir) && listSubdirs(showDir).length === 0) {
          fs.rmdirSync(showDir);
        }
      }
      if (fs.existsSync(weekdayDir) && listSubdirs(weekdayDir).length === 0) {
        fs.rmdirSync(weekdayDir);
      }
    }
  }

  if (removed > 0) {
    log(`Cleanup complete: removed ${removed} occurrence director${removed === 1 ? 'y' : 'ies'} older than ${retentionDays}d.`);
  }
  pruneAiredHistory(config.cleanup?.airedRetentionDays ?? AIRED_RETENTION_DAYS_DEFAULT);
  return { removed };
}

async function main() {
  const { removed } = await cleanupOldShows();
  console.log(`Cleanup complete: removed ${removed} occurrence director${removed === 1 ? 'y' : 'ies'}.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
