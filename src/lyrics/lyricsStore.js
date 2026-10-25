// The persisted lyrics cache: one JSON file under dataDir
// (lyrics-cache.json), rewritten atomically via tmp+rename, exactly like
// pollsStore.js's single-store discipline. One entry per song+CUT:
//   "Ansambel — Tema (187s)" -> { artist, title, album, durationMs,
//       syncedLrc, plainText, instrumental, externalId, checkedAt }
// The song key alone would let two different cuts of the same title (radio
// edit vs album) poison each other's timings, so the rounded duration rides
// in the key; a play with no duration keys the bare song key and never
// blocks a later duration-bearing play of the same title.
//
// Read path fails OPEN -- a missing or corrupt cache means "everything is
// owed again", never a broken panel. checkedAt is epoch ms (Date.now()),
// NOT an ISO string: the service injects its clock, and comparisons stay
// integer math.
//
// Cache semantics (see lyricsService.js for who asks when):
//   - a stored answer -- found lyrics OR a definitive miss -- is rechecked
//     after RECHECK_AFTER_DAYS (30); a synced hit could improve to a better
//     cut, a miss to a found file, at a bounded cost of one request per song
//     per month (SUB/WAVE kept synced hits forever; we recheck everything on
//     purpose -- self-healing beats a few saved requests at this rate).
//   - a FAILED ask (LRCLIB unreachable) stores nothing: that song waits out
//     the service's in-memory 10-minute backoff instead.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';

export const RECHECK_AFTER_DAYS = 30;
export const RECHECK_AFTER_MS = RECHECK_AFTER_DAYS * 24 * 60 * 60 * 1000;

export function lyricsCachePath() {
  // Derived from dataDir here (not a config.paths entry) so this module owns
  // its own namespace without touching src/config/index.js's frozen surface.
  return path.join(config.dataDir, 'lyrics-cache.json');
}

function emptyCache() {
  return { version: 1, entries: {} };
}

// Fails open: any read problem = empty cache.
export function readLyricsCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(lyricsCachePath(), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || !parsed.entries) {
      return emptyCache();
    }
    return { version: 1, entries: parsed.entries };
  } catch {
    return emptyCache();
  }
}

export function writeLyricsCache(cache) {
  const file = lyricsCachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // pid-suffixed tmp (pollsStore.js's pattern): the web server and a detached
  // producer process could otherwise race two writers onto one tmp name and
  // the second rename would carry the first's half-written bytes.
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, file);
}

export function getCacheEntry(key) {
  return readLyricsCache().entries[key] ?? null;
}

// Read-modify-write with NO await inside: synchronous on the single JS
// thread, so two lookups landing in the same process can never interleave
// and lose an entry. (The whole-station cost is bounded by the LRCLIB
// throttle: at most ~1 write per second, ever.)
export function setCacheEntry(key, entry) {
  const cache = readLyricsCache();
  cache.entries[key] = entry;
  writeLyricsCache(cache);
}

/** A stored answer is final for RECHECK_AFTER_DAYS, then owed again. A
 *  missing/shapeless entry or a non-numeric checkedAt is owed immediately. */
export function needsRecheck(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return true;
  const checked = Number(entry.checkedAt);
  if (!Number.isFinite(checked)) return true;
  return now - checked >= RECHECK_AFTER_MS;
}
