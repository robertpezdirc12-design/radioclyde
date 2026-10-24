// Deterministic Smart Blocks (P3 #14, LibreTime's model -- analysis §4.4):
// named, operator-defined criteria saved in config.json that expand into a
// concrete track list on demand. "12 ambient tracks under 6 minutes, newest
// first" is a saved block, not a re-decided opinion every episode.
//
// Semantics verified from LibreTime's user manual (libretime.org/docs,
// "Playlists and smart blocks", primary source, 2026-10-24):
//   - limit to hours/minutes/items, and by default the block "won't overflow
//     the length" (a track that would cross the limit is left out); the
//     "Allow last track to exceed time limit" checkbox maps to overflow:true.
//   - sort tracks by random / newest / oldest. We keep all three and add
//     "sequential" (alphabetical, the classic block-builder's order) and
//     "popular" (this repo's weightedShuffle -- LibreTime has no equivalent).
//   - "by default, a smart block won't contain repeated items". We go
//     strictly further by running the SAME eligibility chain every other
//     selection in this repo runs: dedupeByTitle, station-wide
//     recently-played exclusion, neverPlay bans, duration cutoffs -- so a
//     block can never schedule what a plain show could not.
//   - static vs dynamic: LibreTime lets a block freeze its content at save
//     time. Ours are always DYNAMIC (generated when the episode is produced,
//     then frozen into the pre-produced show) -- the pre-produced-episode
//     architecture already freezes whatever was picked.
//
// What is deliberately NOT borrowed: LibreTime's per-field operator matrix
// (contains/starts with/greater than/in range per metadata category). Our
// criteria vocabulary is buildTrackQueue's existing closed set -- the brief
// parser's fields -- because a second selection dialect would fork the
// eligibility rules. Criteria unknown to that set are a config error, not a
// silent no-op (same closed-vocabulary honesty as script/format.js's
// segment: validation).
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { fetchCandidateTracksAny } from '../auto/librarySource.js';
import { dedupeByTitle, isBannedTrack, popularityWeight, weightedShuffle } from '../plex/trackFilters.js';
import { shuffle } from '../lib/format.js';
import { recentlyPlayedRatingKeys } from './history.js';
import { loadNeverPlay } from '../scheduler/scheduleUtil.js';
import { neverPlayBans } from './trackSelection/queue.js';

const log = createLogger('station');

// fold to lowercase + ASCII -- same diacritics-insensitive contract as
// pickBestMatch/dedupeByTitle, so "Franjo Žagar" and "franco zagar" name the
// same block.
function fold(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// The closed criteria vocabulary. These are exactly buildTrackQueue's
// selection fields (minus its accumulation options, which blocks replace
// with limit/order) -- so a block and a brief query are interchangeable
// inputs to the same eligibility rules.
const CRITERIA_KEYS = new Set([
  'artist',
  'artistList',
  'genre',
  'decade',
  'albumKeyword',
  'albumGenre',
  'folder',
  'recentlyAdded',
  'excludeKeywords',
  'maxTrackDurationSeconds',
  'minTrackDurationSeconds',
]);

// The closed order vocabulary: LibreTime's three + our two, each a plain
// deterministic (or deterministic-given-RNG) transformation.
const ORDER_MODES = new Set(['random', 'newest', 'oldest', 'sequential', 'popular']);

// ---------------------------------------------------------------------------
// config access (F2 ?. pattern: a station without the block simply has none)
// ---------------------------------------------------------------------------

export function smartBlocksConfig() {
  const blocks = config.smartBlocks;
  if (blocks == null) return [];
  if (!Array.isArray(blocks)) {
    log('WARNING: config.smartBlocks is not an array -- ignoring it (define it as a list of block objects).');
    return [];
  }
  return blocks;
}

export function findSmartBlock(name) {
  const wanted = fold(name);
  if (!wanted) return null;
  return smartBlocksConfig().find((b) => fold(b?.name) === wanted) ?? null;
}

// Validates one block's shape and returns { criteria, limit, order, overflow }
// -- the parts expansion consumes. Everything it rejects gets a specific,
// operator-fixable error; nothing here silently drops a typo.
export function validateSmartBlock(block) {
  if (!block || typeof block !== 'object') {
    throw new Error('Smart block must be an object with a name.');
  }
  if (!block.name || typeof block.name !== 'string') {
    throw new Error('Smart block is missing a "name" (used in briefs as "- smart block: <name>").');
  }
  const criteria = block.criteria ?? {};
  if (typeof criteria !== 'object' || Array.isArray(criteria)) {
    throw new Error(`Smart block "${block.name}"'s "criteria" must be an object.`);
  }
  const unknown = Object.keys(criteria).filter((k) => !CRITERIA_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `Smart block "${block.name}" has unknown criteria key(s): ${unknown.join(', ')}. ` +
        `Allowed: ${[...CRITERIA_KEYS].join(', ')}.`
    );
  }
  // Only genuine selection fields count — duration cutoffs and exclusion
  // keywords narrow a selection, they are not one.
  const SELECTION_KEYS = ['artist', 'artistList', 'genre', 'decade', 'albumKeyword', 'albumGenre', 'folder', 'recentlyAdded'];
  const hasSelection = SELECTION_KEYS.some((k) => {
    const v = criteria[k];
    return Array.isArray(v) ? v.length > 0 : v != null;
  });
  if (!hasSelection) {
    throw new Error(
      `Smart block "${block.name}" has no selection criteria (need at least one of: ` +
        `artist, artistList, genre, decade, albumKeyword, albumGenre, folder, recentlyAdded).`
    );
  }
  const limit = block.limit ?? {};
  if (typeof limit !== 'object' || Array.isArray(limit)) {
    throw new Error(`Smart block "${block.name}"'s "limit" must be an object like { "count": 12 } or { "minutes": 45 }.`);
  }
  const hasCount = Number.isFinite(limit.count) && limit.count > 0;
  const hasMinutes = Number.isFinite(limit.minutes) && limit.minutes > 0;
  if (hasCount === hasMinutes) {
    throw new Error(
      `Smart block "${block.name}" needs exactly one limit: { "count": N } (items, LibreTime "items") ` +
        `or { "minutes": M } (music time, LibreTime "minutes").`
    );
  }
  const order = block.order ?? 'random';
  if (!ORDER_MODES.has(order)) {
    throw new Error(
      `Smart block "${block.name}" has unknown order "${order}". Allowed: ${[...ORDER_MODES].join(', ')}.`
    );
  }
  return {
    criteria,
    limit: hasCount ? { count: Math.floor(limit.count) } : { minutes: limit.minutes },
    order,
    // LibreTime default: the block does not overflow; overflow:true is the
    // "Allow last track to exceed time limit" checkbox.
    overflow: block.overflow === true,
  };
}

// ---------------------------------------------------------------------------
// ordering (pure, testable)
// ---------------------------------------------------------------------------
// Chronological sort, dir=1 oldest-first / dir=-1 newest-first. Year-nulls
// sort LAST in both directions -- a track with no year must not claim the
// front of either list (a naive Infinity sentinel only works for one of the
// two directions; the first test run caught exactly that).
function chronological(tracks, dir) {
  const tie = (a, b) => byFold(a, b, 'artist') || byFold(a, b, 'title');
  return [...tracks].sort((a, b) => {
    const ya = typeof a.year === 'number' ? a.year : null;
    const yb = typeof b.year === 'number' ? b.year : null;
    if (ya === null && yb === null) return tie(a, b);
    if (ya === null) return 1;
    if (yb === null) return -1;
    return dir * (ya - yb) || tie(a, b);
  });
}

function byFold(a, b, field) {
  return fold(a[field]).localeCompare(fold(b[field]));
}

export function orderTracks(tracks, order) {
  const list = [...tracks];
  switch (order) {
    case 'random':
    case undefined:
      return shuffle(list);
    case 'newest':
      return chronological(list, -1);
    case 'oldest':
      return chronological(list, 1);
    case 'sequential':
      return list.sort((a, b) => byFold(a, b, 'artist') || byFold(a, b, 'album') || byFold(a, b, 'title'));
    case 'popular':
      return weightedShuffle(list, popularityWeight);
    default:
      throw new Error(`Unknown smart block order "${order}" (allowed: ${[...ORDER_MODES].join(', ')}).`);
  }
}

// ---------------------------------------------------------------------------
// expansion
// ---------------------------------------------------------------------------

// Expands one block into the exact tracks it would schedule RIGHT NOW.
// Deterministic given (library, history, RNG) -- 'random'/'popular' shuffle
// fresh each call, every other mode is fully stable. Never throws on
// under-fill: a block that cannot reach its limit reports a shortfall, the
// caller decides what an empty/short show means (produce.js fails honestly,
// the CLI just prints).
export async function expandSmartBlock(block, { excludeRatingKeys = new Set(), repeatWindowDays } = {}) {
  const shape = validateSmartBlock(block);
  const raw = await fetchCandidateTracksAny(shape.criteria);

  const recentlyPlayed = recentlyPlayedRatingKeys(repeatWindowDays);
  const bans = neverPlayBans(shape.criteria.excludeKeywords ?? []);
  const maxMs = shape.criteria.maxTrackDurationSeconds
    ? shape.criteria.maxTrackDurationSeconds * 1000
    : config.shows.maxTrackDurationSeconds
      ? config.shows.maxTrackDurationSeconds * 1000
      : undefined;
  const minMs = shape.criteria.minTrackDurationSeconds
    ? shape.criteria.minTrackDurationSeconds * 1000
    : config.shows.minTrackDurationSeconds
      ? config.shows.minTrackDurationSeconds * 1000
      : undefined;

  const eligible = dedupeByTitle(raw).filter(
    (t) =>
      !excludeRatingKeys.has(String(t.ratingKey)) &&
      !recentlyPlayed.has(String(t.ratingKey)) &&
      !isBannedTrack(t, bans) &&
      (!maxMs || t.durationMs <= maxMs) &&
      (!minMs || t.durationMs >= minMs)
  );

  const ordered = orderTracks(eligible, shape.order);
  const selected = [];
  let totalMs = 0;
  let brokeOnLimit = false;
  for (const t of ordered) {
    if (shape.limit.count != null) {
      if (selected.length >= shape.limit.count) break;
      selected.push(t);
      continue;
    }
    // LibreTime's minute limit, no-overflow default: a track that would
    // cross the limit is left out (first non-fit ends the walk -- same
    // simple walk LibreTime does over its sorted pool). overflow:true adds
    // the crossing track, then stops.
    if (totalMs >= shape.limit.minutes * 60 * 1000) break;
    if (!shape.overflow && totalMs + t.durationMs > shape.limit.minutes * 60 * 1000) {
      brokeOnLimit = true;
      break;
    }
    selected.push(t);
    totalMs += t.durationMs;
  }

  // Honest reporting, three distinct outcomes:
  //   shortfall -- the pool genuinely could not fill the limit (count not
  //     reached, empty expansion, or the walk ran out under the minute
  //     limit). The caller decides what that means (produce.js fails the
  //     show honestly, the CLI prints the gap).
  //   limitNote -- the no-overflow walk stopped on design (next track would
  //     have crossed the limit): normal behavior, but the operator sees the
  //     block came up short instead of silently losing minutes.
  //   neither -- the limit was filled exactly as configured.
  let shortfall = null;
  let limitNote = null;
  if (shape.limit.count != null) {
    if (selected.length < shape.limit.count) {
      shortfall = {
        kind: 'count',
        requested: shape.limit.count,
        matched: eligible.length,
        selected: selected.length,
        note: `Pool supplied ${selected.length} of ${shape.limit.count} requested track(s) after the eligibility filters.`,
      };
    }
  } else {
    const targetMs = shape.limit.minutes * 60 * 1000;
    if (totalMs < targetMs) {
      if (selected.length === 0) {
        shortfall = {
          kind: 'minutes',
          requested: shape.limit.minutes,
          matched: eligible.length,
          selected: 0,
          overflow: shape.overflow,
          note:
            eligible.length === 0
              ? 'No tracks left after the eligibility filters (library match minus history/bans/durations).'
              : `No track fits inside the ${shape.limit.minutes}-minute limit${shape.overflow ? '' : ' (overflow off)'} -- the block would be empty.`,
        };
      } else if (brokeOnLimit) {
        limitNote = `Stopped under the ${shape.limit.minutes}-minute limit -- the next track would have crossed it (overflow off, LibreTime default).`;
      } else {
        shortfall = {
          kind: 'minutes',
          requested: shape.limit.minutes,
          matched: eligible.length,
          selected: selected.length,
          overflow: shape.overflow,
          note: `Pool exhausted at ${selected.length} track(s) under the ${shape.limit.minutes}-minute limit.`,
        };
      }
    }
  }

  return {
    tracks: selected,
    // Blocks are MUSIC time -- no DJ overhead is baked in (unlike
    // buildTrackQueue's show-duration fitting). An operator budgeting a
    // 60-minute show budgets the speech on top, exactly like LibreTime
    // operators who set a 58-minute block inside a 60-minute show.
    estimatedMusicMs: selected.reduce((sum, t) => sum + (t.durationMs ?? 0), 0),
    estimatedTotalMs: selected.reduce((sum, t) => sum + (t.durationMs ?? 0), 0),
    targetMs: shape.limit.minutes != null ? shape.limit.minutes * 60 * 1000 : null,
    poolSize: eligible.length,
    block: {
      name: block.name,
      order: shape.order,
      overflow: shape.overflow,
      limit: shape.limit,
    },
    shortfall,
    ...(limitNote ? { limitNote } : {}),
  };
}
