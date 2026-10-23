// Music-source router: Plex first, local folders as the fallback. Every
// caller (trackSelection/queue.js, generateFillerPlaylist.js, the auto
// producer's genre resolution) goes through here instead of importing
// plex/tracks.js directly, so switching the station between Plex, local
// folders, or "auto" is one config change -- not a code change.
//
// source values (config.autoRadio.music.source):
//   "plex"  -- always Plex; a failure is a real error (previous behavior)
//   "local" -- always the local folder provider; Plex is never contacted
//   "auto"  -- Plex when reachable, local folders otherwise (default)
//
// When config.autoRadio is absent entirely (an unmodified station), the
// router still routes to Plex, so existing behavior is bit-identical.
import { config } from '../config/index.js';
import * as plexTracks from '../plex/tracks.js';
import * as plexGenres from '../plex/genres.js';
import { fetchLocalCandidateTracks, allLocalTracks, localGenreTags } from './localLibrary.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('station');

export function musicSource() {
  return config.autoRadio?.music?.source ?? 'plex';
}

export async function fetchCandidateTracksAny(query = {}) {
  const source = musicSource();
  if (source === 'local') return fetchLocalCandidateTracks(query);
  if (source === 'plex') return plexTracks.fetchCandidateTracks(query);
  // auto: Plex first, local on any Plex failure. fetchAllTracks() (a single
  // container fetch) is the cheapest reliable reachability probe that also
  // returns exactly the data the plain no-filter query needs.
  try {
    return await plexTracks.fetchCandidateTracks(query);
  } catch (err) {
    log(`NOTE: Plex query failed (${err.message.split('\n')[0]}) -- using the local library for this query.`);
    return fetchLocalCandidateTracks(query);
  }
}

export async function fetchAllTracksAny() {
  const source = musicSource();
  if (source === 'local') return allLocalTracks();
  if (source === 'plex') return plexTracks.fetchAllTracks();
  try {
    return await plexTracks.fetchAllTracks();
  } catch (err) {
    log(`NOTE: Plex unreachable (${err.message.split('\n')[0]}) -- filler will use the local library.`);
    return allLocalTracks();
  }
}

// Genre tag truth for the deterministic brief parser: Plex's real tag
// vocabulary when available, otherwise the local files' own genre tags.
export async function listGenreTagsAny() {
  const source = musicSource();
  if (source === 'local') return localGenreTags();
  if (source === 'plex') return plexGenres.listGenreTags();
  try {
    return await plexGenres.listGenreTags();
  } catch {
    return localGenreTags();
  }
}

export async function listAlbumGenreTagsAny() {
  const source = musicSource();
  if (source === 'local') return []; // local files have no album-genre concept
  if (source === 'plex') return plexGenres.listAlbumGenreTags();
  try {
    return await plexGenres.listAlbumGenreTags();
  } catch {
    return [];
  }
}
