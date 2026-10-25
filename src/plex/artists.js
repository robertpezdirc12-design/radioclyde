import { config } from '../config/index.js';
import { plexGet, TYPE_ARTIST } from './client.js';

// `title=` on tracks (type=10) does substring matching in Plex (searching
// "Queen" also matches "Christine and the Queens"), but confirmed live that
// it does NOT for artists (type=8) -- `title=Fleetwood` against an artist
// list that has no "Fleetwood" returns zero results instead of matching
// "Fleetwood Mac". So resolving an artist name needs its own substring pass
// over the full artist list rather than relying on the title= filter.
let allArtistsCache = null;
let allArtistsCacheAt = 0;
// TTL refresh for a cache that used to live for the WHOLE process: new
// artists added to Plex stayed invisible until the next restart, exactly
// when an operator is most likely to test a freshly-added act. A stale
// cache re-fetches on the next read; a failed fetch propagates like the
// cold-cache case (the old entry stays in place for the next successful
// read). No in-flight dedup on purpose: two concurrent stale readers can
// both fetch -- last write wins, both answers are correct.
const ALL_ARTISTS_CACHE_TTL_MS = 10 * 60 * 1000;
async function fetchAllArtists() {
  if (allArtistsCache && Date.now() - allArtistsCacheAt < ALL_ARTISTS_CACHE_TTL_MS) return allArtistsCache;
  const data = await plexGet(
    `/library/sections/${config.plex.librarySectionId}/all?type=${TYPE_ARTIST}&X-Plex-Container-Start=0&X-Plex-Container-Size=5000`
  );
  allArtistsCache = data.MediaContainer.Metadata ?? [];
  allArtistsCacheAt = Date.now();
  return allArtistsCache;
}

export async function resolveArtistId(name) {
  const artists = await fetchAllArtists();
  const q = name.toLowerCase();
  const exact = artists.find((a) => a.title.toLowerCase() === q);
  if (exact) return exact.ratingKey;

  const substringMatches = artists.filter(
    (a) => a.title.toLowerCase().includes(q) || q.includes(a.title.toLowerCase())
  );
  if (substringMatches.length === 1) return substringMatches[0].ratingKey;
  if (substringMatches.length > 1) {
    throw new Error(
      `"${name}" matches multiple artists in this library, none exactly: ${substringMatches.map((a) => a.title).join(', ')}. Pick one of these exact names and search again.`
    );
  }
  throw new Error(`"${name}" is not in this library's ${artists.length} artists -- it doesn't exist here, try a different artist, genre, or decade instead of retrying the same name.`);
}
