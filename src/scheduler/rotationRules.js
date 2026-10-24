// Smart library-rotation rules (integration-table item #6, borrowed from
// defenestratexp's liquidsoap-icecast-radio, MIT -- the only no-AI station
// generator whose rotation rules were analyzed in
// docs/ready-made-scripts-analysis.md §4.1). The rules target the ROTATION
// layer -- the off-air filler pool -- where selection was plain shuffle over
// a deduped pool; curated shows already enforce variety structurally
// (repeatArtist / oneTrackPerAlbum / artist cooldown), so they are out of
// scope here on purpose.
//
// Five defenestratexp rules and where each one lives after this module:
//   1. dedup by (artist, title)        -> ALREADY COVERED, stricter: shared
//      dedupeByTitle() collapses same titles station-wide (covers included),
//      so a rotation pool can never hold "the same song" twice at all.
//   2. exclude everything aired in the last 12h -> ALREADY COVERED and
//      exceeded: the filler ledger excludes rotationWindowHours (24h default)
//      and show history excludes shows.repeatWindowDays (30d default).
//   3. cap 30 tracks per artist per playlist -> capPerArtist() below.
//   4. cap 5 per (artist, album) per playlist (compilations must not flood
//      the pool) -> capPerArtistAlbum() below.
//   5. weight by a 7-day play counter so LESS-played tracks surface first,
//      with a novelty boost for tracks added in the last 7 days ->
//      stationPlayCounts() + rotationWeight() + weightedRotationOrder().
//
// Everything here is plain data + plain functions -- no model anywhere. All
// knobs come from config.filler.rotation with working defaults (F2 pattern:
// a config without the block behaves sensibly), and each rule degrades
// honestly on its own: a zeroed knob disables exactly that rule.
import fs from 'node:fs';
import { config } from '../config/index.js';
import { shuffle } from '../lib/format.js';
import { fillerLedgerPath } from './fillerRotation.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function fillerRotationConfig() {
  const r = config.filler?.rotation ?? {};
  return {
    maxTracksPerArtist: r.maxTracksPerArtist ?? 30,
    maxTracksPerArtistAlbum: r.maxTracksPerArtistAlbum ?? 5,
    weightWindowDays: r.weightWindowDays ?? 7,
    noveltyDays: r.noveltyDays ?? 7,
    noveltyBoost: r.noveltyBoost ?? 3,
  };
}

// Same normalization localLibrary.js uses for artist/genre matching: case-
// and diacritics-folded, so "Beyoncé" and "beyonce" land in one cap group
// even when the library mixes tagged and filename-derived metadata.
// Exported for clockwheel.js's pool filters -- one fold everywhere keeps
// "Beyoncé" matching in caps, pool filters, and dedupe alike.
export function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ---------------------------------------------------------------------------
// per-playlist caps (rules 3 and 4)
// ---------------------------------------------------------------------------

// Keeps at most `maxPerArtist` tracks per folded artist. Input ORDER IS THE
// PRIORITY ORDER: the caller passes tracks in the order they should survive
// (weighted-rotation order for filler), so capping never silently re-ranks.
// An empty/unknown artist folds to '' and is capped as its own group -- a
// shelf of untagged files plays like one artist's pile, so it deserves the
// same flood guard. A zero/negative cap disables the rule (returns a copy).
export function capPerArtist(tracks, maxPerArtist) {
  if (!maxPerArtist || maxPerArtist <= 0) return [...tracks];
  const counts = new Map();
  const kept = [];
  for (const t of tracks) {
    const key = fold(t.artist);
    const seen = counts.get(key) ?? 0;
    if (seen >= maxPerArtist) continue;
    counts.set(key, seen + 1);
    kept.push(t);
  }
  return kept;
}

// (artist, album) counterpart of capPerArtist: at most `max` tracks from any
// one record. Tracks with NO album info are never grouped -- there is no
// album identity to cap against (same stance as buildTrackQueue's
// oneTrackPerAlbum), and a cap on them would wrongly punish untagged
// libraries where album is always null. Zero/negative disables.
export function capPerArtistAlbum(tracks, maxPerArtistAlbum) {
  if (!maxPerArtistAlbum || maxPerArtistAlbum <= 0) return [...tracks];
  const counts = new Map();
  const kept = [];
  for (const t of tracks) {
    if (!t.album) {
      kept.push(t);
      continue;
    }
    const key = `${fold(t.artist)}|||${fold(t.album)}`;
    const seen = counts.get(key) ?? 0;
    if (seen >= maxPerArtistAlbum) continue;
    counts.set(key, seen + 1);
    kept.push(t);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// 7-day play counter + novelty (rule 5)
// ---------------------------------------------------------------------------

// Station-wide play counts over the window, merged from BOTH play ledgers:
// played.jsonl (show plays, appended by recordPlayed at finalization) and
// the filler rotation ledger (one entry per aired filler segment, appended
// by scrobbleTrack). Shows deliberately never see filler plays and filler
// deliberately never records into played.jsonl -- but for "how often did
// this track AIR lately" the station has exactly one answer, and it spans
// both files. Torn lines (crash mid-append) are skipped, never fatal, on
// either file; a missing file counts as zero plays.
export function stationPlayCounts(windowDays = 7, now = Date.now()) {
  const counts = new Map();
  if (!windowDays || windowDays <= 0) return counts;
  const cutoff = now - windowDays * DAY_MS;
  const bump = (key) => {
    if (key == null) return;
    const k = String(key);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  const readLedger = (file) => {
    let lines = [];
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
      return; // no file yet -- nothing to count
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const at = new Date(entry.playedAt).getTime();
        if (Number.isFinite(at) && at >= cutoff) bump(entry.ratingKey);
      } catch {
        // torn final line -- skip, don't fail rotation
      }
    }
  };
  readLedger(config.paths.historyFile);
  readLedger(fillerLedgerPath());
  return counts;
}

// weight = 1/(1 + playCount): never zero (a heavily played track stays
// eligible, just later), never unbounded (a never-played track is exactly
// weight 1, not 1/0). Novelty: a track added within noveltyDays gets a
// weight MULTIPLIER (default 3) so new library arrivals surface sooner --
// "boost novosti (7 dni)". addedAtMs is the local-library signal (file
// mtime), addedAt the Plex one (mapped to ms in trackFromMetadata); absent
// signal simply never boosts.
export function rotationWeight(track, { counts = new Map(), noveltyDays = 7, noveltyBoost = 3, now = Date.now() } = {}) {
  const playCount = counts.get(String(track.ratingKey)) ?? 0;
  let weight = 1 / (1 + playCount);
  const addedAt = track.addedAtMs ?? track.addedAt ?? null;
  if (noveltyBoost > 1 && noveltyDays > 0 && addedAt != null && now - addedAt <= noveltyDays * DAY_MS) {
    weight *= noveltyBoost;
  }
  return weight;
}

// Less-played-first ordering via the same Efraimidis-Spirakis weighted
// sampling without replacement trackFilters.weightedShuffle uses for
// popularity (key = random()^(1/weight), sorted descending): lower play
// counts mean higher weight, so they tend to land earlier, but nothing is
// excluded outright the way a strict sort by play count would. A zeroed
// weightWindowDays turns the whole rule off and falls back to plain shuffle
// -- the exact pre-rotation-rules behavior.
export function weightedRotationOrder(
  tracks,
  { counts = new Map(), weightWindowDays = 7, noveltyDays = 7, noveltyBoost = 3, now = Date.now() } = {}
) {
  if (!weightWindowDays || weightWindowDays <= 0) return shuffle(tracks);
  const opts = { counts, noveltyDays, noveltyBoost, now };
  return tracks
    .map((t) => ({ t, key: Math.random() ** (1 / rotationWeight(t, opts)) }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.t);
}
