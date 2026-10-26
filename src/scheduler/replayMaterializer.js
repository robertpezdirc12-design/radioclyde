#!/usr/bin/env node
// Replay occurrence materializer (Paket C2, docs/programming-research.md §5,
// row C2): a day-list entry (weekday template OR date override) carrying
// { type: "replay", sourceDate: "YYYY-MM-DD", sourceTimeKey?: "HH-MM" }
// occupies a REAL slot in the lineup, but at direct-lead time the station
// plays the EXISTING episode -- LibreTime's rebroadcast/"Linked". Nothing is
// ever re-produced: this job COPIES the source occurrence's playlist.m3u +
// context.json into the replay slot's own occurrence dir, and everything
// downstream (updateNowPlaying.loadOccurrence, confirmOccurrenceStart,
// scrobbleTrack) then reads the replay slot exactly like any directed
// occurrence -- no other consumer needed to learn that replays exist.
//
// WHY COPY, NOT SYMLINK: cleanupOldShows.js deletes source DATE dirs after
// cleanup.retentionDays (default 7) -- a symlinked playlist would die with
// the source dir while the replay slot still pointed at it. A copied
// playlist.m3u is kilobytes and survives the sweep.
//
// WHY COPY-NOT-RESOLVE: scrobbleTrack.js decides show-vs-filler by reading
// occurrenceDir(state...)/playlist.m3u (src/plex/scrobbleTrack.js:160-167) --
// a live-resolve variant (redirecting the replay at the SOURCE dir at load
// time) would miss that lookup, dump the replay's tracks into the filler
// rotation ledger, starve the filler pool, and lose the aired history's show
// attribution. A copy keeps every existing reader working unchanged.
//
// WHY NEVER FALL BACK TO PRODUCING A FRESH EPISODE: "drop the occurrence,
// not the broadcast" -- a fallback would run the producer chain
// (generateScript -> recordPlayed), double-burning the show's repeat windows
// and wiping its first-air statistics. A missing source episode is an honest
// no-op here (return false, one log line): filler covers the slot exactly
// like any not-yet-directed occurrence, because updateNowPlaying treats a
// missing playlist as not-directed and leaves the current show playing.
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../lib/logger.js';
import {
  loadSchedule,
  loadDateOverrides,
  effectiveDayLineup,
  weekdayKey,
  dateFromKey,
  timeKey as timeKeyOf,
  timeToMinutes,
  occurrenceDir,
} from './scheduleUtil.js';

const log = createLogger('station');

// station.json keys a replay's sourceDate must at least be SHAPED like (the
// full calendar-roundtrip check lives in stationWriter.assertValidDateKey;
// here it only has to be good enough that occurrenceDir() can't throw on it,
// because a hand-edited station.json is never validated at read time).
const SOURCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Atomic tmp+rename, the stationWriter.atomicWrite discipline -- but local:
// stationWriter's helper writes station.json specifically, and this job
// lands two files in an occurrence dir instead. A torn playlist.m3u would be
// read by whatever next resolves this occurrence, the same reason every
// watched/shared file in the station already gets tmp+rename.
function atomicWrite(targetPath, content) {
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, targetPath);
}

// The source episode's timeKey: an explicit sourceTimeKey wins; otherwise the
// FIRST occurrence of this show id on the source date's EFFECTIVE lineup
// (override > template), sorted by startTime. Effective-lineup resolution is
// the same single precedence rule every walker uses, so an override date's
// episode is found exactly the way a template one is.
function resolveSourceTimeKey(show, srcDate) {
  if (show.sourceTimeKey) return show.sourceTimeKey;
  const entries = effectiveDayLineup(loadSchedule(), loadDateOverrides(), srcDate)
    .filter((s) => s.id === show.id)
    .sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  if (entries.length === 0) return null;
  return timeKeyOf(entries[0].startTime);
}

// Materialize one replay occurrence. Returns true when the target occurrence
// dir holds a playlist.m3u afterwards (freshly copied, or already there --
// callers key off "airable", and checkAndTriggerDirect's own playlist.m3u
// existsSync is the repeat-tick guard), false on every honest no-op. Never
// throws for a bad or missing source: a hand-edited station.json replay that
// points at nothing must not take the scheduler tick down with it.
export function materializeReplayOccurrence(show, weekday, date, timeKey) {
  // Defensive guard (stationWriter validates all of this at WRITE time, but
  // a hand-edit bypasses it): a non-replay entry, a missing id, or a
  // sourceDate that isn't even YYYY-MM-DD-shaped is a caller/config bug --
  // honest no-op, never a throw.
  if (
    show?.type !== 'replay' ||
    typeof show.id !== 'string' ||
    typeof show.sourceDate !== 'string' ||
    !SOURCE_DATE_PATTERN.test(show.sourceDate)
  ) {
    log(`Replay skip: entry "${show?.id ?? '?'}" is not a valid replay (type "${show?.type}", sourceDate "${show?.sourceDate}") -- nothing materialized.`);
    return false;
  }

  const targetDir = occurrenceDir(weekday, show.id, date, timeKey);
  // Idempotency: playlist.m3u in the TARGET dir IS the materialized marker
  // (the same file every readiness check in the station keys off), so a
  // repeat tick or a rescue re-run over a finished slot is a free no-op.
  if (fs.existsSync(path.join(targetDir, 'playlist.m3u'))) {
    return true;
  }

  const srcDate = show.sourceDate;
  // The SOURCE occurrence's weekday comes from its sourceDate the same way
  // the walkers derive weekdays -- one parsing convention for YYYY-MM-DD
  // keys, not two (scheduleUtil.dateFromKey's own contract comment).
  const srcWeekday = weekdayKey(dateFromKey(srcDate));
  const sourceTimeKey = resolveSourceTimeKey(show, srcDate);
  if (!sourceTimeKey) {
    log(`Replay "${show.id}" (${weekday} ${date} ${timeKey}): no occurrence of "${show.id}" on source date ${srcDate}'s effective lineup -- honest no-op, filler covers the slot.`);
    return false;
  }

  // The isDirected contract (updateNowPlaying.js: isDirected/loadOccurrence):
  // a source needs BOTH playlist.m3u and context.json to be rebroadcastable.
  // Anything less is an honest no-op -- NEVER a fresh-production fallback
  // (double-burned repeat windows via recordPlayed, wiped first-air
  // statistics); filler covers the slot instead.
  const srcDir = occurrenceDir(srcWeekday, show.id, srcDate, sourceTimeKey);
  const srcPlaylistPath = path.join(srcDir, 'playlist.m3u');
  const srcContextPath = path.join(srcDir, 'context.json');
  if (!fs.existsSync(srcPlaylistPath) || !fs.existsSync(srcContextPath)) {
    log(`Replay "${show.id}" (${weekday} ${date} ${timeKey}): source episode ${srcDate} ${sourceTimeKey} is not directed (playlist.m3u/context.json missing) -- honest no-op, filler covers the slot.`);
    return false;
  }

  // Tolerant context parse, the loadOccurrence/confirmOccurrenceStart
  // doctrine: an unparseable source context means "not safely
  // rebroadcastable" -- the same false the missing-file checks above return,
  // not a throw.
  let sourceContext;
  try {
    sourceContext = JSON.parse(fs.readFileSync(srcContextPath, 'utf8'));
  } catch (err) {
    log(`Replay "${show.id}" (${weekday} ${date} ${timeKey}): source context.json unreadable (${err.message}) -- honest no-op, filler covers the slot.`);
    return false;
  }

  // Target context: the source's fields SPREAD (durationSeconds and every
  // other field must survive -- loadOccurrence reads durationSeconds,
  // confirmOccurrenceStart re-anchors from it) plus the replay stamp.
  // updateNowPlaying.loadOccurrence passes replayOf through into
  // now_playing_state.json, and scrobbleTrack.js stamps aired.jsonl entries
  // with replay:true from it -- that is how as-run/analytics tell a repeat
  // from a first air, with no second ledger to keep in sync.
  const targetContext = {
    ...sourceContext,
    replay: true,
    replayOf: { date: srcDate, timeKey: sourceTimeKey },
  };

  fs.mkdirSync(targetDir, { recursive: true });
  // context.json FIRST, playlist.m3u LAST: playlist.m3u is the "directed"
  // marker the whole station keys off (occurrenceReadiness, isDirected,
  // checkAndTriggerDirect's skip) -- landing it last mirrors the director's
  // own write order, so a torn materialization looks INCOMPLETE and the
  // startup rebuild sweep (findIncompleteOccurrences -> this function again)
  // heals it with another cheap copy instead of orphaning it.
  atomicWrite(path.join(targetDir, 'context.json'), JSON.stringify(targetContext));
  atomicWrite(path.join(targetDir, 'playlist.m3u'), fs.readFileSync(srcPlaylistPath, 'utf8'));

  log(`Replay "${show.id}" (${weekday} ${date} ${timeKey}): materialized from the ${srcDate} ${sourceTimeKey} episode (playlist.m3u + context.json copied, replayOf stamped).`);
  return true;
}

// Operator rescue entry point (the promoProducer.js CLI convention): points
// the materializer at ONE occurrence by its four coordinates and re-runs it.
// Resolves the entry from that date's effective lineup, so a typo'd show id
// or timeKey is an honest "nothing there" -- EXIT 0 with a log line -- while
// a wrong argument count is a usage error (non-zero).
function main() {
  const [weekday, showId, date, timeKeyArg] = process.argv.slice(2);
  if (!weekday || !showId || !date || !timeKeyArg) {
    console.error('Usage: node src/scheduler/replayMaterializer.js <weekday> <showId> <date> <timeKey>');
    console.error('  Materializes the replay occurrence airing on <date> at <timeKey> (HH-MM) from its sourceDate episode.');
    process.exitCode = 1;
    return;
  }

  const entry = effectiveDayLineup(loadSchedule(), loadDateOverrides(), date).find(
    (s) => s.id === showId && timeKeyOf(s.startTime) === timeKeyArg
  );
  if (!entry) {
    log(`Replay rescue: no occurrence of "${showId}" at ${date} ${timeKeyArg} on that date's effective lineup -- nothing to materialize.`);
    return;
  }
  if (entry.type !== 'replay') {
    log(`Replay rescue: the occurrence of "${showId}" at ${date} ${timeKeyArg} is not a replay (type "${entry.type ?? 'normal'}") -- nothing to materialize.`);
    return;
  }

  const ok = materializeReplayOccurrence(entry, weekday, date, timeKeyArg);
  log(
    ok
      ? `Replay rescue: "${showId}" (${weekday} ${date} ${timeKeyArg}) is materialized.`
      : `Replay rescue: "${showId}" (${weekday} ${date} ${timeKeyArg}) was NOT materialized (see the log line above for why).`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
