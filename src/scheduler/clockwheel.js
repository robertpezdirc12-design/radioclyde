// Format ura / clockwheel (integration-table item #10, borrowed from
// AzuraCast's "Playlist Groups / Clockwheel" design -- discussion #8432,
// unified in Vaalyn's PR #8433; analyzed in docs/ready-made-scripts-analysis.md
// §4.5). The problem it solves is the same one AzuraCast users described:
// weights + shuffling (rotationRules.js) decide WHAT plays next in what
// relative order, but a real station wants a named, operator-readable SHAPE
// for the hour -- "two chill tracks, then a block from the general rotation,
// repeat" -- that no amount of weighting expresses.
//
// AzuraCast concept -> our equivalent (filler = the rotation layer; curated
// shows keep their own structural variety and are out of scope, same stance
// as rotationRules.js):
//   - "Playlist Groups" (children)  -> named POOLS: config-defined filters
//     (artists / genres / keywords / excludeKeywords) over the same eligible
//     track set generateFillerPlaylist already produces.
//   - "children removed from rotation" -> splitPools() assigns every track to
//     the FIRST matching pool; what no pool claims is the reserved "rotation"
//     pool. A claimed track can never surface outside its pool.
//   - clockwheel steps -> STEPS: [{pool, count}] walked cyclically; each step
//     consumes `count` tracks from its pool's queue.
//   - dayparts -> optional {from, to, steps} windows (first match wins, from
//     inclusive / to exclusive). No midnight wrap in v1 -- encode a night
//     wheel as two windows (00:00-05:00 and 23:00-24:00).
//   - "steps that allow listener request takeover" -> ALREADY EXCEEDED by
//     P2 #8: request.queue preempts at EVERY track boundary above all
//     programming, so a wheel never needs to reserve slots for requests.
//   - "Song Playback Timeline" purple badges -> NOT in v1 (no operator
//     timeline UI); the honest substitute is the per-generation log line
//     naming the resolved wheel and each pool's yield.
//
// LS side (verified against THIS build's src/libs/playlist.liq, 2.2.4 tar):
// modes are exactly "normal" | "random" | "randomize" (invalid -> severe log
// + randomize); "randomize" shuffles at load, on every watch reload AND on
// every loop (randomize() is applied in reload() and in the loop branch), so
// wheel order only survives with mode="normal". normal() takes list head ->
// tail in written order and replays the same order on loop; watch reload
// swaps in the freshly written file's order at the next track boundary. The
// repo's radio.liq ships filler_source with mode="normal" (Paket A1,
// docs/programming-research.md §5), so the written wheel order reaches air.
// A DEPLOYED radio.liq from an older install may still carry
// mode="randomize" -- deploy/ubuntu/install.sh only writes that file on
// first install -- and would scramble the wheel before air; runClockwheel
// logs one compatibility line per regeneration so that mismatch can't hide.
//
// Everything is plain data + plain functions -- no model anywhere. The whole
// feature degrades honestly: no config.filler.clockwheel block = exactly the
// pre-clockwheel behavior; an empty/invalid entry is dropped (and counted,
// so the generation log can say so); a dry pool yields fewer tracks than its
// step asks for and the wheel walks on; a fully dry wheel falls through to
// the same ledger-oldest backfill the plain path uses. Reversible by
// deleting the config block.
import { config } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import {
  capPerArtist,
  capPerArtistAlbum,
  fold as foldTrack,
  weightedRotationOrder,
} from './rotationRules.js';

const log = createLogger('station');

// The general pool's reserved name -- steps point at it to mean "everything
// no named pool claimed". A config may NOT define a pool under this name
// (it would silently shadow the reserved one), so it is ignored and the
// generation log reports it.
export const RESERVED_POOL = 'rotation';

// ---------------------------------------------------------------------------
// config parsing (all drop-and-count: a typo degrades, never crashes)
// ---------------------------------------------------------------------------

function normalizeSteps(rawSteps) {
  const steps = [];
  let dropped = 0;
  for (const s of Array.isArray(rawSteps) ? rawSteps : []) {
    const pool = typeof s?.pool === 'string' ? s.pool.trim() : '';
    const count = Number.isFinite(s?.count) ? Math.floor(s.count) : 1;
    if (!pool || count <= 0) {
      dropped++;
      continue;
    }
    steps.push({ pool, count });
  }
  return { steps, dropped };
}

// "HH:MM", 00:00..23:59 plus the sentinel "24:00" -- minutes, or null. Strict
// zero-padded HH:MM on purpose: "6:00" is rejected so a typo can't silently
// shrink a window (same stance as stationWriter.js's TIME_PATTERN).
export function parseWheelTime(text) {
  if (text === '24:00') return 24 * 60;
  const s = String(text ?? '');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) return null;
  const [h, min] = s.split(':').map(Number);
  return h * 60 + min;
}

function normalizeDaypart(raw) {
  const fromMin = parseWheelTime(raw?.from);
  const toMin = parseWheelTime(raw?.to);
  const { steps } = normalizeSteps(raw?.steps);
  if (fromMin == null || toMin == null || toMin <= fromMin || steps.length === 0) return null;
  return { fromMin, toMin, steps };
}

// null when the feature is off: no block, or a block whose steps and dayparts
// are both empty (there is nothing a wheel could resolve to). Counts of
// dropped entries ride along so the generation log can report typos.
export function clockwheelConfig() {
  const c = config.filler?.clockwheel;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const pools = c.pools && typeof c.pools === 'object' && !Array.isArray(c.pools) ? c.pools : {};
  const { steps, dropped: droppedSteps } = normalizeSteps(c.steps);
  const dayparts = [];
  let droppedDayparts = 0;
  for (const dp of Array.isArray(c.dayparts) ? c.dayparts : []) {
    const parsed = normalizeDaypart(dp);
    if (parsed) dayparts.push(parsed);
    else droppedDayparts++;
  }
  if (steps.length === 0 && dayparts.length === 0) return null;
  return { pools, steps, dayparts, droppedSteps, droppedDayparts };
}

// The wheel in effect at `now`: the FIRST daypart whose window contains the
// current minute (from inclusive, to exclusive), else the default steps.
// Returns { label, steps } -- label names the source for the generation log.
export function daypartSteps(wheel, now = Date.now()) {
  const d = new Date(now);
  const minute = d.getHours() * 60 + d.getMinutes();
  for (const dp of wheel.dayparts) {
    if (minute >= dp.fromMin && minute < dp.toMin) {
      return { steps: dp.steps, label: `${wheel.dayparts.indexOf(dp)} (${fmtMin(dp.fromMin)}-${fmtMin(dp.toMin)})` };
    }
  }
  return wheel.steps.length ? { steps: wheel.steps, label: 'default' } : null;
}

function fmtMin(m) {
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// pool split (AzuraCast: "children are removed from the general rotation")
// ---------------------------------------------------------------------------

// Filter fields, ALL optional; a track must match every present field (AND),
// and within a field any listed value counts (OR). A pool def with NO filter
// fields matches nothing -- an empty filter must not silently swallow the
// whole library into one pool.
//   artists:         folded exact match against track.artist
//   genres:          folded exact match against any of track.genre[]
//   keywords:        folded substring match against artist/title/album
//   excludeKeywords: any hit disqualifies the track from this pool
function poolMatches(t, def) {
  const artists = def.artists ?? [];
  const genres = def.genres ?? [];
  const keywords = def.keywords ?? [];
  const exclude = def.excludeKeywords ?? [];
  const hasFilter = artists.length || genres.length || keywords.length || exclude.length;
  if (!hasFilter) return false;
  if (exclude.length) {
    const haystack = foldTrack([t.artist, t.title, t.album].join(' '));
    for (const kw of exclude) {
      if (haystack.includes(foldTrack(kw))) return false;
    }
  }
  if (artists.length) {
    const artist = foldTrack(t.artist);
    if (!artists.some((a) => foldTrack(a) === artist)) return false;
  }
  if (genres.length) {
    const trackGenres = (t.genre ?? []).map(foldTrack);
    if (!genres.some((g) => trackGenres.includes(foldTrack(g)))) return false;
  }
  if (keywords.length) {
    const haystack = foldTrack([t.artist, t.title, t.album].join(' '));
    if (!keywords.some((kw) => haystack.includes(foldTrack(kw)))) return false;
  }
  return true;
}

// Assigns every eligible track to the FIRST pool whose filter matches (config
// order is priority order, exactly like the caps' input-order-is-priority
// stance in rotationRules.js); the rest is the reserved "rotation" pool.
// Returns { named: Map(pool -> tracks), rotation: tracks }.
export function splitPools(eligible, pools) {
  const defs = Object.entries(pools ?? {}).filter(([name]) => name !== RESERVED_POOL);
  const named = new Map(defs.map(([name]) => [name, []]));
  const rotation = [];
  for (const t of eligible) {
    let placed = false;
    for (const [name, def] of defs) {
      if (poolMatches(t, def)) {
        named.get(name).push(t);
        placed = true;
        break;
      }
    }
    if (!placed) rotation.push(t);
  }
  return { named, rotation };
}

// ---------------------------------------------------------------------------
// per-pool queues + the wheel walk
// ---------------------------------------------------------------------------

// The SAME rotation chain the plain filler path uses (weightedRotationOrder ->
// capPerArtist -> capPerArtistAlbum), applied to one pool's member list. The
// caps bind per pool, so a named pool of one artist's tracks is never
// beheaded by the artist cap the way the global pool would be.
export function preparePoolQueue(tracks, rot, counts) {
  const ordered = weightedRotationOrder(tracks, {
    counts,
    weightWindowDays: rot.weightWindowDays,
    noveltyDays: rot.noveltyDays,
    noveltyBoost: rot.noveltyBoost,
  });
  return capPerArtistAlbum(capPerArtist(ordered, rot.maxTracksPerArtist), rot.maxTracksPerArtistAlbum);
}

// Walks the steps cyclically, consuming up to `count` tracks per step from
// its pool's queue (arrays are consumed via shift -- queues are freshly built
// per call, and one regeneration consumes each pool continuously across wheel
// passes, so nothing repeats until its pool is exhausted). An unknown pool
// name yields nothing (honest: the log shows which pools produced tracks). A
// full pass that yields NOTHING means every queue is dry -- stop instead of
// spinning forever. Stops at targetCount.
export function walkWheel(steps, queues, targetCount = Number.POSITIVE_INFINITY) {
  const ordered = [];
  const yields = new Map();
  while (ordered.length < targetCount) {
    const passStart = ordered.length;
    for (let i = 0; i < steps.length && ordered.length < targetCount; i++) {
      const step = steps[i];
      const queue = queues.get(step.pool);
      if (!queue) continue;
      let take = step.count;
      while (take-- > 0 && queue.length > 0 && ordered.length < targetCount) {
        ordered.push(queue.shift());
        yields.set(step.pool, (yields.get(step.pool) ?? 0) + 1);
      }
    }
    if (ordered.length === passStart) break;
  }
  return { ordered, yields };
}

// The one entry point generateFillerPlaylist calls. Returns the wheel-ordered
// track list (length <= poolSize), or null when the resolved wheel is empty
// (caller falls back to the plain rotation path). All degradation is visible
// in the log: which daypart won, dropped entry counts, per-pool yields, and
// the deployed-radio.liq compatibility line.
export function runClockwheel({ eligible, wheel, rot, counts, poolSize, now = Date.now() }) {
  const resolved = daypartSteps(wheel, now);
  if (!resolved || resolved.steps.length === 0) return null;
  if (wheel.droppedSteps || wheel.droppedDayparts) {
    log(
      `clockwheel: dropped ${wheel.droppedSteps} invalid step(s) and ${wheel.droppedDayparts} invalid daypart(s) ` +
        `-- check filler.clockwheel entries (each step needs pool + count > 0, each daypart needs from < to + non-empty steps)`
    );
  }
  const reserved = Object.keys(wheel.pools ?? {}).filter((name) => name === RESERVED_POOL);
  if (reserved.length) {
    log(`clockwheel: pool name "${RESERVED_POOL}" is reserved and cannot be redefined -- its config entry is ignored`);
  }

  const split = splitPools(eligible, wheel.pools);
  const queues = new Map();
  for (const [name, tracks] of split.named) queues.set(name, preparePoolQueue(tracks, rot, counts));
  queues.set(RESERVED_POOL, preparePoolQueue(split.rotation, rot, counts));

  const { ordered, yields } = walkWheel(resolved.steps, queues, poolSize);
  const stepDesc = resolved.steps.map((s) => `${s.pool}:${s.count}`).join(', ');
  const yieldDesc = [...yields.entries()].map(([pool, n]) => `${pool}=${n}`).join(', ') || 'nothing';
  log(`clockwheel: daypart ${resolved.label} -> ${ordered.length}/${poolSize} track(s) [steps: ${stepDesc}] [yields: ${yieldDesc}]`);
  const missing = [...queues.keys()].filter((p) => !yields.has(p));
  if (missing.length) {
    log(`clockwheel: pool(s) [${missing.join(', ')}] contributed no tracks (unknown step name, empty pool, or caps)`);
  }
  log(
    'clockwheel: wheel order plays as written (radio.liq filler_source mode="normal"); ' +
      'an older deployed radio.liq still on mode="randomize" scrambles it before air.'
  );
  return ordered;
}
