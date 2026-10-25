#!/usr/bin/env node
// Daily safety copy of ALL irreplaceable station state into
// config.backup.dir, dated so a bad edit or disk loss can be rolled back:
//  - hand-authored sources: station.json (schedule + personality),
//    show-descriptions/ (per-show briefs), prompts.json (persona +
//    script-review system prompts)
//  - listener-generated state: requests.jsonl (wishes/dedications),
//    polls.json, push/ (VAPID private key included -- losing it invalidates
//    every browser subscription, see docs/auto-radio.md)
//  - operator media: show-logos/, imaging clip dirs (id/stingers/emergency)
//  - expensive derived caches: track_ratingkeys.json, autocue_index.json
//    (rebuildable, but at hours/days of rescanning)
//  - ether evidence: history/*.jsonl (played, aired, listener-samples,
//    filler-rotation, deadair)
//  - config.json from the repo root: the ONLY copy of the station's
//    credentials (studio/icecast/plex/lastfm passwords) -- its copy gets
//    0600, see below.
// Transient/derived state (.station_hash, now_playing*, filler.m3u,
// imaging/*.m3u, running/, cache/, logs/, archive/, podcasts/, piper/,
// pre-generated/, voice-clips/, asrun/) is intentionally NOT copied -- ticks
// regenerate it. Operator media outside the dataDir conventions (music,
// jingles) is the operator's responsibility -- see DEPLOYMENT_GUIDE.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { dateKey } from './scheduleUtil.js';

const log = createLogger('station');

// config.json -- SPECIAL SOURCE, the only one that lives outside dataDir.
// Resolved the same way src/config/index.js:5-6 resolves it
// (path.dirname(fileURLToPath(import.meta.url)) + ../../config.json):
// must stay in lockstep with src/config/index.js:5-6 (DRIFT-CHECKABLE).
const CONFIG_JSON_SOURCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'config.json'
);

// The filler rotation ledger is the ONE irreplaceable ledger that has no
// config.paths entry -- resolve it exactly as its writer module does
// (src/scheduler/fillerRotation.js:31-33, fillerLedgerPath():
// path.join(config.dataDir, 'history', 'filler-rotation.jsonl')).
function fillerRotationLedger() {
  return path.join(config.dataDir, 'history', 'filler-rotation.jsonl');
}

// Backup-retention candidates: whole date-named day directories, exactly the
// shape this job itself writes (YYYY-MM-DD, from dateKey()).
const BACKUP_DATE_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// One source's copy, with the per-source resilience the daily tick needs:
//  - a source that does not exist yet on a fresh dataDir is a NOTE + skip,
//    never a crash (install.sh creates most of them, but a hand-made dataDir
//    may not; audit 2026-10-24: a single ENOENT aborted the whole backup job)
//  - any OTHER copy failure (EACCES, EISDIR from a source that is a
//    directory where a file is expected, ...) is recorded into `errors` and
//    the loop CONTINUES -- one unreadable source must not silently abort the
//    remaining seventeen. Returns 'copied' | 'skipped' | 'error'.
function copySource(label, src, dest, recursive, errors) {
  if (!fs.existsSync(src)) {
    log(`NOTE: backup source ${label} does not exist yet -- skipping it this tick.`);
    return 'skipped';
  }
  try {
    // cpSync creates nested dest parents itself, but the explicit mkdir
    // keeps the per-file history/ copies self-describing (and costs nothing).
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive });
    return 'copied';
  } catch (err) {
    // ENOENT despite existsSync = the source vanished mid-run (race): the
    // same honesty as a never-existing source, NOT an error.
    if (err?.code === 'ENOENT') {
      log(`NOTE: backup source ${label} disappeared before copying -- skipping it this tick.`);
      return 'skipped';
    }
    errors.push({ source: label, message: err?.message ?? String(err) });
    log(`ERROR: backup source ${label} failed: ${err?.message ?? err}`);
    return 'error';
  }
}

// Recursive byte size of the finished destDir tree -- the backup's actual
// footprint on disk (a same-day rerun keeps this honest: same sources, same
// number, because it counts what is on disk, not what this pass wrote).
function treeBytes(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += treeBytes(target);
    else if (entry.isFile()) {
      try {
        total += fs.statSync(target).size;
      } catch {
        /* vanished mid-walk -- not worth failing the summary over */
      }
    }
  }
  return total;
}

// Retention knob, honest on every shape a hand-edit can produce:
//  - absent -> 30 (the documented default, same spirit as the every() wiring
//    defaulting intervalMinutes to 1440)
//  - 0 -> keep forever (SUB/WAVE's documented semantics, like the archive)
//  - non-number / negative / NaN -> keep forever + ONE honest log line --
//    refuse instead of guessing (F2 discipline: a typo'd retention must not
//    become either a wipe or a silent no-op nobody notices).
function resolveRetentionDays(backup) {
  const raw = backup?.retentionDays;
  if (raw === undefined || raw === null) return 30;
  if (raw === 0) return 0;
  if (typeof raw !== 'number' || Number.isNaN(raw) || raw < 0) {
    log(
      `NOTE: config.backup.retentionDays is ${typeof raw === 'number' ? String(raw) : JSON.stringify(raw)} -- refusing to guess, keeping every backup (0 = keep forever, a positive number of days otherwise).`
    );
    return 0;
  }
  return raw;
}

// Retention sweep, mirroring pruneArchives (scheduler.js:115-156) as closely
// as it applies to dated backup dirs:
//  - candidates are entries matching /^\d{4}-\d{2}-\d{2}$/ AND directories --
//    non-date neighbours (a hand-placed file, an operator's notes dir)
//    survive by construction
//  - Guard 1: the name is strictly older than TODAY (string compare on
//    YYYY-MM-DD keys is a calendar compare) -- today's and future dirs
//    (e.g. a restored 2027-01-01) survive no matter what retention said
//  - Guard 2: age in days > retentionDays. Regex-matching-but-invalid
//    calendar dates (2020-13-45) make Date.parse return NaN, NaN > N is
//    false -- they survive rather than get deleted on a guess.
// Both guards must hold, then the whole day dir is removed recursively.
function pruneOldBackups(backupDir, retentionDays) {
  if (retentionDays === 0) return 0; // keep forever
  let entries;
  try {
    entries = fs.readdirSync(backupDir, { withFileTypes: true });
  } catch {
    return 0; // no backup dir at all (cannot happen after mkdirSync, but honest)
  }
  const today = dateKey(new Date());
  const now = Date.now();
  let pruned = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !BACKUP_DATE_DIR_RE.test(entry.name)) continue;
    if (!(entry.name < today)) continue; // today/future survive Guard 1
    const ageDays = (now - Date.parse(entry.name)) / DAY_MS;
    if (!(ageDays > retentionDays)) continue; // too young, or NaN date -- survive
    const target = path.join(backupDir, entry.name);
    fs.rmSync(target, { recursive: true, force: true });
    pruned++;
    log(`Removed ${target} (older than ${retentionDays}d)`);
  }
  return pruned;
}

export async function backupStation() {
  // No sane default for a backup destination (a guessed path could point at
  // the same disk as the data it's supposed to protect) -- a config without
  // a backup block skips the job with a NOTE instead of the per-tick
  // TypeError an unguarded config.backup.dir read produced. Honest no-op,
  // same shape pruneArchives uses for a missing archive block.
  if (!config.backup?.dir) {
    log('NOTE: no config.backup.dir -- skipping station backup this tick (backup block missing).');
    return { skipped: true };
  }
  const backupDir = config.backup.dir;
  const destDir = path.join(backupDir, dateKey(new Date()));
  fs.mkdirSync(destDir, { recursive: true });

  const errors = [];
  let copied = 0;
  let skipped = 0;
  const dest = (name) => path.join(destDir, name);
  // history ledgers copy PER-FILE (not the whole history/ dir) so a torn
  // .tmp-* leftover from some interrupted atomic rewrite can never match a
  // source path -- the backup takes exactly the five ledgers and nothing
  // else from that directory.
  const sources = [
    ['station.json', config.paths.stationFile, dest('station.json'), false],
    ['show-descriptions/', config.paths.showDescriptionsDir, dest('show-descriptions'), true],
    ['prompts.json', config.paths.promptsFile, dest('prompts.json'), false],
    ['requests.jsonl', config.paths.requestsFile, dest('requests.jsonl'), false],
    ['polls.json', config.paths.pollsFile, dest('polls.json'), false],
    ['push/', config.paths.pushDir, dest('push'), true],
    ['track_ratingkeys.json', config.paths.trackRatingKeysPath, dest('track_ratingkeys.json'), false],
    ['autocue_index.json', config.paths.autocueIndexPath, dest('autocue_index.json'), false],
    ['history/played.jsonl', config.paths.historyFile, dest(path.join('history', 'played.jsonl')), false],
    ['history/aired.jsonl', config.paths.airedHistoryFile, dest(path.join('history', 'aired.jsonl')), false],
    ['history/listener-samples.jsonl', config.paths.listenerSamplesFile, dest(path.join('history', 'listener-samples.jsonl')), false],
    ['history/filler-rotation.jsonl', fillerRotationLedger(), dest(path.join('history', 'filler-rotation.jsonl')), false],
    ['history/deadair.jsonl', config.paths.deadAirEventsFile, dest(path.join('history', 'deadair.jsonl')), false],
    ['show-logos/', config.paths.showLogosDir, dest('show-logos'), true],
    ['imaging/id', config.paths.imagingIdDir, dest(path.join('imaging', 'id')), true],
    ['imaging/stingers', config.paths.imagingStingerDir, dest(path.join('imaging', 'stingers')), true],
    ['imaging/emergency', config.paths.imagingEmergencyDir, dest(path.join('imaging', 'emergency')), true],
  ];
  for (const [label, src, destPath, recursive] of sources) {
    const outcome = copySource(label, src, destPath, recursive, errors);
    if (outcome === 'copied') copied++;
    else if (outcome === 'skipped') skipped++;
  }

  // config.json (SPECIAL SOURCE): the station's credentials -- studio.users,
  // icecast source/admin passwords, plex.token, lastfm -- in PLAINTEXT. The
  // source file itself is typically 0644 (the operator's repo-root copy);
  // the BACKUP copy gets 0600, the same discipline every secret file in this
  // repo already uses (src/push/vapid.js:56, src/broadcast/scrobble.js:186).
  const configJsonOutcome = copySource('config.json', CONFIG_JSON_SOURCE, dest('config.json'), false, errors);
  if (configJsonOutcome === 'copied') {
    copied++;
    try {
      fs.chmodSync(dest('config.json'), 0o600);
    } catch (err) {
      errors.push({ source: 'config.json', message: `chmod 0600 failed: ${err?.message ?? err}` });
      log(`ERROR: backup config.json chmod failed: ${err?.message ?? err}`);
    }
  } else if (configJsonOutcome === 'skipped') {
    skipped++;
  }

  const pruned = pruneOldBackups(backupDir, resolveRetentionDays(config.backup));
  const bytes = treeBytes(destDir);

  log(
    `Backup complete: ${copied} copied, ${skipped} skipped, ${errors.length} error(s), ${bytes} bytes, ${pruned} dir(s) pruned -> ${destDir}`
  );
  return { destDir, copied, skipped, errors, bytes, pruned };
}

async function main() {
  const result = await backupStation();
  // `skipped === true` is the no-config-block flag; on a real run `skipped`
  // is the NUMBER of NOTE-skipped sources (13 on a fresh install), which is
  // truthy -- hence the strict identity check, not truthiness.
  if (result.skipped === true) {
    console.log('Backup skipped: no config.backup.dir configured.');
    return;
  }
  console.log(
    `Backup complete: ${result.destDir} (${result.copied} copied, ${result.skipped} skipped, ${result.errors.length} error(s), ${result.bytes} bytes, ${result.pruned} dir(s) pruned)`
  );
  if (result.errors.length > 0) {
    console.log(
      'Backup PARTIAL: the failing source(s) above were NOT copied; everything else was. Fix the source and rerun.'
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
