// Deterministic, no-AI track queue builder. Once a query (artist/genre/
// decade + selection options) is decided, everything here -- fetching,
// popularity weighting, recently-played exclusion, duration-based
// accumulation -- runs without the LLM. This is the piece the producer
// session used to do itself via repeated search_tracks tool calls; pulling
// it out into one deterministic pass is what actually fixes the duration-
// fitting and catalog-variety problems that surfaced testing the AI-driven
// version.
import { config } from '../../config/index.js';
import { fetchCandidateTracksAny, musicSource } from '../../auto/librarySource.js';
import { fetchCandidateAlbums, fetchAlbumTracks, fetchAlbumsByFolder } from '../../plex/albums.js';
import { dedupeByTitle, isBannedTrack, matchesExcludedKeyword, popularityWeight, weightedShuffle } from '../../plex/trackFilters.js';
import { recentlyPlayedRatingKeys, recentlyPlayedAlbumKeys, recentlyPlayedAlbumTitles, albumKey } from '../history.js';
import { shuffle } from '../../lib/format.js';
import { loadNeverPlay } from '../../scheduler/scheduleUtil.js';
import { fold } from '../../scheduler/rotationRules.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('station');

// Exported so smartBlocks.js (P3 #14) merges bans identically instead of
// forking the merge rule -- a block and a brief query must be interchangeable
// inputs to the same eligibility rules.
export function neverPlayBans(excludeKeywords) {
  const station = loadNeverPlay();
  return {
    keywords: [...new Set([...station.keywords, ...excludeKeywords])],
    artists: station.artists,
  };
}

// Heavier per-track commentary (intro + teaser + trivia, roughly two DJ
// segments) costs more airtime than a single-line-per-track pipeline would
// budget for (~25s) -- this is a starting estimate, expected to get tuned
// once aired shows accumulate measured DJ-speech timings to check it
// against.
const DEFAULT_DJ_OVERHEAD_SECONDS = 45;

// "Best of"/"greatest hits"-style albums are exactly the compilations a
// single-album show shouldn't land on (the whole point is one real studio
// record, not a repackaging of tracks from several) -- matched the same
// keyword way as excludeKeywords below, so a brief's own exclusions (e.g.
// "no christmas") stack with these built-in ones rather than replacing them.
const DEFAULT_COMPILATION_ALBUM_KEYWORDS = [
  'greatest hits',
  'best of',
  'the hits',
  'anthology',
  'collection',
  'essential',
  'very best',
  'number ones',
  '#1',
  'box set',
  'ultimate',
  // Confirmed live: a movie soundtrack ("Back to the Future") got picked
  // because the LLM-produced excludeKeywords that run happened not to
  // include "various artists" -- relying on the brief/LLM to always think of
  // it is unreliable, and "Various Artists" as the credited album artist is
  // an unconditional, always-present signal that it's a multi-artist
  // compilation, not one artist's classic album. Baked in here rather than
  // left to the brief so it can never be forgotten.
  'various artists',
];

// Picks one real, non-compilation album at random from whatever
// artist/genre/decade the brief scoped things to (or the whole library, if
// none of those were given -- a fully random "Classic Album" show).
// excludeAlbumKeys is the show-level "don't repeat" for this mode (see
// recentlyPlayedAlbumKeys in producer/history.js) -- a rolling window, not a
// permanent ban: if every non-compilation album is inside the window (an
// artist-locked show with a small catalog, run often enough), fall back to
// the full list rather than failing the show outright.
async function pickRandomAlbum({ artist, genre, decade, albumKeyword, albumGenre, excludeKeywords, excludeAlbumKeys = new Set() }) {
  // Local-library mode has no album entities to pick from (folders carry no
  // album grouping beyond tags) -- say so clearly instead of surfacing a raw
  // Plex connection error.
  if (musicSource() === 'local') {
    throw new Error(
      'singleAlbum shows need Plex album metadata, which the local-folder library does not provide. ' +
        'Restyle the brief as a plain artist/genre/decade selection (with oneTrackPerAlbum for variety), or point music.source back at Plex.'
    );
  }
  const albums = await fetchCandidateAlbums({ artist, genre, decade, albumKeyword, albumGenre });
  const bans = neverPlayBans(excludeKeywords);
  const compilationKeywords = [...DEFAULT_COMPILATION_ALBUM_KEYWORDS, ...bans.keywords];
  const nonCompilation = albums.filter(
    (a) =>
      !matchesExcludedKeyword({ title: a.title, album: a.title, artist: a.artist, genre: a.genre, plexPath: a.plexPath }, compilationKeywords) &&
      !isBannedTrack({ artist: a.artist, plexPath: a.plexPath }, { artists: bans.artists, keywords: [] })
  );
  if (nonCompilation.length === 0) {
    throw new Error(
      `No non-compilation albums found (artist=${artist ?? '-'}, genre=${genre ?? '-'}, decade=${decade ?? '-'}); ${albums.length} album(s) matched before compilation exclusion.`
    );
  }
  const fresh = nonCompilation.filter((a) => !excludeAlbumKeys.has(albumKey(a.artist, a.title)));
  return shuffle(fresh.length > 0 ? fresh : nonCompilation)[0];
}

// folder's counterpart to pickRandomAlbum -- albums here are reconstructed
// from track paths (fetchAlbumsByFolder), not a Plex album entity, so
// "artist" isn't a reliable per-album identity (see fetchAlbumsByFolder's
// comment); dedupe against history by title alone via
// recentlyPlayedAlbumTitles rather than albumKey's artist+title composite.
async function pickRandomAlbumFromFolder({ folder, excludeKeywords, excludeAlbumTitles = new Set() }) {
  const albums = await fetchAlbumsByFolder(folder);
  const bans = neverPlayBans(excludeKeywords);
  const compilationKeywords = [...DEFAULT_COMPILATION_ALBUM_KEYWORDS, ...bans.keywords];
  const nonCompilation = albums.filter(
    (a) =>
      !matchesExcludedKeyword({ title: a.title, album: a.title, artist: a.artist, genre: a.genre, plexPath: a.plexPath }, compilationKeywords) &&
      !isBannedTrack({ artist: a.artist, plexPath: a.plexPath }, { artists: bans.artists, keywords: [] })
  );
  if (nonCompilation.length === 0) {
    throw new Error(
      `No non-compilation albums found under folder "${folder}"; ${albums.length} album(s) matched before compilation exclusion.`
    );
  }
  const fresh = nonCompilation.filter((a) => !excludeAlbumTitles.has(a.title.toLowerCase()));
  return shuffle(fresh.length > 0 ? fresh : nonCompilation)[0];
}

// Single-album show mode: one whole show built around one randomly-picked
// album, rather than a themed mix pulled from across an artist/genre/decade's
// full catalog. "Top songs" here means popularity-weighted sampling within
// that one album (same weightedShuffle mechanism buildTrackQueue's
// weightPopular uses) -- but unlike the regular flow, at least one
// distinctly less-popular track is *reserved* up front rather than left to
// chance, since weighted sampling alone could plausibly land on an
// all-popular-track show for a well-known album. Final playback order is
// reshuffled after selection so "top songs" doesn't also mean "in popularity
// order".
//
// "Don't repeat" lives at the ALBUM level here, not the track level -- the
// regular buildTrackQueue path excludes individual recently-played tracks
// station-wide (recentlyPlayedRatingKeys), but that's the wrong granularity
// for a show whose whole point is playing several tracks off one record
// together as a unit. Blocking individual tracks would either starve a
// re-picked album's own eligible pool for no reason, or do nothing useful --
// the actual repeat concern is the SAME ALBUM coming back too soon, which
// recentlyPlayedAlbumKeys (repeatWindowDays, same brief override as before)
// governs instead. Once an album is picked, none of its own tracks are
// excluded by other shows' history -- repeating them together is the point.
export async function buildSingleAlbumTrackQueue({
  artist,
  genre,
  decade,
  albumKeyword,
  folder,
  albumGenre,
  excludeKeywords = [],
  maxTrackDurationSeconds,
  minTrackDurationSeconds,
  targetDurationMinutes,
  djOverheadSeconds = DEFAULT_DJ_OVERHEAD_SECONDS,
  repeatWindowDays,
  maxAlbumAttempts = 5,
} = {}) {
  if (!targetDurationMinutes) {
    throw new Error('buildSingleAlbumTrackQueue requires targetDurationMinutes');
  }

  // Falls back to config.shows.max/minTrackDurationSeconds (the station-wide
  // defaults, same knobs generateFillerPlaylist.js reads for the max) unless
  // the brief itself implied a different cap -- see the comment on this same
  // fallback in buildTrackQueue below for why a default exists at all.
  const effectiveMaxTrackDurationSeconds = maxTrackDurationSeconds ?? config.shows.maxTrackDurationSeconds;
  const maxTrackDurationMs = effectiveMaxTrackDurationSeconds ? effectiveMaxTrackDurationSeconds * 1000 : undefined;
  const effectiveMinTrackDurationSeconds = minTrackDurationSeconds ?? config.shows.minTrackDurationSeconds;
  const minTrackDurationMs = effectiveMinTrackDurationSeconds ? effectiveMinTrackDurationSeconds * 1000 : undefined;
  const excludeAlbumKeys = recentlyPlayedAlbumKeys(repeatWindowDays);
  const excludeAlbumTitles = folder ? recentlyPlayedAlbumTitles(repeatWindowDays) : undefined;
  const targetMs = targetDurationMinutes * 60 * 1000;
  const overheadMs = djOverheadSeconds * 1000;

  const triedAlbums = new Set();
  let lastError;
  for (let attempt = 1; attempt <= maxAlbumAttempts; attempt++) {
    const album = folder
      ? await pickRandomAlbumFromFolder({ folder, excludeKeywords, excludeAlbumTitles })
      : await pickRandomAlbum({ artist, genre, decade, albumKeyword, albumGenre, excludeKeywords, excludeAlbumKeys });
    // Folder pseudo-albums have no Plex ratingKey (see fetchAlbumsByFolder) --
    // fall back to title as the "already tried this attempt" identity.
    const albumIdentity = album.ratingKey ?? album.title;
    if (triedAlbums.has(albumIdentity)) continue;
    triedAlbums.add(albumIdentity);

    // Folder pseudo-albums carry their tracks inline (no ratingKey to
    // re-fetch by); everything else still looks them up via Plex.
    const rawTracks = album.tracks ?? (await fetchAlbumTracks(album.ratingKey));
    const bans = neverPlayBans(excludeKeywords);
    const eligible = dedupeByTitle(rawTracks).filter(
      (t) =>
        !isBannedTrack(t, bans) &&
        (!maxTrackDurationMs || t.durationMs <= maxTrackDurationMs) &&
        (!minTrackDurationMs || t.durationMs >= minTrackDurationMs)
    );

    if (eligible.length < 2) {
      lastError = new Error(
        `Album "${album.title}" by ${album.artist} only had ${eligible.length} eligible track(s) after filtering -- trying another album.`
      );
      continue;
    }

    // Reserve the single least-popular track as the guaranteed non-popular
    // pick, then weighted-sample the rest toward the album's better-known
    // songs for everything else.
    const byPopularityAsc = [...eligible].sort((a, b) => popularityWeight(a) - popularityWeight(b));
    const deepCut = byPopularityAsc[0];
    const rest = eligible.filter((t) => t !== deepCut);
    const topOrdered = weightedShuffle(rest, popularityWeight);

    const selected = [deepCut];
    let totalMs = deepCut.durationMs + overheadMs;
    for (const track of topOrdered) {
      if (totalMs >= targetMs) break;
      selected.push(track);
      totalMs += track.durationMs + overheadMs;
    }

    return {
      tracks: shuffle(selected),
      estimatedTotalMs: totalMs,
      estimatedMusicMs: selected.reduce((sum, t) => sum + t.durationMs, 0),
      targetMs,
      poolSize: eligible.length,
      album: { title: album.title, artist: album.artist, year: album.year },
    };
  }

  throw lastError ?? new Error(`Could not find a suitable album after ${maxAlbumAttempts} attempts.`);
}

// Time-of-day genre steering (Val 20, A4 -- the activation of the
// preferredGenres field auto/rules.js's blockGenrePreference has carried since
// the auto rules were written). PURE on purpose: buildTrackQueue only decides
// WHEN to call it and what neededCount to pass; everything a test (or a future
// consumer) needs to reason about lives in the return value.
//
// Semantics, all of them soft:
//   - preferredGenres is ANY-OF against track.genre[]: a track matching any
//     one preferred genre survives. Matching is folded (case- and
//     diacritics-insensitive) via rotationRules.js's fold() -- the exact same
//     normalization clockwheel.js's poolMatches uses for its genres filter, so
//     "Rock" in a config and "rock" on a tag (or "Šanson" vs "sanson") land
//     in one group everywhere a genre is compared in this repo.
//   - A track with no/empty .genre never matches -- it simply falls to the
//     give-up side when the pool is thin, it is never "assumed" into the
//     preference.
//   - neededCount comes from the CALLER (buildTrackQueue's average-duration
//     estimate, see below); matching < neededCount is an honest give-up with
//     the pool untouched: the brief's own identity (its artist/genre/decade
//     query) always wins over the block's mood.
// Returns { pool, matched, applied } -- pool is the ORIGINAL array (same
// identity) whenever applied is false, so the no-op paths are exact.
export function narrowPoolByPreferredGenres(eligible, preferredGenres, neededCount) {
  if (!Array.isArray(preferredGenres) || preferredGenres.length === 0 || !eligible?.length) {
    return { pool: eligible, matched: 0, applied: false };
  }
  const wanted = preferredGenres.map(fold);
  const matching = eligible.filter((t) => (Array.isArray(t.genre) ? t.genre : []).some((g) => wanted.includes(fold(g))));
  if (matching.length < neededCount) {
    return { pool: eligible, matched: matching.length, applied: false };
  }
  return { pool: matching, matched: matching.length, applied: true };
}

export async function buildTrackQueue({
  artist,
  genre,
  decade,
  albumKeyword,
  folder,
  artistList,
  albumGenre,
  recentlyAdded = false,
  excludeKeywords = [],
  maxTrackDurationSeconds,
  minTrackDurationSeconds,
  repeatArtist = true,
  oneTrackPerAlbum = false,
  weightPopular = false,
  singleAlbum = false,
  targetDurationMinutes,
  djOverheadSeconds = DEFAULT_DJ_OVERHEAD_SECONDS,
  repeatWindowDays,
  // Auto-radio rule extensions (all optional; defaults preserve the exact
  // pre-autoRadio behavior):
  //   excludeArtists -- Set of lowercased artist names excluded from the
  //     eligible pool (auto/rules.js's artist cooldown). If the exclusion
  //     empties the pool entirely, it is retried WITHOUT the cooldown rather
  //     than failing the show, and cooldownExcluded reports what happened.
  //   popularShare -- 0..1 fraction of selected slots drawn from the pool's
  //     popular half (median popularityWeight split), e.g. 0.7 = ~70/30 mix.
  //   decadeSpread -- round-robin the ordered candidates across decades so a
  //     multi-decade pool alternates instead of weighted-shuffle clumping.
  //   preferredGenres -- array of genre strings (auto/rules.js's
  //     blockGenrePreference, resolved by produce.js from the production-time
  //     time-of-day block): soft steering that narrows the eligible pool to
  //     tracks matching ANY preferred genre (folded, case-insensitive --
  //     narrowPoolByPreferredGenres above). Gives up immediately (pool
  //     untouched, honest log line) when the matching pool is too small to
  //     fill the show's estimated track need; the outcome is reported back as
  //     genrePoolMatched / genreSteeringApplied. Single-album shows never see
  //     it: the early-return path above runs before any of these rules, and a
  //     one-record show's shape IS the point.
  excludeArtists = null,
  popularShare = null,
  decadeSpread = false,
  preferredGenres = [],
} = {}) {
  if (singleAlbum) {
    return buildSingleAlbumTrackQueue({
      artist,
      genre,
      decade,
      albumKeyword,
      folder,
      albumGenre,
      excludeKeywords,
      maxTrackDurationSeconds,
      minTrackDurationSeconds,
      targetDurationMinutes,
      djOverheadSeconds,
      repeatWindowDays,
    });
  }

  if (!artist && !genre && !decade && !albumKeyword && !folder && !artistList?.length && !albumGenre && !recentlyAdded) {
    throw new Error(
      'buildTrackQueue requires at least one of: artist, genre, decade, albumKeyword, folder, artistList, albumGenre, recentlyAdded'
    );
  }
  if (!targetDurationMinutes) {
    throw new Error('buildTrackQueue requires targetDurationMinutes');
  }

  // max/minTrackDurationSeconds are plain mechanical length cutoffs --
  // applied here as a post-fetch prune, same as recently-played exclusion.
  // The values themselves normally come from the brief (e.g. "no tracks
  // over 5 minutes" -> maxTrackDurationSeconds 300, extracted by the AI
  // query-producer's produce_query schema), but most briefs never mention
  // duration at all, so without a fallback nothing stopped a themed
  // selection from landing on a 10+ minute album cut, or on a 30-second
  // interlude/skit track. config.shows.max/minTrackDurationSeconds are
  // those fallbacks -- a brief that actually wants a different range still
  // wins by having the AI set an explicit override.
  const effectiveMaxTrackDurationSeconds = maxTrackDurationSeconds ?? config.shows.maxTrackDurationSeconds;
  const maxTrackDurationMs = effectiveMaxTrackDurationSeconds ? effectiveMaxTrackDurationSeconds * 1000 : undefined;
  const effectiveMinTrackDurationSeconds = minTrackDurationSeconds ?? config.shows.minTrackDurationSeconds;
  const minTrackDurationMs = effectiveMinTrackDurationSeconds ? effectiveMinTrackDurationSeconds * 1000 : undefined;
  const rawCandidates = await fetchCandidateTracksAny({ artist, genre, decade, albumKeyword, folder, artistList, albumGenre, recentlyAdded });
  const recentlyPlayed = recentlyPlayedRatingKeys(repeatWindowDays);
  const bans = neverPlayBans(excludeKeywords);
  const applyCooldown = (t) => !excludeArtists?.size || !excludeArtists.has(String(t.artist).toLowerCase());
  const filterEligible = (withCooldown) =>
    dedupeByTitle(rawCandidates).filter(
      (t) =>
        !recentlyPlayed.has(String(t.ratingKey)) &&
        !isBannedTrack(t, bans) &&
        (!maxTrackDurationMs || t.durationMs <= maxTrackDurationMs) &&
        (!minTrackDurationMs || t.durationMs >= minTrackDurationMs) &&
        (withCooldown ? applyCooldown(t) : true)
    );
  const withoutCooldown = filterEligible(false);
  let eligible = filterEligible(true);
  // A cooldown that starves the whole pool (single-artist show, or a tiny
  // local library where every artist is still "warm") gives up on the
  // cooldown rather than on the show.
  let cooldownBypassed = false;
  if (eligible.length === 0 && excludeArtists?.size && withoutCooldown.length > 0) {
    eligible = withoutCooldown;
    cooldownBypassed = true;
    log(`buildTrackQueue: artist cooldown starved the pool -- retrying without it (${eligible.length} candidate(s) still available).`);
  }
  // Captured BEFORE genre steering can replace `eligible` below: the
  // cooldownExcluded report in the return must stay about the COOLDOWN only,
  // not accidentally absorb the genre narrowing's count (poolSize,
  // deliberately, does describe the final steered pool selection draws from).
  const poolAfterCooldown = eligible.length;

  // Time-of-day genre steering (A4): the production-time block's preferred
  // genres narrow the candidate pool BEFORE any ordering/selection happens,
  // so every downstream rule (weighted shuffle, decade spread, popularity
  // walkers, duration fitting) works on the steered pool. Soft, never a hard
  // ban: when the matching pool cannot fill the show, the narrowing gives up
  // (and logs it) and the brief's own identity wins.
  //
  // neededCount is an average-duration ESTIMATE of how many tracks the show
  // consumes -- Math.ceil(targetMs / (avgDurationMs + overheadMs)) over the
  // FULL eligible pool -- padded by +2: the estimate is a guess from average
  // durations, and a narrowed pool that only just fits would still shorten
  // shows whenever the real durations drawn run long, so the margin keeps a
  // "fits on paper" pool from becoming an on-air shortfall. avgDurationMs is
  // computed over the full (pre-narrowing) pool deliberately: the estimate
  // must describe the show's track budget, not the subset we are about to
  // test for sufficiency (which would beg the question).
  const targetMs = targetDurationMinutes * 60 * 1000;
  const overheadMs = djOverheadSeconds * 1000;
  const preferredConfigured = Array.isArray(preferredGenres) && preferredGenres.length > 0;
  let genrePoolMatched = 0;
  let genreSteeringApplied = false;
  let genrePoolBefore = poolAfterCooldown;
  let genreNeededCount = null;
  if (preferredConfigured && eligible.length > 0) {
    const avgDurationMs = eligible.reduce((sum, t) => sum + (t.durationMs ?? 0), 0) / eligible.length;
    genreNeededCount = Math.ceil(targetMs / (avgDurationMs + overheadMs)) + 2;
    const narrowed = narrowPoolByPreferredGenres(eligible, preferredGenres, genreNeededCount);
    if (narrowed.applied) {
      eligible = narrowed.pool;
      log(
        `buildTrackQueue: time-of-day genre steering narrowed the pool ${genrePoolBefore} -> ${eligible.length} (preferred: ${preferredGenres.join(', ')}).`
      );
    } else if (narrowed.matched > 0) {
      // Honest give-up: the matching pool is real but too small to fill the
      // show, so the preference is skipped entirely (pool untouched) -- a
      // half-applied preference would skew the mix without delivering the
      // block's mood, which is the worst of both worlds.
      log(
        `buildTrackQueue: time-of-day genre steering skipped -- matching pool (${narrowed.matched} track(s)) is too small to fill the show (~${genreNeededCount} needed); the brief's own selection stands (preferred: ${preferredGenres.join(', ')}).`
      );
    }
    genrePoolMatched = narrowed.matched;
    genreSteeringApplied = narrowed.applied;
  }

  let ordered = weightPopular ? weightedShuffle(eligible, popularityWeight) : shuffle(eligible);

  // Decade spread: group by decade and interleave one track per decade per
  // round, so a pool spanning several decades alternates between them.
  // Within a decade, the weighted/shuffled order is preserved.
  if (decadeSpread && ordered.length > 1) {
    const byDecade = new Map();
    for (const t of ordered) {
      const key = t.year != null ? String(Math.floor(t.year / 10)) : 'unknown';
      if (!byDecade.has(key)) byDecade.set(key, []);
      byDecade.get(key).push(t);
    }
    if (byDecade.size > 1) {
      const queues = [...byDecade.values()];
      const spread = [];
      let exhausted = false;
      while (!exhausted) {
        exhausted = true;
        for (const q of queues) {
          if (q.length > 0) {
            spread.push(q.shift());
            exhausted = false;
          }
        }
      }
      ordered = spread;
    }
  }

  // Popularity mix: two walkers (popular half / lesser-known half, each in
  // its own weighted-shuffled order) drawn from in the configured proportion
  // -- an exact enforcement of e.g. "70% well-known, 30% deep cuts" that
  // still ends when the duration target is met.
  let popularWalker = null;
  let lesserWalker = null;
  if (popularShare != null && popularShare > 0 && popularShare < 1 && ordered.length > 1) {
    const weights = ordered.map(popularityWeight);
    const sorted = [...weights].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const popular = ordered.filter((t) => popularityWeight(t) >= median);
    const lesser = ordered.filter((t) => popularityWeight(t) < median);
    if (popular.length > 0 && lesser.length > 0) {
      popularWalker = popular[Symbol.iterator]();
      lesserWalker = lesser[Symbol.iterator]();
      ordered = null; // selection below now pulls from the two walkers
    }
  }

  const usedArtists = new Set();
  const usedAlbums = new Set();
  const selected = [];
  let totalMs = 0;
  let selectedPopular = 0;
  let selectedLesser = 0;

  const nextMixed = () => {
    if (!popularWalker) return null;
    // Keep the running ratio honest: draw from the popular walker whenever
    // the popular share of what's been picked so far is still under target,
    // otherwise from the lesser-known walker; whichever walker is exhausted
    // gives way to the other.
    const wantPopular = selectedPopular / Math.max(selectedPopular + selectedLesser, 1) < popularShare;
    const first = wantPopular ? popularWalker : lesserWalker;
    const second = wantPopular ? lesserWalker : popularWalker;
    for (const it of [first, second]) {
      const { value, done } = it.next();
      if (!done) {
        if (it === popularWalker) selectedPopular++;
        else selectedLesser++;
        return value;
      }
    }
    return null;
  };

  for (;;) {
    const track = popularWalker ? nextMixed() : ordered?.shift();
    if (!track) break;
    if (totalMs >= targetMs) break;
    // Artist-themed selections are expected to repeat the artist by
    // definition (every track already is that artist) -- the no-repeat
    // rule only means something for genre/decade selections, same
    // distinction below draws for oneTrackPerAlbum.
    if (!repeatArtist && usedArtists.has(track.artist)) continue;
    // oneTrackPerAlbum is for the opposite case -- a single-artist show
    // that still wants catalog variety (e.g. "Elvis Lookback" spanning many
    // albums, not several cuts off one record). Tracks with no album info
    // are never deduped against each other.
    if (oneTrackPerAlbum && track.album && usedAlbums.has(track.album)) continue;
    selected.push(track);
    usedArtists.add(track.artist);
    if (track.album) usedAlbums.add(track.album);
    totalMs += track.durationMs + overheadMs;
  }

  return {
    tracks: selected,
    estimatedTotalMs: totalMs,
    estimatedMusicMs: selected.reduce((sum, t) => sum + t.durationMs, 0),
    targetMs,
    poolSize: eligible.length,
    ...(excludeArtists?.size
      ? {
          cooldownExcluded: cooldownBypassed ? 0 : withoutCooldown.length - poolAfterCooldown,
          cooldownBypassed,
        }
      : {}),
    ...(popularShare != null ? { popularShare } : {}),
    ...(decadeSpread ? { decadeSpread: true } : {}),
    // Same conditional-spread stance as the rules above: the steering fields
    // exist only when a preference was actually configured, so an ordinary
    // (non-steered) queue keeps its exact pre-A4 shape. genrePoolBefore and
    // genreNeededCount ride along so produce.js's Phase A summary can state
    // the real numbers ("120 -> 40", "12 matches < ~22 needed") instead of
    // restating what its own log already said less precisely.
    ...(preferredConfigured
      ? { preferredGenres, genrePoolMatched, genreSteeringApplied, genrePoolBefore, genreNeededCount }
      : {}),
  };
}
