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
import { pruneOldEntries } from '../producer/history.js';

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

// Listener requests (server/requestsStore.js) and closed polls
// (server/pollsStore.js): the two ledgers nothing pruned anywhere -- both are
// read and rewritten WHOLE on every read, so growth is a slow leak on every
// studio requests/polls view. 90 days matches the "honest history" horizon
// the aired ledger uses an order of magnitude below; newest-N floors keep a
// burst of aging-out entries from eroding the moderation views' recent pages.
const REQUESTS_RETENTION_DAYS = 90;
const REQUESTS_MIN_KEEP = 200;
const POLLS_RETENTION_DAYS = 90;

// Dead-air guard events (deadair/recordEvent.js, appended by radio.liq's
// blank.detect callbacks as detached processes): the last history ledger with
// no retention of its own, while deadair/ledger.js parses it WHOLE on every
// studio Diagnostics view -- unbounded growth is a slow leak on that read,
// and since the val-18 backup extension every daily backup copies it too, so
// growth also bloats each backup. 90 days matches the requests/polls "honest
// history" horizon: diagnostics older than that belong in the backups, not
// the live ledger. The floor keeps a pathological flapping detector plus a
// huge retention value from eroding the tail the Diagnostics view reads.
const DEADAIR_RETENTION_DAYS_DEFAULT = 90;
const DEADAIR_MIN_KEEP = 2000;

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

// Prunes producer/history.js's played.jsonl (the show-play ledger).
// played.jsonl is re-parsed WHOLE by recentlyPlayedRatingKeys() on every
// filler regeneration AND every script production (~200 lines/day, nothing
// ever pruned it: pruneOldEntries existed with zero callers), so wiring it
// here -- on the same cleanup cadence, right next to the aired-ledger prune
// -- is the missing half. Its own try/catch so a history prune failure
// never skips the other ledger prunes nor throws the scheduler tick.
function prunePlayedHistory() {
  try {
    pruneOldEntries();
  } catch (err) {
    log(`Played-history prune failed (non-fatal): ${err.message}`);
  }
}

// Requests ledger: drop entries whose createdAt is older than retentionDays
// (torn lines skipped-and-counted on the way past, same as the aired prune),
// but never fewer than the newest REQUESTS_MIN_KEEP lines. An entry without
// a parseable createdAt is KEPT (NaN < cutoff is false) -- conservative, the
// same convention the aired prune uses for a bad playedAt. Both this file's
// writers (submission append, moderation rewrite) live in the web-server
// process, which is the same process the scheduler runs in, so the
// read->rename window can't actually interleave with a write the way the
// detached scrobbleTrack appenders can race the aired prune.
export function pruneRequestsLedger(
  retentionDays = REQUESTS_RETENTION_DAYS,
  minKeep = REQUESTS_MIN_KEEP
) {
  const file = config.paths.requestsFile;
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0; // no requests yet (fresh install) or unreadable -- nothing to prune
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
    if (new Date(entry.createdAt).getTime() < cutoff) {
      dropped++;
      continue;
    }
    keptByAge.push(line);
  }
  const keep = keptByAge.length >= minKeep ? keptByAge : lines.slice(-minKeep);
  if (keep.length === lines.length) return 0; // nothing aged out, nothing torn -- leave the file (and its mtime) alone
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
  fs.renameSync(tmp, file);
  log(`Pruned requests ledger: kept ${keep.length}, dropped ${lines.length - keep.length} (retention ${retentionDays}d).`);
  return lines.length - keep.length;
}

// Closed-poll retention. polls.json is rewritten atomically by
// server/pollsStore.js's writeStore (tmp-<pid> + rename, 2-space JSON); this
// prune operates on the file directly with that same atomic pattern (the
// store itself stays untouched -- it fails open on a missing/corrupt file,
// and this rewrite always writes a well-formed store). The ACTIVE poll is
// never touched; a closed poll with an unparseable closedAt is kept (NaN <
// cutoff is false, conservative like every other ledger here). Writers all
// live in the same web-server process as the scheduler, so the
// read->rename window cannot interleave a concurrent vote.
export function pruneClosedPolls(retentionDays = POLLS_RETENTION_DAYS) {
  const file = config.paths.pollsFile;
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return 0; // no polls yet, or corrupt -- readStore's own fail-open domain
  }
  if (!store || typeof store !== 'object' || !Array.isArray(store.closed)) return 0;
  const cutoff = Date.now() - retentionDays * DAY_MS;
  const keep = store.closed.filter((poll) => !(new Date(poll.closedAt).getTime() < cutoff));
  if (keep.length === store.closed.length) return 0;
  const next = { ...store, closed: keep };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
  log(`Pruned closed polls: kept ${keep.length}, dropped ${store.closed.length - keep.length} (retention ${retentionDays}d).`);
  return store.closed.length - keep.length;
}

// Prunes the dead-air event ledger by age (and quietly drops torn lines it
// happens to walk past -- same skip-and-count contract as every other JSONL
// prune here). Rewrites atomically. Honest about the same tiny race the aired
// prune has: recordEvent.js appends from a DETACHED Liquidsoap callback
// process, so a guard transition within the few-ms read->rename window could
// append a line the rewrite drops; cleanup runs 4x/day and the floor keeps
// the blast radius at a single stale transition. An entry with an unparseable
// `at` is KEPT (NaN < cutoff is false) -- conservative, the same convention
// the aired prune uses for a bad playedAt.
export function pruneDeadAirEvents(
  retentionDays = DEADAIR_RETENTION_DAYS_DEFAULT,
  minKeep = DEADAIR_MIN_KEEP
) {
  const file = config.paths.deadAirEventsFile;
  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return 0; // no ledger yet (the guard never fired) or unreadable -- nothing to prune
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
    if (new Date(entry.at).getTime() < cutoff) {
      dropped++;
      continue;
    }
    keptByAge.push(line);
  }
  const keep = keptByAge.length >= minKeep ? keptByAge : lines.slice(-minKeep);
  if (keep.length === lines.length) return 0; // nothing aged out, nothing torn -- leave the file (and its mtime) alone
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
  fs.renameSync(tmp, file);
  log(`Pruned dead-air events: kept ${keep.length}, dropped ${lines.length - keep.length} (retention ${retentionDays}d).`);
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
  // Junk retentionDays must refuse the sweep, not guess at it: cutoff =
  // Date.now() - retentionDays * DAY_MS with a non-number is NaN, and
  // `x >= NaN` is ALWAYS false, so no date dir was ever skipped -- the sweep
  // silently deleted EVERY show dir under running/ including today's
  // (a negative value deletes future dirs the same way). Refusal style
  // mirrors scheduler.js pruneArchives's own guard; the ledger prunes below
  // still run, since they have their own independent retention knobs.
  const retentionOk = Number.isFinite(retentionDays) && retentionDays > 0;
  if (!retentionOk) {
    log(`Cleanup sweep skipped: retentionDays is not a positive number (${JSON.stringify(retentionDays)}).`);
  }
  let removed = 0;

  if (retentionOk && fs.existsSync(runningDir)) {
    const cutoff = Date.now() - retentionDays * DAY_MS;
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
  // Each ledger prune in its own try/catch: one unreadable file must never
  // skip the others nor throw the scheduler tick (every()'s catch would log
  // it, but then these would all be skipped until the next 6h tick).
  try {
    pruneAiredHistory(config.cleanup?.airedRetentionDays ?? AIRED_RETENTION_DAYS_DEFAULT);
  } catch (err) {
    log(`Aired-history prune failed (non-fatal): ${err.message}`);
  }
  prunePlayedHistory();
  try {
    pruneRequestsLedger();
  } catch (err) {
    log(`Requests-ledger prune failed (non-fatal): ${err.message}`);
  }
  try {
    pruneClosedPolls();
  } catch (err) {
    log(`Closed-polls prune failed (non-fatal): ${err.message}`);
  }
  try {
    pruneDeadAirEvents(config.cleanup?.deadairRetentionDays ?? DEADAIR_RETENTION_DAYS_DEFAULT);
  } catch (err) {
    log(`Dead-air-events prune failed (non-fatal): ${err.message}`);
  }
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
