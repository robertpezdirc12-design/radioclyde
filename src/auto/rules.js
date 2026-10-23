// The deterministic selection rules that sit ON TOP of buildTrackQueue's
// existing behavior (dedupe, station-wide never-play, recently-played
// exclusion, duration fitting). Everything here is plain data + plain
// functions -- no model anywhere:
//
//   - Artist cooldown: the same artist may not appear again within N hours,
//     even though the individual TRACKS are all different (station-wide
//     track history already handles the "same song tomorrow" case; this
//     handles "this artist was on air an hour ago"). Implemented as an
//     excludeArtists set threaded into buildTrackQueue's eligible filter.
//   - Time-of-day blocks: maps the clock to a named block (morning /
//     daytime / evening / night) from config. The block picks which template
//     variants the DJ speaks (auto/templates.js) and, optionally, a soft
//     genre preference applied as a pool filter.
//   - Popularity mix: enforced as an exact popular-share walk inside
//     buildTrackQueue (see queue.js's popularShare param) -- e.g. 0.7 keeps
//     roughly 70% of slots drawn from the library's better-known half.
//   - Decade spread: round-robins the ordered candidate list across decades
//     so a genre pool spanning several decades contributes them in
//     alternation instead of weighted-shuffle clumps.
//
// All knobs live in config.autoRadio.rules with working defaults, so an
// autoRadio config that only sets templates still behaves sensibly.
import fs from 'node:fs';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// artist cooldown
// ---------------------------------------------------------------------------

// Reads the station-wide played history (the same played.jsonl the producer
// records into and recentlyPlayedRatingKeys reads) and returns the set of
// artist names (lowercased) played within the cooldown window. Kept as a
// plain read here rather than added to producer/history.js so the auto radio
// stays a self-contained layer over the existing history format.
export function recentArtistNames(cooldownHours) {
  if (!cooldownHours || cooldownHours <= 0) return new Set();
  const historyFile = config.paths.historyFile;
  if (!fs.existsSync(historyFile)) return new Set();
  const cutoff = Date.now() - cooldownHours * HOUR_MS;
  const names = new Set();
  for (const line of fs.readFileSync(historyFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.artist && new Date(entry.playedAt).getTime() >= cutoff) {
        names.add(String(entry.artist).toLowerCase());
      }
    } catch {
      // a torn final line (crash mid-append) must not kill selection
    }
  }
  return names;
}

export function artistCooldownHours() {
  return config.autoRadio?.rules?.artistCooldownHours ?? 3;
}

// Returns { excludeArtists, excludedCount } -- the caller passes
// excludeArtists into buildTrackQueue and logs excludedCount for
// transparency. Excluding by artist can starve a single-artist show's pool
// entirely; buildTrackQueue falls back to the un-cooled pool when the
// filtered one comes up empty, so this stays safe for every show shape.
export function artistCooldownFilter() {
  const hours = artistCooldownHours();
  const excludeArtists = recentArtistNames(hours);
  return { excludeArtists, cooldownHours: hours };
}

// ---------------------------------------------------------------------------
// time-of-day blocks
// ---------------------------------------------------------------------------

const DEFAULT_TIME_BLOCKS = {
  morning: { start: '05:00', end: '10:00' },
  daytime: { start: '10:00', end: '17:00' },
  evening: { start: '17:00', end: '23:00' },
  night: { start: '23:00', end: '05:00' },
};

function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return h * 60 + (m || 0);
}

export function timeBlocks() {
  return config.autoRadio?.rules?.timeOfDayBlocks ?? DEFAULT_TIME_BLOCKS;
}

// Maps a Date (defaults to now) to the name of the block containing it.
// Overnight blocks (start > end, e.g. night 23:00-05:00) wrap correctly.
export function timeBlockKey(now = new Date(), blocks = timeBlocks()) {
  const minutes = now.getHours() * 60 + now.getMinutes();
  for (const [key, block] of Object.entries(blocks)) {
    const start = minutesOfDay(block.start);
    const end = minutesOfDay(block.end);
    if (start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end) {
      return key;
    }
  }
  return null;
}

// Optional soft genre preference for a block, e.g. night -> ["Instrumental"].
// "Soft" means: applied only as a candidate-pool narrowing that gives up
// immediately when it would leave too few tracks, never as a hard ban.
export function blockGenrePreference(blockKey) {
  const blocks = timeBlocks();
  return blocks[blockKey]?.preferredGenres ?? [];
}

// ---------------------------------------------------------------------------
// popularity mix
// ---------------------------------------------------------------------------

export function popularityShare() {
  const share = config.autoRadio?.rules?.popularityMix?.popularShare;
  if (share == null) return null;
  if (share <= 0 || share >= 1) return null; // 0/1 or nonsense = off; plain weighted behavior
  return share;
}
