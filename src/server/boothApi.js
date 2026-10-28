// Booth / Dnevnik -- the public diary of the DJ's spoken words (SUB/WAVE's
// "Booth" feature, the last undelivered P2 listener item from
// docs/subwave-deep-analysis.md section 7). SUB/WAVE pitches it as "the log
// of every word the DJ said": to the listener it gives a sense of liveness,
// to the owner it gives reviewability. radioclyde already HAS the data --
// every produced occurrence carries a script.md whose dj segments are the
// literal words the TTS reads on air -- it just never showed them to anyone.
//
// Model (deterministic, no new dependencies):
//   - WORDS come from the occurrence's script.md, parsed by the SAME
//     parseScript the director consumes (src/director/scriptLoader.js) --
//     one grammar, one parser, one source of truth. dj segments contribute
//     { persona, text }; live segments contribute { persona, kind } markers
//     (their words are synthesized at airtime from live data -- weather,
//     clock, next show -- and are not persisted as text, so the diary marks
//     them honestly instead of inventing them); track segments are music,
//     not speech, and are simply not diary entries.
//   - AIRED-GATE: an occurrence counts as having aired only if aired.jsonl
//     carries at least one entry with that showId whose playedAt falls
//     within the occurrence's scheduled window (start .. start + directed
//     duration + 30 min grace -- filler that scrobbleTrack still attributes
//     to the just-ended show lands inside the grace). A show that was
//     produced but skipped/terminated therefore never enters the diary:
//     the diary answers "what was SAID on air", not "what was written".
//   - The CURRENTLY-LOADED occurrence (now_playing_state.json, the
//     scheduler's own state) is included without the aired gate -- it is
//     what the station itself says is on air -- and flagged current:true.
//
// Honest limits, documented here and shown in the UI:
//   - The text is PRODUCTION-time (same lifetime as all preproduction:
//     prewarmed speech, greetings chosen before a block boundary). A
//     terminated show's tail may have been scripted but never aired; a
//     replay re-airs the recorded words verbatim, and the entry is stamped
//     replay:true from context.json's replayOf (Val 22's stamp).
//   - Personas are reported as keys (config.personas has no display names);
//     the UI capitalizes them, the same treatment nowPlaying.js gives the
//     on-air dj field.
//   - Everything is tolerant: a missing runningDir, an unreadable
//     occurrence, a torn script.md -- each costs exactly that entry (the
//     same per-line discipline as historyApi.readAiredEntries), counted in
//     the `skipped` summary instead of hidden.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { parseScript } from '../script/format.js';
import { readAiredEntries } from './historyApi.js';
import { readNowPlayingState } from '../scheduler/updateNowPlaying.js';

const DEFAULT_SHOWS = 3;
const MAX_SHOWS = 10;
// Filler tracks that start right after a show ends still carry the ended
// show's id (scrobbleTrack reads the state before the scheduler swaps it),
// and the first track can air a little before the nominal start while the
// jingle plays out -- the gate window is generous on purpose: its job is
// "did this show air at all", not exact boundaries.
const GATE_START_TOLERANCE_MS = 60 * 1000;
const GATE_END_GRACE_MS = 30 * 60 * 1000;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;

// '2026-10-19' + '08-00' -> the local ms instant of the scheduled start
// (the occurrence path components ARE the station's local wall clock).
// Anything unparsable -> null (the enumeration drops it, counted as
// invalid).
function occurrenceStartMs(date, timeKey) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}-\d{2}$/.test(timeKey ?? '')) return null;
  const ms = Date.parse(`${date}T${timeKey.slice(0, 2)}:${timeKey.slice(3)}:00`);
  return Number.isFinite(ms) ? ms : null;
}

// context.json, read the same tolerant way updateNowPlaying.loadOccurrence
// reads it: a corrupt file means "not safely loadable", never a crash.
function readOccurrenceMeta(occDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(occDir, 'context.json'), 'utf8'));
    const d = Number(parsed?.durationSeconds);
    return {
      durationMs: Number.isFinite(d) && d > 0 ? d * 1000 : null,
      replayOf: typeof parsed?.replayOf === 'string' && parsed.replayOf ? parsed.replayOf : null,
    };
  } catch {
    return { durationMs: null, replayOf: null };
  }
}

// The spoken half of one script.md through the director's own parser. No
// personas/knownRatingKeys options: this is display, not validation -- an
// unknown persona or a stale ratingKey is shown as-is, and parseScript
// collects issues without ever throwing. Returns { title, segments } with
// dj/live segments only, or null when the file yields no speech at all
// (missing, empty, or a track-only script).
function spokenSegments(scriptMd) {
  let parsed;
  try {
    parsed = parseScript(String(scriptMd));
  } catch {
    return null;
  }
  const segments = [];
  for (const seg of parsed?.segments ?? []) {
    if (seg.type === 'dj' && seg.persona && seg.body) {
      segments.push({ type: 'dj', persona: String(seg.persona), text: String(seg.body) });
    } else if (seg.type === 'live' && seg.persona) {
      segments.push({ type: 'live', persona: String(seg.persona), kind: seg.kind ?? null });
    }
  }
  if (segments.length === 0) return null;
  return { title: parsed?.title ?? null, segments };
}

// Walk runningDir/<weekday>/<showId>/<date>/<timeKey> -- every level is
// tolerant (a missing or unreadable directory ends that branch), because
// cleanupOldShows rewrites these trees while the station runs.
function listOccurrenceDirs() {
  const out = [];
  let weekdays;
  try {
    weekdays = fs.readdirSync(config.paths.runningDir, { withFileTypes: true });
  } catch {
    return out; // no shows produced yet (fresh install) -- honest empty
  }
  for (const wd of weekdays) {
    if (!wd.isDirectory()) continue;
    let showIds;
    try {
      showIds = fs.readdirSync(path.join(config.paths.runningDir, wd.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sd of showIds) {
      if (!sd.isDirectory()) continue;
      let dates;
      try {
        dates = fs.readdirSync(path.join(config.paths.runningDir, wd.name, sd.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dd of dates) {
        if (!dd.isDirectory()) continue;
        let times;
        try {
          times = fs.readdirSync(path.join(config.paths.runningDir, wd.name, sd.name, dd.name), { withFileTypes: true });
        } catch {
          continue;
        }
        for (const td of times) {
          if (!td.isDirectory()) continue;
          out.push({
            weekday: wd.name,
            showId: sd.name,
            date: dd.name,
            timeKey: td.name,
            dir: path.join(config.paths.runningDir, wd.name, sd.name, dd.name, td.name),
          });
        }
      }
    }
  }
  return out;
}

// The aired gate: does the ledger prove this occurrence went out? One entry
// with the showId inside the window is enough (the diary's bar is "aired",
// not "aired in full").
function occurrenceAired(airedEntries, showId, startMs, endMs) {
  for (const e of airedEntries) {
    if (e.showId !== showId || !e.playedAt) continue;
    const t = Date.parse(e.playedAt);
    if (Number.isFinite(t) && t >= startMs - GATE_START_TOLERANCE_MS && t <= endMs + GATE_END_GRACE_MS) {
      return true;
    }
  }
  return false;
}

// The diary itself. `limit` clamps BOTH ways (historyApi's discipline: 0
// honestly means "no shows", a huge value means MAX_SHOWS -- never the whole
// disk). Returns { shows, skipped } and never throws.
export function getBoothDiary({ limit, nowMs = Date.now() } = {}) {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(0, Math.min(Math.trunc(limit), MAX_SHOWS))
    : DEFAULT_SHOWS;
  const skipped = { noScript: 0, unparseable: 0, notAired: 0 };

  if (safeLimit === 0) return { shows: [], skipped };

  const aired = readAiredEntries();
  const state = readNowPlayingState();
  const currentKey =
    state && typeof state === 'object' && state.id && state.date && state.timeKey
      ? `${state.id}|${state.date}|${state.timeKey}`
      : null;

  const candidates = [];
  for (const occ of listOccurrenceDirs()) {
    const startMs = occurrenceStartMs(occ.date, occ.timeKey);
    if (startMs === null) continue; // path with a non-date component -- not an occurrence
    const isCurrent = currentKey === `${occ.showId}|${occ.date}|${occ.timeKey}`;
    if (!isCurrent && startMs > nowMs) continue; // a future occurrence: produced, not yet aired
    const meta = readOccurrenceMeta(occ.dir);
    if (isCurrent) {
      candidates.push({ ...occ, startMs, current: true, meta });
      continue;
    }
    // Past occurrence: the ledger must prove it aired.
    const endMs = startMs + (meta.durationMs ?? DEFAULT_DURATION_MS);
    if (!occurrenceAired(aired, occ.showId, startMs, endMs)) {
      skipped.notAired += 1;
      continue;
    }
    candidates.push({ ...occ, startMs, current: false, meta });
  }
  // Newest first; a same-start tie (two shows, same date+time across
  // weekdays) breaks deterministically on the path.
  candidates.sort((a, b) => b.startMs - a.startMs || a.dir.localeCompare(b.dir));

  const shows = [];
  for (const occ of candidates) {
    if (shows.length >= safeLimit) break;
    let scriptMd;
    try {
      scriptMd = fs.readFileSync(path.join(occ.dir, 'script.md'), 'utf8');
    } catch {
      // Directed occurrences always have a script.md (the script stage
      // precedes the director), so this is an odd tree -- count it, move on.
      skipped.noScript += 1;
      continue;
    }
    const spoken = spokenSegments(scriptMd);
    if (!spoken) {
      skipped.unparseable += 1;
      continue;
    }
    shows.push({
      current: occ.current,
      showId: occ.showId,
      showTitle: spoken.title ?? occ.showId,
      date: occ.date,
      timeKey: occ.timeKey,
      replay: occ.meta.replayOf ? true : false,
      segments: spoken.segments,
    });
  }
  return { shows, skipped };
}

// Route registration, topListenedApi's shape. Read-only GET; a station that
// runs public mode lists /api/booth in config.web.publicPaths exactly like
// /api/history (the auth hook's method gate keeps it GET/HEAD-only there).
export function registerBoothRoutes(fastify) {
  fastify.get('/api/booth', (request) => {
    const limit = parseInt(request.query?.limit, 10);
    return getBoothDiary({ limit: Number.isFinite(limit) ? limit : undefined });
  });
}
