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

  const poolSize = config.filler.poolSize;
  let pool = shuffle(eligible).slice(0, poolSize);
  if (pool.length < poolSize) {
    // Small library (or a wide rotation window): every track is either in the
    // rotation ledger or filtered out. Backfill from the ledger entries that
    // have been off-air the LONGEST, so the pool stays full but still rotates
    // -- the alternative (leaving a short pool) would make Liquidsoap loop a
    // tiny playlist faster and repeat MORE audibly.
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
  fs.writeFileSync(config.paths.fillerPath, content);
  log(
    `Wrote filler playlist: ${pool.length} tracks -> ${config.paths.fillerPath} ` +
      `(excluded ${fillerRecentlyAired.size} filler-aired within ${rotationWindowHours()}h)`
  );
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
