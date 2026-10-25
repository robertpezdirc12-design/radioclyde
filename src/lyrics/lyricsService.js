// The "Besedila" backend: LRCLIB synced/plain lyrics for the track on air,
// served at GET /api/lyrics/current (src/server/api.js wires registerLyricsRoute
// in). Frozen response contract (the listener page's panel, public/app.js +
// /home/z/my-project/scratch/lyrics-smoke.cjs, is the authority):
//
//   { songId, synced, lines: [{ startMs, text }], source, pending,
//     offsetMs, stationOffsetMs }
//
//   songId          "Ansambel — Tema" -- the panel's own trackKey() like-key,
//                   so its songId-change detection keys tracks EXACTLY like
//                   we do; null = no music on air.
//   synced          true when at least one line carries a startMs.
//   lines           startMs null for untimed lines (never the current line);
//                   empty text = an instrumental rest, rendered as such.
//   source          'lrclib' when we have lines (cache or fresh -- the cache
//                   IS lrclib data, so naming it honestly), else null.
//   pending         true while we still OWE this song an answer: a lookup in
//                   flight, queued behind the LRCLIB throttle, or waiting out
//                   the failure backoff. The panel polls 4 s while pending and
//                   a late answer heals it. NEVER a definitive miss: an
//                   unreachable LRCLIB stays pending; only a stored 404/miss
//                   (or plain "no lyrics") flips pending to false.
//   offsetMs /      station-side timing correction, always 0 here (we know of
//   stationOffsetMs none; aliases, both sent, the panel reads one). The
//                   listener's own device offset is applied client-side.
//   503             { error: 'lyrics-disabled' } when config.lyrics.enabled
//                   === false -- TERMINAL, the panel stops polling.
//
// Lookup triggers: the route is the REQUIRED lazy trigger (on every hit,
// resolve the airing track, check cache freshness/backoff, and if an answer
// is owed, start the lookup and answer pending:true -- never waiting on it).
// ensureLyrics(entry) is the optional enqueue-time trigger for the
// orchestrator to wire (minutes before airtime); it lives on the default
// service so src/director / src/scheduler stay untouched by this module.
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { composeNowPlaying } from '../server/nowPlaying.js';
import { createLrclibClient } from './lrclib.js';
import { recordToLyrics } from './lrc.js';
import { getCacheEntry, needsRecheck, setCacheEntry } from './lyricsStore.js';

const log = createLogger('lyrics');

// A failed ask is not an answer: remember it in memory only (nothing
// persisted), so a song that repeats while LRCLIB is down does not hammer it.
// Bounded like SUB/WAVE's BoundedKeyMap -- oldest key evicted on overflow.
const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
const MAX_TRACKED_FAILURES = 500;

function createBoundedMap(maxKeys) {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set(key, value) {
      map.delete(key);
      map.set(key, value);
      if (map.size > maxKeys) map.delete(map.keys().next().value);
    },
    delete: (key) => map.delete(key),
  };
}

/** config.lyrics.enabled === false switches the feature off; a MISSING block
 *  means enabled (honest default -- the panel degrades to "no lyrics" on its
 *  own rather than hiding). Flip requires a restart, like every config block. */
export function lyricsEnabled(cfg = config) {
  return cfg.lyrics?.enabled !== false;
}

/** The stable per-track key: EXACTLY the listener page's own like-key
 *  (public/app.js trackKey(): trimmed "artist — title", em dash). */
export function songKey(artist, title) {
  return `${String(artist ?? '').trim()} — ${String(title ?? '').trim()}`;
}

/** Cache key: the song key plus the cut, so a different edit of the same
 *  title is a different entry (see lyricsStore.js). */
export function cacheKeyFor(artist, title, durationMs) {
  const durationSec = Math.round(Number(durationMs) / 1000);
  const key = songKey(artist, title);
  return durationSec > 0 ? `${key} (${durationSec}s)` : key;
}

function noMusicPayload() {
  return { songId: null, synced: false, lines: [], source: null, pending: false, offsetMs: 0, stationOffsetMs: 0 };
}

function pendingPayload(songId) {
  // Mirrors the frozen pending shape the panel was built against: empty
  // lines, no source -- the next poll (4 s) picks up the answer.
  return { songId, synced: false, lines: [], source: null, pending: true, offsetMs: 0, stationOffsetMs: 0 };
}

function storedLyrics(entry) {
  if (!entry) return null;
  return recordToLyrics({
    syncedLyrics: entry.syncedLrc,
    plainLyrics: entry.plainText,
    instrumental: entry.instrumental,
  });
}

export function createLyricsService({ client = createLrclibClient({}), now = Date.now, logger = log } = {}) {
  const inFlight = new Map(); // cacheKey -> the running lookup promise
  const failedAt = createBoundedMap(MAX_TRACKED_FAILURES);

  // Start (or join) the owed lookup for one cache key. Returns the running
  // promise, or null when none is owed / one is already running / the song is
  // backing off from a failure. Never rejects.
  function ensureLookup(key, track, entry, { pastBackoff = false } = {}) {
    if (!lyricsEnabled()) return null;
    const running = inFlight.get(key);
    if (running) return running;
    if (!needsRecheck(entry, now())) return null;
    const failed = failedAt.get(key);
    if (!pastBackoff && failed !== undefined && now() - failed < FAILURE_BACKOFF_MS) return null;

    const lookup = (async () => {
      try {
        const record = await client.find({
          artist: track.artist,
          title: track.title,
          album: track.album ?? null,
          durationSec: Number(track.durationMs) / 1000,
        });
        // A null record is LRCLIB's definitive "nothing for this cut" --
        // stored as a lyrics-less entry, rechecked after 30 days.
        setCacheEntry(key, {
          artist: String(track.artist ?? ''),
          title: String(track.title ?? ''),
          album: track.album ?? null,
          durationMs: Number.isFinite(Number(track.durationMs)) ? Number(track.durationMs) : null,
          syncedLrc: typeof record?.syncedLyrics === 'string' ? record.syncedLyrics : null,
          plainText: typeof record?.plainLyrics === 'string' ? record.plainLyrics : null,
          instrumental: record?.instrumental === true,
          externalId: record?.id != null ? String(record.id) : null,
          checkedAt: now(),
        });
        failedAt.delete(key);
      } catch (err) {
        // Transport / timeout / exhausted retries: "ask later". Nothing is
        // stored -- the song backs off in memory and stays pending.
        failedAt.set(key, now());
        logger(`LRCLIB lookup for "${key}" failed: ${err?.message ?? err}`);
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, lookup);
    return lookup;
  }

  return {
    /** The payload for the airing track (or null track = no music). Pure and
     *  synchronous from the caller's view: an owed lookup is STARTED as a
     *  side effect, never awaited -- the read path degrades immediately. */
    currentLyrics(track) {
      if (!track) return noMusicPayload();
      const artist = String(track.artist ?? '').trim();
      const title = String(track.title ?? '').trim();
      if (!artist || !title) return noMusicPayload(); // a track we cannot even key
      const key = cacheKeyFor(artist, title, track.durationMs);
      const entry = getCacheEntry(key);
      if (needsRecheck(entry, now())) {
        ensureLookup(key, { ...track, artist, title }, entry);
        // pending also covers "owed but backing off": the panel keeps its
        // slow poll alive and the ask fires the moment the backoff lapses.
        return pendingPayload(songKey(artist, title));
      }
      const lyrics = storedLyrics(entry);
      return {
        songId: songKey(artist, title),
        synced: lyrics?.synced === true,
        lines: lyrics?.lines ?? [],
        source: lyrics ? 'lrclib' : null,
        pending: false,
        offsetMs: 0,
        stationOffsetMs: 0,
      };
    },

    /** Enqueue-time trigger (optional, for the orchestrator to wire): look
     *  the entry up NOW if an answer is owed, minutes before it airs, so a
     *  refusal has time to clear before the on-air route asks again. Returns
     *  the running lookup or null; fire-and-forget safe. */
    ensureLyrics(track) {
      if (!track?.artist || !track?.title) return null;
      const artist = String(track.artist).trim();
      const title = String(track.title).trim();
      const key = cacheKeyFor(artist, title, track.durationMs);
      return ensureLookup(key, { ...track, artist, title }, getCacheEntry(key));
    },

    /** Test/ops seam: is an owed lookup currently running for this key? */
    lookupInFlight(artist, title, durationMs) {
      return inFlight.has(cacheKeyFor(artist, title, durationMs));
    },
  };
}

const defaultService = createLyricsService({});

function defaultResolveTrack() {
  // The music track on air right now (null when a DJ is speaking or nothing
  // has aired) -- the same source of truth /api/now-playing reads, so the
  // panel's two views of "what is on air" can never drift apart.
  try {
    return composeNowPlaying().track ?? null;
  } catch {
    return null;
  }
}

/** GET /api/lyrics/current -- see the contract comment at the top of this
 *  file. Injectable seams ({ service, resolveTrack }) keep the route tests
 *  off the network and off the real now-playing files. */
export function registerLyricsRoute(fastify, { service = defaultService, resolveTrack = defaultResolveTrack } = {}) {
  fastify.get('/api/lyrics/current', async (_request, reply) => {
    // Poll data: no intermediary may serve a cached copy of "what is on air
    // right now" (the service worker already bypasses /api/*; this is the
    // belt-and-braces half, same as SUB/WAVE's route).
    reply.header('Cache-Control', 'no-store');
    if (!lyricsEnabled()) {
      // 503 = terminally switched off; the panel stops polling on it.
      return reply.code(503).send({ error: 'lyrics-disabled' });
    }
    return service.currentLyrics(resolveTrack());
  });
}

/** The enqueue-time trigger on the shared service (see createLyricsService). */
export function ensureLyrics(track) {
  return defaultService.ensureLyrics(track);
}
