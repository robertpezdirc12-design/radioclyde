#!/usr/bin/env node
// Off-air filler: a big shuffled pool from the whole music library, so
// Liquidsoap's fallback() has something to play whenever no show is
// scheduled (or the scheduled show isn't ready yet) instead of the station
// going fully silent and Icecast clients disconnecting. Deliberately does
// NOT call recordPlayed() -- filler plays shouldn't shrink the recently-
// played pool that narrow curated shows (single-artist, etc.) draw from.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { fetchAllTracksAny } from '../auto/librarySource.js';
import { dedupeByTitle, isBannedTrack } from '../plex/trackFilters.js';
import { recentlyPlayedRatingKeys } from '../producer/history.js';
import { toLocalPath } from '../plex/musicLibrary.js';
import { mergeTrackRatingKeys } from '../plex/ratingKeyIndex.js';
import { shuffle } from '../lib/format.js';
import * as scheduleUtil from './scheduleUtil.js';
import { annotateTrackEntry } from '../director/playlist.js';
import { recentFillerPlays, rotationWindowHours, pruneLedger } from './fillerRotation.js';
import { clockwheelConfig, runClockwheel } from './clockwheel.js';
import { prefetchLyrics } from '../lyrics/lyricsService.js';
import {
  capPerArtist,
  capPerArtistAlbum,
  fillerRotationConfig,
  stationPlayCounts,
  weightedRotationOrder,
} from './rotationRules.js';

const log = createLogger('station');

// Resolves a track object to its playable local path for playlist entries --
// auto-radio's local library tracks carry localPath directly (there is no
// Plex path prefix to map), Plex tracks keep the config-mapped conversion.
function trackLocalPath(t) {
  return t.localPath ?? toLocalPath(t.plexPath);
}

export async function generateFillerPlaylist() {
  const all = await fetchAllTracksAny();
  const recentlyPlayed = recentlyPlayedRatingKeys();
  // Cross-regeneration rotation: what filler itself aired inside the rotation
  // window (fillerRotation.js) is excluded too, so consecutive playlists don't
  // re-pick the same songs. Show history is deliberately left alone.
  const fillerRecentlyAired = recentFillerPlays();
  // Station-wide never-play list (keywords + artists) lives on station.json,
  // not config.json -- config.filler keeps poolSize/intervals/max duration.
  const neverPlay = scheduleUtil.loadNeverPlay();
  const maxTrackDurationMs = config.filler.maxTrackDurationSeconds
    ? config.filler.maxTrackDurationSeconds * 1000
    : undefined;
  const eligible = dedupeByTitle(all).filter(
    (t) =>
      !recentlyPlayed.has(String(t.ratingKey)) &&
      !fillerRecentlyAired.has(String(t.ratingKey)) &&
      !isBannedTrack(t, neverPlay) &&
      (!maxTrackDurationMs || t.durationMs <= maxTrackDurationMs)
  );

  // Smart rotation rules (P2 #6, defenestratexp -- scheduler/rotationRules.js):
  // less-played-first weighting over the 7-day play counter (show history +
  // filler ledger merged), novelty boost for freshly added tracks, then
  // per-playlist flood caps (30/artist, 5/(artist,album) defaults). The
  // ordering produced here is the CAPS' priority order -- capping keeps the
  // first N per group, so a heavily played artist's overflow tracks are the
  // ones that drop. Every knob lives in config.filler.rotation and zeroes
  // itself off individually; missing block = working defaults.
  const rot = fillerRotationConfig();
  const playCounts = stationPlayCounts(rot.weightWindowDays);

  // Format ura / clockwheel (P2 #10, AzuraCast PR #8433 design --
  // scheduler/clockwheel.js): when config.filler.clockwheel defines a wheel,
  // the pool becomes a NAMED-SHAPE sequence (steps -> pools, N per step,
  // dayparts) instead of one flat weighted shuffle. The rotation rules above
  // still apply -- per pool. No block (or a wheel that resolves to nothing)
  // = exactly the plain path below.
  const poolSize = config.filler.poolSize;
  const wheel = clockwheelConfig();
  let afterAlbumCap = null;
  if (wheel) {
    afterAlbumCap = runClockwheel({ eligible, wheel, rot, counts: playCounts, poolSize });
  }

  if (!afterAlbumCap) {
    let ordered = weightedRotationOrder(eligible, {
      counts: playCounts,
      weightWindowDays: rot.weightWindowDays,
      noveltyDays: rot.noveltyDays,
      noveltyBoost: rot.noveltyBoost,
    });
    const afterArtistCap = capPerArtist(ordered, rot.maxTracksPerArtist);
    afterAlbumCap = capPerArtistAlbum(afterArtistCap, rot.maxTracksPerArtistAlbum);
    if (afterAlbumCap.length < eligible.length) {
      log(
        `filler: rotation caps trimmed the pool ${eligible.length} -> ${afterAlbumCap.length} ` +
          `(artist cap ${rot.maxTracksPerArtist}: ${afterArtistCap.length}, album cap ${rot.maxTracksPerArtistAlbum}: ${afterAlbumCap.length}; ` +
          `${playCounts.size} track(s) have play counts inside the ${rot.weightWindowDays}d window)`
      );
    }
  }

  let pool = afterAlbumCap.slice(0, poolSize);
  if (pool.length < poolSize) {
    // Small library (or a wide rotation window): every track is either in the
    // rotation ledger or filtered out. Backfill from the ledger entries that
    // have been off-air the LONGEST, so the pool stays full but still rotates
    // -- the alternative (leaving a short pool) would make Liquidsoap loop a
    // tiny playlist faster and repeat MORE audibly. The backfill deliberately
    // ignores the rotation caps: a full pool beats an enforced cap once the
    // capped pool can't fill it (same philosophy as buildTrackQueue's
    // artist-cooldown bypass), and ledger-oldest-first is already the
    // strongest anti-repeat ordering available here.
    const freshCount = pool.length;
    const backfillCandidates = all.filter(
      (t) =>
        fillerRecentlyAired.has(String(t.ratingKey)) &&
        !recentlyPlayed.has(String(t.ratingKey)) &&
        !isBannedTrack(t, neverPlay) &&
        (!maxTrackDurationMs || t.durationMs <= maxTrackDurationMs)
    );
    backfillCandidates.sort(
      (a, b) => (fillerRecentlyAired.get(String(a.ratingKey)) ?? 0) - (fillerRecentlyAired.get(String(b.ratingKey)) ?? 0)
    );
    // Oldest-first, then shuffle the TAKEN slice: shuffling before slicing
    // would scramble the oldest-first ordering and re-air recent tracks
    // (caught by the after-fix audit repro on 2026-10-24).
    pool = pool.concat(shuffle(backfillCandidates.slice(0, poolSize - pool.length)));
    log(`filler: only ${freshCount} un-aired track(s) in rotation window -- backfilled to ${pool.length} from oldest-rotated tracks`);
  }
  const localPaths = pool.map(trackLocalPath);
  // Same fade-up as show tracks (director/playlist.js's annotateTrackEntry)
  // -- filler is real music too, no reason it should hard-cut in while show
  // tracks fade.
  const content = localPaths.map(annotateTrackEntry).join('\n') + '\n';

  // Feeds scrobbleTrack.js's path->ratingKey lookup, same as director/index.js.
  await mergeTrackRatingKeys(pool.map((t, i) => [localPaths[i], t.ratingKey]));

  fs.mkdirSync(path.dirname(config.paths.fillerPath), { recursive: true });
  // Atomic tmp+rename -- Liquidsoap watches filler.m3u (reload_mode="watch"),
  // and a plain write could be caught half-written mid-swap (same discipline
  // as updateNowPlaying.js's now_playing.m3u write).
  const fillerTmp = `${config.paths.fillerPath}.tmp-${process.pid}`;
  fs.writeFileSync(fillerTmp, content);
  fs.renameSync(fillerTmp, config.paths.fillerPath);
  log(
    `Wrote filler playlist: ${pool.length} tracks -> ${config.paths.fillerPath} ` +
      `(excluded ${fillerRecentlyAired.size} filler-aired within ${rotationWindowHours()}h)`
  );

  // Enqueue-time lyrics prefetch (the dual-trigger's early half -- inert
  // unless config.lyrics.prefetch is true): every pool track that still owes
  // LRCLIB an answer starts its lookup NOW, hours before it airs, on the same
  // shared service the /api/lyrics/current route uses in this process (one
  // throttle, one in-flight map). Fire-and-forget: the scheduler's in-process
  // runs land the lookups in the background; the one-shot CLI's pending
  // fetches pace its exit (first run only -- a warm cache with the 30-day
  // recheck starts ~zero lookups). See lyricsService.prefetchLyrics.
  const lyricsStarted = prefetchLyrics(pool);
  if (lyricsStarted > 0) {
    log(`lyrics prefetch: ${lyricsStarted}/${pool.length} pool track(s) owed a lookup -- started now, ahead of airtime`);
  }

  pruneLedger();
  return { trackCount: pool.length };
}

async function main() {
  const { trackCount } = await generateFillerPlaylist();
  console.log(`Filler playlist: ${trackCount} tracks -> ${config.paths.fillerPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log(`ERROR: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}
