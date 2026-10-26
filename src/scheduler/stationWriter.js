// The write half of station.json -- scheduleUtil.js only ever reads it.
// Every write here is atomic (temp file + rename, so a reader never sees a
// half-written file) and serialized through lib/lock.js's withLock() (so two
// concurrent studio requests can't race each other into a corrupt file).
//
// Validates before writing: startTime format, durationMinutes > 0, the
// referenced show id actually exists under show-descriptions/. A day's
// occurrences are treated as a single ordered, gapless sequence. Dragging one
// directly onto another's slot swaps the two in place (see findSwapTarget) --
// everything else stays put. Anything else that would otherwise overlap
// (a resize, a reassignment, a drag into empty space) instead reorders and
// repacks the whole day around the change via reorderAndPack() below, rather
// than rejecting the write outright. Removing an occurrence closes up
// whatever gap it leaves.
//
// Writes always expand to plain per-weekday keys -- station.json's optional
// comma-joined shared-weekday-key compression (e.g.
// "monday,tuesday,wednesday": [...]) stays supported for hand-editing (see
// scheduleUtil.js's loadSchedule()) but a studio write never recreates it;
// once the studio edits a day that was part of a shared key, that day
// becomes its own independent entry going forward.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { withLock } from '../lib/lock.js';
// Pure formatter only -- the read half stays the read half (scheduleUtil
// imports nothing from this file, so no cycle).
import { dateKey } from './scheduleUtil.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const SOURCE_TIME_KEY_PATTERN = /^([01]\d|2[0-3])-[0-5]\d$/;
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_MINUTES = 24 * 60;

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function readStationFile() {
  return JSON.parse(fs.readFileSync(config.paths.stationFile, 'utf8'));
}

function atomicWrite(data) {
  const tmpPath = `${config.paths.stationFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, config.paths.stationFile);
}

// Expands any comma-joined weekday keys in the raw schedule object into
// plain per-weekday keys, same expansion loadSchedule() does for readers --
// needed here too since a write must know which day it's actually editing.
// Paket C1 (Val 22): the literal "dates" key passes through VERBATIM (its
// value is the override object, not a lineup) -- a weekday write must never
// wipe date overrides; removeShowOccurrences() is the one place that walks
// into it, and it does so explicitly.
function expandSchedule(rawSchedule) {
  const expanded = {};
  for (const [key, shows] of Object.entries(rawSchedule ?? {})) {
    for (const day of key.split(',').map((d) => d.trim())) {
      expanded[day] = shows;
    }
  }
  return expanded;
}

function assertValidWeekday(weekday) {
  if (!WEEKDAYS.includes(weekday)) {
    throw new Error(`Invalid weekday "${weekday}" -- must be one of: ${WEEKDAYS.join(', ')}`);
  }
}

// Paket C1 (Val 22) -- a date override key must be a real calendar date, not
// just regex-shaped: "2026-13-45" passes ^\d{4}-\d{2}-\d{2}$ but
// new Date(2026, 12, 45) rolls over into the next year/month -- the
// round-trip check catches what the regex can't (same conservatism class as
// scheduler.js's station-theme date guard). Past and far-future dates are
// both allowed: walkers cap at 14 days anyway, and a distant key is inert
// until its date enters the horizon.
function assertValidDateKey(date) {
  if (typeof date !== 'string' || !DATE_KEY_PATTERN.test(date)) {
    throw new Error(`Invalid date "${date}" -- expected YYYY-MM-DD.`);
  }
  const [y, m, d] = date.split('-').map(Number);
  const roundTrip = new Date(y, m - 1, d);
  if (roundTrip.getFullYear() !== y || roundTrip.getMonth() !== m - 1 || roundTrip.getDate() !== d) {
    throw new Error(`Invalid date "${date}" -- not a real calendar date.`);
  }
}

// Paket C2 (Val 22) -- replay fields only ever persist on entries that ARE
// replays: anything else ("type": "normal"/null from a clearing patch, a
// patch that dropped the type, an orphaned sourceDate) is normalized away
// here so a normal entry can't carry stale replay metadata into future
// writes.
function normalizeReplayFields(entry) {
  if (entry.type === 'replay') return entry;
  const { type, sourceDate, sourceTimeKey, ...rest } = entry;
  return rest;
}

function assertValidOccurrence(occurrence) {
  if (!TIME_PATTERN.test(occurrence.startTime)) {
    throw new Error(`Invalid startTime "${occurrence.startTime}" -- expected HH:MM (24-hour).`);
  }
  if (!Number.isFinite(occurrence.durationMinutes) || occurrence.durationMinutes <= 0) {
    throw new Error(`Invalid durationMinutes "${occurrence.durationMinutes}" -- must be a positive number.`);
  }
  if (!occurrence.id || typeof occurrence.id !== 'string') {
    throw new Error('Occurrence must have a string "id".');
  }
  const briefPath = path.join(config.paths.showDescriptionsDir, `${occurrence.id}.md`);
  if (!fs.existsSync(briefPath)) {
    throw new Error(`No show "${occurrence.id}" found under show-descriptions/ -- create the show first.`);
  }
  // Paket C2 (Val 22) -- the replay occurrence type. "normal"/null/omitted
  // are all a plain show (normalizeReplayFields() strips them before
  // storage); anything else is rejected so a typo can't silently downgrade a
  // replay into a fresh-production slot. Source-audio existence is
  // deliberately NOT validated here: a replay may legitimately be scheduled
  // before its source airs (an evening replay of the morning episode) -- the
  // source only needs to exist at materialization time, where a missing
  // episode degrades honestly (materializer no-ops, filler covers the slot)
  // instead of being rejected at write time.
  const type = occurrence.type ?? undefined; // null == unset (JSON clients)
  if (type !== undefined && type !== 'normal' && type !== 'replay') {
    throw new Error(`Invalid occurrence type "${occurrence.type}" -- only "replay" is supported (omit "type", or "normal", for a fresh show).`);
  }
  if (type === 'replay') {
    if (typeof occurrence.sourceDate !== 'string' || !DATE_KEY_PATTERN.test(occurrence.sourceDate)) {
      throw new Error('A replay occurrence requires "sourceDate" (YYYY-MM-DD -- the date the source episode aired).');
    }
    assertValidDateKey(occurrence.sourceDate);
    // Not in the future (YYYY-MM-DD string compare == calendar compare,
    // dateKey() is local-calendar): a same-day source is fine (evening
    // replay of the morning episode), a tomorrow source is a lie.
    if (occurrence.sourceDate > dateKey(new Date())) {
      throw new Error(`Replay sourceDate "${occurrence.sourceDate}" is in the future -- the source episode hasn't aired yet.`);
    }
    if (occurrence.sourceTimeKey !== undefined && occurrence.sourceTimeKey !== null) {
      if (typeof occurrence.sourceTimeKey !== 'string' || !SOURCE_TIME_KEY_PATTERN.test(occurrence.sourceTimeKey)) {
        throw new Error(`Invalid sourceTimeKey "${occurrence.sourceTimeKey}" -- expected HH-MM (e.g. "10-30").`);
      }
    }
  }
}

// Inserts `moving` among `others` at the position its startTime sorts to
// (this is just "where in the sequence did it get dropped" -- ties are
// broken by putting `moving` after an equal-time neighbor), then repacks
// the whole resulting list back-to-back with zero gaps. The anchor (the
// first item's actual start time) is whichever is earlier: the drop target,
// or the earliest of the other occurrences -- so reordering within the
// existing broadcast window never drifts the day's start, but dropping
// something genuinely earlier than everything else legitimately extends it.
function reorderAndPack(others, moving) {
  const targetMinutes = timeToMinutes(moving.startTime);
  const sortedOthers = [...others].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
  let insertAt = sortedOthers.findIndex((o) => timeToMinutes(o.startTime) > targetMinutes);
  if (insertAt === -1) insertAt = sortedOthers.length;
  const ordered = [...sortedOthers.slice(0, insertAt), moving, ...sortedOthers.slice(insertAt)];

  const otherStarts = sortedOthers.map((o) => timeToMinutes(o.startTime));
  const anchor = Math.min(targetMinutes, ...(otherStarts.length ? otherStarts : [targetMinutes]));

  let cursor = anchor;
  return ordered.map((occ) => {
    if (cursor + occ.durationMinutes > DAY_MINUTES) {
      throw new Error(`No room left in the day for "${occ.id}" -- shorten something earlier in the lineup first.`);
    }
    const placed = { ...occ, startTime: minutesToTime(cursor) };
    cursor += occ.durationMinutes;
    return placed;
  });
}

// If `moving`'s new startTime lands inside an existing occurrence's slot,
// the two swap places (each keeps its own duration) and nothing else in the
// day changes. Returns null if there's no overlap -- the caller falls back
// to reorderAndPack for a move into genuinely empty space.
function findSwapTarget(day, movingIdx, moving) {
  const targetStart = timeToMinutes(moving.startTime);
  const targetEnd = targetStart + moving.durationMinutes;
  return day.find((o, i) => {
    if (i === movingIdx) return false;
    const start = timeToMinutes(o.startTime);
    return start < targetEnd && targetStart < start + o.durationMinutes;
  });
}

// Repacks an already-ordered list back-to-back with zero gaps, starting
// from its own first item's start time -- used after a removal, so
// whatever gap the removed occurrence leaves behind closes up too.
function closeGaps(orderedOccurrences) {
  if (orderedOccurrences.length === 0) return orderedOccurrences;
  let cursor = timeToMinutes(orderedOccurrences[0].startTime);
  return orderedOccurrences.map((occ) => {
    const placed = { ...occ, startTime: minutesToTime(cursor) };
    cursor += occ.durationMinutes;
    return placed;
  });
}

async function withStation(mutate) {
  return withLock(config.paths.stationLockPath, async () => {
    const data = readStationFile();
    data.schedule = expandSchedule(data.schedule);
    const result = mutate(data);
    atomicWrite(data);
    return result;
  });
}

// Returns the whole day's occurrences post-repack (not just the one added)
// so the caller can see exactly what else moved to make room.
export async function addOccurrence(weekday, occurrence) {
  assertValidWeekday(weekday);
  // Validate the RAW entry first (an invalid "type" must be REJECTED, not
  // silently normalized away), then strip "normal"/null replay fields.
  assertValidOccurrence(occurrence);
  const normalized = normalizeReplayFields(occurrence);
  return withStation((data) => {
    const day = data.schedule[weekday] ?? [];
    const placed = reorderAndPack(day, normalized);
    data.schedule[weekday] = placed;
    return placed;
  });
}

// timeKey identifies the existing occurrence being changed (its current
// startTime with ":" replaced by "-", matching scheduleUtil.js's timeKey()).
// patch may change startTime/durationMinutes/id. Returns the whole day's
// occurrences post-repack (or post-swap), same reasoning as addOccurrence.
//
// A plain drag (startTime changes, nothing else) that lands on top of
// another occurrence swaps the two in place -- everything else in the day
// stays exactly where it is, which is what dragging one show directly onto
// another's slot in the studio grid is expected to do. A resize, a show
// reassignment, or a drag into genuinely empty space instead reorders and
// repacks the whole day around the change (see reorderAndPack).
export async function updateOccurrence(weekday, timeKey, patch) {
  assertValidWeekday(weekday);
  return withStation((data) => {
    const day = data.schedule[weekday] ?? [];
    const idx = day.findIndex((s) => s.startTime.replace(':', '-') === timeKey);
    if (idx === -1) throw new Error(`No occurrence at ${weekday} ${timeKey} to update.`);
    const updated = { ...day[idx], ...patch };
    // Paket C2 (Val 22): show reassignment -- a replay's sourceDate points
    // at the OLD show's episode; carrying it over to a new id would
    // silently replay the wrong show's material. Strip on any id change.
    if (patch.id !== undefined && patch.id !== day[idx].id) {
      delete updated.type;
      delete updated.sourceDate;
      delete updated.sourceTimeKey;
    }
    // Paket C2: a patch may explicitly clear the replay ("type": "normal"
    // or null) -- validate the merged RAW shape first (a bad type value is
    // rejected, never silently normalized), then normalizeReplayFields
    // keeps the stored entry clean (replay fields persist only on actual
    // replays).
    assertValidOccurrence(updated);
    const final = normalizeReplayFields(updated);

    const isPlainMove = patch.startTime !== undefined && patch.durationMinutes === undefined && patch.id === undefined;
    const swapTarget = isPlainMove ? findSwapTarget(day, idx, final) : null;
    if (swapTarget) {
      const swapIdx = day.indexOf(swapTarget);
      const placed = [...day];
      placed[idx] = { ...day[idx], startTime: swapTarget.startTime };
      placed[swapIdx] = { ...swapTarget, startTime: day[idx].startTime };
      placed.sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
      data.schedule[weekday] = placed;
      return placed;
    }

    const rest = day.filter((_, i) => i !== idx);
    const placed = reorderAndPack(rest, final);
    data.schedule[weekday] = placed;
    return placed;
  });
}

export async function removeOccurrence(weekday, timeKey) {
  assertValidWeekday(weekday);
  return withStation((data) => {
    const day = data.schedule[weekday] ?? [];
    const idx = day.findIndex((s) => s.startTime.replace(':', '-') === timeKey);
    if (idx === -1) throw new Error(`No occurrence at ${weekday} ${timeKey} to remove.`);
    const [removed] = day.splice(idx, 1);
    data.schedule[weekday] = closeGaps(day);
    return removed;
  });
}

// Drops every occurrence of `id` from every weekday and closes the gaps
// those slots leave behind. Used by studio show-delete so a deleted brief
// can't leave orphaned schedule entries. Skips the write entirely when the
// show isn't on the lineup (no reason to expand shared weekday keys or
// trip scheduleWatch for a no-op).
export async function removeShowOccurrences(id) {
  return withLock(config.paths.stationLockPath, async () => {
    const data = readStationFile();
    data.schedule = expandSchedule(data.schedule);
    const removed = [];
    for (const [weekday, day] of Object.entries(data.schedule ?? {})) {
      // Paket C1 (Val 22): "dates" is the override block (an object keyed by
      // YYYY-MM-DD), not a weekday lineup -- day.filter would TypeError on
      // it. Swept separately right below.
      if (weekday === 'dates') continue;
      const kept = day.filter((occ) => {
        if (occ.id === id) {
          removed.push({ weekday, startTime: occ.startTime });
          return false;
        }
        return true;
      });
      if (kept.length !== day.length) {
        data.schedule[weekday] = closeGaps(kept);
      }
    }
    // Paket C1 (Val 22): date overrides can reference the show too -- a
    // deleted brief must not leave orphaned override entries (the same
    // guarantee the weekday sweep above gives). Emptied date keys are
    // dropped; the whole dates block goes away with the last key. Entries
    // removed from overrides report as { date, startTime } -- additive to
    // the { weekday, startTime } shape weekday removals have always
    // returned, and the only consumer (showBriefWriter.deleteShowBrief)
    // just passes the array through.
    const dates = data.schedule.dates;
    if (dates && typeof dates === 'object' && !Array.isArray(dates)) {
      for (const [date, day] of Object.entries(dates)) {
        if (!Array.isArray(day)) continue; // fail-open: hand-edited garbage is not ours to fix here
        const kept = day.filter((occ) => {
          if (occ.id === id) {
            removed.push({ date, startTime: occ.startTime });
            return false;
          }
          return true;
        });
        if (kept.length !== day.length) {
          if (kept.length === 0) delete dates[date];
          else dates[date] = closeGaps(kept);
        }
      }
      if (Object.keys(dates).length === 0) delete data.schedule.dates;
    }
    if (removed.length > 0) atomicWrite(data);
    return removed;
  });
}

export async function replaceDaySchedule(weekday, occurrences) {
  assertValidWeekday(weekday);
  // RAW validation first (bad "type" rejected), then normalization
  // ("normal"/null stripped) -- same order discipline as addOccurrence.
  for (const occurrence of occurrences) assertValidOccurrence(occurrence);
  const normalized = occurrences.map(normalizeReplayFields);
  return withStation((data) => {
    const sorted = [...normalized].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    const placed = closeGaps(sorted);
    data.schedule[weekday] = placed;
    return placed;
  });
}

// Paket C1 (Val 22) -- replace a whole calendar DATE's lineup (holiday /
// one-off event override): schedule.dates[date] fully replaces that date's
// weekly template ("that date skips recurrence"), never merges with it.
// Same ordering discipline as replaceDaySchedule: sorted, then packed
// back-to-back with closeGaps. An EMPTY occurrences array is a deliberate
// dark day -- stored as [] so the override suppresses the template and
// filler/emergency cover the date honestly.
export async function replaceDateSchedule(date, occurrences) {
  assertValidDateKey(date);
  if (!Array.isArray(occurrences)) {
    throw new Error('"occurrences" must be an array (an empty one means a deliberate dark day).');
  }
  // RAW validation first (bad "type" rejected), then normalization
  // ("normal"/null stripped) -- same order discipline as addOccurrence.
  for (const occurrence of occurrences) assertValidOccurrence(occurrence);
  const normalized = occurrences.map(normalizeReplayFields);
  return withStation((data) => {
    const sorted = [...normalized].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    const placed = closeGaps(sorted);
    data.schedule.dates = { ...(data.schedule.dates ?? {}) };
    data.schedule.dates[date] = placed;
    return placed;
  });
}

// Paket C1 (Val 22) -- removes a date override entirely: that date falls
// back to its weekday's weekly template again. Removing the LAST override
// key removes the whole schedule.dates block (station.json stays tidy).
// Throws when there is nothing at that date -- a silent no-op here would
// read as "removed" in the studio UI while the file never changed.
export async function removeDateSchedule(date) {
  assertValidDateKey(date);
  return withStation((data) => {
    const dates = data.schedule.dates;
    if (!dates || typeof dates !== 'object' || Array.isArray(dates) || !(date in dates)) {
      throw new Error(`No date override for "${date}" to remove.`);
    }
    const removed = dates[date];
    delete dates[date];
    if (Object.keys(dates).length === 0) delete data.schedule.dates;
    return removed;
  });
}

// patch may include name/downtime/neverPlay/filler.excludeKeywords under "station".
export async function updateStationMeta(patch) {
  return withStation((data) => {
    data.station = { ...data.station, ...patch.station };
    if (patch.station?.neverPlay) {
      const keywords = [...(patch.station.neverPlay.keywords ?? [])];
      const artists = [...(patch.station.neverPlay.artists ?? [])];
      data.station.neverPlay = { keywords, artists };
      data.station.filler = { ...(data.station.filler ?? {}), excludeKeywords: keywords };
    }
    if (patch.downtime !== undefined) data.downtime = patch.downtime;
    return { station: data.station, downtime: data.downtime };
  });
}
